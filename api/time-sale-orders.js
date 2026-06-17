import { submitTimeSaleOrder } from '../lib/timeSaleOrders.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        code: 'METHOD_NOT_ALLOWED',
        message: 'POST 요청만 가능합니다.'
      });
    }

    const result = await submitTimeSaleOrder(req.body || {});
    const status = result.ok
      ? 200
      : result.code === 'STOCK_EXCEEDED' || result.code === 'SOLD_OUT'
        ? 409
        : 200;

    return res.status(status).json(result);
  } catch (error) {
    console.error('time-sale-orders error:', error);

    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: '주문 처리 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
}
