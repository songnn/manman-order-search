import crypto from 'node:crypto';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import { getGoogleAuth, getSheetsClient } from './googleSheetsClient.js';
import { supabaseAdmin } from './supabaseAdmin.js';

export const OPS_CONFIG = {
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  ORDER_SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  INVENTORY_SPREADSHEET_ID:
    process.env.INVENTORY_SPREADSHEET_ID || '12JVJaSAu58xLZUAnl9IvVW_mjOAxNZ9MuHWqSg2nuxE',
  SETTLEMENT_DRIVE_FOLDER_ID:
    process.env.SETTLEMENT_DRIVE_FOLDER_ID || '1FDxd4IUy_f_rAZnqMBOG37hVaf9weIVj',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  RAW_READ_START_ROW: Number(process.env.RAW_READ_START_ROW || 6000)
};

const INVENTORY_LIST_SHEETS = [
  { name: '입고리스트', dDayOffset: 0 },
  { name: '입고리스트(D-1)', dDayOffset: -1 },
  { name: '입고리스트(D-2)', dDayOffset: -2 },
  { name: '입고리스트(D-3)', dDayOffset: -3 }
];

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.google-apps.spreadsheet'
]);

const STORAGE_ORDER = {
  '냉장': 1,
  '냉동': 2,
  '상온': 3
};

export async function syncOperationsData(options = {}) {
  const includeInventory = options.includeInventory !== false;
  const includeDrive = options.includeDrive !== false;
  const result = {
    ok: true,
    inventory: { skipped: true },
    settlements: { skipped: true }
  };

  if (includeInventory) {
    result.inventory = await syncInventorySheets();
  }

  if (includeDrive) {
    try {
      result.settlements = await syncSettlementDriveFolder();
    } catch (error) {
      result.settlements = {
        ok: false,
        error: error.message
      };
      result.ok = false;
    }
  }

  return result;
}

export async function syncInventorySheets() {
  const syncRunId = crypto.randomUUID();
  const [imageMap, bufferNotes, settlementAggregates, inventoryRows, rawRows] = await Promise.all([
    readProductImageMap(),
    readRawOrderBufferNotes(syncRunId),
    readSettlementBufferAggregate(),
    readInventoryListRows(),
    readInventoryRawRows()
  ]);

  const bufferAggregates = aggregateBufferNotes(bufferNotes);
  const records = inventoryRows.map(row => {
    const productKey = normalizeProductKey(row.productName);
    const imageInfo = imageMap.get(productKey) || {};
    const bufferInfo = getAggregateForProductDate(bufferAggregates, productKey, row.inboundDateKey);
    const settlementInfo = getSettlementAggregateForProductDate(
      settlementAggregates,
      productKey,
      row.inboundDateKey
    );

    return {
      stable_id: row.stableId,
      store_name: OPS_CONFIG.STORE_NAME,
      source_spreadsheet_id: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
      source_sheet_name: row.sourceSheetName,
      source_row_number: row.sourceRowNumber,
      product_name: row.productName,
      product_key: productKey,
      storage_method: row.storageMethod,
      sales_type: row.salesType,
      inbound_date: row.inboundDateKey || null,
      inbound_date_text: row.inboundDateText,
      inbound_quantity: row.inboundQuantity,
      package_unit: row.packageUnit,
      supply_price: Number(settlementInfo?.supplyPriceVatIncluded || 0),
      sale_price: Number(imageInfo.salePrice || settlementInfo?.salePrice || 0),
      image_url: imageInfo.imageUrl || '',
      our_buffer_quantity: Number(bufferInfo?.quantity || 0),
      hq_buffer_quantity: Number(settlementInfo?.hqBufferQuantity || 0),
      d_day_offset: row.dDayOffset,
      raw_json: row.raw,
      synced_at: new Date().toISOString(),
      sync_run_id: syncRunId
    };
  });

  const rawRecords = rawRows.map(row => ({
    stable_id: row.stableId,
    store_name: OPS_CONFIG.STORE_NAME,
    source_spreadsheet_id: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    source_sheet_name: row.sourceSheetName,
    source_row_number: row.sourceRowNumber,
    product_name: row.productName,
    product_key: normalizeProductKey(row.productName),
    storage_method: row.storageMethod,
    sales_type: row.salesType,
    outbound_date: row.outboundDateKey || null,
    outbound_date_text: row.outboundDateText,
    quantity: row.quantity,
    package_unit: row.packageUnit,
    raw_json: row.raw,
    synced_at: new Date().toISOString(),
    sync_run_id: syncRunId
  }));

  const noteRecords = bufferNotes.map(row => ({
    stable_id: row.stableId,
    store_name: OPS_CONFIG.STORE_NAME,
    source_spreadsheet_id: OPS_CONFIG.ORDER_SPREADSHEET_ID,
    source_sheet_name: row.sourceSheetName,
    source_row_number: row.sourceRowNumber,
    product_name: row.productName,
    product_key: normalizeProductKey(row.productName),
    pickup_date: row.pickupDateKey || null,
    pickup_date_text: row.pickupDateText,
    note_text: row.noteText,
    parsed_buffer_quantity: row.parsedBufferQuantity,
    raw_json: row.raw,
    synced_at: new Date().toISOString(),
    sync_run_id: syncRunId
  }));

  if (records.length) {
    await upsertInChunks('operations_inventory_items', records, 'stable_id');
    await deleteStaleSyncRows('operations_inventory_items', syncRunId, [
      '입고리스트',
      '입고리스트(D-1)',
      '입고리스트(D-2)',
      '입고리스트(D-3)'
    ]);
  }

  if (rawRecords.length) {
    await upsertInChunks('operations_inventory_raw_rows', rawRecords, 'stable_id');
    await deleteStaleSyncRows('operations_inventory_raw_rows', syncRunId, ['입고 raw']);
  }

  await replaceSyncedRows('operations_buffer_notes', noteRecords, syncRunId);

  return {
    ok: true,
    syncRunId,
    inventoryCount: records.length,
    rawCount: rawRecords.length,
    bufferNoteCount: noteRecords.length
  };
}

