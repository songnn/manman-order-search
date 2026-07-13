import { getOperationsDashboardData, getOperationsSettlementReviewData, syncInventorySheets } from '../lib/opsData.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      message: 'GET 요청만 가능합니다.'
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    if (String(req.query?.refresh || '') === '1') {
      await syncInventorySheets();
    }

    const wantsSettlement = String(req.query?.settlement || '') === '1';
    const wantsSettlementOnly = wantsSettlement && String(req.query?.settlementOnly || '') === '1';
    const forceRefresh = String(req.query?.refresh || '') === '1';
    let data = wantsSettlementOnly
      ? await getOperationsSettlementReviewData({ force: forceRefresh })
      : await getOperationsDashboardData({
          includeSettlement: wantsSettlement
        });

    if (!wantsSettlementOnly && !forceRefresh && !data.inboundAllItems?.length) {
      await syncInventorySheets();
      data = await getOperationsDashboardData({
        includeSettlement: wantsSettlement
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('buffer-dashboard error:', error);

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
