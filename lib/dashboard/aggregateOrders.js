import { getSeoulToday, parseDashboardDate, toDateKey } from './parseOrders.js';

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
  const growthBundle = buildGrowthBundle(growthRows, period, {
    mode,
    reportEndDate
  });
  const kakaoRoomMetrics = buildKakaoRoomMetrics(growthRows, reportEndDate);
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
    growthAnalysis: growthBundle.growthAnalysis,
    participationFrequency: growthBundle.participationFrequency,
    customerMovement: growthBundle.customerMovement,
    lifecycle: growthBundle.lifecycle,
    kakaoRoomMetrics,
    dataQuality: {
      basisForGrowth: 'groupDate',
      totalValidRows: rows.length,
      includedOrderRows: analysisRows.length,
      includedGrowthRows: growthRows.length,
      excludedTodayRows: rows.length - analysisRows.length,
      excludedGrowthRows: rows.length - growthRows.length
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

function getGrowthRows(rows, today) {
  return rows.filter(row =>
    row.groupDate &&
    row.groupDate.getTime() < today.getTime() &&
    getCustomerKey(row.customerName)
  );
}

function buildGrowthBundle(rows, selectedPeriod, options) {
  const currentPeriod = normalizePeriodForGrowth(selectedPeriod, rows);
  const empty = buildEmptyGrowthBundle(currentPeriod);

  if (!isValidPeriod(currentPeriod)) return empty;

  const reportEndDate = options.reportEndDate;
  const isInProgress = isPeriodInProgress(currentPeriod, options.mode, reportEndDate);
  const previousPeriod = getComparablePeriod(currentPeriod, {
    mode: options.mode,
    offset: -1,
    isInProgress
  });
  const current = summarizeParticipation(rows, currentPeriod);
  const previous = summarizeParticipation(rows, previousPeriod);
  const profiles = buildCustomerProfiles(rows, currentPeriod, previousPeriod);
  const lifecycle = classifyCustomerLifecycle(profiles, currentPeriod, previousPeriod);
  const fourPeriodAverage = buildFourPeriodAverage(rows, currentPeriod, {
    mode: options.mode,
    isInProgress
  });
  const changes = buildGrowthChanges(current, previous);
  const growthAnalysis = {
    basis: 'groupDate',
    basisLabel: '공구일자 기준',
    currentPeriod: serializePeriod(currentPeriod),
    previousPeriod: serializePeriod(previousPeriod),
    isInProgress,
    current: {
      ...current,
      newCustomerCount: lifecycle.newCustomers.length,
      returningCustomerCount: lifecycle.returningCustomers.length
    },
    previous,
    fourPeriodAverage,
    changes,
    diagnosis: buildGrowthDiagnosis(current, previous, changes)
  };

  return {
    growthAnalysis,
    participationFrequency: {
      weekly: buildWeeklyFrequency(rows, reportEndDate),
      monthly: buildMonthlyFrequency(rows, reportEndDate)
    },
    customerMovement: buildCustomerMovement(profiles, currentPeriod, previousPeriod),
    lifecycle
  };
}

function buildEmptyGrowthBundle(period) {
  const emptySummary = emptyParticipationSummary(period);

  return {
    growthAnalysis: {
      basis: 'groupDate',
      basisLabel: '공구일자 기준',
      currentPeriod: serializePeriod(period),
      previousPeriod: null,
      isInProgress: false,
      current: emptySummary,
      previous: emptySummary,
      fourPeriodAverage: emptySummary,
      changes: {
        revenueRate: null,
        customerRate: null,
        frequencyRate: null,
        valueRate: null,
        dominantDriver: null
      },
      diagnosis: '비교 가능한 이전 데이터가 부족합니다.'
    },
    participationFrequency: {
      weekly: [],
      monthly: []
    },
    customerMovement: {
      currentPeriod: serializePeriod(period),
      previousPeriod: null,
      populationCount: 0,
      matrix: [],
      metrics: emptyMovementMetrics()
    },
    lifecycle: emptyLifecycle()
  };
}

function summarizeParticipation(rows, period) {
  if (!isValidPeriod(period)) return emptyParticipationSummary(period);

  const customerMap = new Map();
  let quantity = 0;
  let orderLineCount = 0;
  let revenue = 0;

  rows.forEach(row => {
    if (!row.groupDate || !isBetween(row.groupDate, period.from, period.to)) return;

    const customerKey = getCustomerKey(row.customerName);
    if (!customerKey) return;

    quantity += row.quantity;
    orderLineCount += 1;
    revenue += row.revenue;

    const current = customerMap.get(customerKey) || {
      customerName: customerKey,
      dates: new Set(),
      quantity: 0,
      orderLineCount: 0,
      revenue: 0
    };

    current.dates.add(toDateKey(row.groupDate));
    current.quantity += row.quantity;
    current.orderLineCount += 1;
    current.revenue += row.revenue;
    customerMap.set(customerKey, current);
  });

  const customers = Array.from(customerMap.values()).map(customer => ({
    customerName: customer.customerName,
    participationDays: customer.dates.size,
    quantity: customer.quantity,
    orderLineCount: customer.orderLineCount,
    revenue: customer.revenue
  }));
  const activeCustomers = customers.length;
  const totalParticipationDays = customers.reduce((sum, customer) => sum + customer.participationDays, 0);
  const twoPlusCustomerCount = customers.filter(customer => customer.participationDays >= 2).length;

  return {
    period: serializePeriod(period),
    revenue,
    activeCustomers,
    totalParticipationDays,
    avgParticipationDays: divide(totalParticipationDays, activeCustomers),
    revenuePerActiveCustomer: divide(revenue, activeCustomers),
    revenuePerParticipationDay: divide(revenue, totalParticipationDays),
    twoPlusCustomerCount,
    twoPlusRate: percent(twoPlusCustomerCount, activeCustomers),
    quantity,
    orderLineCount
  };
}

function emptyParticipationSummary(period) {
  return {
    period: serializePeriod(period),
    revenue: 0,
    activeCustomers: 0,
    totalParticipationDays: 0,
    avgParticipationDays: 0,
    revenuePerActiveCustomer: 0,
    revenuePerParticipationDay: 0,
    twoPlusCustomerCount: 0,
    twoPlusRate: 0,
    quantity: 0,
    orderLineCount: 0
  };
}

function buildGrowthChanges(current, previous) {
  const revenueRate = changeRate(current.revenue, previous.revenue);
  const customerRate = changeRate(current.activeCustomers, previous.activeCustomers);
  const frequencyRate = changeRate(current.avgParticipationDays, previous.avgParticipationDays);
  const valueRate = changeRate(current.revenuePerParticipationDay, previous.revenuePerParticipationDay);
  const candidates = [
    { key: 'customer', label: '구매 고객 수', rate: customerRate },
    { key: 'frequency', label: '고객당 참여일수', rate: frequencyRate },
    { key: 'value', label: '참여 1일당 주문금액', rate: valueRate }
  ].filter(item => item.rate !== null);
  const dominantDriver = candidates.length
    ? candidates.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))[0]
    : null;

  return {
    revenueRate,
    customerRate,
    frequencyRate,
    valueRate,
    dominantDriver
  };
}

