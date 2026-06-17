import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getSheetsClient, getSpreadsheetId } from './googleSheetsClient.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const DISCOUNT_TIMEZONE = 'Asia/Seoul';

const DISCOUNT_SHEET_RANGE = "'할인상품'!A2:M";
const DISCOUNT_ASSET_WRITE_RANGE_PREFIX = "'할인상품'!";
const DISCOUNT_CACHE_TTL_MS = 30 * 1000;
const DISCOUNT_IMAGE_PLACEHOLDER =
  'https://picsum.photos/seed/manman-discount-placeholder/1200/1200';
const DISCOUNT_ASSET_MANIFEST_URL = new URL(
  '../public/discount-assets/manifest.json',
  import.meta.url
);
const DISCOUNT_PRODUCT_SNAPSHOT_URL = new URL(
  './discount-products-data.json',
  import.meta.url
);

const COL = {
  START_DATE: 0,
  END_DATE: 1,
  PRODUCT_NAME: 2,
  IMAGE_URL: 3,
  SALE_PRICE: 4,
  GROUP_PRICE: 5,
  ONLINE_LOWEST_PRICE: 6,
  DESCRIPTION: 7,
  THEME_COLOR: 8,
  THEME_ICON_URL: 9,
  STORAGE_LOCATION: 10,
  STOCK_QUANTITY: 11,
  CATEGORY: 12
};

const FALLBACK_THEME_COLORS = [
  '#F2DE95',
  '#BEE7DC',
  '#F4B8A8',
  '#C9D7FF',
  '#D9C7A0',
  '#BFE3A0',
  '#F7CFE1',
  '#D4C4FF'
];

let rowsCache = {
  expiresAt: 0,
  rows: null
};

let assetManifestCache = {
  loadedAt: 0,
  manifest: null
};

let snapshotCache = {
  loadedAt: 0,
  payload: null
};

let backgroundRowsRefreshPromise = null;

export async function getActiveDiscountProducts({
  now = dayjs().tz(DISCOUNT_TIMEZONE),
  preferSnapshot = false,
  refreshInBackground = false,
  sheetTimeoutMs = 0,
  maxSheetRow = null
} = {}) {
  const nowKst = toKstDayjs(now);
  const rowFilter = normalizeSheetRowFilter({ maxSheetRow });

  if (preferSnapshot) {
    if (rowsCache.rows && rowsCache.expiresAt > Date.now()) {
      return buildActiveDiscountProductsPayload(
        normalizeDiscountRows(rowsCache.rows),
        nowKst,
        { source: 'sheet-cache', rowFilter }
      );
    }

    if (sheetTimeoutMs > 0) {
      const rowsPromise = readDiscountRows({ force: true });

      if (refreshInBackground) {
        trackDiscountRowsRefresh(rowsPromise);
      }

      try {
        const rows = await withTimeout(rowsPromise, sheetTimeoutMs);

        return buildActiveDiscountProductsPayload(
          normalizeDiscountRows(rows),
          nowKst,
          { source: 'sheet', rowFilter }
        );
      } catch (error) {
        if (error?.name !== 'TimeoutError') {
          console.warn('discount-products sheet refresh failed, falling back to snapshot:', error);
        }
      }
    }

    const snapshotResult = getActiveDiscountProductsFromSnapshot(nowKst, { rowFilter });
    if (snapshotResult) {
      if (refreshInBackground) refreshDiscountRowsInBackground();
      return snapshotResult;
    }
  }

  const rows = await readDiscountRows();

  return buildActiveDiscountProductsPayload(
    normalizeDiscountRows(rows),
    nowKst,
    { source: 'sheet', rowFilter }
  );
}

function normalizeDiscountRows(rows) {
  const normalized = [];

  rows.forEach((row, index) => {
    try {
      const item = normalizeDiscountRow(row, index);
      if (item) normalized.push(item);
    } catch (error) {
      console.warn(`discount-products row ${index + 2} skipped:`, error);
    }
  });

  return normalized;
}

