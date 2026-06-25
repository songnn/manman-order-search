import crypto from 'node:crypto';
import { syncProductCategoryCache } from '../lib/dashboard/productCategories.js';
import { reanalyzeKakaoCsvMatches } from '../lib/kakaoCsvProcessing.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { readUnifiedRowsWithRowNumbers_ } from '../lib/orders.js';

export default async function handler(req, res) {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized'
      });
    }

    if (process.env.ORDER_CACHE_FREEZE === '1') {
      return res.status(200).json({
        ok: true,
        skipped: true,
        frozen: true,
        message: '주문 캐시 freeze 중이라 구글시트 동기화를 건너뜁니다.'
      });
    }

    const syncRunId = crypto.randomUUID();

    const rows = await readUnifiedRowsWithRowNumbers_();

    const records = rows
      .filter(row => row.customerName && row.productName)
      .map(row => toOrderCacheRecord_(row, syncRunId));

    if (!records.length) {
      return res.status(500).json({
        ok: false,
        message: '동기화할 주문 데이터가 없습니다. 기존 캐시는 삭제하지 않았습니다.'
      });
    }

    await upsertInChunks_(records, 500);

    const syncedSourceSheetNames = [...new Set(records
      .map(record => record.source_sheet_name)
      .filter(Boolean))];

    let deleteQuery = supabaseAdmin
      .from('order_cache')
      .delete()
      .eq('store_name', process.env.STORE_NAME || '전농래미안크레시티점')
      .neq('sync_run_id', syncRunId);

    if (syncedSourceSheetNames.length) {
      deleteQuery = deleteQuery.in('source_sheet_name', syncedSourceSheetNames);
    }

    const { error: deleteError } = await deleteQuery;

    if (deleteError) throw deleteError;

    const includeAnalytics = isTruthy_(req.query?.analytics ?? req.body?.analytics);
    let productCategorySync = { ok: false, skipped: true };
    let kakaoCsvReanalysis = { ok: false, skipped: true };

    if (includeAnalytics) {
      try {
        productCategorySync = await syncProductCategoryCache();
      } catch (error) {
        console.warn('product category sync skipped:', error.message);
        productCategorySync = { ok: false, error: error.message };
      }

      try {
        kakaoCsvReanalysis = await reanalyzeKakaoCsvMatches({ maxUploads: 20 });
      } catch (error) {
        console.warn('kakao csv reanalysis skipped:', error.message);
        kakaoCsvReanalysis = { ok: false, error: error.message };
      }
    }

    return res.status(200).json({
      ok: true,
      count: records.length,
      syncRunId,
      productCategorySync,
      kakaoCsvReanalysis
    });
  } catch (error) {
    console.error('sync-orders error:', error);

    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
}

function isTruthy_(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function toOrderCacheRecord_(row, syncRunId) {
  const customerLabel = normalizeDisplayCustomerLabel_(row.customerName);
  const digits = customerLabel.replace(/\D/g, '');
  const customerDigits4 = digits ? digits.slice(-4) : null;

  const pickupDateValue = dateTextToNumber_(row.pickupDate);
  const orderDateValue = dateTextToNumber_(row.orderDate);

  return {
    store_name: process.env.STORE_NAME || '전농래미안크레시티점',
    source_sheet_name: row.sourceSheetName || process.env.RAW_SHEET_NAME || 'Raw_주문입력',
    source_row_number: row.sourceRowNumber,

    customer_label: customerLabel,
    customer_search: customerLabel.toLowerCase().replace(/\s+/g, ''),
    customer_digits4: customerDigits4,

    product_name: row.productName,
    quantity: row.quantity,
    price: row.price,
    image_url: row.imageUrl,

    order_date_text: row.orderDate,
    pickup_date_text: row.pickupDate,
    order_date_value: orderDateValue,
    pickup_date_value: pickupDateValue,

    visible_until: getVisibleUntilDate_(row.pickupDate),
    sync_run_id: syncRunId,
    synced_at: new Date().toISOString()
  };
}

async function upsertInChunks_(records, chunkSize = 500) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);

    const { error } = await supabaseAdmin
      .from('order_cache')
      .upsert(chunk, {
        onConflict: 'store_name,source_sheet_name,source_row_number'
      });

    if (error) throw error;
  }
}

function normalizeDisplayCustomerLabel_(value) {
  return clean_(value).replace(/\s+/g, ' ');
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function dateTextToNumber_(text) {
  const raw = clean_(text);
  if (!raw) return 99999999;

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return 99999999;

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    const today = getKstToday_();
    year = today.getFullYear();
    month = Number(nums[0]);
    day = Number(nums[1]);

    const currentMonth = today.getMonth() + 1;
    if (currentMonth === 12 && month === 1) year += 1;
    if (currentMonth === 1 && month === 12) year -= 1;
  }

  return year * 10000 + month * 100 + day;
}

function getVisibleUntilDate_(pickupDateText) {
  const date = parseDateText_(pickupDateText);
  if (!date) return null;

  const visibleDays = Number(process.env.CUSTOMER_VISIBLE_DAYS_AFTER_PICKUP || 7);

  date.setDate(date.getDate() + visibleDays);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
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
    const today = getKstToday_();
    year = today.getFullYear();
    month = Number(nums[0]);
    day = Number(nums[1]);

    const currentMonth = today.getMonth() + 1;
    if (currentMonth === 12 && month === 1) year += 1;
    if (currentMonth === 1 && month === 12) year -= 1;
  }

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;

  return date;
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