export async function syncSettlementDriveFolder() {
  const drive = await getDriveClient();
  const syncRunId = crypto.randomUUID();
  const files = await listSettlementFiles(drive);
  const parsedFiles = [];
  let itemCount = 0;

  for (const file of files) {
    if (!EXCEL_MIME_TYPES.has(file.mimeType) && !/\.(xlsx|xls|xlsm)$/i.test(file.name || '')) {
      continue;
    }

    const workbookBuffer = await downloadDriveSpreadsheet(drive, file);
    const parsed = parseSettlementWorkbook(file, workbookBuffer, syncRunId);

    await supabaseAdmin
      .from('operations_settlement_items')
      .delete()
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .eq('drive_file_id', file.id);

    await upsertInChunks('operations_settlement_files', [parsed.fileRecord], 'drive_file_id');
    if (parsed.itemRecords.length) {
      await upsertInChunks('operations_settlement_items', parsed.itemRecords, 'stable_id');
    }

    parsedFiles.push({
      driveFileId: file.id,
      fileName: file.name,
      rowCount: parsed.itemRecords.length
    });
    itemCount += parsed.itemRecords.length;
  }

  return {
    ok: true,
    syncRunId,
    fileCount: parsedFiles.length,
    itemCount,
    files: parsedFiles
  };
}

export async function getOperationsDashboardData() {
  const [inventoryRows, bufferEvents, receivingEvents, receivingChecks] = await Promise.all([
    readSupabaseRows('operations_inventory_items', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('inbound_date', { ascending: false })
        .order('source_sheet_name', { ascending: true })
        .order('source_row_number', { ascending: true })
    ),
    readSupabaseRows('operations_buffer_events', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('created_at', { ascending: false })
        .limit(2000)
    ),
    readSupabaseRows('operations_receiving_events', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('created_at', { ascending: false })
        .limit(2000)
    ),
    readSupabaseRows('operations_receiving_checks', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
    )
  ]);
  const orderPickupDateValues = getInventoryPickupDateValues(inventoryRows);
  const orderRows = orderPickupDateValues.length
    ? await readSupabaseRowsPaged('order_cache', query =>
        query
          .select('product_name,quantity,pickup_date_text,pickup_date_value')
          .eq('store_name', OPS_CONFIG.STORE_NAME)
          .in('pickup_date_value', orderPickupDateValues)
      )
    : [];
  const orderAggregates = buildOrderAggregates(orderRows);

  const dashboardItems = buildDashboardItems(
    inventoryRows,
    bufferEvents,
    receivingEvents,
    receivingChecks,
    orderAggregates
  );
  const todayKey = getKstDateKey();
  const salesInventoryItems = dashboardItems
    .filter(item => /^입고리스트/.test(normalizeSheetName(item.sourceSheetName)));
  const salesDateOptions = buildSalesDateOptions(salesInventoryItems);
  const defaultSalesDateKey = getDefaultSalesDateKey(salesDateOptions, todayKey);
  const latestInboundDate = salesInventoryItems
    .map(item => item.inboundDateKey)
    .filter(Boolean)
    .sort()
    .pop() || todayKey;
  const staleCutoffDateKey = formatDateKey(addDays(dateFromKey(todayKey) || getKstDate(), -2));

  return {
    ok: true,
    storeName: OPS_CONFIG.STORE_NAME,
    todayKey,
    latestInboundDate,
    staleCutoffDateKey,
    defaultSalesDateKey,
    salesDateOptions,
    salesAllItems: salesInventoryItems.sort(sortInboundItems),
    salesItems: salesInventoryItems
      .filter(item => item.inboundDateKey === defaultSalesDateKey)
      .sort(sortInboundItems),
    inboundItems: dashboardItems
      .filter(item => normalizeSheetName(item.sourceSheetName) === '입고리스트' && item.inboundDateKey === todayKey)
      .sort(sortInboundItems),
    latestInboundItems: dashboardItems
      .filter(item => normalizeSheetName(item.sourceSheetName) === '입고리스트' && item.inboundDateKey === latestInboundDate)
      .sort(sortInboundItems),
    staleItems: dashboardItems
      .filter(item =>
        /^입고리스트/.test(normalizeSheetName(item.sourceSheetName)) &&
        item.inboundDateKey &&
        item.inboundDateKey <= staleCutoffDateKey
      )
      .sort(sortInboundItems),
    generatedAt: new Date().toISOString()
  };
}

function buildSalesDateOptions(items) {
  const grouped = new Map();

  items.forEach(item => {
    if (!item.inboundDateKey) return;

    const current = grouped.get(item.inboundDateKey) || {
      dateKey: item.inboundDateKey,
      label: formatDateLabel(item.inboundDateKey, item.inboundDateText),
      count: 0,
      sheetNames: new Set()
    };

    current.count += 1;
    current.sheetNames.add(item.sourceSheetName || '');
    grouped.set(item.inboundDateKey, current);
  });

  return Array.from(grouped.values())
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
    .map(option => ({
      dateKey: option.dateKey,
      label: option.label,
      count: option.count,
      sheetNames: Array.from(option.sheetNames).filter(Boolean)
    }));
}

