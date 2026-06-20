import { getSheetsClient, getSpreadsheetId } from './googleSheetsClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const CONFIG = {
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  ALLOWED_PICKUP_DIGITS: new Set(
    String(process.env.PICKUP_COMPLETION_ALLOWED_DIGITS || '*')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )
};

export async function getPickupCompletionMap(rows) {
  const normalizedRows = normalizeSourceRows(rows);
  if (!normalizedRows.length) return new Map();

  const bySheet = new Map();
  normalizedRows.forEach(row => {
    if (!bySheet.has(row.sourceSheetName)) bySheet.set(row.sourceSheetName, []);
    bySheet.get(row.sourceSheetName).push(row.sourceRowNumber);
  });

  const results = [];

  for (const [sheetName, rowNumbers] of bySheet.entries()) {
    const { data, error } = await supabaseAdmin
      .from('pickup_completions')
      .select('stable_id,source_sheet_name,source_row_number,completed,completed_at')
      .eq('store_name', CONFIG.STORE_NAME)
      .eq('source_sheet_name', sheetName)
      .in('source_row_number', [...new Set(rowNumbers)]);

    if (error) {
      if (isMissingPickupTableError(error)) return new Map();
      throw error;
    }

    results.push(...(data || []));
  }

  return new Map(results.map(row => [`${row.source_sheet_name}::${row.source_row_number}`, row]));
}

export async function togglePickupCompletion({ sourceRows, completed, actor, phoneLast4 }) {
  const requestedRows = normalizeSourceRows(sourceRows);
  const digits = clean(phoneLast4).replace(/\D/g, '').slice(-4);

  if (!CONFIG.ALLOWED_PICKUP_DIGITS.has('*') && !CONFIG.ALLOWED_PICKUP_DIGITS.has(digits)) {
    throw new Error('현재 배포 테스트는 4739 주문만 픽업완료 처리할 수 있습니다.');
  }

  if (!requestedRows.length) {
    throw new Error('픽업완료 처리할 주문 행 정보가 없습니다.');
  }

  const verifiedRows = await verifyAllowedSourceRows(requestedRows, digits);

  if (!verifiedRows.length) {
    throw new Error('4739 주문 행을 찾지 못했습니다.');
  }

  const complete = Boolean(completed);
  const now = new Date().toISOString();
  const records = verifiedRows.map(row => ({
    stable_id: sourceStableId(row.source_sheet_name, row.source_row_number),
    store_name: CONFIG.STORE_NAME,
    source_sheet_name: row.source_sheet_name,
    source_row_number: row.source_row_number,
    customer_label: row.customer_label,
    customer_digits4: row.customer_digits4,
    product_name: row.product_name,
    pickup_date_text: row.pickup_date_text,
    completed: complete,
    completed_at: complete ? now : null,
    completed_by: clean(actor) || digits,
    last_action_at: now,
    needs_sheet_sync: true
  }));

  const { error } = await supabaseAdmin
    .from('pickup_completions')
    .upsert(records, {
      onConflict: 'stable_id'
    });

  if (error) throw withPickupSchemaHint(error);

  return {
    ok: true,
    completed: complete,
    count: records.length,
    rows: records.map(row => ({
      sourceSheetName: row.source_sheet_name,
      sourceRowNumber: row.source_row_number,
      completed: row.completed
    }))
  };
}

export async function syncPickupCompletionsToSheet({ limit = 500 } = {}) {
  const { data, error } = await supabaseAdmin
    .from('pickup_completions')
    .select('*')
    .eq('store_name', CONFIG.STORE_NAME)
    .eq('needs_sheet_sync', true)
    .order('last_action_at', { ascending: true })
    .limit(limit);

  if (error) throw withPickupSchemaHint(error);

  const rows = data || [];
  const rawRows = rows.filter(row => row.source_sheet_name === CONFIG.RAW_SHEET_NAME);

  if (!rawRows.length) {
    return {
      ok: true,
      synced: 0,
      skipped: rows.length
    };
  }

  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const dataUpdates = rawRows.map(row => ({
    range: `${CONFIG.RAW_SHEET_NAME}!K${row.source_row_number}:K${row.source_row_number}`,
    values: [[row.completed ? '✅ 픽업완료' : '']]
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: dataUpdates
    }
  });

  const syncedAt = new Date().toISOString();
  for (const row of rawRows) {
    const { error: updateError } = await supabaseAdmin
      .from('pickup_completions')
      .update({
        needs_sheet_sync: false,
        sheet_synced_at: syncedAt,
        sheet_synced_value: row.completed ? '✅ 픽업완료' : ''
      })
      .eq('stable_id', row.stable_id);

    if (updateError) throw withPickupSchemaHint(updateError);
  }

  return {
    ok: true,
    synced: rawRows.length,
    skipped: rows.length - rawRows.length
  };
}

async function verifyAllowedSourceRows(rows, digits) {
  const verified = [];
  const bySheet = new Map();

  rows.forEach(row => {
    if (!bySheet.has(row.sourceSheetName)) bySheet.set(row.sourceSheetName, []);
    bySheet.get(row.sourceSheetName).push(row.sourceRowNumber);
  });

  for (const [sheetName, rowNumbers] of bySheet.entries()) {
    const { data, error } = await supabaseAdmin
      .from('order_cache')
      .select('source_sheet_name,source_row_number,customer_label,customer_digits4,product_name,pickup_date_text')
      .eq('store_name', CONFIG.STORE_NAME)
      .eq('source_sheet_name', sheetName)
      .eq('customer_digits4', digits)
      .in('source_row_number', [...new Set(rowNumbers)]);

    if (error) throw error;
    verified.push(...(data || []));
  }

  return verified;
}

function normalizeSourceRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      sourceSheetName: clean(row.sourceSheetName || row.source_sheet_name),
      sourceRowNumber: Number(row.sourceRowNumber || row.source_row_number || 0)
    }))
    .filter(row => row.sourceSheetName && Number.isInteger(row.sourceRowNumber) && row.sourceRowNumber > 0);
}

function sourceStableId(sheetName, rowNumber) {
  return `${CONFIG.STORE_NAME}::${sheetName}::${rowNumber}`;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function withPickupSchemaHint(error) {
  if (!isMissingPickupTableError(error)) return error;

  return new Error(
    '픽업완료 Supabase 테이블이 없습니다. docs/supabase-ops-schema.sql을 Supabase SQL Editor에서 먼저 실행해주세요.'
  );
}

function isMissingPickupTableError(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`;
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    /does not exist|schema cache|Could not find the table/i.test(message)
  );
}
