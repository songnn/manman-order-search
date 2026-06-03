import { getSeoulToday, parseDashboardDate, toDateKey } from './parseOrders.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = new Set(['daily', 'weekly', 'monthly']);

export function aggregateDashboardRows(rows, options = {}) {
  const today = options.today || getSeoulToday();
  const period = PERIODS.has(options.period) ? options.period : 'daily';
  const anchorDate = parseDashboardDate(options.anchor || options.to, today) || today;
  const currentPeriod = getPeriodRange(anchorDate, period);
  const previousPeriod = getPreviousPeriodRange(currentPeriod, period);
  const trendPeriod = getTrendPeriodRange(anchorDate, period);
  const currentRows = filterRowsByRange(rows, currentPeriod.from, currentPeriod.to);
  const previousRows = filterRowsByRange(rows, previousPeriod.from, previousPeriod.to);
  const trendRows = filterRowsByRange(rows, trendPeriod.from, trendPeriod.to);
  const currentTotals = sumRows(currentRows);
  const previousTotals = sumRows(previousRows);
  const activeSeries = buildSeries(trendRows, trendPeriod.from, trendPeriod.to, period);

  return {
    summary: {
      current: {
        ...currentTotals,
        quantityChangeRate: changeRate(currentTotals.quantity, previousTotals.quantity),
        orderCountChangeRate: changeRate(currentTotals.orderCount, previousTotals.orderCount),
        revenueChangeRate: changeRate(currentTotals.revenue, previousTotals.revenue),
        averageOrderValueChangeRate: changeRate(
          currentTotals.averageOrderValue,
          previousTotals.averageOrderValue
        )
      },
      previous: previousTotals
    },
    series: {
      active: activeSeries,
      daily: period === 'daily' ? activeSeries : [],
      weekly: period === 'weekly' ? activeSeries : [],
      monthly: period === 'monthly' ? activeSeries : []
    },
    rankings: {
      customers: {
        byQuantity: rankCustomers(currentRows, 'quantity'),
        byRevenue: rankCustomers(currentRows, 'revenue')
      },
      products: {
        byQuantity: rankProducts(currentRows, 'quantity'),
        byRevenue: rankProducts(currentRows, 'revenue')
      }
    },
    meta: {
      period,
      anchorDate: toDateKey(anchorDate),
      currentPeriod: {
        from: toDateKey(currentPeriod.from),
        to: toDateKey(currentPeriod.to),
        label: formatPeriodLabel(currentPeriod, period)
      },
      previousPeriod: {
        from: toDateKey(previousPeriod.from),
        to: toDateKey(previousPeriod.to),
        label: formatPeriodLabel(previousPeriod, period)
      },
      trendPeriod: {
        from: toDateKey(trendPeriod.from),
        to: toDateKey(trendPeriod.to)
      },
      comparisonLabel: getComparisonLabel(period),
      today: toDateKey(today),
      rowCount: currentRows.length
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

export function getPeriodRange(anchorDate, period) {
  const anchor = normalizeDate(anchorDate);

  if (period === 'weekly') {
    return {
      from: startOfWeekMonday(anchor),
      to: endOfWeekSunday(anchor)
    };
  }

  if (period === 'monthly') {
    return {
      from: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
      to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
    };
  }

  return {
    from: anchor,
    to: anchor
  };
}

function getPreviousPeriodRange(currentPeriod, period) {
  if (period === 'weekly') {
    return {
      from: addDays(currentPeriod.from, -7),
      to: addDays(currentPeriod.to, -7)
    };
  }

  if (period === 'monthly') {
    const previousMonth = new Date(
      currentPeriod.from.getFullYear(),
      currentPeriod.from.getMonth() - 1,
      1
    );

    return {
      from: previousMonth,
      to: new Date(previousMonth.getFullYear(), previousMonth.getMonth() + 1, 0)
    };
  }

  return {
    from: addDays(currentPeriod.from, -1),
    to: addDays(currentPeriod.to, -1)
  };
}

function getTrendPeriodRange(anchorDate, period) {
  const current = getPeriodRange(anchorDate, period);

  if (period === 'weekly') {
    return {
      from: addDays(current.from, -11 * 7),
      to: current.to
    };
  }

  if (period === 'monthly') {
    return {
      from: new Date(current.from.getFullYear(), current.from.getMonth() - 11, 1),
      to: current.to
    };
  }

  return {
    from: addDays(current.from, -29),
    to: current.to
  };
}

function buildSeries(rows, fromDate, toDate, period) {
  if (period === 'weekly') return buildWeeklySeries(rows, fromDate, toDate);
  if (period === 'monthly') return buildMonthlySeries(rows, fromDate, toDate);
  return buildDailySeries(rows, fromDate, toDate);
}

function buildDailySeries(rows, fromDate, toDate) {
  const grouped = new Map();

  rows.forEach(row => {
    addToTotalsMap(grouped, toDateKey(row.basisDate), row);
  });

  const series = [];
  let current = normalizeDate(fromDate);

  while (current.getTime() <= toDate.getTime()) {
    const key = toDateKey(current);
    series.push({
      date: key,
      ...(grouped.get(key) || emptyTotals())
    });
    current = addDays(current, 1);
  }

  return series;
}

function buildWeeklySeries(rows, fromDate, toDate) {
  const grouped = new Map();

  rows.forEach(row => {
    const weekStart = startOfWeekMonday(row.basisDate);
    addToTotalsMap(grouped, toDateKey(weekStart), row);
  });

  const series = [];
  let current = startOfWeekMonday(fromDate);
  const end = startOfWeekMonday(toDate);

  while (current.getTime() <= end.getTime()) {
    const key = toDateKey(current);
    series.push({
      weekStart: key,
      weekLabel: formatWeekLabel(current),
      ...(grouped.get(key) || emptyTotals())
    });
    current = addDays(current, 7);
  }

  return series;
}

function buildMonthlySeries(rows, fromDate, toDate) {
  const grouped = new Map();

  rows.forEach(row => {
    addToTotalsMap(grouped, toMonthKey(row.basisDate), row);
  });

  const series = [];
  let current = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  const end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);

  while (current.getTime() <= end.getTime()) {
    const key = toMonthKey(current);
    series.push({
      month: key,
      ...(grouped.get(key) || emptyTotals())
    });
    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }

  return series;
}

function rankCustomers(rows, metric) {
  const grouped = new Map();

  rows.forEach(row => {
    const key = row.customerName || '이름 없음';
    const current = grouped.get(key) || {
      customerName: key,
      quantity: 0,
      orderCount: 0,
      revenue: 0
    };

    current.quantity += row.quantity;
    current.orderCount += 1;
    current.revenue += row.revenue;
    grouped.set(key, current);
  });

  return sortAndRank(grouped, metric).map(item => ({
    ...item,
    averageOrderValue: item.orderCount ? Math.round(item.revenue / item.orderCount) : 0
  }));
}

function rankProducts(rows, metric) {
  const grouped = new Map();

  rows.forEach(row => {
    const key = row.productName || '상품명 없음';
    const current = grouped.get(key) || {
      productName: key,
      imageUrl: row.imageUrl || '',
      quantity: 0,
      orderCount: 0,
      revenue: 0,
      price: row.price,
      customerNames: new Set()
    };

    if (!current.imageUrl && row.imageUrl) current.imageUrl = row.imageUrl;
    current.quantity += row.quantity;
    current.orderCount += 1;
    current.revenue += row.revenue;
    current.price = current.price || row.price;
    if (row.customerName) current.customerNames.add(row.customerName);
    grouped.set(key, current);
  });

  return sortAndRank(grouped, metric).map(item => ({
    rank: item.rank,
    productName: item.productName,
    imageUrl: item.imageUrl,
    quantity: item.quantity,
    orderCount: item.orderCount,
    revenue: item.revenue,
    price: item.price,
    customerCount: item.customerNames.size
  }));
}

function sortAndRank(grouped, metric) {
  return Array.from(grouped.values())
    .sort((a, b) => {
      if (b[metric] !== a[metric]) return b[metric] - a[metric];
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      if (b.quantity !== a.quantity) return b.quantity - a.quantity;
      return String(a.customerName || a.productName || '').localeCompare(
        String(b.customerName || b.productName || ''),
        'ko'
      );
    })
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item
    }));
}

