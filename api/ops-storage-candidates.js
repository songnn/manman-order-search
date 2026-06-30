import { findCustomerCandidatesByDigits, normalizeInventoryRowProductFields } from '../lib/opsData.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const STORE_NAME = process.env.STORE_NAME || '전농래미안크레시티점';
const INVENTORY_PRODUCT_CODE_HEADERS = ['상품코드', '상품 코드', '제품코드', '제품 코드', '품목코드', '품목 코드', '코드'];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      message: 'GET 요청만 가능합니다.'
    });
  }

  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    const digits = clean(req.query?.digits || req.query?.q).replace(/\D/g, '').slice(-4);
    const hasDigits = /^\d{4}$/.test(digits);
    const customerQuery = normalizeCustomerLabel(req.query?.customerQuery || req.query?.customer || req.query?.name);
    const productQuery = clean(req.query?.productQuery || req.query?.product || req.query?.keyword);
    if (!hasDigits && !customerQuery && !productQuery) {
      return res.status(400).json({
        ok: false,
        message: '핸드폰 뒷4자리, 닉네임, 상품명 중 하나를 입력해주세요.'
      });
    }

    const requestedCustomerLabel = normalizeCustomerLabel(req.query?.customerLabel);
    const today = getKstDate();
    const sinceOrderDateValue = dateKeyToNumber(formatDateKey(addDays(today, -21)));
    const minPickupDateValue = dateKeyToNumber(formatDateKey(addDays(today, -7)));
    const maxPickupDateValue = dateKeyToNumber(formatDateKey(addDays(today, 7)));

    const minInventoryDateKey = formatDateKey(addDays(today, -10));
    const maxInventoryDateKey = formatDateKey(addDays(today, 10));

    const [candidateResult, rows, searchedInventoryRows] = await Promise.all([
      hasDigits ? findCustomerCandidatesByDigits({ digits }) : Promise.resolve({ candidates: [] }),
      hasDigits
        ? readRecentOrderRows({
            digits,
            sinceOrderDateValue,
            minPickupDateValue,
            maxPickupDateValue
          })
        : customerQuery
          ? readRecentOrderRowsByCustomer({
              customerQuery,
              sinceOrderDateValue,
              minPickupDateValue,
              maxPickupDateValue
            })
          : Promise.resolve([]),
      productQuery
        ? readRecentInventoryRows({
            productQuery,
            minDateKey: minInventoryDateKey,
            maxDateKey: maxInventoryDateKey
          })
        : Promise.resolve([])
    ]);

    const candidates = mergeCandidates(candidateResult.candidates || [], rows, digits);
    const selectedCustomerLabel =
      requestedCustomerLabel ||
      (candidates.length === 1 ? candidates[0].customerLabel : '');

    if ((hasDigits || customerQuery) && candidates.length > 1 && !selectedCustomerLabel && !productQuery) {
      return res.status(200).json({
        ok: true,
        digits,
        customerQuery,
        requiresCustomerSelection: true,
        selectedCustomerLabel: '',
        candidates,
        items: []
      });
    }

    const scopedRows = selectedCustomerLabel
      ? rows.filter(row => normalizeCustomerLabel(row.customer_label) === selectedCustomerLabel)
      : rows;
    const items = await buildStorageItems(scopedRows, searchedInventoryRows);

    return res.status(200).json({
      ok: true,
      digits,
      requiresCustomerSelection: false,
      selectedCustomerLabel,
      candidates,
      customerQuery,
      productQuery,
      items
    });
  } catch (error) {
    console.error('ops-storage-candidates error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

async function readRecentOrderRows({ digits, sinceOrderDateValue, minPickupDateValue, maxPickupDateValue }) {
  const { data, error } = await supabaseAdmin
    .from('order_cache')
    .select([
      'source_sheet_name',
      'source_row_number',
      'customer_label',
      'customer_digits4',
      'order_date_text',
      'order_date_value',
      'pickup_date_text',
      'pickup_date_value',
      'product_name',
      'quantity',
      'price',
      'image_url'
    ].join(','))
    .eq('store_name', STORE_NAME)
    .eq('customer_digits4', digits)
    .gte('order_date_value', sinceOrderDateValue)
    .gte('pickup_date_value', minPickupDateValue)
    .lte('pickup_date_value', maxPickupDateValue)
    .order('pickup_date_value', { ascending: false })
    .order('source_row_number', { ascending: true })
    .limit(700);

  if (error) throw error;
  return (data || []).map(normalizeInventoryRowProductFields);
}

async function readRecentOrderRowsByCustomer({ customerQuery, sinceOrderDateValue, minPickupDateValue, maxPickupDateValue }) {
  const normalizedSearch = normalizeCustomerSearch(customerQuery);
  if (!normalizedSearch) return [];

  const { data, error } = await supabaseAdmin
    .from('order_cache')
    .select([
      'source_sheet_name',
      'source_row_number',
      'customer_label',
      'customer_digits4',
      'order_date_text',
      'order_date_value',
      'pickup_date_text',
      'pickup_date_value',
      'product_name',
      'quantity',
      'price',
      'image_url'
    ].join(','))
    .eq('store_name', STORE_NAME)
    .gte('order_date_value', sinceOrderDateValue)
    .gte('pickup_date_value', minPickupDateValue)
    .lte('pickup_date_value', maxPickupDateValue)
    .ilike('customer_search', `%${normalizedSearch}%`)
    .order('pickup_date_value', { ascending: false })
    .order('source_row_number', { ascending: true })
    .limit(700);

  if (error) throw error;
  return (data || []).map(normalizeInventoryRowProductFields);
}

function mergeCandidates(candidates, rows, digits) {
  const grouped = new Map();

  candidates.forEach(candidate => {
    const label = normalizeCustomerLabel(candidate.customerLabel);
    if (!label) return;

    grouped.set(label, {
      customerLabel: label,
      customerDigits4: digits,
      orderCount: Number(candidate.orderCount || 0),
      latestOrderDateValue: Number(candidate.latestOrderDateValue || 0),
      latestPickupDateValue: Number(candidate.latestPickupDateValue || 0)
    });
  });

  rows.forEach(row => {
    const label = normalizeCustomerLabel(row.customer_label);
    if (!label) return;
    const rowDigits = clean(row.customer_digits4 || digits).replace(/\D/g, '').slice(-4);

    const current = grouped.get(label) || {
      customerLabel: label,
      customerDigits4: rowDigits,
      orderCount: 0,
      latestOrderDateValue: 0,
      latestPickupDateValue: 0
    };

    current.orderCount += 1;
    current.customerDigits4 = current.customerDigits4 || rowDigits;
    current.latestOrderDateValue = Math.max(current.latestOrderDateValue, Number(row.order_date_value || 0));
    current.latestPickupDateValue = Math.max(current.latestPickupDateValue, Number(row.pickup_date_value || 0));
    grouped.set(label, current);
  });

  return Array.from(grouped.values())
    .sort((a, b) => {
      if (b.latestPickupDateValue !== a.latestPickupDateValue) {
        return b.latestPickupDateValue - a.latestPickupDateValue;
      }

      if (b.latestOrderDateValue !== a.latestOrderDateValue) {
        return b.latestOrderDateValue - a.latestOrderDateValue;
      }

      return a.customerLabel.localeCompare(b.customerLabel, 'ko');
    });
}

async function buildStorageItems(rows, searchedInventoryRows = []) {
  const grouped = new Map();

  rows.forEach(row => {
    const productName = clean(row.product_name);
    const pickupDateKey = dateValueToDateKey(row.pickup_date_value) || parseDateKey(row.pickup_date_text);
    const productKey = normalizeProductKey(productName);
    if (!productName || !pickupDateKey || !productKey) return;

    const key = `${productKey}::${pickupDateKey}`;
    const current = grouped.get(key) || {
      key,
      productName,
      productKey,
      pickupDateKey,
      pickupDateText: clean(row.pickup_date_text),
      quantity: 0,
      orderDateText: clean(row.order_date_text),
      price: Number(row.price || 0),
      imageUrl: clean(row.image_url),
      sourceType: 'order',
      sourceRows: []
    };

    current.quantity += Math.max(1, Number(row.quantity || 0));
    if (!current.imageUrl) current.imageUrl = clean(row.image_url);
    current.sourceRows.push(Number(row.source_row_number || 0));
    grouped.set(key, current);
  });

  const items = Array.from(grouped.values());
  const matchedInventoryRows = await readInventoryRows([...new Set(items.map(item => item.pickupDateKey))]);
  const inventoryRows = mergeInventoryRows([
    ...matchedInventoryRows,
    ...searchedInventoryRows
  ]);

  const mappedItems = items
    .map(item => {
      const inventory = findMatchingInventory(inventoryRows, item);

      return {
        ...item,
        id: inventory?.stable_id || '',
        inventoryStableId: inventory?.stable_id || '',
        productName: inventory?.product_name || item.productName,
        productKey: inventory?.product_key || item.productKey,
        productCode: inventoryProductCode(inventory),
        storageMethod: normalizeStorageMethod(inventory?.storage_method),
        salesType: inventory?.sales_type || '',
        inboundQuantity: Number(inventory?.inbound_quantity || 0),
        packageUnit: inventory?.package_unit || '',
        supplyPrice: Number(inventory?.supply_price || 0),
        hqBufferQuantity: Number(inventory?.hq_buffer_quantity || 0),
        salePrice: Number(inventory?.sale_price || item.price || 0),
        imageUrl: inventory?.image_url || item.imageUrl,
        canStore: true,
        matchMessage: inventory?.stable_id ? '' : '입고리스트 미매칭 · 임시 보관요청으로 등록됩니다.'
      };
    });

  const seenKeys = new Set(mappedItems.map(item =>
    item.inventoryStableId ? `inventory:${item.inventoryStableId}` : `fallback:${item.key}`
  ));
  const inventorySearchItems = searchedInventoryRows
    .filter(row => row?.stable_id)
    .filter(row => {
      const key = `inventory:${row.stable_id}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    })
    .map(row => ({
      key: `inventory:${row.stable_id}`,
      id: row.stable_id,
      inventoryStableId: row.stable_id,
      productName: row.product_name || '',
      productKey: row.product_key || normalizeProductKey(row.product_name),
      productCode: inventoryProductCode(row),
      pickupDateKey: row.inbound_date || '',
      pickupDateText: row.inbound_date_text || row.inbound_date || '',
      quantity: 1,
      orderDateText: '',
      price: Number(row.sale_price || 0),
      salePrice: Number(row.sale_price || 0),
      imageUrl: row.image_url || '',
      storageMethod: normalizeStorageMethod(row.storage_method),
      salesType: row.sales_type || '',
      inboundQuantity: Number(row.inbound_quantity || 0),
      packageUnit: row.package_unit || '',
      supplyPrice: Number(row.supply_price || 0),
      hqBufferQuantity: Number(row.hq_buffer_quantity || 0),
      sourceType: 'inventory',
      sourceRows: [Number(row.source_row_number || 0)],
      canStore: true,
      matchMessage: '최근 픽업 상품 · 기본 1개'
    }));

  return [...mappedItems, ...inventorySearchItems]
    .sort((a, b) => {
      if (Number(b.canStore) !== Number(a.canStore)) return Number(b.canStore) - Number(a.canStore);
      if (b.pickupDateKey !== a.pickupDateKey) return b.pickupDateKey.localeCompare(a.pickupDateKey);
      const storageDiff = storageRank(a.storageMethod) - storageRank(b.storageMethod);
      if (storageDiff !== 0) return storageDiff;
      return a.productName.localeCompare(b.productName, 'ko');
    });
}

async function readInventoryRows(dateKeys) {
  if (!dateKeys.length) return [];

  const { data, error } = await supabaseAdmin
    .from('operations_inventory_items')
    .select([
      'stable_id',
      'product_name',
      'product_key',
      'storage_method',
      'sales_type',
      'inbound_date',
      'inbound_date_text',
      'inbound_quantity',
      'package_unit',
      'supply_price',
      'hq_buffer_quantity',
      'sale_price',
      'image_url',
      'raw_json'
    ].join(','))
    .eq('store_name', STORE_NAME)
    .in('inbound_date', dateKeys);

  if (error) throw error;
  return (data || []).map(normalizeInventoryRowProductFields);
}

async function readRecentInventoryRows({ productQuery, minDateKey, maxDateKey }) {
  const normalizedQuery = normalizeProductKey(productQuery);
  if (!normalizedQuery) return [];

  const { data, error } = await supabaseAdmin
    .from('operations_inventory_items')
    .select([
      'stable_id',
      'source_row_number',
      'product_name',
      'product_key',
      'storage_method',
      'sales_type',
      'inbound_date',
      'inbound_date_text',
      'inbound_quantity',
      'package_unit',
      'supply_price',
      'hq_buffer_quantity',
      'sale_price',
      'image_url',
      'raw_json'
    ].join(','))
    .eq('store_name', STORE_NAME)
    .gte('inbound_date', minDateKey)
    .lte('inbound_date', maxDateKey)
    .order('inbound_date', { ascending: false })
    .order('source_row_number', { ascending: true })
    .limit(1000);

  if (error) throw error;

  return (data || [])
    .map(normalizeInventoryRowProductFields)
    .filter(row => {
      const productKey = normalizeProductKey([
        row.product_name,
        row.product_key,
        inventoryProductCode(row)
      ].filter(Boolean).join(' '));
      if (!productKey) return false;
      return productKey.includes(normalizedQuery) || normalizedQuery.includes(productKey);
    })
    .slice(0, 80);
}

function mergeInventoryRows(rows) {
  const result = new Map();
  rows.forEach(row => {
    if (!row?.stable_id) return;
    result.set(row.stable_id, row);
  });
  return Array.from(result.values());
}

function findMatchingInventory(inventoryRows, item) {
  const exactKey = `${item.productKey}::${item.pickupDateKey}`;
  const byExact = inventoryRows.find(row =>
    `${normalizeProductKey(row.product_name)}::${row.inbound_date || ''}` === exactKey
  );

  if (byExact) return byExact;

  return inventoryRows
    .filter(row => row.inbound_date === item.pickupDateKey)
    .map(row => ({
      row,
      key: normalizeProductKey(row.product_name)
    }))
    .filter(candidate =>
      candidate.key.includes(item.productKey) ||
      item.productKey.includes(candidate.key)
    )
    .sort((a, b) => Math.abs(a.key.length - item.productKey.length) - Math.abs(b.key.length - item.productKey.length))[0]?.row || null;
}

function inventoryProductCode(row) {
  return getRawStringByHeaders(row?.raw_json, INVENTORY_PRODUCT_CODE_HEADERS);
}

function getRawStringByHeaders(rawJson, candidates) {
  const raw = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const normalizedCandidates = candidates.map(normalizeHeader).filter(Boolean);

  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeHeader(key);
    if (!normalizedKey) continue;
    if (normalizedCandidates.some(candidate => normalizedKey.includes(candidate))) {
      return clean(value);
    }
  }

  return '';
}

function isAuthorized(req) {
  const expectedAdmin = process.env.ADMIN_TOKEN || '03064';
  const token = req.headers['x-admin-token'] || req.query?.token;
  return Boolean(expectedAdmin && token === expectedAdmin);
}

function normalizeProductKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[0-9]+(?:\.[0-9]+)?\s*(?:g|kg|ml|l|개|팩|박스|입|봉|구|세트)/gi, '')
    .replace(/[^0-9a-z가-힣]+/gi, '');
}

function normalizeHeader(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/[()[\]{}]/g, '')
    .toLowerCase();
}

function normalizeCustomerLabel(value) {
  return clean(value).replace(/\s+/g, ' ');
}

function normalizeStorageMethod(value) {
  const text = clean(value).replace(/\s+/g, '');
  if (text.includes('냉동')) return '냉동';
  if (text.includes('냉장')) return '냉장';
  return '상온';
}

function storageRank(value) {
  return ({ 냉장: 1, 상온: 2, 냉동: 3 })[value] || 9;
}

function parseDateKey(value) {
  const raw = clean(value);
  if (!raw) return '';

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return '';

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    year = getKstDate().getFullYear();
    month = Number(nums[0]);
    day = Number(nums[1]);
  }

  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return '';
  }

  return formatDateKey(date);
}

function dateValueToDateKey(value) {
  const text = clean(value);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function dateKeyToNumber(dateKey) {
  return Number(clean(dateKey).replace(/\D/g, '')) || 0;
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function getKstDate() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(new Date());

  return new Date(
    Number(parts.find(part => part.type === 'year')?.value),
    Number(parts.find(part => part.type === 'month')?.value) - 1,
    Number(parts.find(part => part.type === 'day')?.value)
  );
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeCustomerSearch(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '');
}