function buildGrowthDiagnosis(current, previous, changes) {
  if (!previous.activeCustomers || !previous.totalParticipationDays || changes.revenueRate === null) {
    return '비교 가능한 이전 데이터가 부족합니다.';
  }

  const direction = changes.revenueRate > 0 ? '증가' : changes.revenueRate < 0 ? '감소' : '유지';
  const driver = changes.dominantDriver;
  const driverSentence = driver
    ? `${driver.label} 변화가 가장 크게 나타났습니다.`
    : '주요 변화 요인이 뚜렷하지 않습니다.';

  return [
    `이번 기간 공구매출은 직전 기간보다 ${Math.abs(changes.revenueRate).toFixed(1)}% ${direction}했습니다.`,
    `구매 고객 수는 ${previous.activeCustomers}명에서 ${current.activeCustomers}명, 고객당 참여일수는 ${previous.avgParticipationDays.toFixed(1)}일에서 ${current.avgParticipationDays.toFixed(1)}일로 움직였습니다.`,
    driverSentence
  ].join(' ');
}

function buildFourPeriodAverage(rows, currentPeriod, options) {
  const summaries = [1, 2, 3, 4].map(index =>
    summarizeParticipation(
      rows,
      getComparablePeriod(currentPeriod, {
        mode: options.mode,
        offset: -index,
        isInProgress: options.isInProgress
      })
    )
  );
  const count = summaries.length || 1;

  return {
    periods: summaries.map(summary => summary.period),
    revenue: Math.round(summaries.reduce((sum, item) => sum + item.revenue, 0) / count),
    activeCustomers: round1(summaries.reduce((sum, item) => sum + item.activeCustomers, 0) / count),
    totalParticipationDays: round1(summaries.reduce((sum, item) => sum + item.totalParticipationDays, 0) / count),
    avgParticipationDays: round2(summaries.reduce((sum, item) => sum + item.avgParticipationDays, 0) / count),
    revenuePerActiveCustomer: Math.round(summaries.reduce((sum, item) => sum + item.revenuePerActiveCustomer, 0) / count),
    revenuePerParticipationDay: Math.round(summaries.reduce((sum, item) => sum + item.revenuePerParticipationDay, 0) / count),
    twoPlusCustomerCount: round1(summaries.reduce((sum, item) => sum + item.twoPlusCustomerCount, 0) / count),
    twoPlusRate: round2(summaries.reduce((sum, item) => sum + item.twoPlusRate, 0) / count),
    quantity: round1(summaries.reduce((sum, item) => sum + item.quantity, 0) / count),
    orderLineCount: round1(summaries.reduce((sum, item) => sum + item.orderLineCount, 0) / count)
  };
}

