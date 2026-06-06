import { getActiveDiscountProducts } from '../lib/discountProducts.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        message: 'GET 요청만 가능합니다.',
        timezone: 'Asia/Seoul',
        serverNow: new Date().toISOString(),
        nextChangeAt: null,
        items: []
      });
    }

    const result = await getActiveDiscountProducts();

    return res.status(200).json({
      ok: true,
      ...result
    });
  } catch (error) {
    console.error('discount-products error:', error);

    return res.status(500).json({
      ok: false,
      message: '할인상품을 불러오지 못했습니다.',
      detail: error.message,
      timezone: 'Asia/Seoul',
      serverNow: new Date().toISOString(),
      nextChangeAt: null,
      items: []
    });
  }
}
