import {
  buildProductStorageCatalog,
  normalizeProductStorageKey,
  resolveProductStorage
} from './productStorage.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const STORE_NAME = process.env.STORE_NAME || '전농래미안크레시티점';
const IMAGE_FALLBACK_URL = process.env.OPS_IMAGE_FALLBACK_URL || '/store-purchase-icon.png';
const ACTIVE_INVENTORY_SHEETS = new Set([
  '입고리스트',
  '입고리스트(D-1)',
  '입고리스트(D-2)',
  '입고리스트(D-3)'
]);
const STORAGE_ORDER = { '상온': 1, '냉장': 2, '냉동': 3 };
const FIXED_HOLIDAYS = new Set([
  '01-01',
  '03-01',
  '05-05',
  '06-06',
  '08-15',
  '10-03',
  '10-09',
  '12-25'
]);
const STORE_HOLIDAYS_2026 = new Set([
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-03-02',
  '2026-05-01',
  '2026-05-24',
  '2026-05-25',
  '2026-06-03',
  '2026-07-17',
  '2026-08-17',
  '2026-09-24',
  '2026-09-25',
  '2026-09-26',
  '2026-10-05'
]);
const INVENTORY_SELECT = [
  'stable_id',
  'source_sheet_name',
  'source_row_number',
  'product_name',
  'product_key',
  'storage_method',
  'sales_type',
  'inbound_date',
  'inbound_quantity',
  'package_unit',
  'image_url',
  'synced_at',
  'sync_run_id'
].join(',');

export async function getTvPickupData(options = {}) {
  const now = options.now || new Date();
  const cutoffDate = getTvPickupCutoffDateKey(now);
  const inventoryRows = await readInventoryRows(options.client || supabaseAdmin);
  const selection = selectTvPickupInventoryRows(inventoryRows, now);

  if (!selection.effectiveDate) {
    return buildTvPickupPayload({
      inventoryRows: [],
      receivingChecks: [],
      rawStorageRows: [],
      now,
      cutoffDate
    });
  }

  const relatedRows = inventoryRows.filter(row =>
    row.inbound_date === selection.effectiveDate &&
    selection.productKeys.has(productIdentity(row))
  );
  const stableIds = relatedRows.map(row => clean(row.stable_id)).filter(Boolean);
  const [receivingChecks, rawStorageRows] = await Promise.all([
    readReceivingChecks(stableIds, options.client || supabaseAdmin),
    readRawStorageRows(selection.effectiveDate, options.client || supabaseAdmin)
  ]);

  return buildTvPickupPayload({
    inventoryRows,
    receivingChecks,
    rawStorageRows,
    now,
    cutoffDate
  });
}

