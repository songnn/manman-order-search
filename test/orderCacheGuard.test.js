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

test('기존 주문이 한꺼번에 변하면 최근 정상 캐시로 자동 동결한다', () => {
  const cachedRecords = Array.from({ length: 1000 }, (_, index) => record(index + 1));
  const nextRecords = cachedRecords.map((item, index) =>
    index < 41 ? { ...item, customer_label: `손상 ${index}` } : item
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
    index < 41 ? { ...item, customer_label: `손상 ${index}` } : item
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
