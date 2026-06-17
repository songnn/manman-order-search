import crypto from 'node:crypto';
import fs from 'node:fs';
import { getSheetsClient, getSpreadsheetId } from './googleSheetsClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

export const TIME_SALE_PRODUCT_SHEET_NAME = '할인상품';
export const TIME_SALE_ORDER_SHEET_NAME = '주문목록_할인상품';
export const TIME_SALE_PRODUCT_START_ROW = 200;
export const TIME_SALE_STORE_NAME = process.env.STORE_NAME || '전농래미안크레시티점';

const TIMEZONE = 'Asia/Seoul';
const ORDER_HEADERS = [
  '공구일자(함수)',
  '가격(함수)',
  '이미지 URL',
  '주문일자(기입)',
  '고객명(기입)',
  '주문상품(기입 + 함수)',
  '수량(기입)',
  '아군 주문(기입)',
  '비고(기입)',
  '픽업일',
  '주문ID',
  '할인상품행',
  '휴대폰끝4',
  '생성시각',
  '주문상태'
];
const TIME_SALE_STATIC_DATA_URL = new URL('../public/time-sale-products-data.json', import.meta.url);

const productLocks = new Map();
let orderSheetEnsured = false;

export async function getTimeSaleProductsPayload() {
  await withTimeout(ensureTimeSaleOrderSheet(), 2500).catch(error => {
    console.warn('time-sale order sheet ensure skipped:', error.message);
  });

  const [products, orders] = await Promise.all([
    withTimeout(readTimeSaleProducts(), 3500).catch(error => {
      console.warn('time-sale products sheet read fallback:', error.message);
      return readStaticTimeSaleProducts();
    }),
    withTimeout(readTimeSaleOrderRows(), 2500).catch(error => {
      console.warn('time-sale order stats skipped:', error.message);
      return [];
    })
  ]);
  const statsByRow = buildOrderStatsByProductRow(orders);

  return {
    ok: true,
    timezone: TIMEZONE,
    serverNow: new Date().toISOString(),
    items: products.map(product => ({
      ...product,
      stats: toPublicOrderStats(statsByRow.get(product.sheetRow) || createEmptyOrderStats(product.sheetRow))
    }))
  };
}

