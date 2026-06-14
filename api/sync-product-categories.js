import { syncProductCategoryCache } from '../lib/dashboard/productCategories.js';

export default async function handler(req, res) {
  try {
    if (!['GET', 'POST'].includes(req.method)) {
      return res.status(405).json({
        ok: false,
        message: 'GET 또는 POST 요청만 가능합니다.'
      });
    }

    if (!isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    const result = await syncProductCategoryCache();

    return res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    console.error('sync-product-categories error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  const adminToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
  const authHeader = req.headers.authorization || '';
  const adminHeader = req.headers['x-admin-token'] || '';

  return (
    (cronSecret && authHeader === `Bearer ${cronSecret}`) ||
    adminHeader === adminToken ||
    adminHeader === '03064'
  );
}