export function buildTvPickupPayload({
  inventoryRows = [],
  receivingChecks = [],
  rawStorageRows = [],
  now = new Date(),
  cutoffDate = getTvPickupCutoffDateKey(now)
} = {}) {
  const selection = selectTvPickupInventoryRows(inventoryRows, now, cutoffDate);
  const storageCatalog = buildProductStorageCatalog(rawStorageRows);
  const checksById = new Map(receivingChecks.map(check => [clean(check.inventory_stable_id), check]));
  const completionByProduct = buildCompletionByProduct(selection, checksById);

  const groups = new Map();
  let nonDivisiblePackageCount = 0;

  selection.rows.forEach(row => {
    const key = productIdentity(row);
    if (!key) return;

    const quantityInfo = getPickupUnitQuantity(row.inbound_quantity, row.package_unit);
    if (quantityInfo.nonDivisible) nonDivisiblePackageCount += 1;

    const current = groups.get(key) || {
      productKey: key,
      productName: clean(row.product_name),
      imageUrl: '',
      normalizedQuantity: 0,
      inboundQuantity: 0,
      firstRowNumber: Number.POSITIVE_INFINITY,
      syncedAt: ''
    };

    current.productName = chooseDisplayProductName(current.productName, row.product_name);
    current.imageUrl = chooseImageUrl(current.imageUrl, row.image_url);
    current.normalizedQuantity += quantityInfo.quantity;
    current.inboundQuantity += positiveNumber(row.inbound_quantity);
    current.firstRowNumber = Math.min(
      current.firstRowNumber,
      positiveInteger(row.source_row_number) || Number.POSITIVE_INFINITY
    );
    current.syncedAt = latestIso(current.syncedAt, row.synced_at);

    groups.set(key, current);
  });

  const allItems = [];
  let storageReviewCount = 0;

  groups.forEach(group => {
    const rawStorage = resolveProductStorage(
      storageCatalog,
      group.productName,
      selection.effectiveDate
    );
    const storageType = rawStorage.storageMethodStatus === 'confirmed'
      ? rawStorage.storageMethod
      : null;

    if (!storageType) {
      storageReviewCount += 1;
      return;
    }

    const completion = completionByProduct.get(group.productKey) || {};
    allItems.push({
      productKey: group.productKey,
      displayName: makeTvProductName(group.productName),
      imageUrl: group.imageUrl || IMAGE_FALLBACK_URL,
      storageType,
      status: completion.complete ? 'complete' : 'pending',
      normalizedQuantity: group.normalizedQuantity,
      inboundQuantity: group.inboundQuantity,
      firstRowNumber: Number.isFinite(group.firstRowNumber) ? group.firstRowNumber : 0,
      updatedAt: latestIso(group.syncedAt, completion.updatedAt)
    });
  });

  allItems.sort(comparePickupItems);
  const readyItems = allItems.filter(item => item.status === 'complete');
  const byStorage = countByStorage(allItems);
  const readyByStorage = countByStorage(readyItems);
  const publicItems = readyItems.map((item, index) => ({
    id: `${item.storageType}-${index + 1}`,
    pickupDate: selection.effectiveDate || cutoffDate,
    displayName: item.displayName,
    imageUrl: item.imageUrl,
    storageType: item.storageType,
    status: 'complete',
    sortOrder: index + 1,
    updatedAt: item.updatedAt
  }));
  const sourceUpdatedAt = latestIso(
    ...selection.rows.map(row => row.synced_at),
    ...receivingChecks.map(check => check.updated_at || check.completed_at)
  );

  return {
    ok: true,
    storeName: STORE_NAME,
    effectiveDate: selection.effectiveDate || cutoffDate,
    effectiveDateLabel: formatTvPickupDate(selection.effectiveDate || cutoffDate),
    cutoffDate,
    isFallbackDate: Boolean(
      selection.effectiveDate && selection.effectiveDate !== getSeoulDateKey(now)
    ),
    refreshPolicy: '매일 오전 10시 자동 갱신',
    generatedAt: now.toISOString(),
    updatedAt: sourceUpdatedAt || now.toISOString(),
    summary: {
      totalProducts: allItems.length,
      readyProducts: readyItems.length,
      pendingProducts: Math.max(0, allItems.length - readyItems.length),
      byStorage,
      readyByStorage
    },
    dataQuality: {
      storageReviewCount,
      nonDivisiblePackageCount
    },
    items: publicItems
  };
}

export function selectTvPickupInventoryRows(
  inventoryRows = [],
  now = new Date(),
  cutoffDate = getTvPickupCutoffDateKey(now)
) {
  const inventoryListRows = inventoryRows.filter(row =>
    isInventoryListRow(row) &&
    isGroupSaleRow(row) &&
    clean(row.product_name) &&
    clean(row.inbound_date)
  );
  const activeRows = selectLatestSyncRunRows(
    inventoryListRows.filter(row => !isHistoryRow(row))
  ).filter(row => clean(row.inbound_date) <= cutoffDate);
  const historyRows = inventoryListRows.filter(row =>
    isHistoryRow(row) && clean(row.inbound_date) <= cutoffDate
  );
  const dateSource = [...activeRows, ...historyRows];
  const effectiveDate = dateSource
    .map(row => clean(row.inbound_date))
    .filter(Boolean)
    .sort()
    .pop() || '';
  const activeRowsForDate = activeRows.filter(row => row.inbound_date === effectiveDate);
  const historyRowsForDate = historyRows.filter(row => row.inbound_date === effectiveDate);
  const rows = activeRowsForDate.length
    ? activeRowsForDate
    : dedupeHistoryRows(historyRowsForDate);
  const productKeys = new Set(rows.map(productIdentity).filter(Boolean));
  const relatedDateRows = inventoryListRows.filter(row =>
    row.inbound_date === effectiveDate && productKeys.has(productIdentity(row))
  );

  return {
    cutoffDate,
    effectiveDate,
    rows,
    relatedDateRows,
    productKeys
  };
}

