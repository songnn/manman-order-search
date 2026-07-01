import { readUnifiedRowsWithRowNumbers_ } from '../lib/orders.js';

const SOURCE_ROWS_CACHE_MS = Math.max(0, Number(process.env.OPS_ORDER_CUSTOMERS_CACHE_MS || 60000));
const sourceRowsCache = globalThis.__opsOrderCustomersSourceRowsCache || {
  expiresAt: 0,
  rows: null,
  promise: null
};
globalThis.__opsOrderCustomersSourceRowsCache = sourceRowsCache;

const ORDER_COUNT_EXCLUDED_CUSTOMERS = new Set([
  '로지4298',
  '로지4739',
  '죠르디9319',
  '하품하는죠르디0108',
  '프리지아6450'
]);

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

    const productKey = normalizeProductKey(req.query?.productName || req.query?.productKey || '');
    const dateKey = clean(req.query?.dateKey);

    if (!productKey || !dateKey) {
      return res.status(400).json({
        ok: false,
        message: '상품과 날짜가 필요합니다.'
      });
    }

    const rows = await readCachedUnifiedRows();
    const customers = rows
      .filter(row => normalizeProductKey(row.productName) === productKey)
      .filter(row => parseDateKey(row.pickupDate) === dateKey)
      .filter(row => !isExcludedOrderCustomer(row.customerName))
      .map(row => ({
        customerLabel: clean(row.customerName) || '닉네임 비어있음',
        quantity: Number(row.quantity || 0),
        noteText: clean(row.note),
        pickupDateText: clean(row.pickupDate),
        orderDateText: clean(row.orderDate),
        sourceRowNumber: row.sourceRowNumber
      }))
      .sort((a, b) => Number(a.sourceRowNumber || 0) - Number(b.sourceRowNumber || 0));

    return res.status(200).json({
      ok: true,
      productKey,
      dateKey,
      count: customers.length,
      quantity: customers.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      customers
    });
  } catch (error) {
    console.error('ops-order-customers error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

async function readCachedUnifiedRows() {
  const now = Date.now();
  if (SOURCE_ROWS_CACHE_MS > 0 && Array.isArray(sourceRowsCache.rows) && sourceRowsCache.expiresAt > now) {
    return sourceRowsCache.rows;
  }

  if (sourceRowsCache.promise) return sourceRowsCache.promise;

  sourceRowsCache.promise = readUnifiedRowsWithRowNumbers_()
    .then(rows => {
      sourceRowsCache.rows = Array.isArray(rows) ? rows : [];
      sourceRowsCache.expiresAt = Date.now() + SOURCE_ROWS_CACHE_MS;
      return sourceRowsCache.rows;
    })
    .finally(() => {
      sourceRowsCache.promise = null;
    });

  return sourceRowsCache.promise;
}

function isAuthorized(req) {
  const expectedAdmin = process.env.ADMIN_TOKEN || '03064';
  const token = req.headers['x-admin-token'] || req.query?.token;
  return Boolean(expectedAdmin && token === expectedAdmin);
}

function normalizeProductKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[0-9]+(?:\.[0-9]+)?\s*(?:g|kg|ml|l|개|팩|박스|입|봉|구|세트)/gi, '')
    .replace(/[^0-9a-z가-힣]+/gi, '');
}

function normalizeCustomerForOrderCount(value) {
  return clean(value).replace(/\s+/g, '');
}

function isExcludedOrderCustomer(value) {
  return ORDER_COUNT_EXCLUDED_CUSTOMERS.has(normalizeCustomerForOrderCount(value));
}

function parseDateKey(value) {
  const raw = clean(value);
  if (!raw) return '';

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return '';

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    year = inferYearForMonthDay(Number(nums[0]));
    month = Number(nums[0]);
    day = Number(nums[1]);
  }

  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return '';
  }

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function inferYearForMonthDay(month) {
  const today = getKstDate();
  let year = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return year;
}

function getKstDate() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(new Date());

  return new Date(
    Number(parts.find(part => part.type === 'year')?.value),
    Number(parts.find(part => part.type === 'month')?.value) - 1,
    Number(parts.find(part => part.type === 'day')?.value)
  );
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
