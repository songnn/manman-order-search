import {
  ingestKakaoCsvUpload,
  isKakaoCsvUploadAuthorized
} from '../lib/kakaoCsvProcessing.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'POST 요청만 가능합니다.'
      });
    }

    if (!isKakaoCsvUploadAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const body = await readJsonBody(req);
    const result = await ingestKakaoCsvUpload(body);

    return res.status(200).json({
      ok: true,
      uploadId: result.uploadId,
      fileHash: result.fileHash,
      messageCount: result.messageCount,
      windowMessageCount: result.windowMessageCount,
      joinCount: result.joinCount,
      leaveCount: result.leaveCount,
      matchedOrderCount: result.matchedOrderCount,
      unmatchedCsvOrderCount: result.unmatchedCsvOrderCount,
      unmatchedRawOrderCount: result.unmatchedRawOrderCount
    });
  } catch (error) {
    console.error('kakao-csv-uploads error:', error);

    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.statusCode ? error.message : '카톡 CSV 원본을 저장하지 못했습니다.',
      detail: error.statusCode ? undefined : error.message
    });
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