function getDefaultSalesDateKey(options, todayKey) {
  if (!options.length) return todayKey;

  const optionKeys = new Set(options.map(option => option.dateKey));
  const operationalDateKey = getNextBusinessDateKey(todayKey);

  if (optionKeys.has(operationalDateKey)) return operationalDateKey;
  if (optionKeys.has(todayKey)) return todayKey;

  const futureDate = options
    .map(option => option.dateKey)
    .filter(dateKey => dateKey > todayKey)
    .sort()[0];

  return futureDate || options[0].dateKey;
}

function getNextBusinessDateKey(dateKey) {
  let date = dateFromKey(dateKey) || getKstDate();

  while (isNonBusinessDate(date)) {
    date = addDays(date, 1);
  }

  return formatDateKey(date);
}

function isNonBusinessDate(date) {
  return date.getDay() === 0 || date.getDay() === 6 || Boolean(getHolidayName(date));
}

function getHolidayName(date) {
  const key = formatDateKey(date);
  const fixedKey = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const holidays2026 = {
    '2026-02-16': '설 연휴',
    '2026-02-17': '설날',
    '2026-02-18': '설 연휴',
    '2026-03-02': '삼일절 대체공휴일',
    '2026-05-25': '부처님오신날',
    '2026-08-17': '광복절 대체공휴일',
    '2026-09-24': '추석 연휴',
    '2026-09-25': '추석',
    '2026-09-26': '추석 연휴',
    '2026-10-05': '개천절 대체공휴일'
  };
  const fixedHolidays = {
    '01-01': '신정',
    '03-01': '삼일절',
    '05-05': '어린이날',
    '06-06': '현충일',
    '08-15': '광복절',
    '10-03': '개천절',
    '10-09': '한글날',
    '12-25': '성탄절'
  };

  return holidays2026[key] || fixedHolidays[fixedKey] || '';
}

function formatDateLabel(dateKey, fallbackText = '') {
  const date = dateFromKey(dateKey);
  if (!date) return fallbackText || dateKey;

  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getMonth() + 1}/${date.getDate()}(${weekdays[date.getDay()]})`;
}

function dateFromKey(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

export async function createBufferEvent({ inventoryStableId, deltaQuantity, actorMemo }) {
  const inventory = await getInventoryItemByStableId(inventoryStableId);
  const delta = Number(deltaQuantity || 0);

  if (!inventory) {
    throw new Error('입고 상품을 찾지 못했습니다.');
  }

  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('버퍼 변경 수량이 올바르지 않습니다.');
  }

  const { error } = await supabaseAdmin
    .from('operations_buffer_events')
    .insert({
      store_name: OPS_CONFIG.STORE_NAME,
      inventory_stable_id: inventory.stable_id,
      product_key: inventory.product_key,
      product_name: inventory.product_name,
      delta_quantity: delta,
      actor_memo: clean(actorMemo),
      event_source: 'staff'
    });

  if (error) throw withOpsSchemaHint(error);

  return { ok: true };
}

export async function createReceivingCount({ inventoryStableId, countedQuantity, actorMemo }) {
  const inventory = await getInventoryItemByStableId(inventoryStableId);
  const quantity = Number(countedQuantity || 0);

  if (!inventory) {
    throw new Error('입고 상품을 찾지 못했습니다.');
  }

  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new Error('입고 카운팅 수량이 올바르지 않습니다.');
  }

  const { error } = await supabaseAdmin
    .from('operations_receiving_events')
    .insert({
      store_name: OPS_CONFIG.STORE_NAME,
      inventory_stable_id: inventory.stable_id,
      counted_quantity: quantity,
      actor_memo: clean(actorMemo)
    });

  if (error) throw withOpsSchemaHint(error);

  return { ok: true };
}

export async function setReceivingComplete({ inventoryStableId, isComplete, completedBy }) {
  const inventory = await getInventoryItemByStableId(inventoryStableId);

  if (!inventory) {
    throw new Error('입고 상품을 찾지 못했습니다.');
  }

  const complete = Boolean(isComplete);
  const { error } = await supabaseAdmin
    .from('operations_receiving_checks')
    .upsert({
      inventory_stable_id: inventory.stable_id,
      store_name: OPS_CONFIG.STORE_NAME,
      is_complete: complete,
      completed_at: complete ? new Date().toISOString() : null,
      completed_by: clean(completedBy),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'inventory_stable_id'
    });

  if (error) throw withOpsSchemaHint(error);

  return { ok: true };
}

export async function findCustomerCandidatesByDigits({ digits }) {
  const normalizedDigits = clean(digits).replace(/\D/g, '').slice(-4);
  if (!/^\d{4}$/.test(normalizedDigits)) {
    throw new Error('핸드폰 뒷 4자리를 입력해주세요.');
  }

  const sinceOrderDateValue = dateKeyToNumber(formatDateKey(addDays(getKstDate(), -21)));
  const rows = await readSupabaseRows('order_cache', query =>
    query
      .select('customer_label,customer_digits4,order_date_value,pickup_date_value')
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .eq('customer_digits4', normalizedDigits)
      .gte('order_date_value', sinceOrderDateValue)
      .limit(2000)
  );
  const grouped = new Map();

  rows.forEach(row => {
    const label = clean(row.customer_label);
    if (!label) return;

    const current = grouped.get(label) || {
      customerLabel: label,
      customerDigits4: normalizedDigits,
      orderCount: 0,
      latestOrderDateValue: 0,
      latestPickupDateValue: 0
    };

    current.orderCount += 1;
    current.latestOrderDateValue = Math.max(
      current.latestOrderDateValue,
      Number(row.order_date_value || 0)
    );
    current.latestPickupDateValue = Math.max(
      current.latestPickupDateValue,
      Number(row.pickup_date_value || 0)
    );
    grouped.set(label, current);
  });

  return {
    ok: true,
    digits: normalizedDigits,
    sinceOrderDateValue,
    candidates: Array.from(grouped.values())
      .sort((a, b) => {
        if (b.latestOrderDateValue !== a.latestOrderDateValue) {
          return b.latestOrderDateValue - a.latestOrderDateValue;
        }

        return a.customerLabel.localeCompare(b.customerLabel, 'ko');
      })
  };
}

async function getDriveClient() {
  const auth = getGoogleAuth(['https://www.googleapis.com/auth/drive.readonly']);
  return google.drive({ version: 'v3', auth });
}

async function listSettlementFiles(drive) {
  const files = [];
  let pageToken = undefined;

  do {
    const response = await drive.files.list({
      q: `'${OPS_CONFIG.SETTLEMENT_DRIVE_FOLDER_ID}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
      pageSize: 100,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadDriveSpreadsheet(drive, file) {
  const response = file.mimeType === 'application/vnd.google-apps.spreadsheet'
    ? await drive.files.export(
        {
          fileId: file.id,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        { responseType: 'arraybuffer' }
      )
    : await drive.files.get(
        {
          fileId: file.id,
          alt: 'media',
          supportsAllDrives: true
        },
        { responseType: 'arraybuffer' }
      );

  return Buffer.from(response.data);
}

function parseSettlementWorkbook(file, buffer, syncRunId) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,
    cellNF: false,
    cellText: false
  });
  const itemRecords = [];

  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: ''
    });
    const parsedRows = parseSettlementSheetRows(file, sheetName, rows, syncRunId);
    itemRecords.push(...parsedRows);
  });

  return {
    fileRecord: {
      drive_file_id: file.id,
      store_name: OPS_CONFIG.STORE_NAME,
      file_name: file.name || '',
      mime_type: file.mimeType || '',
      modified_time: file.modifiedTime || null,
      md5_checksum: file.md5Checksum || '',
      size_bytes: Number(file.size || 0),
      parsed_at: new Date().toISOString(),
      sheet_count: workbook.SheetNames.length,
      row_count: itemRecords.length,
      sync_run_id: syncRunId
    },
    itemRecords
  };
}

