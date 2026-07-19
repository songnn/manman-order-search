import { getTvPickupData } from '../lib/tvPickupData.js';

const CACHE_TTL_MS = 30 * 1000;
const responseCache = globalThis.__manmanTvPickupCache || {
  payload: null,
  cachedAt: 0,
  promise: null
};
globalThis.__manmanTvPickupCache = responseCache;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'GET 요청만 가능합니다.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const now = Date.now();
  if (responseCache.payload && now - responseCache.cachedAt < CACHE_TTL_MS) {
    res.setHeader('X-Manman-TV-Cache', 'hit');
    return res.status(200).json(responseCache.payload);
  }

  try {
    if (!responseCache.promise) {
      responseCache.promise = getTvPickupData()
        .then(payload => {
          responseCache.payload = payload;
          responseCache.cachedAt = Date.now();
          return payload;
        })
        .finally(() => {
          responseCache.promise = null;
        });
    }

    const payload = await responseCache.promise;
    res.setHeader('X-Manman-TV-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('tv-pickup error:', error);

    if (responseCache.payload) {
      res.setHeader('X-Manman-TV-Cache', 'stale');
      return res.status(200).json({
        ...responseCache.payload,
        stale: true,
        staleReason: '마지막 정상 입고 정보를 표시하고 있습니다.'
      });
    }

    return res.status(503).json({
      ok: false,
      message: '픽업 안내 데이터를 불러오지 못했습니다.'
    });
  }
}
