import { parseDashboardDate, toDateKey } from './parseOrders.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const MOVEMENT_BUCKETS = [
  { key: 'zero', label: '0회' },
  { key: 'one', label: '1회' },
  { key: 'two', label: '2회' },
  { key: 'threePlus', label: '3회 이상' }
];

const WEEKLY_BUCKETS = [
  ['one', '1일', days => days === 1],
  ['two', '2일', days => days === 2],
  ['three', '3일', days => days === 3],
  ['four', '4일', days => days === 4],
  ['five', '5일', days => days === 5],
  ['six', '6일', days => days === 6],
  ['seven', '7일', days => days >= 7]
];

const MONTHLY_BUCKETS = [
  ['one', '1회', days => days === 1],
  ['two', '2회', days => days === 2],
  ['three', '3회', days => days === 3],
  ['four', '4회', days => days === 4],
  ['fiveToSeven', '5~7회', days => days >= 5 && days <= 7],
  ['eightToEleven', '8~11회', days => days >= 8 && days <= 11],
  ['twelvePlus', '12회 이상', days => days >= 12]
];

const LIFECYCLE_SEGMENTS = {
  new: 'newCustomers',
  retained: 'retainedCustomers',
  returning: 'returningCustomers',
  repeatedExisting: 'repeatedExistingCustomers',
  atRisk: 'atRiskCustomers',
  dormant: 'dormantCustomers',
  longDormant: 'longDormantCustomers'
};

export function buildGrowthDashboardData(rows, options = {}) {
  const currentPeriod = normalizeGrowthPeriod(options.period, rows);
  const empty = buildEmptyDashboardData(currentPeriod);

  if (!isValidPeriod(currentPeriod)) return empty;

  const reportEndDate = normalizeDate(options.reportEndDate || currentPeriod.to);
  const isInProgress = isPeriodInProgress(currentPeriod, options.mode, reportEndDate);
  const previousPeriod = getComparablePeriod(currentPeriod, {
    mode: options.mode,
    isInProgress,
    offset: -1
  });
  const current = summarizeParticipation(rows, currentPeriod);
  const previous = summarizeParticipation(rows, previousPeriod);
  const profiles = buildCustomerProfiles(rows, currentPeriod, previousPeriod);
  const lifecycle = buildLifecycleCounts(profiles, currentPeriod, previousPeriod);
  const changes = buildGrowthChanges(current, previous);

  return {
    growthAnalysis: {
      basis: 'groupDate',
      basisLabel: '공구일자 기준',
      currentPeriod: serializePeriod(currentPeriod),
      previousPeriod: serializePeriod(previousPeriod),
      isInProgress,
      current: {
        ...current,
        newCustomerCount: lifecycle.newCustomers.count,
        returningCustomerCount: lifecycle.returningCustomers.count
      },
      previous,
      fourPeriodAverage: buildFourPeriodAverage(rows, currentPeriod, {
        mode: options.mode,
        isInProgress
      }),
      changes,
      diagnosis: buildGrowthDiagnosis(current, previous, changes)
    },
    participationFrequency: {
      weekly: buildWeeklyFrequency(rows, reportEndDate),
      monthly: buildMonthlyFrequency(rows, reportEndDate)
    },
    customerMovement: buildCustomerMovementSummary(profiles, currentPeriod, previousPeriod),
    lifecycle,
    kakaoRoomMetrics: buildKakaoRoomMetrics(rows, reportEndDate)
  };
}

