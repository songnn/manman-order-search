import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { getSheetsClient, getSpreadsheetId } from './googleSheetsClient.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const DISCOUNT_TIMEZONE = 'Asia/Seoul';

const DISCOUNT_SHEET_RANGE = "'할인상품'!A2:H";
const DISCOUNT_CACHE_TTL_MS = 30 * 1000;
const DISCOUNT_IMAGE_PLACEHOLDER =
  'https://picsum.photos/seed/manman-discount-placeholder/1200/1200';

const COL = {
  START_DATE: 0,
  END_DATE: 1,
  PRODUCT_NAME: 2,
  IMAGE_URL: 3,
  SALE_PRICE: 4,
  GROUP_PRICE: 5,
  ONLINE_LOWEST_PRICE: 6,
  DESCRIPTION: 7
};

let rowsCache = {
  expiresAt: 0,
  rows: null
};

export async function getActiveDiscountProducts({ now = dayjs().tz(DISCOUNT_TIMEZONE) } = {}) {
  const nowKst = toKstDayjs(now);
  const rows = await readDiscountRows();
  const normalized = [];

  rows.forEach((row, index) => {
    try {
      const item = normalizeDiscountRow(row, index);
      if (item) normalized.push(item);
    } catch (error) {
      console.warn(`discount-products row ${index + 2} skipped:`, error);
    }
  });

  const nowMs = nowKst.valueOf();
  const activeItems = normalized
    .filter(item => item._startsAtMs <= nowMs && nowMs < item._endsAtMs)
    .sort((a, b) => a._startsAtMs - b._startsAtMs || a.sheetRow - b.sheetRow)
    .map(stripInternalFields);

  return {
    timezone: DISCOUNT_TIMEZONE,
    serverNow: nowKst.toISOString(),
    nextChangeAt: getNextChangeAt(normalized, nowMs),
    items: activeItems
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
    ? '온라인최저가'
    : groupPrice
      ? '정상판매가'
      : null;
  const discountRate = calculateDiscountRate(salePrice, comparePrice);

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
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    comparePrice,
    comparePriceLabel,
    discountRate,
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

async function readDiscountRows() {
  const now = Date.now();

  if (rowsCache.rows && rowsCache.expiresAt > now) {
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
  const { _startsAtMs, _endsAtMs, ...publicItem } = item;
  return publicItem;
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
