import { findCustomerCandidatesByDigits } from '../lib/opsData.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

const STORE_NAME = process.env.STORE_NAME || '전농래미안크레시티점';

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
    if (!/^\d{4}$/.test(digits)) {
      return res.status(400).json({
        ok: false,
        message: '핸드폰 뒷 4자리를 입력해주세요.'
      });
    }

    const requestedCustomerLabel = normalizeCustomerLabel(req.query?.customerLabel);
    const today = getKstDate();
    const sinceOrderDateValue = dateKeyToNumber(formatDateKey(addDays(today, -21)));
    const minPickupDateValue = dateKeyToNumber(formatDateKey(addDays(today, -7)));
    const maxPickupDateValue = dateKeyToNumber(formatDateKey(addDays(today, 7)));

    const [candidateResult, rows] = await Promise.all([
      findCustomerCandidatesByDigits({ digits }),
      readRecentOrderRows({
        digits,
        sinceOrderDateValue,
        minPickupDateValue,
        maxPickupDateValue
      })
    ]);

    const candidates = mergeCandidates(candidateResult.candidates || [], rows, digits);
    const selectedCustomerLabel =
      requestedCustomerLabel ||
      (candidates.length === 1 ? candidates[0].customerLabel : '');

    if (candidates.length > 1 && !selectedCustomerLabel) {
      return res.status(200).json({
        ok: true,
        digits,
        requiresCustomerSelection: true,
        selectedCustomerLabel: '',
        candidates,
        items: []
      });
    }

    const scopedRows = selectedCustomerLabel
      ? rows.filter(row => normalizeCustomerLabel(row.customer_label) === selectedCustomerLabel)
      : rows;
    const items = await buildStorageItems(scopedRows);

    return res.status(200).json({
      ok: true,
      digits,
      requiresCustomerSelection: false,
      selectedCustomerLabel,
      candidates,
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
  return data || [];
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

    const current = grouped.get(label) || {
      customerLabel: label,
      customerDigits4: digits,
      orderCount: 0,
      latestOrderDateValue: 0,
      latestPickupDateValue: 0
    };

    current.orderCount += 1;
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

async function buildStorageItems(rows) {
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
      sourceRows: []
    };

    current.quantity += Number(row.quantity || 0);
    if (!current.imageUrl) current.imageUrl = clean(row.image_url);
    current.sourceRows.push(Number(row.source_row_number || 0));
    grouped.set(key, current);
  });

  const items = Array.from(grouped.values());
  const inventoryRows = await readInventoryRows([...new Set(items.map(item => item.pickupDateKey))]);

  const mappedItems = items
    .map(item => {
      const inventory = findMatchingInventory(inventoryRows, item);

      return {
        ...item,
        id: inventory?.stable_id || '',
        inventoryStableId: inventory?.stable_id || '',
        productName: inventory?.product_name || item.productName,
        storageMethod: normalizeStorageMethod(inventory?.storage_method),
        inboundQuantity: Number(inventory?.inbound_quantity || 0),
        salePrice: Number(inventory?.sale_price || item.price || 0),
        imageUrl: inventory?.image_url || item.imageUrl,
        canStore: Boolean(inventory?.stable_id)
      };
    });
  const hasStorableItems = mappedItems.some(item => item.canStore);

  return mappedItems
    .filter(item => hasStorableItems ? item.canStore : true)
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
      'inbound_date',
      'inbound_date_text',
      'inbound_quantity',
      'sale_price',
      'image_url'
    ].join(','))
    .eq('store_name', STORE_NAME)
    .in('inbound_date', dateKeys);

  if (error) throw error;
  return data || [];
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
