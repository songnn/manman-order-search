import { getSheetsClient } from './googleSheetsClient.js';
import {
  PRODUCT_STORAGE_SOURCE_SHEET,
  readProductStorageCatalog,
  resolveProductStorage
} from './productStorage.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import {
  readTimeSaleOrderRowsForOrderCache,
  TIME_SALE_ORDER_SHEET_NAME
} from './timeSaleOrders.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  ORDER_INDEX_SHEET_NAME: process.env.ORDER_INDEX_SHEET_NAME || '발주요청(Index)',
  RAW_READ_START_ROW: Number(process.env.RAW_READ_START_ROW || 6000),
  CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP: Number(process.env.CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP || 7)
};

const RAW_FORMULA_COL = {
  GROUP_DATE: 0,
  PRICE: 1,
  IMAGE_URL: 2,
  ORDER_DATE: 3,
  CUSTOMER_NAME: 4,
  PRODUCT_NAME: 5,
  QUANTITY: 6,
  NOTE: 8,
  PICKUP_DATE: 9
};

const ORDER_INDEX_COL = {
  GROUP_DATE: 0,
  PRODUCT_NAME: 3,
  PICKUP_DATE: 5,
  PRICE: 6,
  IMAGE_URL: 7
};

export async function searchOrders(keyword, selectedCustomerLabel) {
  keyword = clean_(keyword);
  selectedCustomerLabel = normalizeDisplayCustomerLabel_(selectedCustomerLabel);

  if (!keyword) {
    return {
      ok: false,
      message: '닉네임 또는 핸드폰 뒷 4자리를 입력해주세요.',
      items: []
    };
  }

  const rawRows = await readRowsFromSupabase_(keyword);

  if (!rawRows.length) {
    return {
      ok: true,
      searched: keyword,
      selectedCustomerLabel: '',
      requiresCustomerSelection: false,
      storeName: CONFIG.STORE_NAME,
      items: []
    };
  }

  const matchedRows = rawRows.filter(row => matchesCustomer_(row.customerName, keyword));

  if (!matchedRows.length) {
    return {
      ok: true,
      searched: keyword,
      selectedCustomerLabel: '',
      requiresCustomerSelection: false,
      storeName: CONFIG.STORE_NAME,
      items: []
    };
  }

  const visibleMatchedRows = matchedRows.filter(isVisibleToCustomer_);

  if (!visibleMatchedRows.length) {
    return {
      ok: true,
      searched: keyword,
      selectedCustomerLabel: '',
      requiresCustomerSelection: false,
      storeName: CONFIG.STORE_NAME,
      items: []
    };
  }

  const candidateInfo = buildCandidateInfo_(visibleMatchedRows);
  const hasSelectableCandidates = candidateInfo.length >= 2;

  if (hasSelectableCandidates) {
    const hasValidSelection = candidateInfo.some(candidate =>
      normalizeDisplayCustomerLabel_(candidate.customerLabel) === selectedCustomerLabel
    );

    if (!selectedCustomerLabel || !hasValidSelection) {
      return {
        ok: true,
        searched: keyword,
        selectedCustomerLabel: '',
        requiresCustomerSelection: true,
        storeName: CONFIG.STORE_NAME,
        candidates: candidateInfo,
        items: []
      };
    }
  }

  const filteredRows = hasSelectableCandidates
    ? visibleMatchedRows.filter(row =>
        normalizeDisplayCustomerLabel_(row.customerName) === selectedCustomerLabel
      )
    : visibleMatchedRows;

  const grouped = {};

  filteredRows.forEach(row => {
    const groupKey = [
      normalizeDisplayCustomerLabel_(row.customerName),
      normalizeProductKey_(row.productName),
      clean_(row.orderDate),
      clean_(row.pickupDate),
      String(row.price || 0),
      clean_(row.imageUrl)
    ].join('||');

    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        orderDate: row.orderDate,
        pickupDate: row.pickupDate,
        productName: row.productName,
        quantity: 0,
        price: row.price,
        imageUrl: row.imageUrl,
        customerLabel: normalizeDisplayCustomerLabel_(row.customerName),
        orderDateValue: dateTextToNumber_(row.orderDate),
        pickupDateValue: dateTextToNumber_(row.pickupDate),
        isTimeSaleOrder: row.sourceSheetName === TIME_SALE_ORDER_SHEET_NAME
      };
    }

    grouped[groupKey].quantity += row.quantity;
    grouped[groupKey].isTimeSaleOrder =
      grouped[groupKey].isTimeSaleOrder || row.sourceSheetName === TIME_SALE_ORDER_SHEET_NAME;
  });

  const groupedItems = Object.values(grouped);
  let productStorageCatalog = new Map();
  let productStorageAvailable = true;
  const configuredStorageTimeout = Number(process.env.PRODUCT_STORAGE_LOOKUP_TIMEOUT_MS || 1500);
  const storageTimeoutMs = Number.isFinite(configuredStorageTimeout)
    ? Math.max(250, configuredStorageTimeout)
    : 1500;

  try {
    productStorageCatalog = await withTimeout_(
      readProductStorageCatalog(
        groupedItems.map(item => item.productName),
        { storeName: CONFIG.STORE_NAME }
      ),
      storageTimeoutMs
    );
  } catch (error) {
    productStorageAvailable = false;
    console.warn('product storage lookup skipped:', error.message);
  }

  const items = groupedItems
    .sort((a, b) => {
      if (a.pickupDateValue !== b.pickupDateValue) {
        return a.pickupDateValue - b.pickupDateValue;
      }

      if (a.orderDateValue !== b.orderDateValue) {
        return a.orderDateValue - b.orderDateValue;
      }

      return String(a.productName || '').localeCompare(String(b.productName || ''), 'ko');
    })
    .map(item => {
      const productStorage = productStorageAvailable
        ? resolveProductStorage(productStorageCatalog, item.productName, item.pickupDate)
        : {
            storageMethod: null,
            storageMethodStatus: 'unavailable',
            storageMethodSource: null
          };

      return {
        orderDate: item.orderDate,
        pickupDate: item.pickupDate,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
        imageUrl: item.imageUrl,
        customerLabel: item.customerLabel,
        orderDateValue: item.orderDateValue,
        pickupDateValue: item.pickupDateValue,
        isTimeSaleOrder: Boolean(item.isTimeSaleOrder),
        ...productStorage
      };
    });

  const storageStatusCounts = items.reduce((counts, item) => {
    const status = item.storageMethodStatus || 'pending';
    counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});

  return {
    ok: true,
    searched: keyword,
    selectedCustomerLabel: hasSelectableCandidates ? selectedCustomerLabel : '',
    requiresCustomerSelection: false,
    storeName: CONFIG.STORE_NAME,
    productStorage: {
      sourceSheetName: PRODUCT_STORAGE_SOURCE_SHEET,
      available: productStorageAvailable,
      confirmedItemCount: Number(storageStatusCounts.confirmed || 0),
      pendingItemCount: Number(storageStatusCounts.pending || 0),
      conflictItemCount: Number(storageStatusCounts.conflict || 0),
      unavailableItemCount: Number(storageStatusCounts.unavailable || 0)
    },
    items
  };
}