function buildWeeklyFrequency(rows, reportEndDate) {
  if (!reportEndDate) return [];

  const finalWeekStart = startOfWeekMonday(reportEndDate);
  return Array.from({ length: 12 }, (_, index) => {
    const from = addDays(finalWeekStart, -7 * (11 - index));
    const naturalTo = addDays(from, 6);
    const to = minDate(naturalTo, reportEndDate);

    return buildFrequencyPeriod(rows, { from, to }, {
      type: 'weekly',
      isInProgress: to.getTime() < naturalTo.getTime(),
      buckets: [
        ['one', '1일', days => days === 1],
        ['two', '2일', days => days === 2],
        ['three', '3일', days => days === 3],
        ['four', '4일', days => days === 4],
        ['five', '5일', days => days === 5],
        ['six', '6일', days => days === 6],
        ['seven', '7일', days => days >= 7]
      ]
    });
  });
}

function buildKakaoRoomMetrics(rows, reportEndDate) {
  if (!reportEndDate) {
    return {
      recent30Period: null,
      recent30ActiveCustomers: 0,
      recent30Revenue: 0,
      recent30ParticipationDays: 0
    };
  }

  const period = {
    label: '최근 30일',
    from: addDays(reportEndDate, -29),
    to: reportEndDate
  };
  const summary = summarizeParticipation(rows, period);

  return {
    recent30Period: summary.period,
    recent30ActiveCustomers: summary.activeCustomers,
    recent30Revenue: summary.revenue,
    recent30ParticipationDays: summary.totalParticipationDays
  };
}

