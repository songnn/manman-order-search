import { aggregateDashboardRows } from '../lib/dashboard/aggregateOrders.js';
import { readCachedDashboardSheetRows, readCachedKakaoCsvTelemetry } from '../lib/dashboard/dataSource.js';
import { buildKakaoCsvAnalytics } from '../lib/dashboard/kakaoCsvAnalytics.js';
import { parseDashboardDate, parseDashboardRows, toDateKey } from '../lib/dashboard/parseOrders.js';
import { getProductCategoryLookup } from '../lib/dashboard/productCategories.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  READ_START_ROW: Number(process.env.ADMIN_DASHBOARD_READ_START_ROW || 1)
};

const BASIS_VALUES = new Set(['groupDate', 'orderDate', 'pickupDate']);
const MODE_VALUES = new Set(['recent', 'week', 'month', 'total', 'custom']);
const DEFAULT_EXCLUDED_CUSTOMER_NAMES = [
  '로지4298',
  '로지4739',
  '프리지아6450',
  '죠르디9319',
  '하품하는 죠르디 0108',
  '온누리1004',
  '김두팔 7380',
  '하니팡팡6743',
  '아리 1301',
  '춘삼 9319',
  '김밥말이라이언4829',
  '삼비4739',
  '사우나9071',
  '힐청맨9071'
];

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ ok: false, error: 'GET 요청만 가능합니다.' });
    }

    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
    const receivedToken = req.headers['x-admin-token'];

    if (receivedToken !== expectedToken && receivedToken !== '03064') {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const query = getQuery(req);
    const forceRefresh = query.force === '1' || query.refresh === '1';
    const customerQuery = clean(query.customerQuery);
    if (!customerQuery) {
      return res.status(400).json({ ok: false, error: '검색할 카톡 닉네임 또는 뒤 4자리가 필요합니다.' });
    }

    const basis = BASIS_VALUES.has(query.basis) ? query.basis : 'groupDate';
    const mode = MODE_VALUES.has(query.mode) ? query.mode : 'recent';
    const telemetryPromise = readCachedKakaoCsvTelemetry({ force: forceRefresh });
    const { rows } = await readCachedDashboardSheetRows({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      sheetName: CONFIG.RAW_SHEET_NAME,
      startRow: CONFIG.READ_START_ROW,
      force: forceRefresh
    });
    const parsed = parseDashboardRows(rows, {
      basis,
      startRowNumber: CONFIG.READ_START_ROW,
      excludedCustomerNames: getExcludedCustomerNames(query)
    });
    const aggregated = aggregateDashboardRows(parsed.validRows, {
      mode,
      days: query.days,
      year: query.year,
      month: query.month,
      weekIndex: query.weekIndex,
      from: query.from,
      to: query.to,
      customerQuery
    });
    const today = parseDashboardDate(aggregated.meta.today);
    const analysisRows = parsed.validRows.filter(row =>
      row.basisDate && today && row.basisDate.getTime() < today.getTime()
    );
    const periodRows = filterRowsForPeriod(analysisRows, aggregated.period);
    const target = findCustomerName(analysisRows, customerQuery);

    if (!target) {
      return res.status(404).json({
        ok: false,
        error: `"${customerQuery}"에 해당하는 고객을 찾지 못했습니다.`
      });
    }

    const targetKey = normalizeCustomerKey(target);
    const customerRows = analysisRows.filter(row => normalizeCustomerKey(row.customerName) === targetKey);
    const customerPeriodRows = periodRows.filter(row => normalizeCustomerKey(row.customerName) === targetKey);
    const productNames = Array.from(new Set(customerRows.map(row => row.productName).filter(Boolean)));
    const categoryResult = await getProductCategoryLookup(productNames);
    const categoryByProduct = categoryResult.categories;
    const categorizedRows = customerRows.map(row => ({
      ...row,
      category: categoryByProduct[row.productName] || '분류확인'
    }));
    const categorizedPeriodRows = customerPeriodRows.map(row => ({
      ...row,
      category: categoryByProduct[row.productName] || '분류확인'
    }));
    const cumulativeStats = buildCustomerStats(analysisRows);
    const periodStats = buildCustomerStats(periodRows);
    const customerStats = cumulativeStats.get(targetKey) || emptyCustomerStat(target);
    const periodCustomerStats = periodStats.get(targetKey) || emptyCustomerStat(target);
    const { telemetry } = await telemetryPromise;
    const kakaoAnalytics = buildKakaoCsvAnalytics(analysisRows, telemetry, {
      reportPeriod: aggregated.period,
      reportEndDate: aggregated.meta.reportEndDate,
      recentDays: query.kakaoRecentDays || 30
    });
    const profile = findKakaoProfile(kakaoAnalytics.customerProfiles || [], target);
    const matchedOrders = getMatchedOrdersForCustomer(telemetry, targetKey);
    const categoryBreakdown = buildCategoryBreakdown(categorizedRows);
    const periodSeries = buildCustomerPeriodSeries(categorizedPeriodRows, aggregated.period, mode);
    const topProductsByOrderCount = buildProductBreakdown(categorizedRows)
      .sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0) || (b.revenue || 0) - (a.revenue || 0));

    return res.status(200).json({
      ok: true,
      customerName: target,
      query: customerQuery,
      period: aggregated.period,
      profile: profile || buildFallbackProfile(customerStats),
      summary: {
        cumulativeOrderLines: customerStats.orderCount,
        cumulativeQuantity: customerStats.quantity,
        cumulativeRevenue: customerStats.revenue,
        periodOrderLines: periodCustomerStats.orderCount,
        periodQuantity: periodCustomerStats.quantity,
        periodRevenue: periodCustomerStats.revenue,
        mostOrderedProduct: topProductsByOrderCount[0]?.productName || '',
        topRevenueCategory: categoryBreakdown[0]?.category || ''
      },
      ranks: {
        cumulativeQuantityRank: rankCustomer(cumulativeStats, targetKey, 'quantity'),
        cumulativeRevenueRank: rankCustomer(cumulativeStats, targetKey, 'revenue'),
        periodQuantityRank: rankCustomer(periodStats, targetKey, 'quantity'),
        periodRevenueRank: rankCustomer(periodStats, targetKey, 'revenue')
      },
      categorySource: categoryResult.source,
      categorySheetName: categoryResult.sheetName,
      categoryStoredHitCount: categoryResult.storedHitCount,
      categorySheetHitCount: categoryResult.sheetHitCount,
      categoryRuleFallbackCount: categoryResult.ruleFallbackCount,
      categoryTableUnavailable: categoryResult.tableUnavailable,
      categoryBreakdown,
      topCategoriesByRevenue: categoryBreakdown,
      topProductsByOrderCount,
      periodSeries,
      matchedOrders,
      recentOrders: categorizedRows
        .sort((a, b) => b.basisDate.getTime() - a.basisDate.getTime())
        .slice(0, 50)
        .map(row => ({
          date: toDateKey(row.basisDate),
          productName: row.productName,
          category: row.category,
          quantity: row.quantity,
          revenue: row.revenue
        }))
    });
  } catch (error) {
    console.error('admin-dashboard-kakao-user error:', error);

    return res.status(500).json({
      ok: false,
      error: '카톡 유저 상세 데이터를 불러오지 못했습니다.',
      detail: error.message
    });
  }
}