export function buildGrowthCustomerList(rows, options = {}) {
  const segment = options.segment || {};
  const currentPeriod = resolveCustomerListPeriod(rows, options);
  const previousPeriod = getComparablePeriod(currentPeriod, {
    mode: options.mode,
    isInProgress: false,
    offset: -1
  });
  const profiles = buildCustomerProfiles(rows, currentPeriod, previousPeriod);
  let customers = [];
  let title = '고객 목록';

  if (segment.type === 'lifecycle') {
    const lifecycle = buildLifecycleLists(profiles, currentPeriod, previousPeriod);
    const key = LIFECYCLE_SEGMENTS[segment.key] || 'newCustomers';
    customers = lifecycle[key] || [];
    title = lifecycleTitle(segment.key);
  } else if (segment.type === 'movement') {
    const previousBucket = segment.previousBucket || 'zero';
    const currentBucket = segment.currentBucket || 'zero';
    customers = profiles
      .filter(profile =>
        getMovementBucket(profile.previousParticipationDays) === previousBucket &&
        getMovementBucket(profile.currentParticipationDays) === currentBucket &&
        (profile.previousParticipationDays > 0 || profile.currentParticipationDays > 0)
      )
      .map(profile => ({
        ...profile,
        status: `${movementLabel(previousBucket)} → ${movementLabel(currentBucket)}`
      }));
    title = `${movementLabel(previousBucket)} → ${movementLabel(currentBucket)}`;
  } else if (segment.type === 'frequency') {
    const buckets = segment.frequencyType === 'monthly' ? MONTHLY_BUCKETS : WEEKLY_BUCKETS;
    const bucketKey = segment.bucketKey || 'one';
    const bucket = buckets.find(([key]) => key === bucketKey) || buckets[0];
    customers = profiles
      .filter(profile => bucket[2](profile.currentParticipationDays))
      .map(profile => ({
        ...profile,
        status: bucket[1]
      }));
    title = `${bucket[1]} 참여 고객`;
  }

  return {
    period: serializePeriod(currentPeriod),
    previousPeriod: serializePeriod(previousPeriod),
    title,
    customers: customers
      .sort(sortCustomerProfiles)
      .slice(0, Number(options.limit || 500))
  };
}

export function getCustomerKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ');
}

export function getGrowthRows(rows, today) {
  const todayDate = normalizeDate(today);

  return rows.filter(row =>
    row.groupDate &&
    row.groupDate.getTime() < todayDate.getTime() &&
    getCustomerKey(row.customerName)
  );
}