function buildMonthlyFrequency(rows, reportEndDate) {
  if (!reportEndDate) return [];

  const firstDate = getFirstGroupDate(rows);
  const periods = [];

  for (let offset = 5; offset >= 0; offset -= 1) {
    const from = new Date(reportEndDate.getFullYear(), reportEndDate.getMonth() - offset, 1);
    const naturalTo = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    const to = minDate(naturalTo, reportEndDate);
    if (firstDate && to.getTime() < new Date(firstDate.getFullYear(), firstDate.getMonth(), 1).getTime()) continue;

    periods.push(buildFrequencyPeriod(rows, { from, to }, {
      type: 'monthly',
      isInProgress: to.getTime() < naturalTo.getTime(),
      buckets: [
        ['one', '1회', days => days === 1],
        ['two', '2회', days => days === 2],
        ['three', '3회', days => days === 3],
        ['four', '4회', days => days === 4],
        ['fiveToSeven', '5~7회', days => days >= 5 && days <= 7],
        ['eightToEleven', '8~11회', days => days >= 8 && days <= 11],
        ['twelvePlus', '12회 이상', days => days >= 12]
      ]
    }));
  }

  return periods;
}

function buildFrequencyPeriod(rows, period, options) {
  const customerDays = new Map();

  rows.forEach(row => {
    if (!row.groupDate || !isBetween(row.groupDate, period.from, period.to)) return;

    const key = getCustomerKey(row.customerName);
    if (!key) return;

    const dates = customerDays.get(key) || new Set();
    dates.add(toDateKey(row.groupDate));
    customerDays.set(key, dates);
  });

  const buckets = {};
  const bucketDetails = {};
  options.buckets.forEach(([key, label]) => {
    buckets[key] = 0;
    bucketDetails[key] = {
      key,
      label,
      customers: []
    };
  });

  const dayCounts = [];
  customerDays.forEach((dates, customerName) => {
    const participationDays = dates.size;
    const bucket = options.buckets.find(([, , matcher]) => matcher(participationDays));
    dayCounts.push(participationDays);
    if (!bucket) return;

    const [bucketKey] = bucket;
    buckets[bucketKey] += 1;
    bucketDetails[bucketKey].customers.push({
      customerName,
      participationDays
    });
  });

  const activeCustomers = customerDays.size;
  const oneCount = buckets.one || 0;
  const twoPlusCount = dayCounts.filter(days => days >= 2).length;
  const threePlusCount = dayCounts.filter(days => days >= 3).length;
  const fourPlusCount = dayCounts.filter(days => days >= 4).length;
  const eightPlusCount = dayCounts.filter(days => days >= 8).length;

  return {
    periodStart: toDateKey(period.from),
    periodEnd: toDateKey(period.to),
    isInProgress: options.isInProgress,
    activeCustomers,
    buckets,
    bucketDetails,
    avgDays: round2(divide(dayCounts.reduce((sum, days) => sum + days, 0), activeCustomers)),
    medianDays: median(dayCounts),
    oneRate: percent(oneCount, activeCustomers),
    twoPlusRate: percent(twoPlusCount, activeCustomers),
    threePlusRate: percent(threePlusCount, activeCustomers),
    fourPlusRate: percent(fourPlusCount, activeCustomers),
    eightPlusRate: percent(eightPlusCount, activeCustomers)
  };
}

function buildCustomerProfiles(rows, currentPeriod, previousPeriod) {
  const profileMap = new Map();

  rows.forEach(row => {
    if (!row.groupDate || row.groupDate.getTime() > currentPeriod.to.getTime()) return;

    const customerName = getCustomerKey(row.customerName);
    if (!customerName) return;

    const profile = profileMap.get(customerName) || {
      customerName,
      customerDigits4: getCustomerDigits4(customerName),
      firstOrderDate: row.groupDate,
      lastOrderDate: row.groupDate,
      cumulativeDates: new Set(),
      cumulativeRevenue: 0,
      currentDates: new Set(),
      currentOrderLines: 0,
      currentQuantity: 0,
      currentRevenue: 0,
      previousDates: new Set(),
      previousRevenue: 0,
      recentProducts: []
    };

    profile.firstOrderDate = minDate(profile.firstOrderDate, row.groupDate);
    profile.lastOrderDate = maxDate(profile.lastOrderDate, row.groupDate);
    profile.cumulativeDates.add(toDateKey(row.groupDate));
    profile.cumulativeRevenue += row.revenue;
    profile.recentProducts.push({
      date: row.groupDate,
      productName: row.productName
    });

    if (isBetween(row.groupDate, currentPeriod.from, currentPeriod.to)) {
      profile.currentDates.add(toDateKey(row.groupDate));
      profile.currentOrderLines += 1;
      profile.currentQuantity += row.quantity;
      profile.currentRevenue += row.revenue;
    }

    if (isValidPeriod(previousPeriod) && isBetween(row.groupDate, previousPeriod.from, previousPeriod.to)) {
      profile.previousDates.add(toDateKey(row.groupDate));
      profile.previousRevenue += row.revenue;
    }

    profileMap.set(customerName, profile);
  });

  return Array.from(profileMap.values()).map(profile => finalizeCustomerProfile(profile));
}

