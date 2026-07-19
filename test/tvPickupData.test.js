import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTvPickupPayload,
  getPickupUnitQuantity,
  getTvPickupCutoffDateKey,
  makeTvProductName,
  parsePackageUnit
} from '../lib/tvPickupData.js';

function inventoryRow(overrides = {}) {
  return {
    stable_id: overrides.stable_id || `item-${overrides.source_row_number || 1}`,
    source_sheet_name: '입고리스트',
    source_row_number: 1,
    product_name: '상품',
    product_key: '',
    storage_method: '상온',
    sales_type: '공구',
    inbound_date: '2026-07-20',
    inbound_quantity: 1,
    package_unit: '1',
    image_url: 'https://example.com/product.jpg',
    synced_at: '2026-07-20T01:00:00.000Z',
    ...overrides
  };
}

function rawStorageRow(row) {
  return {
    product_name: row.product_name,
    product_key: row.product_key,
    storage_method: row.storage_method,
    outbound_date: row.inbound_date,
    source_row_number: row.source_row_number,
    synced_at: row.synced_at,
    raw_json: { 보관방법: row.storage_method }
  };
}

test('서울시각 오전 10시와 휴점일 기준으로 게시 날짜를 전환한다', () => {
  assert.equal(
    getTvPickupCutoffDateKey(new Date('2026-07-20T00:59:00.000Z')),
    '2026-07-16'
  );
  assert.equal(
    getTvPickupCutoffDateKey(new Date('2026-07-20T01:00:00.000Z')),
    '2026-07-20'
  );
  assert.equal(
    getTvPickupCutoffDateKey(new Date('2026-07-19T08:00:00.000Z')),
    '2026-07-16'
  );
  assert.equal(
    getTvPickupCutoffDateKey(new Date('2026-08-17T03:00:00.000Z')),
    '2026-08-14'
  );
});

test('포장단위가 1보다 크면 입고수량을 나눈 정확한 값을 정렬수량으로 쓴다', () => {
  assert.equal(parsePackageUnit('5개입'), 5);
  assert.equal(parsePackageUnit(''), 1);
  assert.equal(parsePackageUnit('0'), 1);
  assert.deepEqual(getPickupUnitQuantity(15, '5'), {
    inboundQuantity: 15,
    packageSize: 5,
    quantity: 3,
    nonDivisible: false
  });
  assert.equal(getPickupUnitQuantity(10, 4).quantity, 2.5);
  assert.equal(getPickupUnitQuantity(10, 4).nonDivisible, true);
});

test('입고완료 상품만 공개하고 포장 환산수량 내림차순으로 정렬한다', () => {
  const rows = [
    inventoryRow({
      stable_id: 'salty',
      source_row_number: 1,
      product_name: '제로칩 솔티맛 x 5봉 / 26년 11월',
      inbound_quantity: 10,
      package_unit: '5'
    }),
    inventoryRow({
      stable_id: 'onion',
      source_row_number: 2,
      product_name: '제로칩 어니언맛 x 5봉 / 26년 11월',
      inbound_quantity: 15,
      package_unit: '5'
    }),
    inventoryRow({
      stable_id: 'pad',
      source_row_number: 3,
      product_name: '신발 발냄새 제거 패드 60매',
      inbound_quantity: 20
    }),
    inventoryRow({
      stable_id: 'pending',
      source_row_number: 4,
      product_name: '입고 대기 상품',
      inbound_quantity: 99
    })
  ];
  const checks = rows.slice(0, 3).map(row => ({
    inventory_stable_id: row.stable_id,
    is_complete: true,
    updated_at: '2026-07-20T01:05:00.000Z'
  }));
  const payload = buildTvPickupPayload({
    inventoryRows: rows,
    receivingChecks: checks,
    rawStorageRows: rows.map(rawStorageRow),
    now: new Date('2026-07-20T01:10:00.000Z')
  });

  assert.equal(payload.summary.totalProducts, 4);
  assert.equal(payload.summary.readyProducts, 3);
  assert.equal(payload.summary.pendingProducts, 1);
  assert.deepEqual(payload.items.map(item => item.displayName), [
    '신발 발냄새 제거 패드 60매',
    '제로칩 어니언맛 x 5봉',
    '제로칩 솔티맛 x 5봉'
  ]);
  assert.ok(payload.items.every(item => item.status === 'complete'));
  assert.ok(payload.items.every(item => !Object.hasOwn(item, 'inboundQuantity')));
  assert.ok(payload.items.every(item => !Object.hasOwn(item, 'packageUnit')));
});

