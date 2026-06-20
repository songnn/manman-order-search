import { readKakaoCsvStore } from '../kakaoCsvProcessing.js';
import { parseDashboardDate, toDateKey } from './parseOrders.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readKakaoCsvTelemetry(options = {}) {
  return readKakaoCsvStore(options);
}

export function buildKakaoCsvAnalytics(orderRows, telemetry, options = {}) {
  const recentDays = Number(options.recentDays || 30);
  const uploads = [...(telemetry.uploads || [])].sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
  );
  const latestUpload = uploads[0] || null;
  const baseReportEndDate = endOfDay(parseDashboardDate(options.reportEndDate) || new Date());
  const reportPeriod = normalizeReportPeriod(options.reportPeriod, baseReportEndDate);
  const latestUploadDate = latestUpload
    ? parseDashboardDate(latestUpload.orderDate || String(latestUpload.uploadedAt || '').slice(0, 10))
    : null;
  const reportEndDate = endOfDay(maxDate(baseReportEndDate, latestUploadDate || baseReportEndDate));
  const fromDate = startOfDay(new Date(reportEndDate.getTime() - (recentDays - 1) * DAY_MS));
  const latestUploadId = latestUpload?.uploadId || '';
  const messages = latestUploadId
    ? (telemetry.messages || []).filter(message => message.uploadId === latestUploadId)
    : [];
  const memberEvents = (telemetry.memberEvents || [])
    .filter(event => !latestUploadId || event.uploadId === latestUploadId)
    .filter(event => event.messageAtDate && event.messageAtDate.getTime() <= reportEndDate.getTime())
    .sort((a, b) => a.messageAtDate.getTime() - b.messageAtDate.getTime());
  const orderMatches = latestUploadId
    ? (telemetry.orderMatches || []).filter(match => match.uploadId === latestUploadId)
    : [];
  const periodOrderMatches = filterMatchesForPeriod(orderMatches, reportPeriod);
  const orderTotals = buildOrderTotalsByCustomer(orderRows || []);
  const customerInsights = buildKakaoCustomerInsights({
    memberEvents,
    orderMatches,
    orderTotals
  });
  const joinProfiles = buildJoinProfiles(memberEvents, orderTotals);
  const leaverProfiles = buildRecentLeaverProfiles(memberEvents, orderTotals, fromDate);
  const zeroPurchaseLeavers = leaverProfiles.filter(profile => profile.cumulativeOrderLines === 0);
  const latestUploadSummary = latestUpload || {};
  const firstOrderDelay = latestUploadSummary.firstOrderAfterMinutes;

  return {
    basis: '카톡 CSV 원본 서버 분석 기준',
    latestUpload,
    recentPeriod: {
      from: toDateKey(fromDate),
      to: toDateKey(reportEndDate),
      dayCount: recentDays
    },
    memberEvents: {
      totalJoinCount: memberEvents.filter(event => event.eventType === 'join').length,
      totalLeaveCount: memberEvents.filter(event => event.eventType === 'leave').length,
      recentLeaveCount: leaverProfiles.length,
      recentZeroPurchaseLeaveCount: zeroPurchaseLeavers.length,
      recentZeroPurchaseLeaveRate: percent(zeroPurchaseLeavers.length, leaverProfiles.length),
      estimatedCurrentMembers: estimateActiveMembers(memberEvents),
      nicknameDigitStats: customerInsights.nicknameDigitStats,
      joinToOrderConversionRate: percent(
        joinProfiles.filter(profile => profile.cumulativeOrderLines > 0).length,
        joinProfiles.length
      )
    },
    matching: {
      csvMessageCount: latestUploadSummary.messageCount || messages.length,
      csvOrderMessageCount: latestUploadSummary.orderCandidateMessageCount || 0,
      rawOrderCount: latestUploadSummary.rawOrderCount || 0,
      matchedRawOrderCount: latestUploadSummary.matchedOrderCount || uniqueCount(orderMatches, 'rawOrderStableId'),
      unmatchedCsvOrderCount: latestUploadSummary.unmatchedCsvOrderCount || 0,
      unmatchedRawOrderCount: latestUploadSummary.unmatchedRawOrderCount || 0,
      avgOrderedAt: latestUploadSummary.avgOrderedAt || averageMatchTime(orderMatches),
      firstOrderedAt: latestUploadSummary.firstOrderedAt || firstMatchTime(orderMatches),
      firstOrderAfterMinutes: firstOrderDelay === '' || firstOrderDelay == null ? null : Number(firstOrderDelay)
    },
    orderTimeline: {
      period: serializeAnalyticsPeriod(reportPeriod),
      hourlyOrderCounts: buildHourlyOrderCounts(periodOrderMatches),
      memberTimeline: customerInsights.memberTimeline
    },
    orderDelay: customerInsights.orderDelay,
    customerProfiles: customerInsights.customerProfiles.slice(0, 2000),
    leavePurchaseBuckets: buildLeavePurchaseBuckets(leaverProfiles),
    orderTimeCoverage: {
      matchedOrderLineCount: uniqueCount(orderMatches, 'rawOrderStableId'),
      orderMatchRecordCount: orderMatches.length,
      latestMatchedAt: getLatestValue(orderMatches, 'matchedAt')
    },
    recentLeavers: leaverProfiles
      .sort((a, b) => String(b.leftAt || '').localeCompare(String(a.leftAt || '')))
      .slice(0, 100),
    matchSamples: orderMatches
      .sort((a, b) => String(a.actualOrderedAt || '').localeCompare(String(b.actualOrderedAt || '')))
      .slice(0, 50)
  };
}

