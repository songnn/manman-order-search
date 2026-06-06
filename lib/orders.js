import { getSheetsClient } from './googleSheetsClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  RAW_READ_START_ROW: Number(process.env.RAW_READ_START_ROW || 6000),
  CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP: Number(process.env.CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP || 7)
};

const RAW_COL = {
  PRICE: 0,
  IMAGE_URL: 1,
  ORDER_DATE: 2,
  CUSTOMER_NAME: 3,
  PRODUCT_NAME: 4,
  QUANTITY: 5,
  PICKUP_DATE: 6
};

export async function searchOrders(keyword, selectedCustomerLabel) {
  keyword = clean_(keyword);
  selectedCustomerLabel = normalizeDisplayCustomerLabel_(selectedCustomerLabel);

  if (!keyword) {
    return {
      ok: false,
      message: '닉네임 또는 휴대폰 끝 4자리를 입력해주세요.',
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
        pickupDateValue: dateTextToNumber_(row.pickupDate)
      };
    }

    grouped[groupKey].quantity += row.quantity;
  });

  const items = Object.values(grouped)
    .sort((a, b) => {
      if (a.pickupDateValue !== b.pickupDateValue) {
        return a.pickupDateValue - b.pickupDateValue;
      }

      if (a.orderDateValue !== b.orderDateValue) {
        return a.orderDateValue - b.orderDateValue;
      }

      return String(a.productName || '').localeCompare(String(b.productName || ''), 'ko');
    })
    .map(item => ({
      orderDate: item.orderDate,
      pickupDate: item.pickupDate,
      productName: item.productName,
      quantity: item.quantity,
      price: item.price,
      imageUrl: item.imageUrl,
      customerLabel: item.customerLabel,
      orderDateValue: item.orderDateValue,
      pickupDateValue: item.pickupDateValue
    }));

  return {
    ok: true,
    searched: keyword,
    selectedCustomerLabel: hasSelectableCandidates ? selectedCustomerLabel : '',
    requiresCustomerSelection: false,
    storeName: CONFIG.STORE_NAME,
    items
  };
}

async function getSheetsClient_() {
  return getSheetsClient();
}

async function readUnifiedRows_() {
  const sheets = await getSheetsClient_();

  const start = Math.max(1, Number(CONFIG.RAW_READ_START_ROW || 1));
  const sheetName = CONFIG.RAW_SHEET_NAME;

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    ranges: [
      `${sheetName}!B${start}:G`,
      `${sheetName}!J${start}:J`
    ],
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const bgValues = response.data.valueRanges?.[0]?.values || [];
  const jValues = response.data.valueRanges?.[1]?.values || [];

  const values = bgValues.map((row, i) => [
    row[0] || '',
    row[1] || '',
    row[2] || '',
    row[3] || '',
    row[4] || '',
    row[5] || '',
    jValues[i]?.[0] || ''
  ]);

  const result = [];

  values.forEach((row, index) => {
    const price = parsePrice_(row[RAW_COL.PRICE]);
    const imageUrl = clean_(row[RAW_COL.IMAGE_URL]);
    const orderDate = clean_(row[RAW_COL.ORDER_DATE]);
    const customerName = clean_(row[RAW_COL.CUSTOMER_NAME]);
    const productName = clean_(row[RAW_COL.PRODUCT_NAME]);
    const quantity = parseQuantity_(row[RAW_COL.QUANTITY]);
    const pickupDate = clean_(row[RAW_COL.PICKUP_DATE]);

    const isEmptyRow =
      !clean_(row[RAW_COL.PRICE]) &&
      !imageUrl &&
      !orderDate &&
      !customerName &&
      !productName &&
      !clean_(row[RAW_COL.QUANTITY]) &&
      !pickupDate;

    if (isEmptyRow) return;
    if (!customerName || !productName) return;

    result.push({
      sourceRowNumber: start + index,
      pickupDate,
      price,
      imageUrl,
      orderDate,
      customerName,
      productName,
      quantity
    });
  });

  return result;
}

export async function readUnifiedRowsWithRowNumbers_() {
  const sheets = await getSheetsClient_();

  const start = Math.max(1, Number(CONFIG.RAW_READ_START_ROW || 1));
  const sheetName = CONFIG.RAW_SHEET_NAME;

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    ranges: [
      `${sheetName}!B${start}:G`,
      `${sheetName}!J${start}:J`
    ],
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const bgValues = response.data.valueRanges?.[0]?.values || [];
  const jValues = response.data.valueRanges?.[1]?.values || [];

  const values = bgValues.map((row, i) => [
    row[0] || '',
    row[1] || '',
    row[2] || '',
    row[3] || '',
    row[4] || '',
    row[5] || '',
    jValues[i]?.[0] || ''
  ]);

  const result = [];

  values.forEach((row, index) => {
    const price = parsePrice_(row[RAW_COL.PRICE]);
    const imageUrl = clean_(row[RAW_COL.IMAGE_URL]);
    const orderDate = clean_(row[RAW_COL.ORDER_DATE]);
    const customerName = clean_(row[RAW_COL.CUSTOMER_NAME]);
    const productName = clean_(row[RAW_COL.PRODUCT_NAME]);
    const quantity = parseQuantity_(row[RAW_COL.QUANTITY]);
    const pickupDate = clean_(row[RAW_COL.PICKUP_DATE]);

    const isEmptyRow =
      !clean_(row[RAW_COL.PRICE]) &&
      !imageUrl &&
      !orderDate &&
      !customerName &&
      !productName &&
      !clean_(row[RAW_COL.QUANTITY]) &&
      !pickupDate;

    if (isEmptyRow) return;
    if (!customerName || !productName) return;

    result.push({
      sourceRowNumber: start + index,
      pickupDate,
      price,
      imageUrl,
      orderDate,
      customerName,
      productName,
      quantity
    });
  });

  return result;
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
    .select('*')
    .eq('store_name', CONFIG.STORE_NAME)
    .or(`visible_until.is.null,visible_until.gte.${today}`)
    .order('pickup_date_value', { ascending: true })
    .order('order_date_value', { ascending: true });

  if (/^\d+$/.test(cleanedKeyword) && keywordDigits.length > 0) {
    query = query.eq('customer_digits4', keywordDigits.slice(-4));
  } else {
    const searchText = cleanedKeyword.toLowerCase().replace(/\s+/g, '');
    query = query.ilike('customer_search', `%${searchText}%`);
  }

  const { data, error } = await query;

  if (error) throw error;

  return (data || []).map(row => ({
    pickupDate: row.pickup_date_text,
    price: row.price,
    imageUrl: row.image_url,
    orderDate: row.order_date_text,
    customerName: row.customer_label,
    productName: row.product_name,
    quantity: row.quantity
  }));
}

function getKstTodayString_() {
  const today = getKstToday_();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}
