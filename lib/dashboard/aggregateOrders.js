import { getSeoulToday, parseDashboardDate, toDateKey } from './parseOrders.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function aggregateDashboardRows(rows, options = {}) {
  const today = options.today || getSeoulToday();
  const fromDate = options.from ? parseDashboardDate(options.from, today) : null;
  const toDate = options.to ? parseDashboardDate(options.to, today) : null;
  const filteredRows = filterRowsByRange(rows, fromDate, toDate);
  const rankingAnchor = getLatestBasisDate(filteredRows) || toDate || today;

  return {
    summary: buildSummary(rows, today),
    series: {
      daily: buildDailySeries(filteredRows, fromDate, toDate),
      weekly: buildWeeklySeries(filteredRows),
      monthly: buildMonthlySeries(filteredRows)
    },
    rankings: {
      customers: buildCustomerRankings(filteredRows, rankingAnchor),
      products: buildProductRankings(filteredRows, rankingAnchor)
    },
    meta: {
      from: fromDate ? toDateKey(fromDate) : null,
      to: toDate ? toDateKey(toDate) : null,
      rankingAnchor: toDateKey(rankingAnchor),
      today: toDateKey(today),
      rowCount: filteredRows.length
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

function buildSummary(rows, today) {
  const yesterday = addDays(today, -1);
  const thisWeekStart = startOfWeekMonday(today);
  const thisWeekEnd = endOfWeekSunday(today);
  const previousWeekStart = addDays(thisWeekStart, -7);
  const previousWeekEnd = addDays(thisWeekEnd, -7);

  const todayTotals = sumRows(rows.filter(row => isSameDay(row.basisDate, today)));
  const yesterdayTotals = sumRows(rows.filter(row => isSameDay(row.basisDate, yesterday)));
  const weekTotals = sumRows(rows.filter(row => isBetween(row.basisDate, thisWeekStart, thisWeekEnd)));
  const previousWeekTotals = sumRows(
    rows.filter(row => isBetween(row.basisDate, previousWeekStart, previousWeekEnd))
  );

  return {
    today: {
      ...todayTotals,
      quantityChangeRate: changeRate(todayTotals.quantity, yesterdayTotals.quantity),
      revenueChangeRate: changeRate(todayTotals.revenue, yesterdayTotals.revenue)
    },
    week: {
      ...weekTotals,
      quantityChangeRate: changeRate(weekTotals.quantity, previousWeekTotals.quantity),
      revenueChangeRate: changeRate(weekTotals.revenue, previousWeekTotals.revenue)
    }
  };
}

function buildDailySeries(rows, fromDate, toDate) {
  const grouped = new Map();

  rows.forEach(row => {
    addToTotalsMap(grouped, toDateKey(row.basisDate), row);
  });

  if (!fromDate || !toDate) {
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({ date, ...totals }));
  }

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

function buildWeeklySeries(rows) {
  const grouped = new Map();

  rows.forEach(row => {
    const weekStart = startOfWeekMonday(row.basisDate);
    const key = toDateKey(weekStart);
    addToTotalsMap(grouped, key, row);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, totals]) => ({
      weekStart,
      weekLabel: formatWeekLabel(new Date(`${weekStart}T00:00:00`)),
      ...totals
    }));
}

function buildMonthlySeries(rows) {
  const grouped = new Map();

  rows.forEach(row => {
    const key = `${row.basisDate.getFullYear()}-${String(row.basisDate.getMonth() + 1).padStart(2, '0')}`;
    addToTotalsMap(grouped, key, row);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, totals]) => ({ month, ...totals }));
}

function buildCustomerRankings(rows, anchorDate) {
  return {
    dailyByQuantity: rankCustomers(rowsForDay(rows, anchorDate), 'quantity'),
    dailyByRevenue: rankCustomers(rowsForDay(rows, anchorDate), 'revenue'),
    weeklyByQuantity: rankCustomers(rowsForWeek(rows, anchorDate), 'quantity'),
    weeklyByRevenue: rankCustomers(rowsForWeek(rows, anchorDate), 'revenue'),
    monthlyByQuantity: rankCustomers(rowsForMonth(rows, anchorDate), 'quantity'),
    monthlyByRevenue: rankCustomers(rowsForMonth(rows, anchorDate), 'revenue')
  };
}

function buildProductRankings(rows, anchorDate) {
  return {
    dailyByQuantity: rankProducts(rowsForDay(rows, anchorDate), 'quantity'),
    dailyByRevenue: rankProducts(rowsForDay(rows, anchorDate), 'revenue'),
    weeklyByQuantity: rankProducts(rowsForWeek(rows, anchorDate), 'quantity'),
    weeklyByRevenue: rankProducts(rowsForWeek(rows, anchorDate), 'revenue'),
    monthlyByQuantity: rankProducts(rowsForMonth(rows, anchorDate), 'quantity'),
    monthlyByRevenue: rankProducts(rowsForMonth(rows, anchorDate), 'revenue')
  };
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

function rowsForDay(rows, date) {
  return rows.filter(row => isSameDay(row.basisDate, date));
}

function rowsForWeek(rows, date) {
  return rows.filter(row => isBetween(row.basisDate, startOfWeekMonday(date), endOfWeekSunday(date)));
}

function rowsForMonth(rows, date) {
  return rows.filter(
    row =>
      row.basisDate.getFullYear() === date.getFullYear() &&
      row.basisDate.getMonth() === date.getMonth()
  );
}

function filterRowsByRange(rows, fromDate, toDate) {
  return rows.filter(row => {
    if (!row.basisDate) return false;
    if (fromDate && row.basisDate.getTime() < fromDate.getTime()) return false;
    if (toDate && row.basisDate.getTime() > toDate.getTime()) return false;

    return true;
  });
}

function getLatestBasisDate(rows) {
  return rows.reduce((latest, row) => {
    if (!latest || row.basisDate.getTime() > latest.getTime()) return row.basisDate;
    return latest;
  }, null);
}

function addToTotalsMap(map, key, row) {
  const current = map.get(key) || emptyTotals();
  current.quantity += row.quantity;
  current.orderCount += 1;
  current.revenue += row.revenue;
  map.set(key, current);
}

function sumRows(rows) {
  return rows.reduce((acc, row) => {
    acc.quantity += row.quantity;
    acc.orderCount += 1;
    acc.revenue += row.revenue;
    return acc;
  }, emptyTotals());
}

function emptyTotals() {
  return {
    quantity: 0,
    orderCount: 0,
    revenue: 0
  };
}

function changeRate(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function isBetween(date, fromDate, toDate) {
  return date.getTime() >= fromDate.getTime() && date.getTime() <= toDate.getTime();
}

function isSameDay(a, b) {
  return toDateKey(a) === toDateKey(b);
}

function addDays(date, days) {
  const result = normalizeDate(date);
  result.setDate(result.getDate() + days);

  return result;
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatWeekLabel(weekStart) {
  const month = weekStart.getMonth() + 1;
  const firstDay = new Date(weekStart.getFullYear(), weekStart.getMonth(), 1);
  const firstWeekStart = startOfWeekMonday(firstDay);
  const weekNumber = Math.floor((weekStart.getTime() - firstWeekStart.getTime()) / (DAY_MS * 7)) + 1;

  return `${month}월 ${weekNumber}주차`;
}
