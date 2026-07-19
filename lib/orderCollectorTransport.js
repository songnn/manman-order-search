import { gunzipSync } from 'node:zlib';

export const ORDER_COLLECTOR_GZIP_ENCODING = 'gzip-base64-v1';
export const ORDER_COLLECTOR_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

function parseJsonText(text) {
  const normalized = String(text || '').trim();
  return normalized ? JSON.parse(normalized) : {};
}

function decodeGzipEnvelope(body) {
  const encoded = String(body?.data || '').trim();

  if (!encoded) {
    throw new Error('압축 요청 데이터가 비어 있습니다.');
  }

  const compressed = Buffer.from(encoded, 'base64');
  const decompressed = gunzipSync(compressed, {
    maxOutputLength: ORDER_COLLECTOR_MAX_DECOMPRESSED_BYTES
  });

  if (decompressed.length > ORDER_COLLECTOR_MAX_DECOMPRESSED_BYTES) {
    throw new Error('압축 해제된 요청 데이터가 허용 크기를 초과했습니다.');
  }

  return parseJsonText(decompressed.toString('utf8'));
}

export function parseOrderCollectorRequestBody(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    if (body.encoding === ORDER_COLLECTOR_GZIP_ENCODING) {
      return decodeGzipEnvelope(body);
    }

    return body;
  }

  const parsed = parseJsonText(Buffer.isBuffer(body) ? body.toString('utf8') : body);

  if (parsed?.encoding === ORDER_COLLECTOR_GZIP_ENCODING) {
    return decodeGzipEnvelope(parsed);
  }

  return parsed;
}