function parseSettlementSheetRows(file, sheetName, rows, syncRunId) {
  const headerIndex = findSettlementHeaderRowIndex(rows);
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map(normalizeHeader);
  const columns = {
    productName: findHeaderIndex(headers, ['상품명', '제품명', '품명', '상품']),
    taxStatus: findHeaderIndex(headers, ['면세', '과세', '세금', '부가세']),
    settlementCount: findHeaderIndex(headers, ['정산서개수', '정산수량', '수량', '개수']),
    supplyExVat: findHeaderIndex(headers, ['vat별도', 'vat 별도', '공급가별도', '공급가(vat별도)']),
    supplyVatIncluded: findHeaderIndex(headers, ['공급가vat포함', 'vat포함', 'vat 포함', '공급가포함', '공급가(vat포함)']),
    salePrice: findHeaderIndex(headers, ['판매가', '매출가']),
    hqBuffer: findHeaderIndex(headers, ['본사버퍼', '추가수량', '추가수량상시판매필요', '버퍼'])
  };

  if (columns.productName < 0) return [];

  const records = [];
  const inferredDate = inferSettlementDateKey(file, sheetName, rows.slice(0, headerIndex + 1));

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const productName = clean(row[columns.productName]);
    if (!productName || productName.includes('합계')) continue;

    const raw = {};
    headers.forEach((header, index) => {
      if (header) raw[header] = clean(row[index]);
    });

    const settlementDateText = clean(
      raw['정산일'] ||
      raw['날짜'] ||
      raw['일자'] ||
      raw['입고일'] ||
      inferredDate.text
    );
    const settlementDate = parseDateText(settlementDateText)?.dateKey || inferredDate.dateKey || null;
    const productKey = normalizeProductKey(productName);
    const hqBufferQuantity = parseNumber(row[columns.hqBuffer]);

    records.push({
      stable_id: stableHash(file.id, sheetName, rowIndex + 1, productKey),
      store_name: OPS_CONFIG.STORE_NAME,
      drive_file_id: file.id,
      file_name: file.name || '',
      sheet_name: sheetName,
      row_number: rowIndex + 1,
      settlement_date: settlementDate,
      settlement_date_text: settlementDateText,
      product_name: productName,
      product_key: productKey,
      tax_status: clean(row[columns.taxStatus]),
      settlement_count: parseNumber(row[columns.settlementCount]),
      supply_price_ex_vat: parseNumber(row[columns.supplyExVat]),
      supply_price_vat_included: parseNumber(row[columns.supplyVatIncluded]),
      sale_price: parseNumber(row[columns.salePrice]),
      hq_buffer_quantity: hqBufferQuantity,
      is_fresh_produce: /과일|야채|채소|농산|복숭아|수박|사과|포도|망고|토마토|버섯/.test(productName),
      raw_json: raw,
      parsed_at: new Date().toISOString(),
      sync_run_id: syncRunId
    });
  }

  return records;
}