function finalizeCustomerProfile(profile) {
  const recentProducts = [...profile.recentProducts]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 3)
    .map(item => item.productName)
    .filter(Boolean);

  return {
    customerName: profile.customerName,
    customerDigits4: profile.customerDigits4,
    firstOrderDate: toDateKey(profile.firstOrderDate),
    lastOrderDate: toDateKey(profile.lastOrderDate),
    currentParticipationDays: profile.currentDates.size,
    previousParticipationDays: profile.previousDates.size,
    currentOrderLines: profile.currentOrderLines,
    currentQuantity: profile.currentQuantity,
    currentRevenue: profile.currentRevenue,
    previousRevenue: profile.previousRevenue,
    cumulativeParticipationDays: profile.cumulativeDates.size,
    cumulativeRevenue: profile.cumulativeRevenue,
    recentProducts,
    status: ''
  };
}

function buildCustomerMovement(profiles, currentPeriod, previousPeriod) {
  const bucketKeys = ['zero', 'one', 'two', 'threePlus'];
  const bucketLabels = {
    zero: '0회',
    one: '1회',
    two: '2회',
    threePlus: '3회 이상'
  };
  const population = profiles.filter(profile =>
    profile.currentParticipationDays > 0 || profile.previousParticipationDays > 0
  );
  const matrix = bucketKeys.map(rowKey => ({
    previousBucket: rowKey,
    previousLabel: bucketLabels[rowKey],
    cells: bucketKeys.map(columnKey => ({
      currentBucket: columnKey,
      currentLabel: bucketLabels[columnKey],
      count: 0,
      rate: 0,
      customers: []
    }))
  }));

  population.forEach(profile => {
    const rowKey = getMovementBucket(profile.previousParticipationDays);
    const columnKey = getMovementBucket(profile.currentParticipationDays);
    const row = matrix.find(item => item.previousBucket === rowKey);
    const cell = row.cells.find(item => item.currentBucket === columnKey);
    cell.count += 1;
    cell.customers.push({
      ...profile,
      status: getMovementStatus(rowKey, columnKey)
    });
  });

  matrix.forEach(row => {
    row.cells.forEach(cell => {
      cell.rate = percent(cell.count, population.length);
      cell.customers.sort(sortCustomerProfiles);
    });
  });

  return {
    currentPeriod: serializePeriod(currentPeriod),
    previousPeriod: serializePeriod(previousPeriod),
    populationCount: population.length,
    matrix,
    metrics: buildMovementMetrics(population)
  };
}

function buildMovementMetrics(population) {
  const previousOne = population.filter(profile => profile.previousParticipationDays === 1);
  const previousTwoPlus = population.filter(profile => profile.previousParticipationDays >= 2);
  const previousActive = population.filter(profile => profile.previousParticipationDays >= 1);
  const previousZero = population.filter(profile => profile.previousParticipationDays === 0);

  return {
    oneToTwoPlusRate: percent(
      previousOne.filter(profile => profile.currentParticipationDays >= 2).length,
      previousOne.length
    ),
    twoPlusRetentionRate: percent(
      previousTwoPlus.filter(profile => profile.currentParticipationDays >= 2).length,
      previousTwoPlus.length
    ),
    twoPlusToOneRate: percent(
      previousTwoPlus.filter(profile => profile.currentParticipationDays === 1).length,
      previousTwoPlus.length
    ),
    churnRate: percent(
      previousActive.filter(profile => profile.currentParticipationDays === 0).length,
      previousActive.length
    ),
    activationRate: percent(
      previousZero.filter(profile => profile.currentParticipationDays >= 1).length,
      previousZero.length
    )
  };
}

