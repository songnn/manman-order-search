import {
  GZIP_JSON_ENCODING,
  GZIP_JSON_MAX_DECOMPRESSED_BYTES,
  parseGzipJsonRequestBody
} from './gzipJsonTransport.js';

export const ORDER_COLLECTOR_GZIP_ENCODING = GZIP_JSON_ENCODING;
export const ORDER_COLLECTOR_MAX_DECOMPRESSED_BYTES = GZIP_JSON_MAX_DECOMPRESSED_BYTES;
export const parseOrderCollectorRequestBody = parseGzipJsonRequestBody;