function buildEmptyDashboardData(period) {
  const summary = emptyParticipationSummary(period);

  return {
    growthAnalysis: {
      basis: 'groupDate',
      basisLabel: '공구일자 기준',
      currentPeriod: serializePeriod(period),
      previousPeriod: null,
      isInProgress: false,
      current: summary,
      previous: summary,
      fourPeriodAverage: summary,
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
    lifecycle: emptyLifecycleCounts(),
    kakaoRoomMetrics: {
      recent30Period: null,
      recent30ActiveCustomers: 0,
      recent30Revenue: 0,
      recent30ParticipationDays: 0
    }
  };
}

function normalizeGrowthPeriod(period, rows) {
  if (period?.from && period?.to) {
    return {
      label: period.label,
      from: normalizeDate(period.from),
      to: normalizeDate(period.to)
    };
  }

  return {
    label: '전체 누적',
    from: getFirstGroupDate(rows),
    to: getLastGroupDate(rows)
  };
}

function resolveCustomerListPeriod(rows, options) {
  if (options.segment?.periodStart && options.segment?.periodEnd) {
    return {
      label: '선택 구간',
      from: parseDashboardDate(options.segment.periodStart),
      to: parseDashboardDate(options.segment.periodEnd)
    };
  }

  if (options.period?.from && options.period?.to) {
    return normalizeGrowthPeriod(options.period, rows);
  }

  return normalizeGrowthPeriod(null, rows);
}

function summarizeParticipation(rows, period) {
  if (!isValidPeriod(period)) return emptyParticipationSummary(period);

  const customerMap = new Map();
  let revenue = 0;
  let quantity = 0;
  let orderLineCount = 0;

  rows.forEach(row => {
    if (!row.groupDate || !isBetween(row.groupDate, period.from, period.to)) return;

    const customerName = getCustomerKey(row.customerName);
    if (!customerName) return;

    const current = customerMap.get(customerName) || {
      dates: new Set(),
      revenue: 0,
      quantity: 0,
      orderLineCount: 0
    };

    current.dates.add(toDateKey(row.groupDate));
    current.revenue += row.revenue;
    current.quantity += row.quantity;
    current.orderLineCount += 1;
    customerMap.set(customerName, current);
    revenue += row.revenue;
    quantity += row.quantity;
    orderLineCount += 1;
  });

  const activeCustomers = customerMap.size;
  let totalParticipationDays = 0;
  let twoPlusCustomerCount = 0;

  customerMap.forEach(customer => {
    totalParticipationDays += customer.dates.size;
    if (customer.dates.size >= 2) twoPlusCustomerCount += 1;
  });

  return {
    period: serializePeriod(period),
    revenue,
    activeCustomers,
    totalParticipationDays,
    avgParticipationDays: round2(divide(totalParticipationDays, activeCustomers)),
    revenuePerActiveCustomer: Math.round(divide(revenue, activeCustomers)),
    revenuePerParticipationDay: Math.round(divide(revenue, totalParticipationDays)),
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

function buildFourPeriodAverage(rows, currentPeriod, options) {
  const summaries = [1, 2, 3, 4].map(index =>
    summarizeParticipation(
      rows,
      getComparablePeriod(currentPeriod, {
        mode: options.mode,
        isInProgress: options.isInProgress,
        offset: -index
      })
    )
  );
  const count = summaries.length || 1;

  return {
    periods: summaries.map(summary => summary.period),
    revenue: Math.round(sum(summaries, 'revenue') / count),
    activeCustomers: round1(sum(summaries, 'activeCustomers') / count),
    totalParticipationDays: round1(sum(summaries, 'totalParticipationDays') / count),
    avgParticipationDays: round2(sum(summaries, 'avgParticipationDays') / count),
    revenuePerActiveCustomer: Math.round(sum(summaries, 'revenuePerActiveCustomer') / count),
    revenuePerParticipationDay: Math.round(sum(summaries, 'revenuePerParticipationDay') / count),
    twoPlusCustomerCount: round1(sum(summaries, 'twoPlusCustomerCount') / count),
    twoPlusRate: round2(sum(summaries, 'twoPlusRate') / count),
    quantity: round1(sum(summaries, 'quantity') / count),
    orderLineCount: round1(sum(summaries, 'orderLineCount') / count)
  };
}

function buildGrowthChanges(current, previous) {
  const customerRate = changeRate(current.activeCustomers, previous.activeCustomers);
  const frequencyRate = changeRate(current.avgParticipationDays, previous.avgParticipationDays);
  const valueRate = changeRate(current.revenuePerParticipationDay, previous.revenuePerParticipationDay);
  const candidates = [
    { key: 'customer', label: '구매 고객 수', rate: customerRate },
    { key: 'frequency', label: '고객당 참여일수', rate: frequencyRate },
    { key: 'value', label: '참여 1일당 주문금액', rate: valueRate }
  ].filter(item => item.rate !== null);

  return {
    revenueRate: changeRate(current.revenue, previous.revenue),
    customerRate,
    frequencyRate,
    valueRate,
    dominantDriver: candidates.length
      ? candidates.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))[0]
      : null
  };
}

function buildGrowthDiagnosis(current, previous, changes) {
  if (!previous.activeCustomers || !previous.totalParticipationDays || changes.revenueRate === null) {
    return '비교 가능한 이전 데이터가 부족합니다.';
  }

  const direction = changes.revenueRate > 0 ? '증가' : changes.revenueRate < 0 ? '감소' : '유지';
  const driverText = changes.dominantDriver
    ? `${changes.dominantDriver.label} 변화가 가장 크게 나타났습니다.`
    : '주요 변화 요인이 뚜렷하지 않습니다.';

  return `이번 기간 공구매출은 직전 기간보다 ${Math.abs(changes.revenueRate).toFixed(1)}% ${direction}했습니다. 구매 고객 수는 ${previous.activeCustomers}명에서 ${current.activeCustomers}명, 고객당 참여일수는 ${previous.avgParticipationDays.toFixed(1)}일에서 ${current.avgParticipationDays.toFixed(1)}일로 움직였습니다. ${driverText}`;
}

function buildWeeklyFrequency(rows, reportEndDate) {
  const weekStart = startOfWeekMonday(reportEndDate);

  return Array.from({ length: 12 }, (_, index) => {
    const from = addDays(weekStart, -7 * (11 - index));
    const naturalTo = addDays(from, 6);
    const to = minDate(naturalTo, reportEndDate);

    return buildFrequencyPeriod(rows, { from, to }, WEEKLY_BUCKETS, to.getTime() < naturalTo.getTime());
  });
}

function buildMonthlyFrequency(rows, reportEndDate) {
  const firstDate = getFirstGroupDate(rows);
  const result = [];

  for (let offset = 5; offset >= 0; offset -= 1) {
    const from = new Date(reportEndDate.getFullYear(), reportEndDate.getMonth() - offset, 1);
    const naturalTo = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    const to = minDate(naturalTo, reportEndDate);

    if (firstDate && to.getTime() < new Date(firstDate.getFullYear(), firstDate.getMonth(), 1).getTime()) {
      continue;
    }

    result.push(buildFrequencyPeriod(rows, { from, to }, MONTHLY_BUCKETS, to.getTime() < naturalTo.getTime()));
  }

  return result;
}

function buildFrequencyPeriod(rows, period, bucketDefinitions, isInProgress) {
  const customerDays = new Map();

  rows.forEach(row => {
    if (!row.groupDate || !isBetween(row.groupDate, period.from, period.to)) return;

    const customerName = getCustomerKey(row.customerName);
    if (!customerName) return;

    const dates = customerDays.get(customerName) || new Set();
    dates.add(toDateKey(row.groupDate));
    customerDays.set(customerName, dates);
  });

  const buckets = Object.fromEntries(bucketDefinitions.map(([key]) => [key, 0]));
  const dayCounts = [];

  customerDays.forEach(dates => {
    const days = dates.size;
    const bucket = bucketDefinitions.find(([, , matcher]) => matcher(days));
    dayCounts.push(days);
    if (bucket) buckets[bucket[0]] += 1;
  });

  const activeCustomers = customerDays.size;

  return {
    periodStart: toDateKey(period.from),
    periodEnd: toDateKey(period.to),
    isInProgress,
    activeCustomers,
    buckets,
    avgDays: round2(divide(dayCounts.reduce((total, days) => total + days, 0), activeCustomers)),
    medianDays: median(dayCounts),
    oneRate: percent(buckets.one || 0, activeCustomers),
    twoPlusRate: percent(dayCounts.filter(days => days >= 2).length, activeCustomers),
    threePlusRate: percent(dayCounts.filter(days => days >= 3).length, activeCustomers),
    fourPlusRate: percent(dayCounts.filter(days => days >= 4).length, activeCustomers),
    eightPlusRate: percent(dayCounts.filter(days => days >= 8).length, activeCustomers)
  };
}

function buildCustomerProfiles(rows, currentPeriod, previousPeriod) {
  const map = new Map();

  rows.forEach(row => {
    if (!row.groupDate || !isValidPeriod(currentPeriod) || row.groupDate.getTime() > currentPeriod.to.getTime()) {
      return;
    }

    const customerName = getCustomerKey(row.customerName);
    if (!customerName) return;

    const profile = map.get(customerName) || {
      customerName,
      customerDigits4: getCustomerDigits4(customerName),
      firstOrderDate: row.groupDate,
      lastOrderDate: row.groupDate,
      cumulativeDates: new Set(),
      cumulativeQuantity: 0,
      cumulativeOrderLines: 0,
      cumulativeRevenue: 0,
      currentDates: new Set(),
      currentOrderLines: 0,
      currentQuantity: 0,
      currentRevenue: 0,
      previousDates: new Set(),
      previousRevenue: 0,
      productMap: new Map()
    };

    profile.firstOrderDate = minDate(profile.firstOrderDate, row.groupDate);
    profile.lastOrderDate = maxDate(profile.lastOrderDate, row.groupDate);
    profile.cumulativeDates.add(toDateKey(row.groupDate));
    profile.cumulativeQuantity += row.quantity;
    profile.cumulativeOrderLines += 1;
    profile.cumulativeRevenue += row.revenue;

    if (row.productName) {
      const product = profile.productMap.get(row.productName) || {
        productName: row.productName,
        lastDate: row.groupDate,
        quantity: 0
      };
      product.lastDate = maxDate(product.lastDate, row.groupDate);
      product.quantity += row.quantity;
      profile.productMap.set(row.productName, product);
    }

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

    map.set(customerName, profile);
  });

  return Array.from(map.values()).map(finalizeProfile);
}

function finalizeProfile(profile) {
  const recentProducts = Array.from(profile.productMap.values())
    .sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime() || b.quantity - a.quantity)
    .slice(0, 3)
    .map(item => item.productName);

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
    cumulativeQuantity: profile.cumulativeQuantity,
    cumulativeOrderLines: profile.cumulativeOrderLines,
    cumulativeRevenue: profile.cumulativeRevenue,
    recentProducts,
    status: ''
  };
}

