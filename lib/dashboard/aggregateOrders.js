import { getSeoulToday, parseDashboardDate, toDateKey } from './parseOrders.js';
import { buildGrowthDashboardData, getGrowthRows } from './growthAnalysis.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MODES = new Set(['recent', 'week', 'month', 'total', 'custom']);
const RECENT_DAYS = new Set([1, 3, 7, 14, 30]);

export function aggregateDashboardRows(rows, options = {}) {
  const today = normalizeDate(options.today || getSeoulToday());
  const reportEndDate = addDays(today, -1);
  const analysisRows = excludeTodayRows(rows, today);
  const mode = MODES.has(options.mode) ? options.mode : 'recent';
  const period = resolvePeriod(analysisRows, mode, options, today, reportEndDate);
  const periodRows = filterRowsForPeriod(analysisRows, period);
  const growthRows = getGrowthRows(rows, today);
  const growthData = buildGrowthDashboardData(growthRows, {
    period,
    mode,
    reportEndDate
  });
  const allTotals = buildTotals(analysisRows);
  const periodTotals = buildTotals(periodRows);
  const dailySeries = period.from && period.to
    ? buildDailySeries(periodRows, period.from, period.to)
    : [];
  const monthlySeries = buildMonthlySeries(analysisRows);
  const customerQuery = clean(options.customerQuery);
  const customerSearchResults = customerQuery
    ? searchCustomers(allTotals.customers, customerQuery).slice(0, 20)
    : [];
  const customerDetail = customerQuery
    ? buildCustomerDetail(rows, customerSearchResults[0]?.customerName || customerQuery)
    : null;

  return {
    mode,
    period: {
      label: period.label,
      from: period.from ? toDateKey(period.from) : null,
      to: period.to ? toDateKey(period.to) : null
    },
    summary: {
      quantity: periodTotals.quantity,
      orderCount: periodTotals.orderCount,
      revenue: periodTotals.revenue,
      customerCount: periodTotals.customerCount,
      productCount: periodTotals.productCount,
      averageOrderValue: periodTotals.averageOrderValue
    },
    series: {
      daily: dailySeries,
      monthly: monthlySeries
    },
    rankings: {
      customersByQuantity: rankCustomers(periodRows, 'quantity'),
      customersByRevenue: rankCustomers(periodRows, 'revenue'),
      productsByQuantity: rankProducts(periodRows, 'quantity'),
      productsByRevenue: rankProducts(periodRows, 'revenue')
    },
    totals: {
      customers: allTotals.customers.slice(0, 200),
      products: allTotals.products.slice(0, 200),
      customersByRevenue: [...allTotals.customers]
        .sort(sortByMetric('revenue'))
        .slice(0, 200)
        .map(withRank),
      productsByRevenue: [...allTotals.products]
        .sort(sortByMetric('revenue'))
        .slice(0, 200)
        .map(withRank),
      customerSearchResults,
      customerDetail
    },
    growthAnalysis: growthData.growthAnalysis,
    participationFrequency: growthData.participationFrequency,
    customerMovement: growthData.customerMovement,
    lifecycle: growthData.lifecycle,
    kakaoRoomMetrics: growthData.kakaoRoomMetrics,
    dataQuality: {
      growthBasis: 'groupDate',
      totalValidRows: rows.length,
      includedRows: analysisRows.length,
      includedGrowthRows: growthRows.length,
      excludedTodayRows: rows.length - analysisRows.length
    },
    options: buildOptions(analysisRows, reportEndDate),
    meta: {
      mode,
      today: toDateKey(today),
      reportEndDate: toDateKey(reportEndDate),
      rowCount: periodRows.length,
      analyzedRowCount: analysisRows.length,
      growthAnalyzedRowCount: growthRows.length,
      excludedTodayRowCount: rows.length - analysisRows.length,
      totalRowCount: rows.length
    }
  };
}

export function startOfWeekMonday(date) {
  const result = normalizeDate(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);

  return result;
}

export function endOfWeekSunday(date) {
  const result = startOfWeekMonday(date);
  result.setDate(result.getDate() + 6);

  return result;
}