function filterRowsByRange(rows, fromDate, toDate) {
  return rows.filter(row => {
    if (!row.basisDate) return false;
    if (row.basisDate.getTime() < fromDate.getTime()) return false;
    if (row.basisDate.getTime() > toDate.getTime()) return false;

    return true;
  });
}

function addToTotalsMap(map, key, row) {
  const current = map.get(key) || emptyTotals();
  current.quantity += row.quantity;
  current.orderCount += 1;
  current.revenue += row.revenue;
  current.averageOrderValue = current.orderCount
    ? Math.round(current.revenue / current.orderCount)
    : 0;
  map.set(key, current);
}

function sumRows(rows) {
  const totals = rows.reduce((acc, row) => {
    acc.quantity += row.quantity;
    acc.orderCount += 1;
    acc.revenue += row.revenue;
    return acc;
  }, emptyTotals());

  totals.averageOrderValue = totals.orderCount
    ? Math.round(totals.revenue / totals.orderCount)
    : 0;

  return totals;
}

function emptyTotals() {
  return {
    quantity: 0,
    orderCount: 0,
    revenue: 0,
    averageOrderValue: 0
  };
}

function changeRate(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function addDays(date, days) {
  const result = normalizeDate(date);
  result.setDate(result.getDate() + days);

  return result;
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function toMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getComparisonLabel(period) {
  if (period === 'weekly') return '전주';
  if (period === 'monthly') return '전월';
  return '전일';
}

function formatPeriodLabel(periodRange, period) {
  if (period === 'weekly') {
    return `${formatFullKoreanDate(periodRange.from)} ~ ${formatFullKoreanDate(periodRange.to)}`;
  }

  if (period === 'monthly') {
    return `${periodRange.from.getFullYear()}년 ${periodRange.from.getMonth() + 1}월`;
  }

  return formatFullKoreanDate(periodRange.from);
}

function formatFullKoreanDate(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${getWeekdayName(date)}`;
}

function getWeekdayName(date) {
  return ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][date.getDay()];
}

function formatWeekLabel(weekStart) {
  const month = weekStart.getMonth() + 1;
  const firstDay = new Date(weekStart.getFullYear(), weekStart.getMonth(), 1);
  const firstWeekStart = startOfWeekMonday(firstDay);
  const weekNumber = Math.floor((weekStart.getTime() - firstWeekStart.getTime()) / (DAY_MS * 7)) + 1;

  return `${month}월 ${weekNumber}주차`;
}
