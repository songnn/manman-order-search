import assert from 'node:assert/strict';
import test from 'node:test';
import { findStaleOrderCacheRecords } from '../lib/orderCacheSync.js';

function record(row, overrides = {}) {
  return {
    source_sheet_name: 'Raw_주문입력',
    source_row_number: row,
    product_name: `상품 ${row}`,
    ...overrides
  };
}

test('새 스냅샷에 없는 캐시 행만 삭제 대상으로 고른다', () => {
  const cachedRecords = [record(1), record(2), record(3)];
  const nextRecords = [record(1), record(2), record(4)];

  const staleRecords = findStaleOrderCacheRecords(cachedRecords, nextRecords);

  assert.deepEqual(staleRecords.map(item => item.source_row_number), [3]);
});

test('같은 행의 내용이 바뀌거나 새 행이 추가되어도 기존 행을 삭제하지 않는다', () => {
  const cachedRecords = [record(1), record(2)];
  const nextRecords = [
    record(1, { product_name: '수정된 상품' }),
    record(2),
    record(3)
  ];

  const staleRecords = findStaleOrderCacheRecords(cachedRecords, nextRecords);

  assert.deepEqual(staleRecords, []);
});

test('서로 다른 원본 시트의 같은 행번호를 구분한다', () => {
  const cachedRecords = [
    record(1),
    record(1, { source_sheet_name: '타임세일_주문' })
  ];
  const nextRecords = [record(1)];

  const staleRecords = findStaleOrderCacheRecords(cachedRecords, nextRecords);

  assert.equal(staleRecords.length, 1);
  assert.equal(staleRecords[0].source_sheet_name, '타임세일_주문');
});