export function getMonthWeekRanges(year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const ranges = [];
  let cursor = normalizeDate(monthStart);

  while (cursor.getTime() <= monthEnd.getTime()) {
    const weekStart = startOfWeekMonday(cursor);
    const weekEnd = endOfWeekSunday(cursor);
    const from = maxDate(weekStart, monthStart);
    const to = minDate(weekEnd, monthEnd);

    ranges.push({
      weekIndex: ranges.length + 1,
      year,
      month,
      from,
      to,
      label: `${month}월 ${ranges.length + 1}주차`,
      rangeLabel: `${month}.${from.getDate()} ~ ${month}.${to.getDate()}`
    });

    cursor = addDays(to, 1);
  }

  return ranges;
}

function resolvePeriod(rows, mode, options, today, reportEndDate) {
  if (mode === 'total') {
    const firstDate = getFirstBasisDate(rows);
    const lastDate = getLastBasisDate(rows);

    return {
      label: '전체 누적',
      from: firstDate,
      to: lastDate
    };
  }

  if (mode === 'week') {
    const year = parseIntOr(options.year, reportEndDate.getFullYear());
    const month = parseIntOr(options.month, reportEndDate.getMonth() + 1);
    const ranges = getMonthWeekRanges(year, month);
    if (!ranges.length || new Date(year, month - 1, 1).getTime() > reportEndDate.getTime()) {
      const from = new Date(year, month - 1, 1);
      const to = addDays(from, -1);

      return {
        label: `${year}년 ${month}월 주간 데이터 없음`,
        from,
        to
      };
    }

    const weekIndex = clamp(parseIntOr(options.weekIndex, getCurrentWeekIndex(ranges, reportEndDate)), 1, ranges.length);
    const selected = ranges[weekIndex - 1] || ranges[0];
    const from = selected.from;
    const to = minDate(selected.to, reportEndDate);

    return {
      label: `${selected.label} (${formatMonthDayRange(from, to)})`,
      from,
      to
    };
  }

  if (mode === 'month') {
    const year = parseIntOr(options.year, reportEndDate.getFullYear());
    const month = parseIntOr(options.month, reportEndDate.getMonth() + 1);
    const from = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const to = minDate(monthEnd, reportEndDate);
    const isClamped = to.getTime() < monthEnd.getTime();

    return {
      label: isClamped
        ? `${year}년 ${month}월 (${formatMonthDayRange(from, to)})`
        : `${year}년 ${month}월`,
      from,
      to
    };
  }

  if (mode === 'custom') {
    const from = parseDashboardDate(options.from, reportEndDate) || reportEndDate;
    const rawTo = parseDashboardDate(options.to, reportEndDate) || from;
    const to = minDate(rawTo, reportEndDate);

    return {
      label: `${formatDateForLabel(from)} ~ ${formatDateForLabel(to)}`,
      from,
      to
    };
  }

  const days = RECENT_DAYS.has(Number(options.days)) ? Number(options.days) : 7;
  const to = normalizeDate(reportEndDate);
  const from = addDays(to, -(days - 1));

  return {
    label: days === 1 ? '어제' : `최근 ${days}일`,
    from,
    to
  };
}

function excludeTodayRows(rows, today) {
  return rows.filter(row => row.basisDate.getTime() < today.getTime());
}

function filterRowsForPeriod(rows, period) {
  if (!period.from || !period.to) return rows;

  return rows.filter(row => isBetween(row.basisDate, period.from, period.to));
}

function buildTotals(rows) {
  const customerMap = new Map();
  const productMap = new Map();
  let quantity = 0;
  let orderCount = 0;
  let revenue = 0;

  rows.forEach(row => {
    quantity += row.quantity;
    orderCount += 1;
    revenue += row.revenue;
    addCustomerTotal(customerMap, row);
    addProductTotal(productMap, row);
  });

  const customers = Array.from(customerMap.values())
    .map(finalizeCustomerTotal)
    .sort(sortByMetric('quantity'))
    .map(withRank);
  const products = Array.from(productMap.values())
    .map(finalizeProductTotal)
    .sort(sortByMetric('quantity'))
    .map(withRank);

  return {
    quantity,
    orderCount,
    revenue,
    averageOrderValue: orderCount ? Math.round(revenue / orderCount) : 0,
    customerCount: customerMap.size,
    productCount: productMap.size,
    customers,
    products
  };
}

