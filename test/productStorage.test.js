import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductStorageCatalog,
  findStaleProductStorageRows,
  normalizeProductStorageKey,
  normalizeStorageMethod,
  readProductStorageCatalog,
  resolveProductStorage,
  summarizeProductStorageRows
} from '../lib/productStorage.js';

test('보관방법은 고객에게 노출 가능한 세 값만 허용한다', () => {
  assert.equal(normalizeStorageMethod('냉동 보관'), '냉동');
  assert.equal(normalizeStorageMethod(' 냉장 '), '냉장');
  assert.equal(normalizeStorageMethod('실온보관'), '상온');
  assert.equal(normalizeStorageMethod(''), null);
  assert.equal(normalizeStorageMethod('0'), null);
  assert.equal(normalizeStorageMethod('미정'), null);
  assert.equal(normalizeStorageMethod('냉장 또는 냉동'), null);
});

test('주문과 입고 Raw가 같은 안전한 상품키 정규화를 공유한다', () => {
  assert.equal(
    normalizeProductStorageKey('  Ａ상품 [ 500g ]  '),
    'a상품 500g'
  );
  assert.equal(normalizeProductStorageKey(null), '');
});

test('Raw 원본 공란은 잘못 캐시된 상온 값보다 우선하며 유효한 중복행으로 보완한다', () => {
  const catalog = buildProductStorageCatalog([
    {
      product_name: '상품 A',
      product_key: '상품 a',
      storage_method: '상온',
      outbound_date: '2026-07-20',
      source_row_number: 10,
      raw_json: { '보관 방법': '' }
    },
    {
      product_name: '상품 A',
      product_key: '상품 a',
      storage_method: '냉장',
      outbound_date: '2026-07-20',
      source_row_number: 11,
      raw_json: { '보관 방법': '냉장' }
    }
  ]);

  assert.deepEqual(resolveProductStorage(catalog, '상품 A', '2026. 7. 20'), {
    storageMethod: '냉장',
    storageMethodStatus: 'confirmed',
    storageMethodSource: '입고 raw'
  });
});

test('같은 상품의 보관방법이 날짜별로 다르면 픽업일 정확 일치만 확정한다', () => {
  const catalog = buildProductStorageCatalog([
    {
      product_name: '상품 B',
      storage_method: '냉장',
      outbound_date: '2026-07-20',
      source_row_number: 20
    },
    {
      product_name: '상품 B',
      storage_method: '냉동',
      outbound_date: '2026-07-21',
      source_row_number: 21
    }
  ]);

  assert.equal(
    resolveProductStorage(catalog, '상품 B', '2026. 7. 20').storageMethod,
    '냉장'
  );
  assert.deepEqual(resolveProductStorage(catalog, '상품 B', '2026. 7. 22'), {
    storageMethod: null,
    storageMethodStatus: 'conflict',
    storageMethodSource: '입고 raw'
  });
  assert.equal(
    resolveProductStorage(catalog, '없는 상품', '2026. 7. 20').storageMethodStatus,
    'pending'
  );
});

test('입고 Raw 동기화 결과에 비식별 보관방법 품질 집계를 제공한다', () => {
  const summary = summarizeProductStorageRows([
    { productName: '상온 A', storageMethod: '상온' },
    { productName: '상온 A', storageMethod: '상온' },
    { productName: '냉장 B', storageMethod: '냉장' },
    { productName: '충돌 C', storageMethod: '냉장' },
    { productName: '충돌 C', storageMethod: '냉동' },
    { productName: '미정 D', storageMethod: '' }
  ]);

  assert.deepEqual(summary, {
    rowCount: 6,
    confirmedProductCount: 2,
    unconfirmedRowCount: 1,
    conflictProductCount: 1,
    counts: {
      '상온': 1,
      '냉장': 1,
      '냉동': 0
    }
  });
});

test('상품키 조회는 긴 목록을 나누고 모든 결과를 하나의 카탈로그로 합친다', async () => {
  const chunks = [];
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in(_column, keys) {
          chunks.push(keys);
          this.keys = keys;
          return this;
        },
        range() {
          return Promise.resolve({
            data: this.keys.map((key, index) => ({
              product_key: key,
              storage_method: index % 2 ? '냉장' : '상온'
            })),
            error: null
          });
        }
      };
    }
  };

  const catalog = await readProductStorageCatalog(
    ['상품 1', '상품 2', '상품 3'],
    { client, storeName: '테스트점', chunkSize: 2 }
  );

  assert.deepEqual(chunks, [['상품 1', '상품 2'], ['상품 3']]);
  assert.equal(catalog.size, 3);
});

test('기존 괄호 공백 상품키도 다음 Raw 동기화 전까지 함께 조회한다', async () => {
  let queriedKeys = [];
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in(_column, keys) {
          queriedKeys = keys;
          return this;
        },
        range() { return Promise.resolve({ data: [], error: null }); }
      };
    }
  };

  await readProductStorageCatalog(['Ａ상품 [ 500g ]'], { client });

  assert.ok(queriedKeys.includes('a상품 500g'));
  assert.ok(queriedKeys.includes('a상품  500g'));
});

test('한 상품의 Raw 이력이 응답 한도를 넘어도 모든 페이지를 읽는다', async () => {
  const ranges = [];
  const allRows = [
    { product_key: '상품', storage_method: '냉장', source_row_number: 1 },
    { product_key: '상품', storage_method: '냉장', source_row_number: 2 },
    { product_key: '상품', storage_method: '냉장', source_row_number: 3 }
  ];
  const client = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        range(from, to) {
          ranges.push([from, to]);
          return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
        }
      };
    }
  };

  const catalog = await readProductStorageCatalog(['상품'], {
    client,
    chunkSize: 1,
    pageSize: 2
  });

  assert.deepEqual(ranges, [[0, 1], [2, 3]]);
  assert.equal(catalog.get('상품').length, 3);
});

test('겹친 동기화에서도 현재 스냅샷에 없는 기존 Raw 행만 삭제 후보로 고른다', () => {
  const cachedRows = [
    { stable_id: 'raw-1', sync_run_id: 'old-run' },
    { stable_id: 'raw-2', sync_run_id: 'old-run' },
    { stable_id: 'raw-3', sync_run_id: 'old-run' }
  ];
  const nextRows = [
    { stable_id: 'raw-1', sync_run_id: 'new-run' },
    { stable_id: 'raw-2', sync_run_id: 'new-run' },
    { stable_id: 'raw-4', sync_run_id: 'new-run' }
  ];

  assert.deepEqual(
    findStaleProductStorageRows(cachedRows, nextRows).map(row => row.stable_id),
    ['raw-3']
  );
});
