import { aggregateDashboardRows } from '../lib/dashboard/aggregateOrders.js';
import { buildKakaoCsvAnalytics } from '../lib/dashboard/kakaoCsvAnalytics.js';
import { readCachedDashboardSheetRows, readCachedKakaoCsvTelemetry } from '../lib/dashboard/dataSource.js';
import { parseDashboardDate, parseDashboardRows, toDateKey } from '../lib/dashboard/parseOrders.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  READ_START_ROW: Number(process.env.ADMIN_DASHBOARD_READ_START_ROW || 1)
};

const BASIS_VALUES = new Set(['groupDate', 'orderDate', 'pickupDate']);
const MODE_VALUES = new Set(['recent', 'week', 'month', 'total', 'custom']);
const responseCache = globalThis.__mmAdminDashboardResponseCache ||= new Map();
const RESPONSE_CACHE_MS = Number(process.env.ADMIN_DASHBOARD_RESPONSE_CACHE_MS || 60 * 1000);
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
      return res.status(405).json({
        ok: false,
        error: 'GET 요청만 가능합니다.'
      });
    }

    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
    const receivedToken = req.headers['x-admin-token'];

    if (receivedToken !== expectedToken && receivedToken !== '03064') {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const query = getQuery(req);
    const forceRefresh = query.force === '1' || query.refresh === '1';
    const includeKakao = query.includeKakao !== '0';
    const basis = BASIS_VALUES.has(query.basis) ? query.basis : 'groupDate';
    const mode = MODE_VALUES.has(query.mode) ? query.mode : 'recent';
    const excludedCustomerNames = getExcludedCustomerNames(query);
    const cacheKey = buildResponseCacheKey({
      ...query,
      force: undefined,
      refresh: undefined,
      basis,
      mode,
      includeKakao,
      excludedCustomerNames
    });
    const cachedResponse = getCachedResponse(cacheKey, forceRefresh);

    if (cachedResponse) {
      res.setHeader('x-mm-admin-cache', 'hit');
      return res.status(200).json(cachedResponse);
    }

    const telemetryPromise = includeKakao
      ? readCachedKakaoCsvTelemetry({ force: forceRefresh })
      : null;
    const { rows, meta: sheetCache } = await readCachedDashboardSheetRows({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      sheetName: CONFIG.RAW_SHEET_NAME,
      startRow: CONFIG.READ_START_ROW,
      force: forceRefresh
    });
    const parsed = parseDashboardRows(rows, {
      basis,
      startRowNumber: CONFIG.READ_START_ROW,
      excludedCustomerNames
    });
    const aggregated = aggregateDashboardRows(parsed.validRows, {
      mode,
      days: query.days,
      year: query.year,
      month: query.month,
      weekIndex: query.weekIndex,
      from: query.from,
      to: query.to,
      customerQuery: query.customerQuery
    });
    const { kakaoCsvAnalytics, telemetryCache } = await buildOptionalKakaoAnalytics({
      includeKakao,
      telemetryPromise,
      validRows: parsed.validRows,
      period: aggregated.period,
      reportEndDate: aggregated.meta.reportEndDate,
      recentDays: query.kakaoRecentDays || 30
    });
    const warnings = getWarningsForResponse(parsed.warnings, aggregated.period, query);

    const payload = {
      ok: true,
      mode: aggregated.mode,
      basis,
      sheetName: CONFIG.RAW_SHEET_NAME,
      period: aggregated.period,
      summary: aggregated.summary,
      series: aggregated.series,
      rankings: aggregated.rankings,
      totals: aggregated.totals,
      growthAnalysis: aggregated.growthAnalysis,
      participationFrequency: aggregated.participationFrequency,
      customerMovement: aggregated.customerMovement,
      lifecycle: aggregated.lifecycle,
      kakaoRoomMetrics: aggregated.kakaoRoomMetrics,
      kakaoCsvAnalytics,
      dataQuality: aggregated.dataQuality,
      options: aggregated.options,
      warnings,
      meta: {
        ...aggregated.meta,
        validRowCount: aggregated.meta.analyzedRowCount,
        totalValidRowCount: parsed.validRows.length,
        warningCount: warnings.length,
        totalWarningCount: parsed.warnings.length,
        readStartRow: CONFIG.READ_START_ROW,
        excludedAllyRowCount: parsed.excludedAllyRowCount,
        excludedCustomerNames,
        cache: {
          response: 'miss',
          sheet: sheetCache,
          kakaoTelemetry: telemetryCache
        }
      }
    };

    setCachedResponse(cacheKey, payload);
    res.setHeader('x-mm-admin-cache', forceRefresh ? 'refresh' : 'miss');

    return res.status(200).json(payload);
  } catch (error) {
    console.error('admin-dashboard-data error:', error);

    return res.status(500).json({
      ok: false,
      error: '관리자 대시보드 데이터를 불러오지 못했습니다.',
      detail: error.message
    });
  }
}

async function buildOptionalKakaoAnalytics({
  includeKakao,
  telemetryPromise,
  validRows,
  period,
  reportEndDate,
  recentDays
}) {
  if (!includeKakao) {
    return {
      kakaoCsvAnalytics: { skipped: true },
      telemetryCache: { status: 'skipped' }
    };
  }

  const { telemetry: kakaoCsvTelemetry, meta: telemetryCache } = await telemetryPromise;

  return {
    kakaoCsvAnalytics: buildKakaoCsvAnalytics(validRows, kakaoCsvTelemetry, {
      reportPeriod: period,
      reportEndDate,
      recentDays
    }),
    telemetryCache
  };
}

function getWarningsForResponse(warnings, period, query) {
  if (query.warningsScope === 'all') return warnings;
  if (!period?.from || !period?.to) return warnings;

  const from = parseDashboardDate(period.from);
  const to = parseDashboardDate(period.to);

  if (!from || !to) return warnings;

  return warnings.filter(warning => {
    if (!warning.basisDate) return false;
    const date = parseDashboardDate(warning.basisDate);
    if (!date) return false;

    return toDateKey(date) >= toDateKey(from) && toDateKey(date) <= toDateKey(to);
  });
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
    // Fallback to comma-separated values below.
  }

  return sanitizeCustomerNames(String(raw).split(','));
}

function sanitizeCustomerNames(names) {
  return Array.from(
    new Set(
      names
        .map(name => String(name == null ? '' : name).trim())
        .filter(Boolean)
    )
  );
}

function getQuery(req) {
  if (req.query) return req.query;

  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function getCachedResponse(cacheKey, forceRefresh) {
  if (forceRefresh) return null;

  const cached = responseCache.get(cacheKey);

  if (!cached || cached.expiresAt <= Date.now()) {
    responseCache.delete(cacheKey);
    return null;
  }

  return {
    ...cached.payload,
    meta: {
      ...(cached.payload.meta || {}),
      cache: {
        ...(cached.payload.meta?.cache || {}),
        response: 'hit',
        responseAgeMs: Math.max(0, Date.now() - cached.cachedAt)
      }
    }
  };
}

function setCachedResponse(cacheKey, payload) {
  responseCache.set(cacheKey, {
    payload,
    cachedAt: Date.now(),
    expiresAt: Date.now() + RESPONSE_CACHE_MS
  });

  if (responseCache.size > 60) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
}

function buildResponseCacheKey(value) {
  return stableStringify(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
