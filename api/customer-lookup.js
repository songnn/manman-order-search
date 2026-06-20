import { findCustomerCandidatesByDigits } from '../lib/opsData.js';

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

    const result = await findCustomerCandidatesByDigits({
      digits: req.query?.digits || req.query?.q
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('customer-lookup error:', error);

    return res.status(400).json({
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