test('같은 상품의 history 완료체크를 현재 입고행에 이어 붙이고 중복 노출하지 않는다', () => {
  const active = inventoryRow({
    stable_id: 'active',
    source_row_number: 8,
    product_name: '농협 안심한우 1등급 제비추리 200g',
    storage_method: '냉장',
    inbound_quantity: 5
  });
  const history = {
    ...active,
    stable_id: 'history',
    source_sheet_name: '입고리스트#history:abc',
    synced_at: '2026-07-19T20:00:00.000Z'
  };
  const payload = buildTvPickupPayload({
    inventoryRows: [active, history],
    receivingChecks: [{
      inventory_stable_id: 'history',
      is_complete: true,
      updated_at: '2026-07-20T01:01:00.000Z'
    }],
    rawStorageRows: [rawStorageRow(active)],
    now: new Date('2026-07-20T01:10:00.000Z')
  });

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].storageType, '냉장');
});

test('현재 입고행에서 완료를 취소하면 과거 history 완료상태보다 우선한다', () => {
  const active = inventoryRow({
    stable_id: 'active-cancelled',
    product_name: '완료 취소 상품',
    sync_run_id: 'run-new',
    synced_at: '2026-07-20T01:02:00.000Z'
  });
  const history = {
    ...active,
    stable_id: 'history-complete',
    source_sheet_name: '입고리스트#history:old',
    sync_run_id: 'run-old',
    synced_at: '2026-07-20T01:01:00.000Z'
  };
  const payload = buildTvPickupPayload({
    inventoryRows: [active, history],
    receivingChecks: [
      {
        inventory_stable_id: 'active-cancelled',
        is_complete: false,
        updated_at: '2026-07-20T01:02:00.000Z'
      },
      {
        inventory_stable_id: 'history-complete',
        is_complete: true,
        updated_at: '2026-07-20T01:01:00.000Z'
      }
    ],
    rawStorageRows: [rawStorageRow(active)],
    now: new Date('2026-07-20T01:10:00.000Z')
  });

  assert.equal(payload.summary.readyProducts, 0);
  assert.equal(payload.summary.pendingProducts, 1);
  assert.equal(payload.items.length, 0);
});

test('최신 동기화 run에 없는 오래된 active 행은 상품판과 수량 합산에서 제외한다', () => {
  const current = inventoryRow({
    stable_id: 'current',
    product_name: '현재 상품',
    sync_run_id: 'run-new',
    synced_at: '2026-07-20T01:02:00.000Z',
    inbound_quantity: 3
  });
  const stale = inventoryRow({
    stable_id: 'stale',
    product_name: '삭제된 이전 상품',
    source_row_number: 2,
    sync_run_id: 'run-old',
    synced_at: '2026-07-20T01:01:00.000Z',
    inbound_quantity: 999
  });
  const payload = buildTvPickupPayload({
    inventoryRows: [stale, current],
    receivingChecks: [{ inventory_stable_id: 'current', is_complete: true }],
    rawStorageRows: [rawStorageRow(current), rawStorageRow(stale)],
    now: new Date('2026-07-20T01:10:00.000Z')
  });

  assert.equal(payload.summary.totalProducts, 1);
  assert.deepEqual(payload.items.map(item => item.displayName), ['현재 상품']);
});

test('입고 Raw에서 보관방법을 확인하지 못한 상품은 공개 목록에서 제외한다', () => {
  const row = inventoryRow({ stable_id: 'unverified', product_name: '미검증 상품' });
  const payload = buildTvPickupPayload({
    inventoryRows: [row],
    receivingChecks: [{ inventory_stable_id: 'unverified', is_complete: true }],
    rawStorageRows: [],
    now: new Date('2026-07-20T01:10:00.000Z')
  });

  assert.equal(payload.summary.totalProducts, 0);
  assert.equal(payload.dataQuality.storageReviewCount, 1);
  assert.equal(payload.items.length, 0);
});

test('TV 상품명은 홍보 접두사와 소비기한 꼬리만 제거한다', () => {
  assert.equal(
    makeTvProductName('[임박초특가] 조아제약 멀티비타민 30캡슐 / 26년 9월 1일'),
    '조아제약 멀티비타민 30캡슐'
  );
  assert.equal(
    makeTvProductName('[국내산 100% 미꾸라지 &무청] 남도식 추어탕 500g'),
    '[국내산 100% 미꾸라지 &무청] 남도식 추어탕 500g'
  );
});

test('공개 payload에 고객 식별정보 키가 포함되지 않는다', () => {
  const row = inventoryRow({ stable_id: 'safe', product_name: '안전한 상품' });
  const payload = buildTvPickupPayload({
    inventoryRows: [row],
    receivingChecks: [{ inventory_stable_id: 'safe', is_complete: true }],
    rawStorageRows: [rawStorageRow(row)],
    now: new Date('2026-07-20T01:10:00.000Z')
  });
  const serialized = JSON.stringify(payload).toLowerCase();

  assert.doesNotMatch(serialized, /customer|phone|digits|nickname|ordertotal|admin.?token/);
});
