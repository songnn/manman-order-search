import { togglePickupCompletion } from '../lib/pickupCompletions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      ok: false,
      message: 'POST 요청만 가능합니다.'
    });
  }

  try {
    const result = await togglePickupCompletion({
      sourceRows: req.body?.sourceRows,
      completed: req.body?.completed,
      actor: req.body?.actor,
      phoneLast4: req.body?.phoneLast4 || req.body?.keyword
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('toggle-pickup-completion error:', error);

    return res.status(400).json({
      ok: false,
      message: error.message
    });
  }
}