async function readProductImageMap() {
  if (!OPS_CONFIG.ORDER_SPREADSHEET_ID) return new Map();

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: OPS_CONFIG.ORDER_SPREADSHEET_ID,
    range: '발주요청(Index)!D2:H',
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const map = new Map();

  (response.data.values || []).forEach(row => {
    const productName = clean(row[0]);
    if (!productName) return;

    map.set(normalizeProductKey(productName), {
      productName,
      pickupDateText: clean(row[2]),
      salePrice: parseNumber(row[3]),
      imageUrl: clean(row[4])
    });
  });

  return map;
}

async function readRawOrderBufferNotes(syncRunId) {
  if (!OPS_CONFIG.ORDER_SPREADSHEET_ID) return [];

  const sheets = await getSheetsClient();
  const start = Math.max(1, OPS_CONFIG.RAW_READ_START_ROW);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: OPS_CONFIG.ORDER_SPREADSHEET_ID,
    range: `${OPS_CONFIG.RAW_SHEET_NAME}!A${start}:K`,
    valueRenderOption: 'FORMATTED_VALUE'
  });

  return (response.data.values || []).flatMap((row, index) => {
    const noteText = clean(row[8]);
    const parsedBufferQuantity = parseBufferNoteQuantity(noteText);
    const productName = clean(row[5]);

    if (!productName || !noteText || !/버퍼/.test(noteText)) return [];

    const pickupDateText = clean(row[9]);
    const pickupDate = parseDateText(pickupDateText);
    const sourceRowNumber = start + index;

    return [{
      stableId: stableHash(OPS_CONFIG.ORDER_SPREADSHEET_ID, OPS_CONFIG.RAW_SHEET_NAME, sourceRowNumber),
      sourceSheetName: OPS_CONFIG.RAW_SHEET_NAME,
      sourceRowNumber,
      productName,
      pickupDateText,
      pickupDateKey: pickupDate?.dateKey || '',
      noteText,
      parsedBufferQuantity,
      raw: rowToObject(['공구일자', '가격', '이미지 URL', '주문일자', '고객명', '주문상품', '수량', '아군 주문', '비고', '픽업일', 'K'], row),
      syncRunId
    }];
  });
}

async function readInventoryListRows() {
  const sheets = await getSheetsClient();
  const ranges = INVENTORY_LIST_SHEETS.map(sheet => `${sheet.name}!A1:K1000`);
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    ranges,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const rows = [];

  (response.data.valueRanges || []).forEach((rangeResult, index) => {
    const sheetInfo = INVENTORY_LIST_SHEETS[index];
    rows.push(...parseInventorySheetRows(sheetInfo, rangeResult.values || []));
  });

  return rows;
}

async function readInventoryRawRows() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    range: `'입고 raw'!A1:K3000`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const rows = response.data.values || [];
  if (rows.length < 2) return [];

  return rows.slice(1).flatMap((row, index) => {
    const productName = clean(row[1]);
    if (!productName) return [];

    const sourceRowNumber = index + 2;
    const outboundDateText = clean(row[3]);
    const outboundDate = parseDateText(outboundDateText);

    return [{
      stableId: stableHash(OPS_CONFIG.INVENTORY_SPREADSHEET_ID, '입고 raw', sourceRowNumber),
      sourceSheetName: '입고 raw',
      sourceRowNumber,
      storageMethod: normalizeStorageMethod(row[0]),
      productName,
      salesType: clean(row[2]),
      outboundDateText,
      outboundDateKey: outboundDate?.dateKey || '',
      quantity: parseNumber(row[4]),
      packageUnit: clean(row[5]),
      raw: rowToObject(['보관 방법', '상품명', '구분', '출고일', '출고수량', '포장 단위'], row)
    }];
  });
}

function parseInventorySheetRows(sheetInfo, rows) {
  const headerIndex = findHeaderRowIndex(rows, ['보관', '상품명', '입고수량']);
  if (headerIndex < 0) return [];

  const header = rows[headerIndex].map(normalizeHeader);
  const columns = {
    storageMethod: findHeaderIndex(header, ['보관방법', '보관']),
    productName: findHeaderIndex(header, ['상품명', '상품']),
    salesType: findHeaderIndex(header, ['구분']),
    inboundDate: findHeaderIndex(header, ['입고일']),
    inboundQuantity: findHeaderIndex(header, ['입고수량', '수량']),
    packageUnit: findHeaderIndex(header, ['포장단위', '포장'])
  };

  const parsed = [];

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const productName = clean(row[columns.productName]);
    if (!productName) continue;

    const inboundDateText = clean(row[columns.inboundDate]);
    const inboundDate = parseDateText(inboundDateText);
    const sourceRowNumber = rowIndex + 1;

    parsed.push({
      stableId: stableHash(OPS_CONFIG.INVENTORY_SPREADSHEET_ID, sheetInfo.name, sourceRowNumber),
      sourceSheetName: sheetInfo.name,
      sourceRowNumber,
      storageMethod: normalizeStorageMethod(row[columns.storageMethod]),
      productName,
      salesType: clean(row[columns.salesType]),
      inboundDateText,
      inboundDateKey: inboundDate?.dateKey || '',
      inboundQuantity: parseNumber(row[columns.inboundQuantity]),
      packageUnit: clean(row[columns.packageUnit]),
      dDayOffset: sheetInfo.dDayOffset,
      raw: rowToObject(rows[headerIndex], row)
    });
  }

  return parsed;
}