function buildActiveDiscountProductsPayload(normalized, nowKst, meta = {}) {
  const nowMs = nowKst.valueOf();
  const rowFilter = meta.rowFilter || {};
  const eligibleItems = normalized.filter(item => {
    if (Number.isInteger(rowFilter.maxSheetRow) && item.sheetRow > rowFilter.maxSheetRow) {
      return false;
    }

    return true;
  });
  const activeItems = eligibleItems
    .filter(item => item._startsAtMs <= nowMs && nowMs < item._endsAtMs)
    .sort((a, b) => a._startsAtMs - b._startsAtMs || a.sheetRow - b.sheetRow)
    .map(stripInternalFields);

  return {
    timezone: DISCOUNT_TIMEZONE,
    serverNow: nowKst.toISOString(),
    nextChangeAt: getNextChangeAt(eligibleItems, nowMs),
    items: activeItems,
    source: meta.source || 'sheet',
    snapshotGeneratedAt: meta.snapshotGeneratedAt || null
  };
}

function getActiveDiscountProductsFromSnapshot(nowKst, options = {}) {
  const snapshot = readDiscountProductSnapshot();
  const snapshotItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
  if (!snapshotItems.length) return null;

  const normalized = snapshotItems
    .map((item, index) => normalizeSnapshotDiscountItem(item, index))
    .filter(Boolean);

  if (!normalized.length) return null;

  const result = buildActiveDiscountProductsPayload(normalized, nowKst, {
    source: 'snapshot',
    snapshotGeneratedAt: snapshot.generatedAt || null,
    rowFilter: options.rowFilter || {}
  });

  return result;
}

function normalizeSheetRowFilter(options = {}) {
  const maxSheetRow = Number(options.maxSheetRow);

  return {
    maxSheetRow: Number.isInteger(maxSheetRow) && maxSheetRow >= 2 ? maxSheetRow : null
  };
}

function normalizeSnapshotDiscountItem(item, index) {
  const startsAtMs = Date.parse(item?.startsAt || '');
  const endsAtMs = Date.parse(item?.endsAt || '');

  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) return null;

  return {
    ...item,
    sheetRow: Number(item.sheetRow || index + 2),
    _startsAtMs: startsAtMs,
    _endsAtMs: endsAtMs
  };
}

function readDiscountProductSnapshot() {
  if (snapshotCache.payload) return snapshotCache.payload;

  try {
    const payload = JSON.parse(fs.readFileSync(DISCOUNT_PRODUCT_SNAPSHOT_URL, 'utf8'));
    snapshotCache = {
      loadedAt: Date.now(),
      payload
    };

    return payload;
  } catch {
    snapshotCache = {
      loadedAt: Date.now(),
      payload: null
    };

    return null;
  }
}

function refreshDiscountRowsInBackground() {
  if (backgroundRowsRefreshPromise) return;

  trackDiscountRowsRefresh(readDiscountRows({ force: true }));
}

function trackDiscountRowsRefresh(promise) {
  if (backgroundRowsRefreshPromise) return;

  backgroundRowsRefreshPromise = promise
    .catch(error => {
      console.warn('discount-products background refresh failed:', error);
    })
    .finally(() => {
      backgroundRowsRefreshPromise = null;
    });
}

