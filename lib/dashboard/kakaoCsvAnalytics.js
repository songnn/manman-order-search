import { readKakaoCsvStore } from '../kakaoCsvProcessing.js';
import { parseDashboardDate, toDateKey } from './parseOrders.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function readKakaoCsvTelemetry() {
  return readKakaoCsvStore();
}

export function buildKakaoCsvAnalytics(orderRows, telemetry, options = {}) {
  const reportEndDate = endOfDay(parseDashboardDate(options.reportEndDate) || new Date());
  const recentDays = Number(options.recentDays || 30);
  const fromDate = startOfDay(new Date(reportEndDate.getTime() - (recentDays - 1) * DAY_MS));
  const uploads = [...(telemetry.uploads || [])].sort((a, b) =>
    String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || ''))
  );
  const latestUpload = uploads[0] || null;
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
  const orderTotals = buildOrderTotalsByCustomer(orderRows || []);
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
      hourlyOrderCounts: buildHourlyOrderCounts(orderMatches)
    },
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

function buildJoinProfiles(events, orderTotals) {
  const joins = new Map();
  events.forEach(event => {
    if (event.eventType !== 'join') return;
    const key = event.normalizedUser || normalizeCustomerKey(event.memberSubject);
    if (!key) return;
    joins.set(key, event);
  });

  return Array.from(joins.values()).map(event => {
    const key = event.normalizedUser || normalizeCustomerKey(event.memberSubject);
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
    const key = event.normalizedUser || normalizeCustomerKey(event.memberSubject);
    if (!key) return;
    leaves.set(key, event);
  });

  return Array.from(leaves.values()).map(event => {
    const key = event.normalizedUser || normalizeCustomerKey(event.memberSubject);
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

function emptyOrderTotal() {
  return {
    quantity: 0,
    orderLineCount: 0,
    revenue: 0,
    firstOrderDate: null,
    lastOrderDate: null,
    topProduct: '',
    productCounts: new Map()
  };
}

function estimateActiveMembers(events) {
  const state = new Map();

  events.forEach(event => {
    const key = event.normalizedUser || normalizeCustomerKey(event.memberSubject);
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

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, count]) => ({ hour: `${hour}시`, count }));
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
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
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