async function readSettlementBufferAggregate() {
  const rows = await readSupabaseRows('operations_settlement_items', query =>
    query
      .select('product_key,settlement_date,hq_buffer_quantity,supply_price_vat_included,sale_price')
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .limit(5000)
  );

  const byExactDate = new Map();

  rows.forEach(row => {
    addSettlementAggregate(byExactDate, row.product_key, row.settlement_date || '', row);
  });

  const byProduct = new Map();

  byExactDate.forEach((aggregate, key) => {
    const [productKey, dateKey] = key.split('::');
    if (!productKey || !dateKey) return;
    if (!byProduct.has(productKey)) byProduct.set(productKey, []);
    byProduct.get(productKey).push({ ...aggregate, dateKey });
  });

  byProduct.forEach(aggregates => {
    aggregates.sort((a, b) => String(b.dateKey).localeCompare(String(a.dateKey)));
  });

  return { byExactDate, byProduct };
}

function addSettlementAggregate(map, productKey, dateKey, row) {
  if (!productKey || !dateKey) return;

  const key = aggregateKey(productKey, dateKey);
  const current = map.get(key) || {
    quantity: 0,
    hqBufferQuantity: 0,
    supplyPriceVatIncluded: 0,
    salePrice: 0
  };

  current.quantity += Number(row.hq_buffer_quantity || 0);
  current.hqBufferQuantity += Number(row.hq_buffer_quantity || 0);
  current.supplyPriceVatIncluded = Number(row.supply_price_vat_included || current.supplyPriceVatIncluded || 0);
  current.salePrice = Number(row.sale_price || current.salePrice || 0);

  map.set(key, current);
}

function aggregateBufferNotes(notes) {
  const map = new Map();

  notes.forEach(note => {
    const productKey = normalizeProductKey(note.productName);
    const quantity = Number(note.parsedBufferQuantity || 0);
    const key = aggregateKey(productKey, note.pickupDateKey || '');
    const productOnlyKey = aggregateKey(productKey, '');

    map.set(key, {
      quantity: Number(map.get(key)?.quantity || 0) + quantity
    });
    map.set(productOnlyKey, {
      quantity: Number(map.get(productOnlyKey)?.quantity || 0) + quantity
    });
  });

  return map;
}

function getAggregateForProductDate(map, productKey, dateKey) {
  if (!dateKey) return null;
  return map.get(aggregateKey(productKey, dateKey)) || null;
}

function getSettlementAggregateForProductDate(aggregates, productKey, dateKey) {
  if (!productKey || !dateKey || !aggregates) return null;

  const exact = aggregates.byExactDate?.get(aggregateKey(productKey, dateKey));
  if (exact) return exact;

  const date = dateFromKey(dateKey);
  const productAggregates = aggregates.byProduct?.get(productKey) || [];
  if (!date || !productAggregates.length) return null;

  const closestPast = productAggregates
    .map(aggregate => ({
      aggregate,
      diffDays: diffDays(dateFromKey(aggregate.dateKey), date)
    }))
    .filter(candidate => candidate.diffDays >= 0 && candidate.diffDays <= 14)
    .sort((a, b) => a.diffDays - b.diffDays)[0];

  return closestPast?.aggregate || null;
}

function buildOrderAggregates(orderRows) {
  const aggregates = new Map();

  (orderRows || []).forEach(row => {
    const productKey = normalizeProductKey(row.product_name);
    const dateKey = dateValueToDateKey(row.pickup_date_value) ||
      parseDateText(row.pickup_date_text)?.dateKey ||
      '';
    if (!productKey || !dateKey) return;

    const key = aggregateKey(productKey, dateKey);
    const current = aggregates.get(key) || {
      orderQuantity: 0,
      orderLineCount: 0
    };
    const quantity = Number(row.quantity || 0);

    current.orderQuantity += quantity;
    current.orderLineCount += 1;

    aggregates.set(key, current);
  });

  const result = new Map();
  aggregates.forEach((aggregate, key) => {
    result.set(key, {
      orderQuantity: aggregate.orderQuantity,
      orderLineCount: aggregate.orderLineCount
    });
  });

  return result;
}