function withTimeout(promise, timeoutMs) {
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

function readStaticTimeSaleProducts() {
  try {
    const payload = JSON.parse(fs.readFileSync(TIME_SALE_STATIC_DATA_URL, 'utf8'));
    return (payload.items || []).map(item => ({
      ...item,
      chips: Array.isArray(item.chips) ? item.chips : splitChips(item.description || ''),
      stockQuantity: parseStock(item.stockQuantity),
      discountRate: item.discountRate || calculateDiscountRate(item.salePrice, item.comparePrice)
    }));
  } catch {
    return [];
  }
}

export async function submitTimeSaleOrder(input = {}) {
  await ensureTimeSaleOrderSheet();

  const sheetRow = Number(input.sheetRow);
  const quantity = Number(input.quantity);
  const phoneLast4 = normalizePhoneLast4(input.phoneLast4);

  if (!Number.isInteger(sheetRow) || sheetRow < TIME_SALE_PRODUCT_START_ROW) {
    return createOrderError('상품 정보를 확인하지 못했습니다.', 'INVALID_PRODUCT');
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return createOrderError('주문 수량을 확인해주세요.', 'INVALID_QUANTITY');
  }

  if (!phoneLast4) {
    return createOrderError('휴대폰 끝 4자리를 입력해주세요.', 'INVALID_PHONE');
  }

  const candidates = await findCustomerCandidatesByPhone(phoneLast4);
  const selectedCustomerLabel = normalizeCustomerLabel(input.customerLabel);
  const manualCustomerName = normalizeCustomerLabel(input.customerName);
  const customerResult = resolveCustomerForOrder({
    candidates,
    selectedCustomerLabel,
    manualCustomerName,
    phoneLast4
  });

  if (!customerResult.ok || customerResult.requiresCustomerSelection || customerResult.requiresCustomerName) {
    return customerResult;
  }

  return runWithProductLock(sheetRow, async () => {
    const sheets = await getSheetsClient();
    const spreadsheetId = getSpreadsheetId();
    const product = await readTimeSaleProductBySheetRow(sheetRow);

    if (!product) {
      return createOrderError('상품 정보를 찾지 못했습니다.', 'INVALID_PRODUCT');
    }

    const currentStock = Number(product.stockQuantity || 0);
    if (currentStock <= 0) {
      return createOrderError('이미 품절된 상품입니다.', 'SOLD_OUT', {
        remainingStock: 0
      });
    }

    if (quantity > currentStock) {
      return createOrderError(`현재 남은 재고는 ${currentStock}개입니다.`, 'STOCK_EXCEEDED', {
        remainingStock: currentStock
      });
    }

    const nextStock = currentStock - quantity;
    const orderDate = getKstTodayDate();
    const pickupDate = addBusinessDays(orderDate, 2);
    const orderDateText = formatDateForSheet(orderDate);
    const pickupDateText = formatDateForSheet(pickupDate);
    const orderId = createTimeSaleOrderId(orderDate);
    const createdAt = new Date().toISOString();
    let orderRow = null;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${TIME_SALE_PRODUCT_SHEET_NAME}'!L${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nextStock]]
      }
    });

    try {
      const appendResponse = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${TIME_SALE_ORDER_SHEET_NAME}'!A:O`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            `=IFERROR(INDEX('${TIME_SALE_PRODUCT_SHEET_NAME}'!A:A,INDIRECT("L"&ROW())),"")`,
            `=IFERROR(INDEX('${TIME_SALE_PRODUCT_SHEET_NAME}'!E:E,INDIRECT("L"&ROW())),"")`,
            `=IFERROR(INDEX('${TIME_SALE_PRODUCT_SHEET_NAME}'!D:D,INDIRECT("L"&ROW())),"")`,
            orderDateText,
            customerResult.customerLabel,
            product.productName,
            quantity,
            '',
            '타임특가',
            pickupDateText,
            orderId,
            sheetRow,
            phoneLast4,
            createdAt,
            '주문완료'
          ]]
        }
      });
      orderRow = parseUpdatedRowNumber(appendResponse.data?.updates?.updatedRange) ||
        await findTimeSaleOrderRowById(orderId);
    } catch (error) {
      await restoreProductStock(sheetRow, currentStock).catch(restoreError => {
        console.warn('time-sale stock restore failed:', restoreError.message);
      });
      throw error;
    }

    let cacheSynced = false;
    if (Number.isInteger(orderRow) && orderRow >= 2) {
      try {
        await upsertTimeSaleOrderCache({
          orderRow,
          orderDateText,
          pickupDateText,
          customerLabel: customerResult.customerLabel,
          phoneLast4,
          product,
          quantity,
          orderId,
          createdAt
        });
        cacheSynced = true;
      } catch (error) {
        console.warn('time-sale order cache upsert failed:', error.message);
      }
    } else {
      console.warn('time-sale order row could not be resolved:', orderId);
    }

    return {
      ok: true,
      orderId,
      sourceRowNumber: orderRow,
      productName: product.productName,
      quantity,
      customerLabel: customerResult.customerLabel,
      phoneLast4,
      pickupDate: pickupDateText,
      orderDate: orderDateText,
      remainingStock: nextStock,
      sheetRow,
      cacheSynced
    };
  });
}

export async function findCustomerCandidatesByPhone(phoneLast4) {
  const digits = normalizePhoneLast4(phoneLast4);
  if (!digits) return [];

  const today = formatDateKey(getKstTodayDate());
  const { data, error } = await supabaseAdmin
    .from('order_cache')
    .select('customer_label')
    .eq('store_name', TIME_SALE_STORE_NAME)
    .eq('customer_digits4', digits)
    .or(`visible_until.is.null,visible_until.gte.${today}`)
    .limit(200);

  if (error) throw error;

  const grouped = new Map();
  (data || []).forEach(row => {
    const label = normalizeCustomerLabel(row.customer_label);
    if (!label) return;

    const current = grouped.get(label) || {
      customerLabel: label,
      orderCount: 0
    };
    current.orderCount += 1;
    grouped.set(label, current);
  });

  return [...grouped.values()]
    .sort((a, b) => b.orderCount - a.orderCount || a.customerLabel.localeCompare(b.customerLabel, 'ko'));
}

