import {
  generateSettlementProductImages,
  getOperationsDashboardData
} from '../lib/opsData.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
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

    const body = req.method === 'POST' ? (req.body || {}) : {};
    const limit = Number(body.limit || req.query?.limit || 8);
    const category = String(body.category || req.query?.category || '').trim();
    const dryRun = String(body.dryRun || req.query?.dryRun || '') === '1';
    const result = await generateSettlementProductImages({
      limit,
      category,
      dryRun
    });
    const dashboard = dryRun ? null : await getOperationsDashboardData();
    const ok = Boolean(result.ok || result.generatedCount > 0 || dryRun);

    return res.status(200).json({
      ...result,
      ok,
      dashboard
    });
  } catch (error) {
    console.error('ops-generate-images error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

function isAuthorized(req) {
  const expectedAdmin = process.env.ADMIN_TOKEN || '03064';
  const token = req.headers['x-admin-token'] || req.query?.token;
  return Boolean(expectedAdmin && token === expectedAdmin);
}
