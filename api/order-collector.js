import {
  isOrderCollectorAuthorized,
  runOrderCollectorAction
} from '../lib/orderCollector.js';
import { parseOrderCollectorRequestBody } from '../lib/orderCollectorTransport.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        ok: false,
        error: 'POST 요청만 가능합니다.'
      });
    }

    if (!isOrderCollectorAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const body = parseOrderCollectorRequestBody(req.body);
    const action = String(body.action || '').trim();

    if (!action) {
      return res.status(400).json({
        ok: false,
        error: 'action 값이 필요합니다.'
      });
    }

    const result = await runOrderCollectorAction(action, body.payload || {});

    return res.status(200).json(result);
  } catch (error) {
    console.error('order-collector error:', error);

    return res.status(500).json({
      ok: false,
      error: error.message || '자동 주문수집 처리 중 오류가 발생했습니다.'
    });
  }
}