function withTimeout(promise, timeoutMs) {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`discount-products sheet read timed out after ${timeoutMs}ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

export async function getAllDiscountProductsForAssets(options = {}) {
  const { includeSheetAssetFields = false } = options;
  const rows = await readDiscountRows();

  return rows
    .map((row, index) => {
      try {
        return normalizeDiscountRow(row, index);
      } catch (error) {
        console.warn(`discount-products asset row ${index + 2} skipped:`, error);
        return null;
      }
    })
    .filter(Boolean)
    .map(item => includeSheetAssetFields ? stripRuntimeFields(item) : stripInternalFields(item));
}

export async function updateDiscountProductAssetCells(updates = []) {
  const data = updates
    .filter(update => {
      return Number.isInteger(update?.sheetRow) &&
        update.sheetRow >= 2 &&
        normalizeDiscountThemeColor(update.themeColor) &&
        normalizeDiscountThemeIconUrl(update.themeIconUrl);
    })
    .map(update => ({
      range: `${DISCOUNT_ASSET_WRITE_RANGE_PREFIX}I${update.sheetRow}:J${update.sheetRow}`,
      values: [[
        normalizeDiscountThemeColor(update.themeColor),
        normalizeDiscountThemeIconUrl(update.themeIconUrl)
      ]]
    }));

  if (!data.length) return { updatedRanges: [] };

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      valueInputOption: 'RAW',
      data
    }
  });

  rowsCache = {
    expiresAt: 0,
    rows: null
  };

  return {
    updatedRanges: response.data.responses?.map(item => item.updatedRange).filter(Boolean) || []
  };
}

export function normalizeDiscountRow(row, index) {
  const sheetRow = index + 2;
  const startsAt = parseDiscountDate(row?.[COL.START_DATE]);
  const explicitEndDate = parseDiscountDate(row?.[COL.END_DATE]);
  const productName = clean(row?.[COL.PRODUCT_NAME]);
  const rawImageUrl = clean(row?.[COL.IMAGE_URL]);
  const salePrice = parsePrice(row?.[COL.SALE_PRICE]);

  if (!startsAt || !productName || !rawImageUrl || !salePrice) {
    return null;
  }

  const endsAt = explicitEndDate ? explicitEndDate.add(1, 'day') : startsAt.add(1, 'day');

  if (!endsAt.isAfter(startsAt)) {
    console.warn(`discount-products row ${sheetRow}: 종료일이 시작일보다 빠릅니다.`);
    return null;
  }

  const groupPrice = parsePrice(row?.[COL.GROUP_PRICE]);
  const onlineLowestPrice = parsePrice(row?.[COL.ONLINE_LOWEST_PRICE]);
  const comparePrice = onlineLowestPrice || groupPrice || null;
  const comparePriceLabel = onlineLowestPrice
    ? '온라인 최저가'
    : groupPrice
      ? '정상판매가'
      : null;
  const discountRate = calculateDiscountRate(salePrice, comparePrice);
  const assetKey = getDiscountAssetKey(productName);
  const manifestAsset = getDiscountAssetManifestItem(assetKey);
  const themeColor =
    normalizeDiscountThemeColor(row?.[COL.THEME_COLOR]) ||
    normalizeDiscountThemeColor(manifestAsset?.themeColor) ||
    getFallbackDiscountThemeColor(productName);
  const themeIconUrl =
    normalizeDiscountThemeIconUrl(row?.[COL.THEME_ICON_URL]) ||
    normalizeDiscountThemeIconUrl(manifestAsset?.themeIconUrl) ||
    null;

  if (comparePrice && discountRate == null) {
    console.warn(
      `discount-products row ${sheetRow}: 할인가가 비교 기준 가격 이상입니다.`,
      { salePrice, comparePrice }
    );
  }

  return {
    id: `discount-product-row-${sheetRow}`,
    sheetRow,
    productName,
    imageUrl: normalizeImageUrl(rawImageUrl),
    salePrice,
    groupPrice,
    onlineLowestPrice,
    description: clean(row?.[COL.DESCRIPTION]),
    storageLocation: clean(row?.[COL.STORAGE_LOCATION]),
    stockQuantity: parseStockQuantity(row?.[COL.STOCK_QUANTITY]),
    category: clean(row?.[COL.CATEGORY]),
    assetKey,
    themeColor,
    themeIconUrl,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    comparePrice,
    comparePriceLabel,
    discountRate,
    _sheetThemeColor: normalizeDiscountThemeColor(row?.[COL.THEME_COLOR]),
    _sheetThemeIconUrl: normalizeDiscountThemeIconUrl(row?.[COL.THEME_ICON_URL]),
    _startsAtMs: startsAt.valueOf(),
    _endsAtMs: endsAt.valueOf()
  };
}

export function calculateDiscountRate(salePrice, comparePrice) {
  if (!salePrice || !comparePrice || salePrice >= comparePrice) return null;

  const rate = ((comparePrice - salePrice) / comparePrice) * 100;
  const rounded = Math.round(rate);

  return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

export function parsePrice(value) {
  const text = clean(value).replace(/[,\s원₩]/g, '');
  const n = Number(text);

  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseStockQuantity(value) {
  if (value == null || value === '') return null;

  const text = clean(value).replace(/[,\s개]/g, '');
  const n = Number(text);

  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseDiscountDate(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    return createKstStartOfDay(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate()
    );
  }

  if (typeof value === 'number') {
    return parseGoogleSheetsSerialDate(value);
  }

  const raw = clean(value);
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 30000) {
    return parseGoogleSheetsSerialDate(Number(raw));
  }

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  const year = Number(nums[0]);
  const month = Number(nums[1]);
  const day = Number(nums[2]);

  if (year < 1000) return null;

  return createKstStartOfDay(year, month, day);
}

async function readDiscountRows(options = {}) {
  const { force = false } = options;
  const now = Date.now();

  if (!force && rowsCache.rows && rowsCache.expiresAt > now) {
    return rowsCache.rows;
  }

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: DISCOUNT_SHEET_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  const rows = response.data.values || [];

  rowsCache = {
    expiresAt: now + DISCOUNT_CACHE_TTL_MS,
    rows
  };

  return rows;
}

function getNextChangeAt(items, nowMs) {
  const nextMs = items.reduce((min, item) => {
    const candidates = [];

    if (item._startsAtMs > nowMs) candidates.push(item._startsAtMs);
    if (item._startsAtMs <= nowMs && item._endsAtMs > nowMs) candidates.push(item._endsAtMs);

    candidates.forEach(candidate => {
      if (candidate > nowMs && (!min || candidate < min)) {
        min = candidate;
      }
    });

    return min;
  }, 0);

  return nextMs ? dayjs(nextMs).tz(DISCOUNT_TIMEZONE).toISOString() : null;
}

function stripInternalFields(item) {
  const { _startsAtMs, _endsAtMs, _sheetThemeColor, _sheetThemeIconUrl, ...publicItem } = item;
  return publicItem;
}

function stripRuntimeFields(item) {
  const { _startsAtMs, _endsAtMs, ...assetItem } = item;
  return assetItem;
}

export function getDiscountAssetKey(productName) {
  return crypto
    .createHash('sha1')
    .update(clean(productName).toLowerCase())
    .digest('hex')
    .slice(0, 14);
}

export function getFallbackDiscountThemeColor(productName) {
  return FALLBACK_THEME_COLORS[0];
}

function getDiscountAssetManifestItem(assetKey) {
  if (!assetKey) return null;

  const manifest = readDiscountAssetManifest();

  return manifest?.items?.[assetKey] || null;
}

function readDiscountAssetManifest() {
  const now = Date.now();
  if (assetManifestCache.manifest && now - assetManifestCache.loadedAt < DISCOUNT_CACHE_TTL_MS) {
    return assetManifestCache.manifest;
  }

  try {
    const text = fs.readFileSync(DISCOUNT_ASSET_MANIFEST_URL, 'utf8');
    const manifest = JSON.parse(text);

    assetManifestCache = {
      loadedAt: now,
      manifest
    };

    return manifest;
  } catch {
    assetManifestCache = {
      loadedAt: now,
      manifest: { version: 1, items: {} }
    };

    return assetManifestCache.manifest;
  }
}

function normalizeDiscountThemeColor(value) {
  const text = clean(value);
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return '';

  if (text.length === 4) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toUpperCase();
  }

  return text.toUpperCase();
}

function normalizeDiscountThemeIconUrl(value) {
  const text = clean(value);
  if (!text) return '';

  if (text.startsWith('/')) return text;

  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch {
    // Fallback below.
  }

  return '';
}

function parseGoogleSheetsSerialDate(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const date = dayjs.utc('1899-12-30T00:00:00Z').add(Math.floor(serial), 'day');

  return createKstStartOfDay(
    Number(date.format('YYYY')),
    Number(date.format('M')),
    Number(date.format('D'))
  );
}

function createKstStartOfDay(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;

  const dateKey = [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-');
  const parsed = dayjs(dateKey, 'YYYY-MM-DD', true);

  if (!parsed.isValid()) return null;

  return dayjs.tz(`${dateKey} 00:00:00`, 'YYYY-MM-DD HH:mm:ss', DISCOUNT_TIMEZONE);
}

function toKstDayjs(value) {
  if (dayjs.isDayjs(value)) return value.tz(DISCOUNT_TIMEZONE);

  return dayjs(value).tz(DISCOUNT_TIMEZONE);
}

function normalizeImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch {
    // Fallback below.
  }

  return DISCOUNT_IMAGE_PLACEHOLDER;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