export async function readTimeSaleProducts() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${TIME_SALE_PRODUCT_SHEET_NAME}'!C${TIME_SALE_PRODUCT_START_ROW}:M`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const rows = response.data.values || [];

  return rows
    .map((row, index) => normalizeTimeSaleProductRow(row, TIME_SALE_PRODUCT_START_ROW + index))
    .filter(Boolean);
}

export async function readTimeSaleProductBySheetRow(sheetRow) {
  const rowNumber = Number(sheetRow);
  if (!Number.isInteger(rowNumber) || rowNumber < TIME_SALE_PRODUCT_START_ROW) return null;

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${TIME_SALE_PRODUCT_SHEET_NAME}'!C${rowNumber}:M${rowNumber}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const row = response.data.values?.[0] || [];
  return normalizeTimeSaleProductRow(row, rowNumber);
}

export async function readTimeSaleOrderRows() {
  await ensureTimeSaleOrderSheet();

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${TIME_SALE_ORDER_SHEET_NAME}'!A2:O`,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  return (response.data.values || [])
    .map((row, index) => normalizeTimeSaleOrderRow(row, index + 2))
    .filter(Boolean);
}

export async function readTimeSaleOrderRowsForOrderCache() {
  const rows = await readTimeSaleOrderRows();

  return rows
    .filter(row => row.orderStatus !== '취소')
    .map(row => ({
      sourceSheetName: TIME_SALE_ORDER_SHEET_NAME,
      sourceRowNumber: row.sourceRowNumber,
      pickupDate: row.pickupDate,
      price: row.price,
      imageUrl: row.imageUrl,
      orderDate: row.orderDate,
      customerName: row.customerName,
      productName: row.productName,
      quantity: row.quantity
    }));
}

export async function ensureTimeSaleOrderSheet() {
  if (orderSheetEnsured) return;

  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)'
  });
  const exists = (metadata.data.sheets || []).some(sheet =>
    sheet.properties?.title === TIME_SALE_ORDER_SHEET_NAME
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: TIME_SALE_ORDER_SHEET_NAME,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 15,
                  frozenRowCount: 1
                }
              }
            }
          }
        ]
      }
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TIME_SALE_ORDER_SHEET_NAME}'!A1:O1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [ORDER_HEADERS]
    }
  });

  orderSheetEnsured = true;
}

function normalizeTimeSaleProductRow(row, sheetRow) {
  const productName = clean(row?.[0]);
  const imageUrl = clean(row?.[1]);
  const salePrice = parseNumber(row?.[2]);

  if (!productName || !imageUrl || !salePrice) return null;

  const stockQuantity = parseStock(row?.[9]);
  const description = clean(row?.[5]);

  return {
    id: `time-sale-row-${sheetRow}`,
    sheetRow,
    productName,
    imageUrl,
    salePrice,
    groupPrice: parseNumber(row?.[3]),
    comparePrice: parseNumber(row?.[4]),
    description,
    chips: splitChips(description),
    storageLocation: clean(row?.[8]),
    stockQuantity,
    category: clean(row?.[10]),
    discountRate: calculateDiscountRate(salePrice, parseNumber(row?.[4]) || parseNumber(row?.[3]))
  };
}

function normalizeTimeSaleOrderRow(row, sourceRowNumber) {
  const customerName = normalizeCustomerLabel(row?.[4]);
  const productName = clean(row?.[5]);
  const quantity = parseNumber(row?.[6]) || 0;

  if (!customerName || !productName || !quantity) return null;

  return {
    sourceSheetName: TIME_SALE_ORDER_SHEET_NAME,
    sourceRowNumber,
    price: parseNumber(row?.[1]) || 0,
    imageUrl: clean(row?.[2]),
    orderDate: clean(row?.[3]),
    customerName,
    productName,
    quantity,
    pickupDate: clean(row?.[9]),
    orderId: clean(row?.[10]),
    discountSheetRow: parseNumber(row?.[11]) || null,
    phoneLast4: normalizePhoneLast4(row?.[12]),
    createdAt: clean(row?.[13]),
    orderStatus: clean(row?.[14]) || '주문완료'
  };
}