async function getSheetsClient_() {
  return getSheetsClient();
}

async function readUnifiedRows_() {
  return readUnifiedRowsFromFormula_({ requireCustomerName: true });
}

export async function readUnifiedRowsWithRowNumbers_() {
  return readUnifiedRowsFromFormula_({ requireCustomerName: false });
}

async function readUnifiedRowsFromFormula_({ requireCustomerName }) {
  const sheets = await getSheetsClient_();

  const start = Math.max(1, Number(CONFIG.RAW_READ_START_ROW || 1));
  const sheetName = CONFIG.RAW_SHEET_NAME;

  const [rawResponse, indexResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `'${escapeSheetName_(sheetName)}'!A${start}:J`,
      valueRenderOption: 'FORMATTED_VALUE'
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `'${escapeSheetName_(CONFIG.ORDER_INDEX_SHEET_NAME)}'!A2:H`,
      valueRenderOption: 'FORMULA'
    })
  ]);

  const productIndex = buildOrderIndexByProduct_(indexResponse.data.values || []);
  const result = [];

  (rawResponse.data.values || []).forEach((row, index) => {
    const orderDate = sheetDateValueToText_(row[RAW_FORMULA_COL.ORDER_DATE]);
    const orderDateValue = sheetDateValueToNumber_(row[RAW_FORMULA_COL.ORDER_DATE]);
    const customerName = cleanNonFormula_(row[RAW_FORMULA_COL.CUSTOMER_NAME]);
    const productName = cleanNonFormula_(row[RAW_FORMULA_COL.PRODUCT_NAME]);
    const quantity = parseQuantity_(row[RAW_FORMULA_COL.QUANTITY]);
    const note = cleanNonFormula_(row[RAW_FORMULA_COL.NOTE]);

    const indexRows = productIndex.get(normalizeProductKey_(productName)) || [];
    const groupDateValue =
      sheetDateValueToNumber_(row[RAW_FORMULA_COL.GROUP_DATE]) ||
      resolveGroupDateValue_(indexRows, orderDateValue);
    const price =
      parsePrice_(cleanNonFormula_(row[RAW_FORMULA_COL.PRICE])) ||
      resolvePrice_(indexRows, groupDateValue);
    const imageUrl =
      cleanNonFormula_(row[RAW_FORMULA_COL.IMAGE_URL]) ||
      resolveImageUrl_(indexRows);
    const pickupDateValue =
      sheetDateValueToNumber_(row[RAW_FORMULA_COL.PICKUP_DATE]) ||
      resolvePickupDateValue_(indexRows, orderDateValue);
    const pickupDate = dateNumberToDisplayText_(pickupDateValue);

    const isEmptyRow =
      !orderDate &&
      !customerName &&
      !productName &&
      !cleanNonFormula_(row[RAW_FORMULA_COL.QUANTITY]) &&
      !pickupDate;

    if (isEmptyRow) return;
    if (!productName) return;
    if (requireCustomerName && !customerName) return;

    result.push({
      sourceSheetName: sheetName,
      sourceRowNumber: start + index,
      pickupDate,
      price,
      imageUrl,
      orderDate,
      customerName,
      productName,
      note,
      quantity
    });
  });

  try {
    result.push(...await readTimeSaleOrderRowsForOrderCache());
  } catch (error) {
    console.warn('time-sale order rows skipped:', error.message);
  }

  return result;
}