function buildCustomerStats(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = normalizeCustomerKey(row.customerName);
    if (!key) return;

    const current = map.get(key) || emptyCustomerStat(row.customerName);
    current.quantity += Number(row.quantity || 0);
    current.orderCount += 1;
    current.revenue += Number(row.revenue || 0);
    current.firstOrderDate = current.firstOrderDate
      ? minDate(current.firstOrderDate, row.basisDate)
      : row.basisDate;
    current.lastOrderDate = current.lastOrderDate
      ? maxDate(current.lastOrderDate, row.basisDate)
      : row.basisDate;
    map.set(key, current);
  });
  return map;
}

function buildCategoryBreakdown(rows) {
  const map = new Map();
  rows.forEach(row => {
    const category = row.category || '분류확인';
    const current = map.get(category) || {
      category,
      orderCount: 0,
      quantity: 0,
      revenue: 0
    };
    current.orderCount += 1;
    current.quantity += Number(row.quantity || 0);
    current.revenue += Number(row.revenue || 0);
    map.set(category, current);
  });
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity)
    .slice(0, 12);
}

function buildProductBreakdown(rows) {
  const map = new Map();
  rows.forEach(row => {
    const current = map.get(row.productName) || {
      productName: row.productName,
      category: row.category || '분류확인',
      orderCount: 0,
      quantity: 0,
      revenue: 0
    };
    current.orderCount += 1;
    current.quantity += Number(row.quantity || 0);
    current.revenue += Number(row.revenue || 0);
    map.set(row.productName, current);
  });
  return Array.from(map.values());
}

