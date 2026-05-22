import { searchOrders } from '../lib/orders.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        message: 'POST 요청만 가능합니다.',
        items: []
      });
    }

    const { keyword, selectedCustomerLabel } = req.body || {};

    const result = await searchOrders(keyword, selectedCustomerLabel);

    return res.status(200).json(result);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      message: '서버 오류가 발생했습니다.',
      detail: error.message,
      items: []
    });
  }
}