function buildOrderIndexByProduct_(rows) {
  const map = new Map();

  rows.forEach(row => {
    const productName = cleanNonFormula_(row[ORDER_INDEX_COL.PRODUCT_NAME]);
    if (!productName) return;

    const key = normalizeProductKey_(productName);
    const items = map.get(key) || [];

    items.push({
      groupDateValue: sheetDateValueToNumber_(row[ORDER_INDEX_COL.GROUP_DATE]),
      pickupDateValue: sheetDateValueToNumber_(row[ORDER_INDEX_COL.PICKUP_DATE]),
      price: parsePrice_(cleanNonFormula_(row[ORDER_INDEX_COL.PRICE])),
      imageUrl: cleanNonFormula_(row[ORDER_INDEX_COL.IMAGE_URL])
    });

    map.set(key, items);
  });

  return map;
}

function resolveGroupDateValue_(indexRows, orderDateValue) {
  if (!Number.isFinite(orderDateValue)) return null;

  return indexRows
    .map(row => row.groupDateValue)
    .filter(value => Number.isFinite(value) && value <= orderDateValue)
    .sort((a, b) => b - a)[0] || null;
}

function resolvePrice_(indexRows, groupDateValue) {
  const scopedRows = indexRows.filter(row =>
    Number(row.price || 0) > 0 &&
    (
      !Number.isFinite(groupDateValue) ||
      !Number.isFinite(row.groupDateValue) ||
      row.groupDateValue >= groupDateValue
    )
  );

  const rows = scopedRows.length ? scopedRows : indexRows;

  return rows
    .map(row => Number(row.price || 0))
    .filter(price => price > 0)
    .sort((a, b) => a - b)[0] || 0;
}

function resolveImageUrl_(indexRows) {
  return indexRows.find(row => row.imageUrl)?.imageUrl || '';
}