export function enrichCustomersWithKakaoProfiles(customers, orderRows, telemetry) {
  const uploads = [...(telemetry.uploads || [])].sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
  );
  const latestUploadId = uploads[0]?.uploadId || '';
  const memberEvents = latestUploadId
    ? (telemetry.memberEvents || []).filter(event => event.uploadId === latestUploadId)
    : [];
  const orderMatches = latestUploadId
    ? (telemetry.orderMatches || []).filter(match => match.uploadId === latestUploadId)
    : [];
  const insights = buildKakaoCustomerInsights({
    memberEvents,
    orderMatches,
    orderTotals: buildOrderTotalsByCustomer(orderRows || [])
  });
  const profileMap = new Map(insights.customerProfiles.map(profile => [profile.normalizedUser, profile]));

  return (customers || []).map(customer => {
    const profile = profileMap.get(normalizeCustomerKey(customer.customerName));
    if (!profile) return customer;

    return {
      ...customer,
      firstJoinedAt: profile.firstJoinedAt,
      lastMemberEventAt: profile.lastMemberEventAt,
      isCurrentKakaoMember: profile.isCurrentMember,
      hasNicknameDigits4: profile.hasNicknameDigits4,
      firstActualOrderedAt: profile.firstActualOrderedAt,
      secondActualOrderedAt: profile.secondActualOrderedAt,
      daysFromJoinToFirstOrder: profile.daysFromJoinToFirstOrder,
      daysFromJoinToSecondOrder: profile.daysFromJoinToSecondOrder,
      cumulativeQuantity: profile.totalQuantity || customer.cumulativeQuantity || 0,
      cumulativeOrderLines: profile.totalOrderLines || customer.cumulativeOrderLines || 0,
      cumulativeRevenue: profile.totalRevenue || customer.cumulativeRevenue || 0
    };
  });
}

function buildJoinProfiles(events, orderTotals) {
  const joins = new Map();
  events.forEach(event => {
    if (event.eventType !== 'join') return;
    const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
    if (!key) return;
    joins.set(key, event);
  });

  return Array.from(joins.values()).map(event => {
    const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
    const order = orderTotals.get(key) || emptyOrderTotal();
    return {
      userName: event.memberSubject || event.userName,
      normalizedUser: key,
      joinedAt: event.messageAt,
      cumulativeQuantity: order.quantity,
      cumulativeOrderLines: order.orderLineCount,
      cumulativeRevenue: order.revenue
    };
  });
}

function buildRecentLeaverProfiles(events, orderTotals, fromDate) {
  const leaves = new Map();
  events.forEach(event => {
    if (event.eventType !== 'leave') return;
    if (!event.messageAtDate || event.messageAtDate.getTime() < fromDate.getTime()) return;
    const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
    if (!key) return;
    leaves.set(key, event);
  });

  return Array.from(leaves.values()).map(event => {
    const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
    const order = orderTotals.get(key) || emptyOrderTotal();

    return {
      userName: event.memberSubject || event.userName,
      normalizedUser: key,
      leftAt: event.messageAt,
      leftAtRaw: event.dateRaw,
      cumulativeQuantity: order.quantity,
      cumulativeOrderLines: order.orderLineCount,
      cumulativeRevenue: order.revenue,
      firstOrderDate: order.firstOrderDate ? toDateKey(order.firstOrderDate) : '',
      lastOrderDate: order.lastOrderDate ? toDateKey(order.lastOrderDate) : '',
      topProduct: order.topProduct || ''
    };
  });
}