function emptyMovementMetrics() {
  return {
    oneToTwoPlusRate: 0,
    twoPlusRetentionRate: 0,
    twoPlusToOneRate: 0,
    churnRate: 0,
    activationRate: 0
  };
}

function classifyCustomerLifecycle(profiles, currentPeriod, previousPeriod) {
  const lifecycle = emptyLifecycle();

  profiles.forEach(profile => {
    const firstOrderDate = parseDashboardDate(profile.firstOrderDate);
    const lastOrderDate = parseDashboardDate(profile.lastOrderDate);
    const currentActive = profile.currentParticipationDays > 0;
    const previousActive = profile.previousParticipationDays > 0;
    let assignedCurrentStatus = false;

    if (currentActive && firstOrderDate && isBetween(firstOrderDate, currentPeriod.from, currentPeriod.to)) {
      lifecycle.newCustomers.push({ ...profile, status: '신규' });
      assignedCurrentStatus = true;
    }

    if (currentActive && previousActive) {
      lifecycle.retainedCustomers.push({ ...profile, status: '유지' });
      assignedCurrentStatus = true;
    }

    if (
      currentActive &&
      !previousActive &&
      firstOrderDate &&
      isValidPeriod(previousPeriod) &&
      firstOrderDate.getTime() < previousPeriod.from.getTime()
    ) {
      lifecycle.returningCustomers.push({ ...profile, status: '복귀' });
      assignedCurrentStatus = true;
    }

    if (currentActive && !assignedCurrentStatus) {
      lifecycle.repeatedExistingCustomers.push({ ...profile, status: '기존 반복' });
    }

    if (!currentActive && lastOrderDate && profile.cumulativeParticipationDays >= 2) {
      const daysSinceLastOrder = diffDays(currentPeriod.to, lastOrderDate);

      if (daysSinceLastOrder >= 90) {
        lifecycle.longDormantCustomers.push({ ...profile, status: '장기 휴면', daysSinceLastOrder });
      } else if (daysSinceLastOrder >= 45) {
        lifecycle.dormantCustomers.push({ ...profile, status: '휴면', daysSinceLastOrder });
      } else if (daysSinceLastOrder >= 21) {
        lifecycle.atRiskCustomers.push({ ...profile, status: '관심 필요', daysSinceLastOrder });
      }
    }
  });

  Object.keys(lifecycle).forEach(key => {
    lifecycle[key].sort(sortCustomerProfiles);
  });

  return lifecycle;
}