function buildOrderStatsByProductRow(orders) {
  const stats = new Map();

  orders
    .filter(order => order.orderStatus !== '취소')
    .forEach(order => {
      const key = Number(order.discountSheetRow || 0);
      if (!key) return;

      const item = stats.get(key) || createEmptyOrderStats(key);
      item.orderCount += 1;
      item.totalQuantity += Number(order.quantity || 0);
      item.buyerLabels.add(order.customerName);
      if (order.customerName) {
        item.recentBuyers.unshift(order.customerName);
      }
      stats.set(key, item);
    });

  stats.forEach((item, key) => {
    const uniqueRecent = [];
    item.recentBuyers.forEach(label => {
      if (label && !uniqueRecent.includes(label)) uniqueRecent.push(label);
    });
    item.buyerCount = item.buyerLabels.size;
    item.recentBuyers = uniqueRecent.slice(0, 8);
    item.watchingText = formatWatchingText(createWatchingCount({
      sheetRow: key,
      buyerCount: item.buyerCount,
      totalQuantity: item.totalQuantity
    }));
    delete item.buyerLabels;
  });

  return stats;
}

function toPublicOrderStats(stats) {
  return {
    sheetRow: Number(stats?.sheetRow || 0),
    orderCount: Number(stats?.orderCount || 0),
    totalQuantity: Number(stats?.totalQuantity || 0),
    buyerCount: Number(stats?.buyerCount || 0),
    recentBuyers: Array.isArray(stats?.recentBuyers) ? stats.recentBuyers : [],
    watchingText: clean(stats?.watchingText) || formatWatchingText(createWatchingCount({
      sheetRow: Number(stats?.sheetRow || 0),
      buyerCount: Number(stats?.buyerCount || 0),
      totalQuantity: Number(stats?.totalQuantity || 0)
    }))
  };
}

function createEmptyOrderStats(sheetRow) {
  return {
    sheetRow,
    orderCount: 0,
    totalQuantity: 0,
    buyerCount: 0,
    buyerLabels: new Set(),
    recentBuyers: [],
    watchingText: formatWatchingText(createWatchingCount({ sheetRow }))
  };
}

function resolveCustomerForOrder({ candidates, selectedCustomerLabel, manualCustomerName, phoneLast4 }) {
  if (candidates.length >= 2) {
    const matched = candidates.find(candidate => candidate.customerLabel === selectedCustomerLabel);
    if (!matched) {
      return {
        ok: true,
        requiresCustomerSelection: true,
        candidates
      };
    }

    return {
      ok: true,
      customerLabel: matched.customerLabel
    };
  }

  if (candidates.length === 1 && !manualCustomerName) {
    const onlyCandidate = candidates[0];

    if (selectedCustomerLabel && selectedCustomerLabel !== onlyCandidate.customerLabel) {
      return {
        ok: true,
        requiresCustomerSelection: true,
        candidates
      };
    }

    return {
      ok: true,
      customerLabel: onlyCandidate.customerLabel
    };
  }

  const fallbackName = manualCustomerName || selectedCustomerLabel;
  if (!fallbackName) {
    return {
      ok: true,
      requiresCustomerName: true,
      candidates: []
    };
  }

  return {
    ok: true,
    customerLabel: ensureCustomerLabelHasPhone(fallbackName, phoneLast4)
  };
}

async function findTimeSaleOrderRowById(orderId) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${TIME_SALE_ORDER_SHEET_NAME}'!K:K`,
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const rows = response.data.values || [];
  const index = rows.findIndex(row => clean(row?.[0]) === orderId);

  return index >= 0 ? index + 1 : null;
}

function parseUpdatedRowNumber(updatedRange) {
  const match = clean(updatedRange).match(/![A-Z]+(\d+)(?::|$)/i);
  if (!match) return null;

  const row = Number(match[1]);
  return Number.isInteger(row) ? row : null;
}

