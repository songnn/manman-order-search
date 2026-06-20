import { syncPickupCompletionsToSheet } from '../lib/pickupCompletions.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({
      ok: false,
      message: 'GET 또는 POST 요청만 가능합니다.'
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    const limit = Number(req.query?.limit || req.body?.limit || 500);
    const result = await syncPickupCompletionsToSheet({ limit });

    return res.status(200).json(result);
  } catch (error) {
    console.error('sync-pickup-completions error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

function isAuthorized(req) {
  const expectedCron = process.env.CRON_SECRET;
  const expectedAdmin = process.env.ADMIN_TOKEN || '03064';
  const authHeader = req.headers.authorization || '';
  const adminToken = req.headers['x-admin-token'] || req.query?.token;

  if (expectedCron && authHeader === `Bearer ${expectedCron}`) return true;
  return Boolean(expectedAdmin && adminToken === expectedAdmin);
}
