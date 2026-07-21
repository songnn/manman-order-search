import crypto from 'node:crypto';
import { syncProductCategoryCache } from '../lib/dashboard/productCategories.js';
import { reanalyzeKakaoCsvMatches } from '../lib/kakaoCsvProcessing.js';
import {
  evaluateOrderCacheSnapshot,
  orderCacheGuardOptionsFromEnv
} from '../lib/orderCacheGuard.js';
import { findStaleOrderCacheRecords } from '../lib/orderCacheSync.js';
import { decideOrderCacheSync } from '../lib/orderCacheSyncPolicy.js';
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

    const syncRunId = crypto.randomUUID();
    const syncStartedAt = new Date().toISOString();

    const rows = await readUnifiedRowsWithRowNumbers_();

    const records = rows
      .filter(row => row.customerName && row.productName)
      .map(row => toOrderCacheRecord_(row, syncRunId, syncStartedAt));

    if (!records.length) {
      return res.status(500).json({
        ok: false,
        message: '동기화할 주문 데이터가 없습니다. 기존 캐시는 삭제하지 않았습니다.'
      });
    }

    const syncedSourceSheetNames = [...new Set(records
      .map(record => record.source_sheet_name)
      .filter(Boolean))];
    const cachedRecords = await readCachedRecords_(syncedSourceSheetNames);
    const guard = evaluateOrderCacheSnapshot({
      nextRecords: records,
      cachedRecords,
      options: orderCacheGuardOptionsFromEnv()
    });
    const syncPolicy = decideOrderCacheSync({
      guard,
      manualCleanupFreeze: process.env.ORDER_CACHE_FREEZE === '1',
      guardDisabled: process.env.ORDER_CACHE_GUARD_DISABLED === '1'
    });

    if (!syncPolicy.allowUpsert) {
      console.warn('order cache hard rejection:', JSON.stringify({
        reasons: syncPolicy.hardReasons,
        metrics: guard.metrics
      }));

      res.setHeader('Retry-After', '300');
      return res.status(503).json({
        ok: false,
        skipped: true,
        frozen: true,
        autoFrozen: true,
        syncMode: syncPolicy.mode,
        message: '구글시트 오류값 또는 중복행을 감지해 이번 실행만 재시도합니다.',
        guard
      });
    }

    if (syncPolicy.mode === 'continuous-safe') {
      console.warn('order cache continuous safe sync:', JSON.stringify({
        reasons: guard.reasons,
        metrics: guard.metrics
      }));
    }

    await upsertInChunks_(records, 500);
    const staleRecords = findStaleOrderCacheRecords(cachedRecords, records);
    if (syncPolicy.allowStaleDeletion) {
      await deleteStaleRecords_(staleRecords, syncStartedAt);
    }

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
      staleCandidateCount: staleRecords.length,
      staleDeletedCount: syncPolicy.allowStaleDeletion ? staleRecords.length : 0,
      syncRunId,
      frozen: false,
      autoFrozen: false,
      syncMode: syncPolicy.mode,
      cleanupFrozen: !syncPolicy.allowStaleDeletion,
      guard,
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

function toOrderCacheRecord_(row, syncRunId, syncedAt) {
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
    synced_at: syncedAt
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

async function readCachedRecords_(sourceSheetNames, pageSize = 1000) {
  if (!sourceSheetNames.length) return [];

  const records = [];
  const storeName = process.env.STORE_NAME || '전농래미안크레시티점';

  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('order_cache')
      .select([
        'source_sheet_name',
        'source_row_number',
        'customer_label',
        'product_name',
        'quantity',
        'price',
        'image_url',
        'order_date_text',
        'pickup_date_text',
        'sync_run_id',
        'synced_at'
      ].join(','))
      .eq('store_name', storeName)
      .in('source_sheet_name', sourceSheetNames)
      .order('source_sheet_name', { ascending: true })
      .order('source_row_number', { ascending: true })
      .range(start, start + pageSize - 1);

    if (error) throw error;

    records.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return records;
}

async function deleteStaleRecords_(records, syncStartedAt, chunkSize = 500) {
  const storeName = process.env.STORE_NAME || '전농래미안크레시티점';
  const groups = new Map();

  records.forEach(record => {
    const source = clean_(record.source_sheet_name);
    const syncRunId = clean_(record.sync_run_id);
    if (!source) return;

    const key = `${source}::${syncRunId || '(null)'}`;
    const group = groups.get(key) || { source, syncRunId, rows: [] };
    group.rows.push(Number(record.source_row_number));
    groups.set(key, group);
  });

  for (const group of groups.values()) {
    const rowNumbers = [...new Set(group.rows.filter(Number.isInteger))];

    for (let i = 0; i < rowNumbers.length; i += chunkSize) {
      let query = supabaseAdmin
        .from('order_cache')
        .delete()
        .eq('store_name', storeName)
        .eq('source_sheet_name', group.source)
        .in('source_row_number', rowNumbers.slice(i, i + chunkSize));

      query = group.syncRunId
        ? query.eq('sync_run_id', group.syncRunId)
        : query.is('sync_run_id', null);
      query = query.lt('synced_at', syncStartedAt);

      const { error } = await query;
      if (error) throw error;
    }
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