async function restoreProductStock(sheetRow, stockQuantity) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `'${TIME_SALE_PRODUCT_SHEET_NAME}'!L${sheetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[stockQuantity]]
    }
  });
}

async function upsertTimeSaleOrderCache({
  orderRow,
  orderDateText,
  pickupDateText,
  customerLabel,
  phoneLast4,
  product,
  quantity,
  orderId,
  createdAt
}) {
  const { error } = await supabaseAdmin
    .from('order_cache')
    .upsert({
      store_name: TIME_SALE_STORE_NAME,
      source_sheet_name: TIME_SALE_ORDER_SHEET_NAME,
      source_row_number: orderRow,
      customer_label: customerLabel,
      customer_search: customerLabel.toLowerCase().replace(/\s+/g, ''),
      customer_digits4: phoneLast4,
      product_name: product.productName,
      quantity,
      price: product.salePrice,
      image_url: product.imageUrl,
      order_date_text: orderDateText,
      pickup_date_text: pickupDateText,
      order_date_value: dateTextToNumber(orderDateText),
      pickup_date_value: dateTextToNumber(pickupDateText),
      visible_until: getVisibleUntilDate(pickupDateText),
      sync_run_id: orderId,
      synced_at: createdAt
    }, {
      onConflict: 'store_name,source_sheet_name,source_row_number'
    });

  if (error) throw error;
}

function runWithProductLock(sheetRow, task) {
  const key = String(sheetRow);
  const previous = productLocks.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (productLocks.get(key) === next) productLocks.delete(key);
    });

  productLocks.set(key, next);
  return next;
}

function createTimeSaleOrderId(orderDate) {
  const y = orderDate.getFullYear();
  const m = String(orderDate.getMonth() + 1).padStart(2, '0');
  const d = String(orderDate.getDate()).padStart(2, '0');

  return `TS-${y}${m}${d}-${crypto.randomUUID().slice(0, 8)}`;
}

function addBusinessDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let added = 0;

  while (added < days) {
    next.setDate(next.getDate() + 1);
    const day = next.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }

  return next;
}

function getKstTodayDate() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(new Date());
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);

  return new Date(year, month - 1, day);
}

function formatDateForSheet(date) {
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}`;
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function getVisibleUntilDate(pickupDateText) {
  const date = parseDateText(pickupDateText);
  if (!date) return null;

  date.setDate(date.getDate() + Number(process.env.CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP || 7));

  return formatDateKey(date);
}

function parseDateText(text) {
  const nums = clean(text).match(/\d+/g);
  if (!nums || nums.length < 2) return null;

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    const today = getKstTodayDate();
    year = today.getFullYear();
    month = Number(nums[0]);
    day = Number(nums[1]);
  }

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateTextToNumber(text) {
  const date = parseDateText(text);
  if (!date) return 99999999;

  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function createWatchingCount({ sheetRow, buyerCount = 0, totalQuantity = 0 }) {
  const seed = (Number(sheetRow || 0) * 17) % 70;
  return Math.max(18, 88 + seed + buyerCount * 9 + totalQuantity * 4);
}

function formatWatchingText(count) {
  if (count >= 100) return `${(count / 100).toFixed(1)}백명이 보고 있습니다`;
  return `${count}명이 보고 있습니다`;
}

function ensureCustomerLabelHasPhone(label, phoneLast4) {
  const normalized = normalizeCustomerLabel(label).replace(/\s+/g, ' ');
  if (normalized.replace(/\D/g, '').endsWith(phoneLast4)) return normalized;

  return `${normalized} ${phoneLast4}`;
}

function calculateDiscountRate(salePrice, comparePrice) {
  if (!salePrice || !comparePrice || salePrice >= comparePrice) return null;
  return Math.max(1, Math.round(((comparePrice - salePrice) / comparePrice) * 100));
}

function splitChips(value) {
  return clean(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseStock(value) {
  if (value == null || value === '') return 0;
  const stock = Number(String(value).replace(/[,\s개]/g, ''));
  return Number.isFinite(stock) && stock >= 0 ? Math.floor(stock) : 0;
}

function parseNumber(value) {
  const number = Number(String(value ?? '').replace(/[,\s원₩]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizePhoneLast4(value) {
  const digits = clean(value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

function normalizeCustomerLabel(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function createOrderError(message, code, extra = {}) {
  return {
    ok: false,
    code,
    message,
    ...extra
  };
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