function buildCustomerMovementSummary(profiles, currentPeriod, previousPeriod) {
  const population = profiles.filter(profile =>
    profile.currentParticipationDays > 0 || profile.previousParticipationDays > 0
  );
  const matrix = MOVEMENT_BUCKETS.map(previous => ({
    previousBucket: previous.key,
    previousLabel: previous.label,
    cells: MOVEMENT_BUCKETS.map(current => ({
      currentBucket: current.key,
      currentLabel: current.label,
      count: 0,
      rate: 0
    }))
  }));

  population.forEach(profile => {
    const row = matrix.find(item => item.previousBucket === getMovementBucket(profile.previousParticipationDays));
    const cell = row.cells.find(item => item.currentBucket === getMovementBucket(profile.currentParticipationDays));
    cell.count += 1;
  });

  matrix.forEach(row => {
    row.cells.forEach(cell => {
      cell.rate = percent(cell.count, population.length);
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
    oneToTwoPlusRate: percent(previousOne.filter(profile => profile.currentParticipationDays >= 2).length, previousOne.length),
    twoPlusRetentionRate: percent(previousTwoPlus.filter(profile => profile.currentParticipationDays >= 2).length, previousTwoPlus.length),
    twoPlusToOneRate: percent(previousTwoPlus.filter(profile => profile.currentParticipationDays === 1).length, previousTwoPlus.length),
    churnRate: percent(previousActive.filter(profile => profile.currentParticipationDays === 0).length, previousActive.length),
    activationRate: percent(previousZero.filter(profile => profile.currentParticipationDays >= 1).length, previousZero.length)
  };
}

function buildLifecycleCounts(profiles, currentPeriod, previousPeriod) {
  const lists = buildLifecycleLists(profiles, currentPeriod, previousPeriod);

  return Object.fromEntries(
    Object.entries(lists).map(([key, customers]) => [
      key,
      { count: customers.length }
    ])
  );
}

function buildLifecycleLists(profiles, currentPeriod, previousPeriod) {
  const lifecycle = emptyLifecycleLists();

  profiles.forEach(profile => {
    const firstOrderDate = parseDashboardDate(profile.firstOrderDate);
    const lastOrderDate = parseDashboardDate(profile.lastOrderDate);
    const currentActive = profile.currentParticipationDays > 0;
    const previousActive = profile.previousParticipationDays > 0;
    let assigned = false;

    if (currentActive && firstOrderDate && isBetween(firstOrderDate, currentPeriod.from, currentPeriod.to)) {
      lifecycle.newCustomers.push({ ...profile, status: '신규' });
      assigned = true;
    }

    if (currentActive && previousActive) {
      lifecycle.retainedCustomers.push({ ...profile, status: '유지' });
      assigned = true;
    }

    if (
      currentActive &&
      !previousActive &&
      isValidPeriod(previousPeriod) &&
      firstOrderDate &&
      firstOrderDate.getTime() < previousPeriod.from.getTime()
    ) {
      lifecycle.returningCustomers.push({ ...profile, status: '복귀' });
      assigned = true;
    }

    if (currentActive && !assigned) {
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

function buildKakaoRoomMetrics(rows, reportEndDate) {
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

function emptyLifecycleCounts() {
  return Object.fromEntries(
    Object.keys(emptyLifecycleLists()).map(key => [key, { count: 0 }])
  );
}

function emptyLifecycleLists() {
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

function emptyMovementMetrics() {
  return {
    oneToTwoPlusRate: 0,
    twoPlusRetentionRate: 0,
    twoPlusToOneRate: 0,
    churnRate: 0,
    activationRate: 0
  };
}

function isPeriodInProgress(period, mode, reportEndDate) {
  if (!isValidPeriod(period) || !reportEndDate || period.to.getTime() !== reportEndDate.getTime()) {
    return false;
  }

  if (mode === 'month') {
    return period.to.getTime() < new Date(period.from.getFullYear(), period.from.getMonth() + 1, 0).getTime();
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
    const to = new Date(from.getFullYear(), from.getMonth(), Math.min(period.to.getDate(), monthEnd.getDate()));
    return { label: `${from.getFullYear()}년 ${from.getMonth() + 1}월 동일 경과일`, from, to };
  }

  if (options.mode === 'week' && options.isInProgress) {
    const from = addDays(period.from, 7 * offset);
    const to = addDays(period.to, 7 * offset);
    return { label: `${from.getMonth() + 1}.${from.getDate()} ~ ${to.getMonth() + 1}.${to.getDate()}`, from, to };
  }

  const dayCount = diffDays(period.to, period.from) + 1;
  const to = addDays(period.from, dayCount * offset - 1);
  const from = addDays(to, -(dayCount - 1));
  return { label: `${toDateKey(from)} ~ ${toDateKey(to)}`, from, to };
}

function serializePeriod(period) {
  if (!isValidPeriod(period)) return null;

  return {
    label: period.label || `${toDateKey(period.from)} ~ ${toDateKey(period.to)}`,
    from: toDateKey(period.from),
    to: toDateKey(period.to),
    dayCount: diffDays(period.to, period.from) + 1
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

function getMovementBucket(days) {
  if (days >= 3) return 'threePlus';
  if (days === 2) return 'two';
  if (days === 1) return 'one';
  return 'zero';
}

function movementLabel(key) {
  return MOVEMENT_BUCKETS.find(item => item.key === key)?.label || '0회';
}

function lifecycleTitle(key) {
  return {
    new: '신규 고객',
    retained: '유지 고객',
    returning: '복귀 고객',
    repeatedExisting: '기존 반복 고객',
    atRisk: '관심 필요 고객',
    dormant: '휴면 고객',
    longDormant: '장기 휴면 고객'
  }[key] || '고객 목록';
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

function getCustomerDigits4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
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

function startOfWeekMonday(date) {
  const result = normalizeDate(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function endOfWeekSunday(date) {
  return addDays(startOfWeekMonday(date), 6);
}

function isBetween(date, from, to) {
  return date.getTime() >= from.getTime() && date.getTime() <= to.getTime();
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const result = normalizeDate(date);
  result.setDate(result.getDate() + days);
  return result;
}

function minDate(a, b) {
  return a.getTime() <= b.getTime() ? normalizeDate(a) : normalizeDate(b);
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? normalizeDate(a) : normalizeDate(b);
}

function diffDays(to, from) {
  return Math.round((normalizeDate(to).getTime() - normalizeDate(from).getTime()) / DAY_MS);
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
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
