import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOrderCacheSnapshot } from '../lib/orderCacheGuard.js';

function record(row, overrides = {}) {
  return {
    source_sheet_name: 'Raw_주문입력',
    source_row_number: row,
    customer_label: `고객 ${row}`,
    product_name: `상품 ${row}`,
    quantity: 1,
    price: 1000,
    image_url: 'https://example.com/product.png',
    order_date_text: '2026. 7. 15',
    pickup_date_text: '2026. 7. 16',
    ...overrides
  };
}

test('정상 스냅샷과 새 주문은 동기화를 허용한다', () => {
  const cachedRecords = Array.from({ length: 200 }, (_, index) => record(index + 1));
  const nextRecords = [...cachedRecords, record(201), record(202)];

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, true);
  assert.equal(result.frozen, false);
  assert.equal(result.metrics.addedRows, 2);
});

test('시트 행 삭제로 뒤 주문의 행번호가 이동해도 실제 내용 기준으로 동기화한다', () => {
  const cachedRecords = Array.from({ length: 200 }, (_, index) => record(index + 1));
  const shiftedRecords = cachedRecords.slice(101).map((item, index) => ({
    ...item,
    source_row_number: 101 + index
  }));
  const nextRecords = [
    ...cachedRecords.slice(0, 100),
    ...shiftedRecords,
    record(200, { customer_label: '신규 고객 A', product_name: '신규 상품 A' }),
    record(201, { customer_label: '신규 고객 B', product_name: '신규 상품 B' })
  ];

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, true);
  assert.equal(result.frozen, false);
  assert.equal(result.metrics.contentMatchedRows, 199);
  assert.equal(result.metrics.addedRows, 2);
  assert.equal(result.metrics.removedRows, 1);
  assert.equal(result.metrics.changedExistingRows, 1);
});

test('기존 주문이 한꺼번에 변하면 최근 정상 캐시로 자동 동결한다', () => {
  const cachedRecords = Array.from({ length: 1000 }, (_, index) => record(index + 1));
  const nextRecords = cachedRecords.map((item, index) =>
    index < 101 ? { ...item, customer_label: `손상 ${index}` } : item
  );

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, false);
  assert.equal(result.frozen, true);
  assert.ok(result.reasons.some(reason => reason.code === 'too_many_existing_rows_changed'));
});

test('시트 행이 급감하면 자동 동결한다', () => {
  const cachedRecords = Array.from({ length: 1000 }, (_, index) => record(index + 1));
  const nextRecords = cachedRecords.slice(0, 500);

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(reason => reason.code === 'source_row_count_dropped'));
});

test('행수 비율 허용 범위 안이어도 기존 주문이 안전 기준보다 많이 사라지면 동결한다', () => {
  const cachedRecords = Array.from({ length: 1000 }, (_, index) => record(index + 1));
  const nextRecords = cachedRecords.slice(0, 899);

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, false);
  assert.equal(result.metrics.changedExistingRows, 0);
  assert.equal(result.metrics.removedRows, 101);
  assert.ok(result.reasons.some(reason => reason.code === 'too_many_rows_removed'));
});

test('구글시트 오류값이 있으면 자동 동결한다', () => {
  const cachedRecords = Array.from({ length: 200 }, (_, index) => record(index + 1));
  const nextRecords = cachedRecords.map((item, index) =>
    index === 0 ? { ...item, image_url: '#REF!' } : item
  );

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(reason => reason.code === 'spreadsheet_errors'));
});

test('시트가 정상본으로 돌아오면 첫 검사에서 즉시 동결을 해제한다', () => {
  const cachedRecords = Array.from({ length: 1000 }, (_, index) => record(index + 1));
  const brokenRecords = cachedRecords.map((item, index) =>
    index < 101 ? { ...item, customer_label: `손상 ${index}` } : item
  );

  const frozen = evaluateOrderCacheSnapshot({
    nextRecords: brokenRecords,
    cachedRecords
  });
  const recovered = evaluateOrderCacheSnapshot({
    nextRecords: cachedRecords,
    cachedRecords
  });

  assert.equal(frozen.frozen, true);
  assert.equal(recovered.frozen, false);
  assert.equal(recovered.ok, true);
});

test('현재 운영 규모에서 정상적인 82건 수정과 225건 추가는 허용한다', () => {
  const cachedRecords = Array.from({ length: 15264 }, (_, index) => record(index + 1));
  const nextRecords = [
    ...cachedRecords.map((item, index) =>
      index < 82 ? { ...item, customer_label: `정상 수정 ${index}` } : item
    ),
    ...Array.from({ length: 225 }, (_, index) => record(15265 + index))
  ];

  const result = evaluateOrderCacheSnapshot({ nextRecords, cachedRecords });

  assert.equal(result.ok, true);
  assert.equal(result.frozen, false);
  assert.equal(result.metrics.changedExistingRows, 82);
  assert.equal(result.metrics.addedRows, 307);
  assert.equal(result.metrics.removedRows, 82);
  assert.equal(result.metrics.changedRowLimit, 153);
});