function resolvePickupDateValue_(indexRows, orderDateValue) {
  if (!Number.isFinite(orderDateValue)) return null;

  return indexRows
    .map(row => row.pickupDateValue)
    .filter(value => Number.isFinite(value) && value >= orderDateValue)
    .sort((a, b) => a - b)[0] || null;
}

function cleanNonFormula_(value) {
  const text = clean_(value);
  return text.startsWith('=') ? '' : text;
}

function escapeSheetName_(sheetName) {
  return String(sheetName || '').replace(/'/g, "''");
}

function sheetDateValueToText_(value) {
  const serial = sheetSerialNumber_(value);
  if (serial != null) return serialToDisplayText_(serial);

  return cleanNonFormula_(value);
}

function sheetDateValueToNumber_(value) {
  const serial = sheetSerialNumber_(value);
  if (serial != null) return serialToDateNumber_(serial);

  const text = cleanNonFormula_(value);
  if (!text) return null;

  const dateNumber = dateTextToNumber_(text);
  return dateNumber === 99999999 ? null : dateNumber;
}

function sheetSerialNumber_(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n < 20000 || n > 80000) return null;

  return Math.floor(n);
}

function serialToDisplayText_(serial) {
  const parts = serialToDateParts_(serial);
  if (!parts) return '';

  return `${parts.year}. ${parts.month}. ${parts.day}`;
}

function serialToDateNumber_(serial) {
  const parts = serialToDateParts_(serial);
  if (!parts) return null;

  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function serialToDateParts_(serial) {
  const date = new Date(Date.UTC(1899, 11, 30 + Number(serial || 0)));
  if (Number.isNaN(date.getTime())) return null;

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function dateNumberToDisplayText_(dateNumber) {
  if (!Number.isFinite(dateNumber)) return '';

  const year = Math.floor(dateNumber / 10000);
  const month = Math.floor((dateNumber % 10000) / 100);
  const day = dateNumber % 100;

  if (!year || !month || !day) return '';
  return `${year}. ${month}. ${day}`;
}

function isVisibleToCustomer_(row) {
  const pickupDate = parseDateText_(row.pickupDate);
  if (!pickupDate) return true;

  const today = getKstToday_();

  const expireDate = new Date(
    pickupDate.getFullYear(),
    pickupDate.getMonth(),
    pickupDate.getDate()
  );

  expireDate.setDate(expireDate.getDate() + CONFIG.CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP);

  return today.getTime() <= expireDate.getTime();
}

function parseDateText_(text) {
  const raw = clean_(text);
  if (!raw) return null;

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return null;

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    month = Number(nums[0]);
    day = Number(nums[1]);
    year = inferYearForMonthDay_(month, day);
  }

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;

  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getKstToday_() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });

  const parts = formatter.formatToParts(new Date());

  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);
  const day = Number(parts.find(p => p.type === 'day')?.value);

  return new Date(year, month - 1, day);
}

function buildCandidateInfo_(matchedRows) {
  const grouped = {};

  matchedRows.forEach(row => {
    const displayLabel = normalizeDisplayCustomerLabel_(row.customerName);
    if (!displayLabel) return;

    if (!grouped[displayLabel]) {
      grouped[displayLabel] = {
        customerLabel: displayLabel,
        orderCount: 0,
        rawCustomerLabels: {}
      };
    }

    grouped[displayLabel].orderCount += 1;
    grouped[displayLabel].rawCustomerLabels[row.customerName] = true;
  });

  return Object.keys(grouped)
    .sort((a, b) => a.localeCompare(b, 'ko'))
    .map(label => ({
      customerLabel: grouped[label].customerLabel,
      orderCount: grouped[label].orderCount,
      rawCustomerLabels: Object.keys(grouped[label].rawCustomerLabels)
    }));
}