function emptyLifecycle() {
  return {
    newCustomers: [],
    retainedCustomers: [],
    returningCustomers: [],
    repeatedExistingCustomers: [],
    atRiskCustomers: [],
    dormantCustomers: [],
    longDormantCustomers: []
  };
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

function normalizePeriodForGrowth(period, rows) {
  if (period?.from && period?.to) {
    return {
      label: period.label,
      from: normalizeDate(period.from),
      to: normalizeDate(period.to)
    };
  }

  const firstDate = getFirstGroupDate(rows);
  const lastDate = getLastGroupDate(rows);

  return {
    label: firstDate && lastDate ? '전체 누적' : '데이터 없음',
    from: firstDate,
    to: lastDate
  };
}

function isValidPeriod(period) {
  return Boolean(
    period?.from &&
    period?.to &&
    period.from instanceof Date &&
    period.to instanceof Date &&
    !Number.isNaN(period.from.getTime()) &&
    !Number.isNaN(period.to.getTime()) &&
    period.from.getTime() <= period.to.getTime()
  );
}

function serializePeriod(period) {
  if (!isValidPeriod(period)) return null;

  return {
    label: period.label || `${formatDateForLabel(period.from)} ~ ${formatDateForLabel(period.to)}`,
    from: toDateKey(period.from),
    to: toDateKey(period.to),
    dayCount: diffDays(period.to, period.from) + 1
  };
}

function isPeriodInProgress(period, mode, reportEndDate) {
  if (!isValidPeriod(period) || !reportEndDate) return false;
  if (period.to.getTime() !== reportEndDate.getTime()) return false;

  if (mode === 'month') {
    const monthEnd = new Date(period.from.getFullYear(), period.from.getMonth() + 1, 0);
    return period.to.getTime() < monthEnd.getTime();
  }

  if (mode === 'week') {
    return period.to.getTime() < endOfWeekSunday(period.from).getTime();
  }

  return false;
}

function getComparablePeriod(period, options) {
  if (!isValidPeriod(period)) return { label: '비교 기간 없음', from: null, to: null };

  const offset = Number(options.offset || -1);

  if (options.mode === 'month' && options.isInProgress && period.from.getDate() === 1) {
    const from = new Date(period.from.getFullYear(), period.from.getMonth() + offset, 1);
    const monthEnd = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    const to = new Date(
      from.getFullYear(),
      from.getMonth(),
      Math.min(period.to.getDate(), monthEnd.getDate())
    );

    return {
      label: `${from.getFullYear()}년 ${from.getMonth() + 1}월 동일 경과일`,
      from,
      to
    };
  }

  if (options.mode === 'week' && options.isInProgress) {
    const from = addDays(period.from, 7 * offset);
    const to = addDays(period.to, 7 * offset);

    return {
      label: `${formatMonthDayRange(from, to)} 동일 요일`,
      from,
      to
    };
  }

  const dayCount = diffDays(period.to, period.from) + 1;
  const to = addDays(period.from, dayCount * offset - 1);
  const from = addDays(to, -(dayCount - 1));

  return {
    label: `${formatDateForLabel(from)} ~ ${formatDateForLabel(to)}`,
    from,
    to
  };
}

function getFirstGroupDate(rows) {
  return rows.reduce((first, row) => {
    if (!row.groupDate) return first;
    if (!first || row.groupDate.getTime() < first.getTime()) return row.groupDate;
    return first;
  }, null);
}

function getLastGroupDate(rows) {
  return rows.reduce((last, row) => {
    if (!row.groupDate) return last;
    if (!last || row.groupDate.getTime() > last.getTime()) return row.groupDate;
    return last;
  }, null);
}

function getCustomerKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ');
}

function getCustomerDigits4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function getMovementBucket(days) {
  if (days >= 3) return 'threePlus';
  if (days === 2) return 'two';
  if (days === 1) return 'one';
  return 'zero';
}

function getMovementStatus(previousBucket, currentBucket) {
  const labels = {
    zero: '0회',
    one: '1회',
    two: '2회',
    threePlus: '3회 이상'
  };

  return `${labels[previousBucket]} → ${labels[currentBucket]}`;
}

function sortCustomerProfiles(a, b) {
  if ((b.currentParticipationDays || 0) !== (a.currentParticipationDays || 0)) {
    return (b.currentParticipationDays || 0) - (a.currentParticipationDays || 0);
  }

  if ((b.currentRevenue || 0) !== (a.currentRevenue || 0)) {
    return (b.currentRevenue || 0) - (a.currentRevenue || 0);
  }

  return String(b.lastOrderDate || '').localeCompare(String(a.lastOrderDate || ''));
}

function divide(value, denominator) {
  return denominator ? value / denominator : 0;
}

function percent(value, denominator) {
  return denominator ? round2((value / denominator) * 100) : 0;
}

function changeRate(current, previous) {
  if (!previous) return current ? null : 0;
  return round2(((current - previous) / previous) * 100);
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) return sorted[middle];
  return round2((sorted[middle - 1] + sorted[middle]) / 2);
}

function diffDays(to, from) {
  return Math.round((normalizeDate(to).getTime() - normalizeDate(from).getTime()) / DAY_MS);
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
