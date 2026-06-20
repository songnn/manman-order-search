import { getSheetsClient } from '../googleSheetsClient.js';
import { readKakaoCsvTelemetry } from './kakaoCsvAnalytics.js';

const sheetCache = globalThis.__mmAdminDashboardSheetCache ||= new Map();
const telemetryCache = globalThis.__mmAdminDashboardTelemetryCache ||= {
  value: null,
  fetchedAt: 0,
  expiresAt: 0,
  promise: null
};

const DEFAULT_SHEET_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_TELEMETRY_CACHE_MS = 2 * 60 * 1000;

export async function readCachedDashboardSheetRows({
  spreadsheetId,
  sheetName,
  startRow,
  force = false
}) {
  const normalizedStart = Math.max(1, Number(startRow || 1));
  const cacheKey = [
    spreadsheetId,
    sheetName,
    normalizedStart
  ].join('::');
  const now = Date.now();
  const ttlMs = Number(process.env.ADMIN_DASHBOARD_SHEET_CACHE_MS || DEFAULT_SHEET_CACHE_MS);
  const cached = sheetCache.get(cacheKey);

  if (!force && cached?.rows && cached.expiresAt > now) {
    return {
      rows: cached.rows,
      meta: cacheMeta('hit', cached.fetchedAt, cached.rows.length)
    };
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const promise = fetchDashboardSheetRows_({
    spreadsheetId,
    sheetName,
    startRow: normalizedStart
  })
    .then(rows => {
      const entry = {
        rows,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
        promise: null
      };
      sheetCache.set(cacheKey, entry);

      return {
        rows,
        meta: cacheMeta(force ? 'refresh' : 'miss', entry.fetchedAt, rows.length)
      };
    })
    .catch(error => {
      if (cached?.rows?.length) {
        console.warn('admin dashboard sheet refresh failed, using stale rows:', error.message);
        return {
          rows: cached.rows,
          meta: {
            ...cacheMeta('stale', cached.fetchedAt, cached.rows.length),
            error: error.message
          }
        };
      }

      throw error;
    })
    .finally(() => {
      const latest = sheetCache.get(cacheKey);
      if (latest?.promise === promise) {
        latest.promise = null;
      }
    });

  sheetCache.set(cacheKey, {
    ...(cached || {}),
    promise
  });

  return promise;
}

export async function readCachedKakaoCsvTelemetry({ force = false } = {}) {
  const now = Date.now();
  const ttlMs = Number(process.env.ADMIN_DASHBOARD_TELEMETRY_CACHE_MS || DEFAULT_TELEMETRY_CACHE_MS);

  if (!force && telemetryCache.value && telemetryCache.expiresAt > now) {
    return {
      telemetry: telemetryCache.value,
      meta: cacheMeta('hit', telemetryCache.fetchedAt)
    };
  }

  if (!force && telemetryCache.promise) {
    return telemetryCache.promise;
  }

  telemetryCache.promise = readKakaoCsvTelemetry({
    maxUploads: Number(process.env.ADMIN_DASHBOARD_KAKAO_UPLOAD_LIMIT || 1)
  })
    .then(telemetry => {
      telemetryCache.value = telemetry;
      telemetryCache.fetchedAt = Date.now();
      telemetryCache.expiresAt = telemetryCache.fetchedAt + ttlMs;

      return {
        telemetry,
        meta: cacheMeta(force ? 'refresh' : 'miss', telemetryCache.fetchedAt)
      };
    })
    .catch(error => {
      if (telemetryCache.value) {
        console.warn('kakao csv telemetry refresh failed, using stale data:', error.message);
        return {
          telemetry: telemetryCache.value,
          meta: {
            ...cacheMeta('stale', telemetryCache.fetchedAt),
            error: error.message
          }
        };
      }

      throw error;
    })
    .finally(() => {
      telemetryCache.promise = null;
    });

  return telemetryCache.promise;
}

async function fetchDashboardSheetRows_({ spreadsheetId, sheetName, startRow }) {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A${startRow}:J`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  return response.data.values || [];
}

function cacheMeta(status, fetchedAt, rowCount) {
  return {
    status,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    ageMs: fetchedAt ? Math.max(0, Date.now() - fetchedAt) : null,
    rowCount
  };
}