function addCustomerTotal(map, row) {
  if (!row.customerName) return;

  const key = row.customerName;
  const current = map.get(key) || {
    customerName: key,
    quantity: 0,
    orderCount: 0,
    revenue: 0,
    firstOrderDate: row.basisDate,
    lastOrderDate: row.basisDate,
    productQuantities: new Map(),
    productNames: new Set(),
    rows: []
  };

  current.quantity += row.quantity;
  current.orderCount += 1;
  current.revenue += row.revenue;
  current.firstOrderDate = minDate(current.firstOrderDate, row.basisDate);
  current.lastOrderDate = maxDate(current.lastOrderDate, row.basisDate);
  current.productNames.add(row.productName);
  current.productQuantities.set(
    row.productName,
    (current.productQuantities.get(row.productName) || 0) + row.quantity
  );
  current.rows.push(row);
  map.set(key, current);
}

function addProductTotal(map, row) {
  const key = row.productName || '상품명 없음';
  const current = map.get(key) || {
    productName: key,
    imageUrl: row.imageUrl || '',
    quantity: 0,
    orderCount: 0,
    revenue: 0,
    firstOrderDate: row.basisDate,
    lastOrderDate: row.basisDate,
    customerNames: new Set()
  };

  if (!current.imageUrl && row.imageUrl) current.imageUrl = row.imageUrl;
  current.quantity += row.quantity;
  current.orderCount += 1;
  current.revenue += row.revenue;
  current.firstOrderDate = minDate(current.firstOrderDate, row.basisDate);
  current.lastOrderDate = maxDate(current.lastOrderDate, row.basisDate);
  if (row.customerName) current.customerNames.add(row.customerName);
  map.set(key, current);
}

function finalizeCustomerTotal(item) {
  const topProduct = Array.from(item.productQuantities.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))[0]?.[0] || '';

  return {
    customerName: item.customerName,
    quantity: item.quantity,
    orderCount: item.orderCount,
    revenue: item.revenue,
    averageOrderValue: item.orderCount ? Math.round(item.revenue / item.orderCount) : 0,
    firstOrderDate: toDateKey(item.firstOrderDate),
    lastOrderDate: toDateKey(item.lastOrderDate),
    topProduct,
    productTypeCount: item.productNames.size
  };
}

function finalizeProductTotal(item) {
  return {
    productName: item.productName,
    imageUrl: item.imageUrl,
    quantity: item.quantity,
    orderCount: item.orderCount,
    revenue: item.revenue,
    customerCount: item.customerNames.size,
    firstOrderDate: toDateKey(item.firstOrderDate),
    lastOrderDate: toDateKey(item.lastOrderDate)
  };
}

function buildCustomerDetail(rows, customerName) {
  const normalizedTarget = normalizeSearchText(customerName);
  const customerRows = rows.filter(row =>
    normalizeSearchText(row.customerName) === normalizedTarget ||
    normalizeSearchText(row.customerName).includes(normalizedTarget)
  );

  if (!customerRows.length) return null;

  const totals = buildTotals(customerRows);
  const customer = totals.customers[0];
  const topProducts = rankProducts(customerRows, 'quantity').slice(0, 5);
  const recentOrders = [...customerRows]
    .sort((a, b) => b.basisDate.getTime() - a.basisDate.getTime())
    .slice(0, 10)
    .map(row => ({
      date: toDateKey(row.basisDate),
      productName: row.productName,
      quantity: row.quantity,
      revenue: row.revenue,
      price: row.price,
      imageUrl: row.imageUrl
    }));

  return {
    ...customer,
    topProducts,
    recentOrders,
    monthlySeries: buildMonthlySeries(customerRows)
  };
}

function rankCustomers(rows, metric) {
  return buildTotals(rows).customers
    .sort(sortByMetric(metric))
    .slice(0, 10)
    .map(withRank);
}

function rankProducts(rows, metric) {
  return buildTotals(rows).products
    .sort(sortByMetric(metric))
    .slice(0, 10)
    .map(withRank);
}

