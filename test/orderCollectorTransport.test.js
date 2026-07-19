import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  ORDER_COLLECTOR_GZIP_ENCODING,
  parseOrderCollectorRequestBody
} from '../lib/orderCollectorTransport.js';

test('parseOrderCollectorRequestBody keeps regular JSON objects unchanged', () => {
  const body = {
    action: 'getInitialData',
    payload: {}
  };

  assert.equal(parseOrderCollectorRequestBody(body), body);
});

test('parseOrderCollectorRequestBody decodes a gzip base64 envelope', () => {
  const original = {
    action: 'prepareCsvJob',
    payload: {
      csvText: '가나다라\n'.repeat(5000),
      dateStr: '2026-07-19'
    }
  };
  const compressed = gzipSync(JSON.stringify(original)).toString('base64');

  const parsed = parseOrderCollectorRequestBody({
    encoding: ORDER_COLLECTOR_GZIP_ENCODING,
    data: compressed
  });

  assert.deepEqual(parsed, original);
});

test('parseOrderCollectorRequestBody rejects an empty gzip envelope', () => {
  assert.throws(
    () => parseOrderCollectorRequestBody({
      encoding: ORDER_COLLECTOR_GZIP_ENCODING,
      data: ''
    }),
    /압축 요청 데이터가 비어 있습니다/
  );
});