function normalizeProductKey_(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDisplayCustomerLabel_(value) {
  return clean_(value).replace(/\s+/g, ' ');
}

function matchesCustomer_(cellValue, keyword) {
  const rawCell = normalizeDisplayCustomerLabel_(cellValue).toLowerCase();
  const rawKeyword = normalizeDisplayCustomerLabel_(keyword).toLowerCase();

  if (!rawCell || !rawKeyword) return false;

  if (rawCell.includes(rawKeyword)) return true;

  const cellDigits = rawCell.replace(/\D/g, '');
  const keywordDigits = rawKeyword.replace(/\D/g, '');

  if (keywordDigits) {
    if (cellDigits === keywordDigits) return true;
    if (cellDigits.endsWith(keywordDigits)) return true;
    if (cellDigits.includes(keywordDigits)) return true;
  }

  return false;
}

function parsePrice_(value) {
  const text = clean_(value).replace(/,/g, '').replace(/원/g, '');
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseQuantity_(value) {
  const text = clean_(value).replace(/,/g, '');
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function dateTextToNumber_(text) {
  const raw = clean_(text);
  if (!raw) return 99999999;

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return 99999999;

  if (nums.length >= 3) {
    const first = Number(nums[0]);
    const second = Number(nums[1]);
    const third = Number(nums[2]);

    if (first > 999) {
      return first * 10000 + second * 100 + third;
    }

    const inferredYear = inferYearForMonthDay_(first, second);
    return inferredYear * 10000 + first * 100 + second;
  }

  const month = Number(nums[0]);
  const day = Number(nums[1]);
  const year = inferYearForMonthDay_(month, day);

  return year * 10000 + month * 100 + day;
}

function inferYearForMonthDay_(month, day) {
  const today = getKstToday_();
  let year = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return year;
}

async function readRowsFromSupabase_(keyword) {
  const cleanedKeyword = clean_(keyword);
  const keywordDigits = cleanedKeyword.replace(/\D/g, '');
  const today = getKstTodayString_();

  let query = supabaseAdmin
    .from('order_cache')
    .select([
      'source_sheet_name',
      'source_row_number',
      'pickup_date_text',
      'price',
      'image_url',
      'order_date_text',
      'customer_label',
      'product_name',
      'quantity',
      'order_date_value',
      'pickup_date_value'
    ].join(','))
    .eq('store_name', CONFIG.STORE_NAME)
    .or(`visible_until.is.null,visible_until.gte.${today}`)
    .order('pickup_date_value', { ascending: true })
    .order('order_date_value', { ascending: true })
    .limit(Number(process.env.ORDER_SEARCH_MAX_ROWS || 600));

  if (/^\d+$/.test(cleanedKeyword) && keywordDigits.length > 0) {
    query = query.eq('customer_digits4', keywordDigits.slice(-4));
  } else {
    const searchText = cleanedKeyword.toLowerCase().replace(/\s+/g, '');
    query = query.ilike('customer_search', `%${searchText}%`);
  }

  const { data, error } = await query;

  if (error) throw error;

  const rows = (data || []).map(row => ({
    sourceSheetName: row.source_sheet_name || CONFIG.RAW_SHEET_NAME,
    sourceRowNumber: row.source_row_number,
    pickupDate: row.pickup_date_text,
    price: row.price,
    imageUrl: row.image_url,
    orderDate: row.order_date_text,
    customerName: row.customer_label,
    productName: row.product_name,
    quantity: row.quantity
  }));

  return mergeFreshTimeSaleRowsForSearch_(rows, cleanedKeyword);
}

async function mergeFreshTimeSaleRowsForSearch_(rows, keyword) {
  if (process.env.FRESH_TIME_SALE_ORDER_SEARCH !== '1') {
    return rows;
  }

  let timeSaleRows = [];

  try {
    timeSaleRows = await withTimeout_(
      readTimeSaleOrderRowsForOrderCache(),
      Number(process.env.TIME_SALE_ORDER_SEARCH_TIMEOUT_MS || 2500)
    );
  } catch (error) {
    console.warn('fresh time-sale order rows skipped:', error.message);
    return rows;
  }

  if (!timeSaleRows.length) return rows;

  const existingKeys = new Set(rows
    .filter(row => row.sourceSheetName && row.sourceRowNumber)
    .map(row => `${row.sourceSheetName}::${row.sourceRowNumber}`));

  timeSaleRows.forEach(row => {
    const key = `${row.sourceSheetName}::${row.sourceRowNumber}`;
    if (existingKeys.has(key)) return;
    if (!matchesCustomer_(row.customerName, keyword)) return;

    rows.push(row);
    existingKeys.add(key);
  });

  return rows;
}

function withTimeout_(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getKstTodayString_() {
  const today = getKstToday_();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