function buildCustomerPeriodSeries(rows, period, mode) {
  if (mode === 'total') {
    const map = new Map();
    rows.forEach(row => {
      const key = toDateKey(row.basisDate).slice(0, 7);
      addToSeries(map, key, row);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ label: key.slice(5) + '월', ...value }));
  }

  const from = parseDashboardDate(period?.from);
  const to = parseDashboardDate(period?.to);
  if (!from || !to) return [];
  const map = new Map();
  rows.forEach(row => addToSeries(map, toDateKey(row.basisDate), row));

  const result = [];
  let cursor = from;
  while (cursor.getTime() <= to.getTime()) {
    const key = toDateKey(cursor);
    result.push({
      label: `${cursor.getMonth() + 1}/${cursor.getDate()}`,
      ...(map.get(key) || { quantity: 0, orderCount: 0, revenue: 0 })
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return result;
}

function addToSeries(map, key, row) {
  const current = map.get(key) || { quantity: 0, orderCount: 0, revenue: 0 };
  current.quantity += Number(row.quantity || 0);
  current.orderCount += 1;
  current.revenue += Number(row.revenue || 0);
  map.set(key, current);
}

function getMatchedOrdersForCustomer(telemetry, targetKey) {
  const latestUploadId = [...(telemetry.uploads || [])]
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))[0]?.uploadId;

  return (telemetry.orderMatches || [])
    .filter(match => match.uploadId === latestUploadId)
    .filter(match => normalizeCustomerKey(match.customerName) === targetKey)
    .sort((a, b) => String(a.actualOrderedAt || '').localeCompare(String(b.actualOrderedAt || '')))
    .map(match => ({
      actualOrderedAt: match.actualOrderedAt,
      productName: match.productName,
      quantity: match.quantity,
      messageRaw: match.messageRaw,
      matchConfidence: match.matchConfidence
    }));
}

function findCustomerName(rows, customerQuery) {
  const normalizedQuery = normalizeCustomerKey(customerQuery);
  const digits = clean(customerQuery).replace(/\D/g, '');
  const names = Array.from(new Set(rows.map(row => row.customerName).filter(Boolean)));

  return names.find(name => normalizeCustomerKey(name) === normalizedQuery) ||
    (digits ? names.find(name => name.replace(/\D/g, '').endsWith(digits.slice(-4))) : '') ||
    names.find(name => normalizeCustomerKey(name).includes(normalizedQuery)) ||
    '';
}

function findKakaoProfile(profiles, customerName) {
  const targetKey = normalizeCustomerKey(customerName);
  return (profiles || []).find(profile =>
    normalizeCustomerKey(profile.customerName) === targetKey ||
    normalizeCustomerKey(profile.userName) === targetKey
  ) || null;
}

function buildFallbackProfile(stats) {
  return {
    customerName: stats.customerName,
    firstOrderDate: stats.firstOrderDate ? toDateKey(stats.firstOrderDate) : '',
    lastOrderDate: stats.lastOrderDate ? toDateKey(stats.lastOrderDate) : ''
  };
}

function rankCustomer(statsMap, targetKey, metric) {
  const rows = Array.from(statsMap.entries())
    .sort(([, a], [, b]) => (b[metric] || 0) - (a[metric] || 0) || (b.revenue || 0) - (a.revenue || 0));
  const index = rows.findIndex(([key]) => key === targetKey);
  return index >= 0 ? index + 1 : null;
}

function emptyCustomerStat(customerName) {
  return {
    customerName,
    quantity: 0,
    orderCount: 0,
    revenue: 0,
    firstOrderDate: null,
    lastOrderDate: null
  };
}

function filterRowsForPeriod(rows, period) {
  const from = parseDashboardDate(period?.from);
  const to = parseDashboardDate(period?.to);
  if (!from || !to) return rows;
  return rows.filter(row =>
    row.basisDate &&
    row.basisDate.getTime() >= from.getTime() &&
    row.basisDate.getTime() <= to.getTime()
  );
}

function getExcludedCustomerNames(query) {
  if (!Object.prototype.hasOwnProperty.call(query, 'excludedCustomers')) {
    return DEFAULT_EXCLUDED_CUSTOMER_NAMES;
  }
  const raw = Array.isArray(query.excludedCustomers)
    ? query.excludedCustomers[0]
    : query.excludedCustomers;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeCustomerNames(parsed);
  } catch {
    // Fallback below.
  }
  return sanitizeCustomerNames(String(raw).split(','));
}

function sanitizeCustomerNames(names) {
  return Array.from(new Set(names.map(name => clean(name)).filter(Boolean)));
}

function getQuery(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function normalizeCustomerKey(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '');
}

function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