function buildDailySeries(rows, fromDate, toDate) {
  const grouped = new Map();

  rows.forEach(row => addToSeriesMap(grouped, toDateKey(row.basisDate), row));

  const series = [];
  let current = normalizeDate(fromDate);

  while (current.getTime() <= toDate.getTime()) {
    const key = toDateKey(current);
    series.push({
      date: key,
      ...(grouped.get(key) || emptySeriesPoint())
    });
    current = addDays(current, 1);
  }

  return series;
}

function buildMonthlySeries(rows) {
  const grouped = new Map();

  rows.forEach(row => addToSeriesMap(grouped, toMonthKey(row.basisDate), row));

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, totals]) => ({
      month,
      ...totals
    }));
}

function addToSeriesMap(map, key, row) {
  const current = map.get(key) || emptySeriesPoint();
  current.quantity += row.quantity;
  current.orderCount += 1;
  current.revenue += row.revenue;
  map.set(key, current);
}

function emptySeriesPoint() {
  return {
    quantity: 0,
    orderCount: 0,
    revenue: 0
  };
}

function buildOptions(rows, today) {
  const monthMap = new Map();

  rows.forEach(row => {
    const key = toMonthKey(row.basisDate);
    if (!monthMap.has(key)) {
      monthMap.set(key, {
        year: row.basisDate.getFullYear(),
        month: row.basisDate.getMonth() + 1,
        label: `${row.basisDate.getMonth() + 1}월`
      });
    }
  });

  const months = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
  const currentYear = today.getFullYear();

  return {
    recentDays: [1, 3, 7, 14, 30],
    years: Array.from(new Set(months.map(item => item.year))),
    months,
    currentYear,
    currentMonth: today.getMonth() + 1
  };
}

function searchCustomers(customers, query) {
  const normalizedQuery = normalizeSearchText(query);
  const digits = String(query || '').replace(/\D/g, '');

  if (!normalizedQuery && !digits) return [];

  return customers.filter(customer => {
    const name = customer.customerName || '';
    const normalizedName = normalizeSearchText(name);
    const customerDigits = name.replace(/\D/g, '');

    if (normalizedName.includes(normalizedQuery)) return true;
    if (digits && customerDigits.endsWith(digits.slice(-4))) return true;

    return false;
  });
}

function sortByMetric(metric) {
  return (a, b) => {
    if ((b[metric] || 0) !== (a[metric] || 0)) return (b[metric] || 0) - (a[metric] || 0);
    if ((b.revenue || 0) !== (a.revenue || 0)) return (b.revenue || 0) - (a.revenue || 0);
    if ((b.quantity || 0) !== (a.quantity || 0)) return (b.quantity || 0) - (a.quantity || 0);

    return String(a.customerName || a.productName || '').localeCompare(
      String(b.customerName || b.productName || ''),
      'ko'
    );
  };
}

function withRank(item, index) {
  return {
    rank: index + 1,
    ...item
  };
}

function getCurrentWeekIndex(ranges, today) {
  const index = ranges.findIndex(range => isBetween(today, range.from, range.to));
  return index >= 0 ? index + 1 : 1;
}

function getFirstBasisDate(rows) {
  return rows.reduce((first, row) => {
    if (!first || row.basisDate.getTime() < first.getTime()) return row.basisDate;
    return first;
  }, null);
}

function getLastBasisDate(rows) {
  return rows.reduce((last, row) => {
    if (!last || row.basisDate.getTime() > last.getTime()) return row.basisDate;
    return last;
  }, null);
}

function isBetween(date, fromDate, toDate) {
  return date.getTime() >= fromDate.getTime() && date.getTime() <= toDate.getTime();
}

function addDays(date, days) {
  const result = normalizeDate(date);
  result.setDate(result.getDate() + days);

  return result;
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? normalizeDate(a) : normalizeDate(b);
}

function minDate(a, b) {
  return a.getTime() <= b.getTime() ? normalizeDate(a) : normalizeDate(b);
}

function toMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function formatDateForLabel(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function formatMonthDayRange(from, to) {
  return `${from.getMonth() + 1}.${from.getDate()} ~ ${to.getMonth() + 1}.${to.getDate()}`;
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSearchText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