export function getTvPickupCutoffDateKey(now = new Date()) {
  const clock = getSeoulClock(now);
  let date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day));

  if (clock.hour < 10) {
    date = addUtcDays(date, -1);
  }

  while (isClosedDate(date)) {
    date = addUtcDays(date, -1);
  }

  return formatUtcDateKey(date);
}

export function getPickupUnitQuantity(inboundQuantity, packageUnit) {
  const inbound = positiveNumber(inboundQuantity);
  const packageSize = parsePackageUnit(packageUnit);
  const quantity = inbound / packageSize;
  const nearestInteger = Math.round(quantity);

  return {
    inboundQuantity: inbound,
    packageSize,
    quantity,
    nonDivisible: Math.abs(quantity - nearestInteger) > 0.000001
  };
}

export function parsePackageUnit(value) {
  const text = clean(value).replace(/,/g, '');
  const match = text.match(/\d+(?:\.\d+)?/);
  const parsed = match ? Number(match[0]) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function makeTvProductName(value) {
  return clean(value)
    .replace(/^\s*\[(?=[^\]]*(?:임박|특가|한정|단독))[^\]]+\]\s*/i, '')
    .replace(/\s*\/\s*(?:20)?\d{2}년\s*\d{1,2}월(?:\s*\d{1,2}일)?\s*$/i, '')
    .replace(/\s*\/\s*(?:제조일로부터|소비기한|유통기한).+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTvPickupDate(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey || '';
  const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  return `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 ${weekdays[date.getUTCDay()]}`;
}

function comparePickupItems(a, b) {
  const storageDiff = (STORAGE_ORDER[a.storageType] || 9) - (STORAGE_ORDER[b.storageType] || 9);
  if (storageDiff) return storageDiff;
  if (b.normalizedQuantity !== a.normalizedQuantity) return b.normalizedQuantity - a.normalizedQuantity;
  if (b.inboundQuantity !== a.inboundQuantity) return b.inboundQuantity - a.inboundQuantity;
  if (a.firstRowNumber !== b.firstRowNumber) return a.firstRowNumber - b.firstRowNumber;
  return a.displayName.localeCompare(b.displayName, 'ko');
}

function countByStorage(items) {
  const counts = { '상온': 0, '냉장': 0, '냉동': 0 };
  items.forEach(item => {
    if (Object.prototype.hasOwnProperty.call(counts, item.storageType)) {
      counts[item.storageType] += 1;
    }
  });
  return counts;
}

function buildCompletionByProduct(selection, checksById) {
  const primaryRowsByProduct = groupRowsByProduct(selection.rows);
  const relatedRowsByProduct = groupRowsByProduct(selection.relatedDateRows);
  const completionByProduct = new Map();

  selection.productKeys.forEach(productKey => {
    const primaryRows = primaryRowsByProduct.get(productKey) || [];
    const primaryChecks = primaryRows
      .map(row => checksById.get(clean(row.stable_id)))
      .filter(Boolean);

    if (primaryChecks.length) {
      completionByProduct.set(productKey, {
        complete: primaryRows.every(row =>
          checksById.get(clean(row.stable_id))?.is_complete === true
        ),
        updatedAt: latestIso(
          ...primaryChecks.map(check => check.updated_at || check.completed_at)
        )
      });
      return;
    }

    const inheritedChecks = (relatedRowsByProduct.get(productKey) || [])
      .map(row => checksById.get(clean(row.stable_id)))
      .filter(Boolean)
      .sort((a, b) => checkTimestamp(b).localeCompare(checkTimestamp(a)));
    const latestCheck = inheritedChecks[0];
    completionByProduct.set(productKey, {
      complete: latestCheck?.is_complete === true,
      updatedAt: latestCheck ? checkTimestamp(latestCheck) : ''
    });
  });

  return completionByProduct;
}

function groupRowsByProduct(rows) {
  const grouped = new Map();
  rows.forEach(row => {
    const key = productIdentity(row);
    if (!key) return;
    const current = grouped.get(key) || [];
    current.push(row);
    grouped.set(key, current);
  });
  return grouped;
}

function checkTimestamp(check) {
  return clean(check?.updated_at || check?.completed_at);
}

function selectLatestSyncRunRows(rows) {
  const rowsWithRun = rows.filter(row => clean(row.sync_run_id));
  if (!rowsWithRun.length) return rows;
  const latestRow = [...rowsWithRun]
    .sort((a, b) => clean(b.synced_at).localeCompare(clean(a.synced_at)))[0];
  const latestRunId = clean(latestRow?.sync_run_id);
  return rows.filter(row => clean(row.sync_run_id) === latestRunId);
}

function dedupeHistoryRows(rows) {
  const latestByProduct = new Map();

  rows.forEach(row => {
    const key = productIdentity(row);
    if (!key) return;
    const current = latestByProduct.get(key);
    if (!current || compareHistoryRows(row, current) < 0) {
      latestByProduct.set(key, row);
    }
  });

  return Array.from(latestByProduct.values());
}

function compareHistoryRows(a, b) {
  const syncedDiff = clean(b.synced_at).localeCompare(clean(a.synced_at));
  if (syncedDiff) return syncedDiff;
  return positiveInteger(a.source_row_number) - positiveInteger(b.source_row_number);
}

function productIdentity(row) {
  return normalizeProductStorageKey(row?.product_key || row?.product_name);
}

function isInventoryListRow(row) {
  return ACTIVE_INVENTORY_SHEETS.has(baseSourceSheet(row?.source_sheet_name));
}

function isHistoryRow(row) {
  return /#history:/i.test(clean(row?.source_sheet_name));
}

function baseSourceSheet(value) {
  return clean(value).split('#history:')[0];
}

function isGroupSaleRow(row) {
  const salesType = clean(row?.sales_type).replace(/\s+/g, '');
  return salesType === '공구' || salesType === '공동구매';
}

function getSeoulClock(now) {
  const formatter = new Intl.DateTimeFormat('en-CA-u-hc-h23', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute
  };
}

function getSeoulDateKey(now) {
  const clock = getSeoulClock(now);
  return [
    clock.year,
    String(clock.month).padStart(2, '0'),
    String(clock.day).padStart(2, '0')
  ].join('-');
}

function isClosedDate(date) {
  const weekday = date.getUTCDay();
  const dateKey = formatUtcDateKey(date);
  const fixedKey = dateKey.slice(5);
  return weekday === 0 || weekday === 6 ||
    STORE_HOLIDAYS_2026.has(dateKey) ||
    FIXED_HOLIDAYS.has(fixedKey);
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function formatUtcDateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function parseDateKey(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function chooseDisplayProductName(current, candidate) {
  const next = clean(candidate);
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function chooseImageUrl(current, candidate) {
  if (isUsableImageUrl(current)) return current;
  return isUsableImageUrl(candidate) ? clean(candidate) : '';
}

function isUsableImageUrl(value) {
  const text = clean(value);
  return /^https?:\/\//i.test(text) || /^\/(?!\/)/.test(text);
}

function positiveNumber(value) {
  const parsed = Number(String(value == null ? '' : value).replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function latestIso(...values) {
  return values.map(clean).filter(Boolean).sort().pop() || '';
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

async function readInventoryRows(client) {
  const { data, error } = await client
    .from('operations_inventory_items')
    .select(INVENTORY_SELECT)
    .eq('store_name', STORE_NAME)
    .order('synced_at', { ascending: false })
    .order('inbound_date', { ascending: false })
    .order('source_row_number', { ascending: true })
    .limit(1000);

  if (error) throw error;
  return data || [];
}

async function readReceivingChecks(stableIds, client) {
  if (!stableIds.length) return [];
  const rows = [];

  for (let index = 0; index < stableIds.length; index += 100) {
    const chunk = stableIds.slice(index, index + 100);
    const { data, error } = await client
      .from('operations_receiving_checks')
      .select('inventory_stable_id,is_complete,completed_at,updated_at')
      .eq('store_name', STORE_NAME)
      .in('inventory_stable_id', chunk);

    if (error) throw error;
    rows.push(...(data || []));
  }

  return rows;
}

async function readRawStorageRows(dateKey, client) {
  if (!dateKey) return [];
  const { data, error } = await client
    .from('operations_inventory_raw_rows')
    .select('product_name,product_key,storage_method,outbound_date,outbound_date_text,source_row_number,synced_at,raw_json')
    .eq('store_name', STORE_NAME)
    .eq('source_sheet_name', '입고 raw')
    .eq('outbound_date', dateKey)
    .order('source_row_number', { ascending: true })
    .limit(1000);

  if (error) throw error;
  return data || [];
}