function dateValueToDateKey(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateKeyToNumber(dateKey) {
  const text = clean(dateKey).replace(/\D/g, '');
  return /^\d{8}$/.test(text) ? Number(text) : 0;
}

function buildDashboardItems(inventoryRows, bufferEvents, receivingEvents, receivingChecks, orderAggregates) {
  const bufferByItem = groupBySum(bufferEvents, 'inventory_stable_id', 'delta_quantity');
  const receivingByItem = groupBySum(receivingEvents, 'inventory_stable_id', 'counted_quantity');
  const bufferHistoryByItem = groupByRows(bufferEvents, 'inventory_stable_id');
  const receivingCheckByItem = new Map(receivingChecks.map(row => [row.inventory_stable_id, row]));

  return inventoryRows.map(row => {
    const bufferDelta = Number(bufferByItem.get(row.stable_id) || 0);
    const initialBufferQuantity =
      Number(row.hq_buffer_quantity || 0) + Number(row.our_buffer_quantity || 0);
    const bufferRemainingQuantity = Math.max(0, initialBufferQuantity + bufferDelta);
    const bufferUsedQuantity = Math.max(0, initialBufferQuantity - bufferRemainingQuantity);
    const inboundQuantity = Number(row.inbound_quantity || 0);
    const countedQuantity = Number(receivingByItem.get(row.stable_id) || 0);
    const receivingCheck = receivingCheckByItem.get(row.stable_id);
    const isReceivingComplete = Boolean(receivingCheck?.is_complete);
    const orderInfo = orderAggregates?.get(aggregateKey(row.product_key, row.inbound_date || '')) || {};
    const customerOrderQuantity = Number(orderInfo.orderQuantity || 0);
    const physicalRemainingQuantity = Math.max(
      0,
      inboundQuantity - bufferUsedQuantity
    );

    return {
      id: row.stable_id,
      sourceSheetName: row.source_sheet_name,
      sourceRowNumber: row.source_row_number,
      productName: row.product_name,
      productKey: row.product_key,
      storageMethod: normalizeStorageMethod(row.storage_method),
      salesType: row.sales_type || '',
      inboundDateKey: row.inbound_date || '',
      inboundDateText: row.inbound_date_text || '',
      inboundQuantity,
      remainingQuantity: physicalRemainingQuantity,
      physicalRemainingQuantity,
      packageUnit: row.package_unit || '',
      supplyPrice: Number(row.supply_price || 0),
      salePrice: Number(row.sale_price || 0),
      imageUrl: row.image_url || '',
      ourBufferQuantity: Number(row.our_buffer_quantity || 0),
      hqBufferQuantity: Number(row.hq_buffer_quantity || 0),
      initialBufferQuantity,
      bufferRemainingQuantity,
      bufferUsedQuantity,
      customerOrderQuantity,
      orderLineCount: Number(orderInfo.orderLineCount || 0),
      countedQuantity,
      isReceivingComplete,
      completedAt: receivingCheck?.completed_at || '',
      dDayOffset: row.d_day_offset,
      bufferHistory: (bufferHistoryByItem.get(row.stable_id) || []).slice(0, 120).map(event => ({
        deltaQuantity: Number(event.delta_quantity || 0),
        actorMemo: event.actor_memo || '',
        eventSource: event.event_source || '',
        createdAt: event.created_at
      }))
    };
  });
}

async function getInventoryItemByStableId(stableId) {
  const { data, error } = await supabaseAdmin
    .from('operations_inventory_items')
    .select('*')
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .eq('stable_id', stableId)
    .maybeSingle();

  if (error) throw withOpsSchemaHint(error);
  return data || null;
}

async function upsertInChunks(tableName, records, onConflict, chunkSize = 500) {
  for (let i = 0; i < records.length; i += chunkSize) {
    const { error } = await supabaseAdmin
      .from(tableName)
      .upsert(records.slice(i, i + chunkSize), { onConflict });

    if (error) throw withOpsSchemaHint(error);
  }
}

async function replaceSyncedRows(tableName, records, syncRunId) {
  if (records.length) {
    await upsertInChunks(tableName, records, 'stable_id');
  }

  const { error } = await supabaseAdmin
    .from(tableName)
    .delete()
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .neq('sync_run_id', syncRunId);

  if (error) throw withOpsSchemaHint(error);
}

async function deleteStaleSyncRows(tableName, syncRunId, sourceSheetNames) {
  let query = supabaseAdmin
    .from(tableName)
    .delete()
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .neq('sync_run_id', syncRunId);

  if (sourceSheetNames?.length) {
    query = query.in('source_sheet_name', sourceSheetNames);
  }

  const { error } = await query;
  if (error) throw withOpsSchemaHint(error);
}

async function readSupabaseRows(tableName, buildQuery) {
  const { data, error } = await buildQuery(supabaseAdmin.from(tableName));

  if (error) {
    if (isMissingOpsTableError(error)) {
      throw withOpsSchemaHint(error);
    }
    throw error;
  }

  return data || [];
}

async function readSupabaseRowsPaged(tableName, buildQuery, { pageSize = 1000, maxRows = 50000 } = {}) {
  const rows = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    const to = Math.min(from + pageSize - 1, maxRows - 1);
    const { data, error } = await buildQuery(supabaseAdmin.from(tableName)).range(from, to);

    if (error) {
      if (isMissingOpsTableError(error)) {
        throw withOpsSchemaHint(error);
      }
      throw error;
    }

    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

function getInventoryPickupDateValues(rows) {
  return [...new Set((rows || [])
    .filter(row => /^입고리스트/.test(normalizeSheetName(row.source_sheet_name)))
    .map(row => dateKeyToNumber(row.inbound_date))
    .filter(Boolean))];
}

function groupBySum(rows, keyName, valueName) {
  const map = new Map();

  rows.forEach(row => {
    const key = row[keyName];
    if (!key) return;
    map.set(key, Number(map.get(key) || 0) + Number(row[valueName] || 0));
  });

  return map;
}

function groupByRows(rows, keyName) {
  const map = new Map();

  rows.forEach(row => {
    const key = row[keyName];
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });

  return map;
}

function parseBufferNoteQuantity(value) {
  const text = clean(value);
  if (!/버퍼/.test(text)) return 0;

  const normalized = text
    .replace(/[＞〉➜➡⇒]/g, '>')
    .replace(/→/g, '>');
  const hasAllocationMarker = /버퍼\s*배분/.test(normalized);
  const startsWithBufferQuantity = /버퍼\s*\d/.test(normalized);

  if (hasAllocationMarker || startsWithBufferQuantity) {
    const chainMatches = [
      ...normalized.matchAll(/\d+\s*(?:-+\s*>\s*|>\s*)\d+(?:\s*(?:-+\s*>\s*|>\s*)\d+)*/g)
    ];

    if (chainMatches.length) {
      const lastChain = chainMatches[chainMatches.length - 1][0];
      const numbers = lastChain.match(/\d+/g) || [];
      return Number(numbers[numbers.length - 1] || 0);
    }
  }

  const directMatch = text.match(/버퍼\s*[:：]?\s*(\d+)/i);
  if (directMatch) return Number(directMatch[1] || 0);

  return 0;
}

function findSettlementHeaderRowIndex(rows) {
  return rows.findIndex(row => {
    const text = (row || []).map(normalizeHeader).join(' ');
    const hasProduct = ['상품명', '제품명', '품명', '상품'].some(keyword =>
      text.includes(normalizeHeader(keyword))
    );
    return hasProduct && text.includes(normalizeHeader('공급가')) && text.includes(normalizeHeader('판매가'));
  });
}

function findHeaderRowIndex(rows, requiredKeywords) {
  return rows.findIndex(row => {
    const text = (row || []).map(normalizeHeader).join(' ');
    return requiredKeywords.every(keyword => text.includes(normalizeHeader(keyword)));
  });
}

function findHeaderIndex(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.findIndex(header => normalizedCandidates.some(candidate => header.includes(candidate)));
}

function normalizeHeader(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/[()[\]{}]/g, '')
    .toLowerCase();
}

function normalizeStorageMethod(value) {
  const text = clean(value);
  if (/냉동/.test(text)) return '냉동';
  if (/냉장/.test(text)) return '냉장';
  if (/상온|실온/.test(text)) return '상온';
  return text && text !== '0' ? text : '상온';
}

function normalizeProductKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[()[\]{}]/g, '')
    .trim();
}

