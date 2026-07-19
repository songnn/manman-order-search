import { supabaseAdmin } from './supabaseAdmin.js';

export const PRODUCT_STORAGE_SOURCE_SHEET = '입고 raw';

const PRODUCT_STORAGE_METHODS = ['상온', '냉장', '냉동'];
const PRODUCT_STORAGE_METHOD_SET = new Set(PRODUCT_STORAGE_METHODS);
const DEFAULT_QUERY_CHUNK_SIZE = 50;
const DEFAULT_QUERY_PAGE_SIZE = 1000;

export function normalizeStorageMethod(value) {
  const text = clean_(value).normalize('NFKC');
  if (!text || text === '0') return null;

  const matches = [];
  if (/냉동/.test(text)) matches.push('냉동');
  if (/냉장/.test(text)) matches.push('냉장');
  if (/상온|실온/.test(text)) matches.push('상온');

  return matches.length === 1 ? matches[0] : null;
}

export function normalizeProductStorageKey(value) {
  const text = clean_(value);
  if (!text) return '';

  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildProductStorageCatalog(rows = []) {
  const catalog = new Map();

  rows.forEach(row => {
    const productKey = normalizeProductStorageKey(row?.product_key || row?.product_name);
    if (!productKey) return;

    const storageMethod = readVerifiedStorageMethod_(row);
    if (!storageMethod) return;

    const current = catalog.get(productKey) || [];
    current.push({
      storageMethod,
      outboundDate: normalizeStorageDate_(row?.outbound_date || row?.outbound_date_text),
      sourceRowNumber: Number(row?.source_row_number || 0),
      syncedAt: clean_(row?.synced_at)
    });
    catalog.set(productKey, current);
  });

  for (const candidates of catalog.values()) {
    candidates.sort(compareStorageCandidates_);
  }

  return catalog;
}

export function resolveProductStorage(catalog, productName, pickupDate = '') {
  const productKey = normalizeProductStorageKey(productName);
  const candidates = catalog?.get(productKey) || [];

  if (!candidates.length) {
    return {
      storageMethod: null,
      storageMethodStatus: 'pending',
      storageMethodSource: null
    };
  }

  const pickupDateKey = normalizeStorageDate_(pickupDate);
  const dateMatches = pickupDateKey
    ? candidates.filter(candidate => candidate.outboundDate === pickupDateKey)
    : [];
  const applicableCandidates = dateMatches.length ? dateMatches : candidates;
  const methods = [...new Set(applicableCandidates
    .map(candidate => normalizeStorageMethod(candidate.storageMethod))
    .filter(method => PRODUCT_STORAGE_METHOD_SET.has(method)))];

  if (methods.length !== 1) {
    return {
      storageMethod: null,
      storageMethodStatus: 'conflict',
      storageMethodSource: PRODUCT_STORAGE_SOURCE_SHEET
    };
  }

  return {
    storageMethod: methods[0],
    storageMethodStatus: 'confirmed',
    storageMethodSource: PRODUCT_STORAGE_SOURCE_SHEET
  };
}

export async function readProductStorageCatalog(productNames, options = {}) {
  const client = options.client || supabaseAdmin;
  const storeName = options.storeName || process.env.STORE_NAME || '전농래미안크레시티점';
  const chunkSize = Math.max(1, Number(options.chunkSize || DEFAULT_QUERY_CHUNK_SIZE));
  const pageSize = Math.max(1, Number(options.pageSize || DEFAULT_QUERY_PAGE_SIZE));
  const productKeys = [...new Set((productNames || [])
    .flatMap(value => [
      normalizeProductStorageKey(value),
      normalizeLegacyProductStorageKey_(value, true),
      normalizeLegacyProductStorageKey_(value, false)
    ])
    .filter(Boolean))];

  if (!productKeys.length) return new Map();

  const rows = [];

  for (let index = 0; index < productKeys.length; index += chunkSize) {
    const chunk = productKeys.slice(index, index + chunkSize);

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from('operations_inventory_raw_rows')
        .select([
          'product_name',
          'product_key',
          'storage_method',
          'outbound_date',
          'outbound_date_text',
          'source_row_number',
          'synced_at',
          'raw_json'
        ].join(','))
        .eq('store_name', storeName)
        .eq('source_sheet_name', PRODUCT_STORAGE_SOURCE_SHEET)
        .in('product_key', chunk)
        .range(from, from + pageSize - 1);

      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
  }

  return buildProductStorageCatalog(rows);
}

export function summarizeProductStorageRows(rows = []) {
  const normalizedRows = rows.map(row => ({
    product_name: row?.productName ?? row?.product_name,
    product_key: row?.productKey ?? row?.product_key,
    storage_method: row?.storageMethod ?? row?.storage_method,
    outbound_date: row?.outboundDateKey ?? row?.outbound_date,
    outbound_date_text: row?.outboundDateText ?? row?.outbound_date_text,
    source_row_number: row?.sourceRowNumber ?? row?.source_row_number,
    raw_json: row?.raw ?? row?.raw_json
  }));
  const catalog = buildProductStorageCatalog(normalizedRows);
  const counts = Object.fromEntries(PRODUCT_STORAGE_METHODS.map(method => [method, 0]));
  let conflictProductCount = 0;

  for (const candidates of catalog.values()) {
    const methods = [...new Set(candidates.map(candidate => candidate.storageMethod))];
    if (methods.length === 1) counts[methods[0]] += 1;
    if (methods.length > 1) conflictProductCount += 1;
  }

  return {
    rowCount: rows.length,
    confirmedProductCount: counts['상온'] + counts['냉장'] + counts['냉동'],
    unconfirmedRowCount: normalizedRows.filter(row => !readVerifiedStorageMethod_(row)).length,
    conflictProductCount,
    counts
  };
}

export function findStaleProductStorageRows(cachedRows = [], nextRows = []) {
  const nextIds = new Set(nextRows
    .map(row => clean_(row?.stable_id))
    .filter(Boolean));

  return cachedRows.filter(row => {
    const stableId = clean_(row?.stable_id);
    return stableId && !nextIds.has(stableId);
  });
}

function readVerifiedStorageMethod_(row) {
  const rawStorageCell = findRawStorageCell_(row?.raw_json);
  if (rawStorageCell.found) {
    return normalizeStorageMethod(rawStorageCell.value);
  }

  return normalizeStorageMethod(row?.storage_method);
}

function findRawStorageCell_(rawJson) {
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    return { found: false, value: null };
  }

  for (const [header, value] of Object.entries(rawJson)) {
    const normalizedHeader = clean_(header)
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[()[\]{}]/g, '')
      .toLowerCase();

    if (normalizedHeader === '보관방법' || normalizedHeader === '보관') {
      return { found: true, value };
    }
  }

  return { found: false, value: null };
}

function normalizeStorageDate_(value) {
  const text = clean_(value);
  if (!text) return '';

  const numbers = text.match(/\d+/g) || [];
  if (numbers.length < 3 || Number(numbers[0]) < 1000) return '';

  const year = Number(numbers[0]);
  const month = Number(numbers[1]);
  const day = Number(numbers[2]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return '';

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function compareStorageCandidates_(a, b) {
  if (a.outboundDate !== b.outboundDate) {
    return String(b.outboundDate || '').localeCompare(String(a.outboundDate || ''));
  }

  return Number(b.sourceRowNumber || 0) - Number(a.sourceRowNumber || 0);
}

function normalizeLegacyProductStorageKey_(value, normalizeUnicode) {
  const text = clean_(value);
  if (!text) return '';

  return (normalizeUnicode ? text.normalize('NFKC') : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[()[\]{}]/g, '')
    .trim();
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}
