import { getTimeSaleProductsPayload } from '../lib/timeSaleOrders.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        message: 'GET 요청만 가능합니다.',
        items: []
      });
    }

    const result = await getTimeSaleProductsPayload();

    return res.status(200).json(result);
  } catch (error) {
    console.error('time-sale-products error:', error);

    return res.status(500).json({
      ok: false,
      message: '타임특가 상품을 불러오지 못했습니다.',
      detail: error.message,
      items: []
    });
  }
}