function parseNumber(value) {
  const text = clean(value)
    .replace(/,/g, '')
    .replace(/원|개|ea|EA/g, '')
    .replace(/[^\d.-]/g, '');
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function parseDateText(value) {
  const text = clean(value);
  if (!text) return null;

  let match = text.match(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/);
  if (match) return buildDateInfo(Number(match[1]), Number(match[2]), Number(match[3]), text);

  match = text.match(/(\d{1,2})\D+(\d{1,2})/);
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = inferYearForMonthDay(month);
  return buildDateInfo(year, month, day, text);
}

function inferDateKeyFromText(value) {
  const date = parseDateText(value);
  return {
    dateKey: date?.dateKey || '',
    text: date?.raw || ''
  };
}

function inferSettlementDateKey(file, sheetName, headerRows) {
  const candidates = [
    file.name || '',
    sheetName || '',
    ...(headerRows || []).flatMap(row => row || [])
  ];

  for (const candidate of candidates) {
    const parsed = parseDateText(candidate) || parseCompactDateText(candidate);
    if (parsed?.dateKey) {
      return {
        dateKey: parsed.dateKey,
        text: parsed.raw
      };
    }
  }

  return inferDateKeyFromText(`${file.name || ''} ${sheetName || ''}`);
}

function parseCompactDateText(value) {
  const text = clean(value);
  const match = text.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})(?:\D|$)/);
  if (!match) return null;

  const yearPrefix = Number(match[1]) >= 70 ? 1900 : 2000;
  return buildDateInfo(yearPrefix + Number(match[1]), Number(match[2]), Number(match[3]), match[0].trim());
}

function buildDateInfo(year, month, day, raw) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return {
    date,
    dateKey: [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-'),
    raw
  };
}

function inferYearForMonthDay(month) {
  const today = getKstDate();
  let year = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return year;
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

function getKstDateKey() {
  return formatDateKey(getKstDate());
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function diffDays(fromDate, toDate) {
  if (!fromDate || !toDate) return Number.POSITIVE_INFINITY;

  const fromUtc = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const toUtc = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.round((toUtc - fromUtc) / 86400000);
}

function rowToObject(headers, row) {
  const object = {};
  (headers || []).forEach((header, index) => {
    const key = clean(header) || `col_${index + 1}`;
    object[key] = clean(row[index]);
  });
  return object;
}

function stableHash(...parts) {
  return crypto
    .createHash('sha1')
    .update(parts.map(part => String(part ?? '')).join('||'))
    .digest('hex');
}

function aggregateKey(productKey, dateKey) {
  return `${productKey || ''}::${dateKey || ''}`;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSheetName(value) {
  return clean(value).replace(/\s+/g, '');
}

function sortSalesItems(a, b) {
  if (b.bufferRemainingQuantity !== a.bufferRemainingQuantity) {
    return b.bufferRemainingQuantity - a.bufferRemainingQuantity;
  }

  return sortInboundItems(a, b);
}

function sortInboundItems(a, b) {
  const storageDiff = (STORAGE_ORDER[a.storageMethod] || 9) - (STORAGE_ORDER[b.storageMethod] || 9);
  if (storageDiff !== 0) return storageDiff;
  return String(a.productName || '').localeCompare(String(b.productName || ''), 'ko');
}

function withOpsSchemaHint(error) {
  if (!isMissingOpsTableError(error)) return error;

  return new Error(
    '운영용 Supabase 테이블이 없습니다. docs/supabase-ops-schema.sql을 Supabase SQL Editor에서 먼저 실행해주세요.'
  );
}

function isMissingOpsTableError(error) {
  const message = `${error?.message || ''} ${error?.details || ''}`;
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    /does not exist|schema cache|Could not find the table|운영용 Supabase 테이블/i.test(message)
  );
}
