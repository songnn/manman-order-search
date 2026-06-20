import { syncOperationsData } from '../lib/opsData.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
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

    const includeDrive = String(req.query?.drive ?? req.body?.drive ?? '1') !== '0';
    const includeInventory = String(req.query?.inventory ?? req.body?.inventory ?? '1') !== '0';
    const result = await syncOperationsData({ includeDrive, includeInventory });

    return res.status(result.ok ? 200 : 207).json(result);
  } catch (error) {
    console.error('sync-ops-data error:', error);

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
