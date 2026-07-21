import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { decideOrderCacheSync } from '../lib/orderCacheSyncPolicy.js';

const root = path.resolve(process.cwd());

test('정상 스냅샷은 전체 동기화와 오래된 행 정리를 모두 수행한다', () => {
  const policy = decideOrderCacheSync({ guard: { ok: true, reasons: [] } });

  assert.deepEqual(policy, {
    mode: 'full',
    allowUpsert: true,
    allowStaleDeletion: true,
    hardReasons: []
  });
});

test('대량 변경 경고가 있어도 새 주문과 수정 주문 동기화는 계속한다', () => {
  const policy = decideOrderCacheSync({
    guard: {
      ok: false,
      reasons: [
        { code: 'too_many_existing_rows_changed' },
        { code: 'too_many_rows_removed' }
      ]
    }
  });

  assert.equal(policy.mode, 'continuous-safe');
  assert.equal(policy.allowUpsert, true);
  assert.equal(policy.allowStaleDeletion, false);
});

test('수동 freeze 설정도 전체 동기화를 멈추지 않고 삭제만 보류한다', () => {
  const policy = decideOrderCacheSync({
    guard: { ok: true, reasons: [] },
    manualCleanupFreeze: true
  });

  assert.equal(policy.mode, 'continuous-safe');
  assert.equal(policy.allowUpsert, true);
  assert.equal(policy.allowStaleDeletion, false);
});

test('구글시트 오류값이나 중복행만 쓰기를 막고 다음 cron에서 재시도한다', () => {
  for (const code of ['spreadsheet_errors', 'duplicate_source_rows']) {
    const policy = decideOrderCacheSync({
      guard: { ok: false, reasons: [{ code }] }
    });

    assert.equal(policy.mode, 'rejected');
    assert.equal(policy.allowUpsert, false);
    assert.equal(policy.allowStaleDeletion, false);
    assert.equal(policy.hardReasons[0].code, code);
  }
});

test('주문 동기화 함수는 서울 리전에서 최대 300초 실행하고 5분마다 재호출된다', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));

  assert.deepEqual(config.functions['api/sync-orders.js'], {
    regions: ['icn1'],
    maxDuration: 300
  });
  assert.ok(config.crons.some(cron =>
    cron.path === '/api/sync-orders' && cron.schedule === '*/5 * * * *'
  ));
});
