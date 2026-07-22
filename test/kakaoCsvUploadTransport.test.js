import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import handler from '../api/kakao-csv-uploads.js';
import { getKakaoCsvExpectedToken } from '../lib/kakaoCsvProcessing.js';
import { GZIP_JSON_ENCODING } from '../lib/gzipJsonTransport.js';

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

test('kakao CSV upload API decodes a gzip JSON envelope', async () => {
  const compressed = gzipSync(JSON.stringify({
    orderDate: '2026-07-23',
    fileContent: ''
  })).toString('base64');
  const req = {
    method: 'POST',
    headers: {
      'x-kakao-csv-token': getKakaoCsvExpectedToken()
    },
    body: {
      encoding: GZIP_JSON_ENCODING,
      data: compressed
    }
  };
  const res = createResponse();
  const originalConsoleError = console.error;

  console.error = () => {};
  try {
    await handler(req, res);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /fileContent/);
});