function buildOrderTotalsByCustomer(rows) {
  const map = new Map();

  rows.forEach(row => {
    const key = normalizeCustomerKey(row.customerName);
    if (!key) return;

    const current = map.get(key) || emptyOrderTotal();
    current.customerName = current.customerName || row.customerName;
    current.quantity += Number(row.quantity || 0);
    current.orderLineCount += 1;
    current.revenue += Number(row.revenue || 0);
    current.firstOrderDate = current.firstOrderDate ? minDate(current.firstOrderDate, row.groupDate) : row.groupDate;
    current.lastOrderDate = current.lastOrderDate ? maxDate(current.lastOrderDate, row.groupDate) : row.groupDate;
    current.productCounts.set(row.productName, (current.productCounts.get(row.productName) || 0) + Number(row.quantity || 0));
    map.set(key, current);
  });

  map.forEach(value => {
    value.topProduct = Array.from(value.productCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'))[0]?.[0] || '';
    delete value.productCounts;
  });

  return map;
}

function buildKakaoCustomerInsights({ memberEvents, orderMatches, orderTotals }) {
  const memberState = buildMemberState(memberEvents);
  const matchMap = buildOrderMatchesByCustomer(orderMatches);
  const keys = new Set([
    ...memberState.keys(),
    ...orderTotals.keys(),
    ...matchMap.keys()
  ]);

  const customerProfiles = Array.from(keys)
    .map(key => {
      const member = memberState.get(key) || {};
      const order = orderTotals.get(key) || emptyOrderTotal();
      const matches = matchMap.get(key) || [];
      const firstActualOrder = matches[0] || null;
      const secondActualOrder = matches[1] || null;
      const firstOrderDate = order.firstOrderDate ? toDateKey(order.firstOrderDate) : '';
      const firstOrderDateObject = firstActualOrder?.actualOrderedAtDate || order.firstOrderDate || null;
      const secondOrderDateObject = secondActualOrder?.actualOrderedAtDate || null;
      const joinedAtDate = member.firstJoinedAtDate || null;

      return {
        userName: member.memberSubject || order.customerName || firstActualOrder?.customerName || '',
        customerName: order.customerName || member.memberSubject || firstActualOrder?.customerName || '',
        normalizedUser: key,
        isOperationalUser: isOperationalKakaoUser(member.memberSubject || order.customerName || firstActualOrder?.customerName || ''),
        firstJoinedAt: member.firstJoinedAt || '',
        lastMemberEventAt: member.lastMemberEventAt || '',
        isCurrentMember: member.isCurrentMember || false,
        hasNicknameDigits4: hasTrailingFourDigits(member.memberSubject || order.customerName || firstActualOrder?.customerName || ''),
        totalQuantity: order.quantity || 0,
        totalOrderLines: order.orderLineCount || 0,
        totalRevenue: order.revenue || 0,
        firstOrderDate,
        lastOrderDate: order.lastOrderDate ? toDateKey(order.lastOrderDate) : '',
        firstActualOrderedAt: firstActualOrder?.actualOrderedAt || '',
        secondActualOrderedAt: secondActualOrder?.actualOrderedAt || '',
        daysFromJoinToFirstOrder: diffDaysDecimal(firstOrderDateObject, joinedAtDate),
        daysFromJoinToSecondOrder: diffDaysDecimal(secondOrderDateObject, joinedAtDate)
      };
    })
    .filter(profile => profile.userName || profile.customerName)
    .sort((a, b) =>
      Number(b.totalOrderLines > 0) - Number(a.totalOrderLines > 0) ||
      Number(b.isCurrentMember) - Number(a.isCurrentMember) ||
      String(a.firstJoinedAt || '9999').localeCompare(String(b.firstJoinedAt || '9999')) ||
      (b.totalRevenue || 0) - (a.totalRevenue || 0)
    );

  return {
    customerProfiles,
    memberTimeline: buildMemberTimeline(memberEvents),
    nicknameDigitStats: buildNicknameDigitStats(customerProfiles),
    orderDelay: buildOrderDelayStats(customerProfiles)
  };
}

function buildMemberState(events) {
  const state = new Map();

  [...(events || [])]
    .filter(event => event.messageAtDate)
    .sort((a, b) => a.messageAtDate.getTime() - b.messageAtDate.getTime())
    .forEach(event => {
      const memberSubject = event.memberSubject || event.userName || '';
      const key = normalizeCustomerKey(memberSubject || event.normalizedUser);
      if (!key) return;

      const current = state.get(key) || {
        memberSubject,
        firstJoinedAt: '',
        firstJoinedAtDate: null,
        lastMemberEventAt: '',
        isCurrentMember: false
      };

      if (event.eventType === 'join' && !current.firstJoinedAt) {
        current.firstJoinedAt = event.messageAt;
        current.firstJoinedAtDate = event.messageAtDate;
      }

      current.memberSubject = memberSubject || current.memberSubject;
      current.lastMemberEventAt = event.messageAt;
      current.isCurrentMember = event.eventType === 'join';
      state.set(key, current);
    });

  return state;
}

function buildOrderMatchesByCustomer(matches) {
  const map = new Map();

  (matches || []).forEach(match => {
    const key = normalizeCustomerKey(match.customerName || match.normalizedCustomer);
    if (!key || !match.actualOrderedAtDate) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(match);
  });

  map.forEach(list => {
    list.sort((a, b) =>
      a.actualOrderedAtDate.getTime() - b.actualOrderedAtDate.getTime() ||
      Number(a.occurrenceIndex || 0) - Number(b.occurrenceIndex || 0)
    );
  });

  return map;
}

function buildMemberTimeline(events) {
  const sorted = [...(events || [])]
    .filter(event => event.messageAtDate)
    .sort((a, b) => a.messageAtDate.getTime() - b.messageAtDate.getTime());
  if (!sorted.length) return [];

  const byDate = new Map();
  sorted.forEach(event => {
    const dateKey = toDateKey(event.messageAtDate);
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(event);
  });

  const activeMembers = new Set();
  const firstDate = startOfDay(sorted[0].messageAtDate);
  const lastDate = startOfDay(sorted[sorted.length - 1].messageAtDate);
  const result = [];
  let cursor = firstDate;

  while (cursor.getTime() <= lastDate.getTime()) {
    const dateKey = toDateKey(cursor);
    const dayEvents = byDate.get(dateKey) || [];
    let joinCount = 0;
    let leaveCount = 0;

    dayEvents.forEach(event => {
      const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
      if (!key) return;
      if (event.eventType === 'join') {
        activeMembers.add(key);
        joinCount += 1;
      } else if (event.eventType === 'leave') {
        activeMembers.delete(key);
        leaveCount += 1;
      }
    });

    result.push({
      date: dateKey,
      memberCount: activeMembers.size,
      joinCount,
      leaveCount
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }

  return result;
}

function buildNicknameDigitStats(customerProfiles) {
  const activeProfiles = customerProfiles.filter(profile => profile.isCurrentMember && !profile.isOperationalUser);
  const missingProfiles = activeProfiles.filter(profile => !profile.hasNicknameDigits4);

  return {
    activeMemberCount: activeProfiles.length,
    missingDigitCount: missingProfiles.length,
    missingDigitRate: percent(missingProfiles.length, activeProfiles.length),
    sampleUsers: missingProfiles.slice(0, 30).map(profile => profile.userName || profile.customerName)
  };
}

function buildOrderDelayStats(customerProfiles) {
  const firstOrderDays = customerProfiles
    .map(profile => profile.daysFromJoinToFirstOrder)
    .filter(value => value != null && value >= 0);
  const secondOrderDays = customerProfiles
    .map(profile => profile.daysFromJoinToSecondOrder)
    .filter(value => value != null && value >= 0);

  return {
    firstOrderCustomerCount: firstOrderDays.length,
    secondOrderCustomerCount: secondOrderDays.length,
    avgDaysToFirstOrder: round1(average(firstOrderDays)),
    medianDaysToFirstOrder: round1(median(firstOrderDays)),
    avgDaysToSecondOrder: round1(average(secondOrderDays)),
    medianDaysToSecondOrder: round1(median(secondOrderDays))
  };
}

function emptyOrderTotal() {
  return {
    quantity: 0,
    orderLineCount: 0,
    revenue: 0,
    customerName: '',
    firstOrderDate: null,
    lastOrderDate: null,
    topProduct: '',
    productCounts: new Map()
  };
}

function estimateActiveMembers(events) {
  const state = new Map();

  events.forEach(event => {
    const key = normalizeCustomerKey(event.memberSubject || event.userName || event.normalizedUser);
    if (!key) return;
    state.set(key, event.eventType);
  });

  return Array.from(state.values()).filter(type => type === 'join').length;
}

function buildLeavePurchaseBuckets(leaverProfiles) {
  const buckets = [
    { key: 'zero', label: '0개', min: 0, max: 0 },
    { key: 'oneToTwo', label: '1~2개', min: 1, max: 2 },
    { key: 'threeToFive', label: '3~5개', min: 3, max: 5 },
    { key: 'sixToTen', label: '6~10개', min: 6, max: 10 },
    { key: 'elevenPlus', label: '11개 이상', min: 11, max: Infinity }
  ];

  return buckets.map(bucket => {
    const count = leaverProfiles.filter(profile =>
      profile.cumulativeQuantity >= bucket.min && profile.cumulativeQuantity <= bucket.max
    ).length;

    return {
      key: bucket.key,
      label: bucket.label,
      count,
      rate: percent(count, leaverProfiles.length)
    };
  });
}

function buildHourlyOrderCounts(matches) {
  const map = new Map();
  matches.forEach(match => {
    const hour = String(match.actualOrderedAt || '').slice(11, 13);
    if (!hour) return;
    map.set(hour, (map.get(hour) || 0) + 1);
  });

  return Array.from({ length: 24 }, (_, hour) => {
    const hourKey = String(hour).padStart(2, '0');
    return {
      hour: `${hourKey}시`,
      hourValue: hour,
      count: map.get(hourKey) || 0
    };
  });
}

function filterMatchesForPeriod(matches, period) {
  if (!period?.from || !period?.to) return matches || [];
  return (matches || []).filter(match => {
    const date = match.actualOrderedAtDate;
    if (!date) return false;
    return date.getTime() >= period.from.getTime() && date.getTime() <= period.to.getTime();
  });
}

function normalizeReportPeriod(period, fallbackEndDate) {
  const from = parseDashboardDate(period?.from);
  const to = parseDashboardDate(period?.to);

  if (from && to) {
    return {
      label: period?.label || '',
      from: startOfDay(from),
      to: endOfDay(to)
    };
  }

  return {
    label: '최근 30일',
    from: startOfDay(new Date(fallbackEndDate.getTime() - 29 * DAY_MS)),
    to: endOfDay(fallbackEndDate)
  };
}

function serializeAnalyticsPeriod(period) {
  if (!period?.from || !period?.to) return null;
  return {
    label: period.label || '',
    from: toDateKey(period.from),
    to: toDateKey(period.to)
  };
}

function firstMatchTime(matches) {
  return [...matches]
    .map(match => match.actualOrderedAt)
    .filter(Boolean)
    .sort()[0] || '';
}

function averageMatchTime(matches) {
  const dates = matches
    .map(match => match.actualOrderedAtDate)
    .filter(Boolean);
  if (!dates.length) return '';
  const avg = dates.reduce((sum, date) => sum + date.getTime(), 0) / dates.length;
  const date = new Date(avg);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function uniqueCount(rows, key) {
  return new Set(rows.map(row => row[key]).filter(Boolean)).size;
}

function normalizeCustomerKey(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '');
}

function hasTrailingFourDigits(value) {
  return /\d{4}\)?\s*$/.test(clean(value));
}

function isOperationalKakaoUser(value) {
  return /전농래미안크레시티점|만만마켓|만만이|오픈채팅봇|매니저|부점장/i.test(clean(value));
}

function diffDaysDecimal(laterDate, earlierDate) {
  if (!laterDate || !earlierDate) return null;
  const diff = laterDate.getTime() - earlierDate.getTime();
  if (!Number.isFinite(diff)) return null;
  return Math.round((diff / DAY_MS) * 10) / 10;
}

function average(values) {
  return values.length
    ? values.reduce((total, value) => total + Number(value || 0), 0) / values.length
    : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round1(value) {
  return value == null || Number.isNaN(Number(value))
    ? null
    : Math.round(Number(value) * 10) / 10;
}

function getLatestValue(rows, key) {
  const values = rows
    .map(row => clean(row[key]))
    .filter(Boolean)
    .sort();
  return values.length ? values[values.length - 1] : '';
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

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function percent(value, denominator) {
  return denominator ? Math.round((value / denominator) * 1000) / 10 : 0;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
