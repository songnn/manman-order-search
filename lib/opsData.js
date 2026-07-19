import crypto from 'node:crypto';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import { getGoogleAuth, getSheetsClient } from './googleSheetsClient.js';
import {
  findStaleProductStorageRows,
  normalizeProductStorageKey,
  normalizeStorageMethod as normalizeVerifiedStorageMethod,
  summarizeProductStorageRows
} from './productStorage.js';
import { supabaseAdmin } from './supabaseAdmin.js';

export const OPS_CONFIG = {
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  ORDER_SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  INVENTORY_SPREADSHEET_ID:
    process.env.INVENTORY_SPREADSHEET_ID || '12JVJaSAu58xLZUAnl9IvVW_mjOAxNZ9MuHWqSg2nuxE',
  SETTLEMENT_DRIVE_FOLDER_ID:
    process.env.SETTLEMENT_DRIVE_FOLDER_ID || '1FDxd4IUy_f_rAZnqMBOG37hVaf9weIVj',
  PRODUCT_IMAGE_BUCKET: process.env.OPS_PRODUCT_IMAGE_BUCKET || 'ops-product-images',
  IMAGE_FALLBACK_URL: process.env.OPS_IMAGE_FALLBACK_URL || '/store-purchase-icon.png',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  RAW_READ_START_ROW: Number(process.env.RAW_READ_START_ROW || 6000)
};

const INVENTORY_LIST_SHEETS = [
  { name: '입고리스트', dDayOffset: 0 },
  { name: '입고리스트(D-1)', dDayOffset: -1 },
  { name: '입고리스트(D-2)', dDayOffset: -2 },
  { name: '입고리스트(D-3)', dDayOffset: -3 }
];

const INVENTORY_LIST_RANGE = 'A1:K1000';
const INVENTORY_RAW_RANGE = process.env.OPS_INVENTORY_RAW_RANGE || 'A1:K10000';
const INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS = {
  productCode: 0,
  storageMethod: 1,
  productName: 2,
  salesType: 3,
  inboundQuantity: 4,
  packageUnit: 6,
  orderQuantity: 7,
  hqBufferQuantity: 8,
  supplyPrice: 9
};
const INVENTORY_RAW_HEADERS = {
  groupSaleDate: ['공구일', '공구 일', '공구일자', '공구 일자', '공구날짜', '공구 날짜', '공구길', '공구글', '공구링크', '공구 링크'],
  productCode: ['상품코드', '상품 코드', '제품코드', '제품 코드', '품목코드', '품목 코드', '코드'],
  orderQuantity: ['발주수량', '발주 수량', '발주량', '발주 량', '주문수량', '주문 수량'],
  hqBufferQuantity: ['본사버퍼', '본사 버퍼', '본사버퍼수량', '본사 버퍼 수량', '본사재고', '본사 재고', '버퍼'],
  supplyPrice: ['공급가', '공급가격', '공급 가격']
};
const INVENTORY_PRODUCT_NAME_HEADERS = ['상품명', '상품 이름', '제품명', '제품 이름', '품명'];
const INVENTORY_RAW_ROW_FALLBACK_COLUMNS = {
  storageMethod: 0,
  productName: 1,
  salesType: 2,
  outboundDate: 3,
  quantity: 4,
  packageUnit: 5,
  groupSaleDate: 6,
  productCode: 7,
  orderQuantity: 8,
  hqBufferQuantity: 9,
  supplyPrice: 10
};

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.google-apps.spreadsheet'
]);

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const COMPLETED_SETTLEMENT_FOLDER_NAME = '정산완료';
const COMPLETED_SETTLEMENT_LOOKBACK_DAYS = Number(process.env.COMPLETED_SETTLEMENT_LOOKBACK_DAYS || 14);
const INVENTORY_HISTORY_RETENTION_DAYS = Number(process.env.OPS_INVENTORY_HISTORY_RETENTION_DAYS || 7);
const GENERATED_IMAGE_PATHS_CACHE_MS = Math.max(0, Number(process.env.OPS_GENERATED_IMAGE_PATHS_CACHE_MS || 60000));
const SETTLEMENT_REVIEW_CACHE_MS = Math.max(0, Number(process.env.OPS_SETTLEMENT_REVIEW_CACHE_MS || 120000));
const CS_SETTLEMENT_IMAGE_URL = '/settlement-cs-item.png';
const generatedProductImagePathsCache = {
  expiresAt: 0,
  paths: null
};
const settlementReviewCache = globalThis.__opsSettlementReviewCache || {
  expiresAt: 0,
  data: null,
  promise: null
};
globalThis.__opsSettlementReviewCache = settlementReviewCache;

const STORAGE_ORDER = {
  '냉장': 1,
  '냉동': 2,
  '상온': 3
};

const ORDER_COUNT_EXCLUDED_CUSTOMERS = new Set([
  '로지4298',
  '로지4739',
  '죠르디9319',
  '하품하는죠르디0108',
  '프리지아6450'
]);

const SPREADSHEET_ERROR_VALUES = [
  '#N/A',
  '#N/A!',
  '#VALUE!',
  '#REF!',
  '#DIV/0!',
  '#NAME?',
  '#NAME!',
  '#NUM!',
  '#NULL!',
  '#ERROR!',
  '#CALC!',
  '#SPILL!',
  '#FIELD!'
];

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
  const syncStartedAt = new Date().toISOString();
  const [bufferNotes, settlementAggregates, inventoryRows, rawRows] = await Promise.all([
    readRawOrderBufferNotes(syncRunId),
    readSettlementBufferAggregate(),
    readInventoryListRows(),
    readInventoryRawRows()
  ]);

  if (!inventoryRows.length) {
    throw new Error('입고리스트에서 유효한 상품을 찾지 못했습니다. 기존 입고 데이터는 유지합니다.');
  }

  const [cachedImageMap, indexImageMap] = await Promise.all([
    readCachedProductImageMap(inventoryRows),
    readProductImageMap()
  ]);
  const imageMap = mergeProductImageMaps(indexImageMap, cachedImageMap);

  const bufferAggregates = aggregateBufferNotes(bufferNotes);
  const records = dedupeInventoryRecords(inventoryRows.map(row => {
    const productKey = normalizeProductKey(row.productName);
    const imageProductKey = normalizeProductImageKey(row.productName) || productKey;
    const imageInfo = imageMap.get(productKey) || imageMap.get(imageProductKey) || {};
    const bufferInfo = getAggregateForProductDate(bufferAggregates, productKey, row.inboundDateKey);
    const settlementInfo = getSettlementAggregateForProductDate(
      settlementAggregates,
      productKey,
      row.inboundDateKey
    );

    const supplyPrice = row.hasSupplyPrice
      ? Number(row.supplyPrice || 0)
      : Number(settlementInfo?.supplyPriceVatIncluded || 0);
    const hqBufferQuantity = row.hasValidHqBufferQuantity
      ? Number(row.hqBufferQuantity || 0)
      : Number(settlementInfo?.hqBufferQuantity || 0);

    return {
      stable_id: row.stableId,
      store_name: OPS_CONFIG.STORE_NAME,
      source_spreadsheet_id: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
      source_sheet_name: row.sourceSheetName,
      source_row_number: row.sourceRowNumber,
      product_name: row.productName,
      product_key: productKey,
      storage_method: row.storageMethod || null,
      sales_type: row.salesType,
      inbound_date: row.inboundDateKey || null,
      inbound_date_text: row.inboundDateText,
      inbound_quantity: row.inboundQuantity,
      package_unit: row.packageUnit,
      supply_price: supplyPrice,
      sale_price: Number(imageInfo.salePrice || settlementInfo?.salePrice || 0),
      image_url: imageInfo.imageUrl || OPS_CONFIG.IMAGE_FALLBACK_URL,
      our_buffer_quantity: Number(bufferInfo?.quantity || 0),
      hq_buffer_quantity: hqBufferQuantity,
      d_day_offset: row.dDayOffset,
      raw_json: row.raw,
      synced_at: syncStartedAt,
      sync_run_id: syncRunId
    };
  }));

  const rawRecords = rawRows.map(row => ({
    stable_id: row.stableId,
    store_name: OPS_CONFIG.STORE_NAME,
    source_spreadsheet_id: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    source_sheet_name: row.sourceSheetName,
    source_row_number: row.sourceRowNumber,
    product_name: row.productName,
    product_key: normalizeProductKey(row.productName),
    storage_method: row.storageMethod || null,
    sales_type: row.salesType,
    outbound_date: row.outboundDateKey || null,
    outbound_date_text: row.outboundDateText,
    quantity: row.quantity,
    package_unit: row.packageUnit,
    raw_json: row.raw,
    synced_at: syncStartedAt,
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
    synced_at: syncStartedAt,
    sync_run_id: syncRunId
  }));

  if (records.length) {
    const archivedRows = await archiveInventoryRowsWithChangedStableIds(records);

    try {
      await upsertInChunks('operations_inventory_items', records, 'stable_id');
    } catch (error) {
      try {
        await restoreArchivedInventoryRows(archivedRows);
      } catch (restoreError) {
        console.error('operations inventory archive rollback failed:', restoreError);
      }
      throw error;
    }

    await deleteExpiredInventoryHistoryRows(syncRunId);
  }

  await deleteInvalidInventoryProductRows();

  if (rawRecords.length) {
    const cachedRawRecords = await readSupabaseRowsPaged(
      'operations_inventory_raw_rows',
      query => query
        .select('stable_id,source_sheet_name,sync_run_id,synced_at')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .in('source_sheet_name', ['입고 raw'])
    );
    await upsertInChunks('operations_inventory_raw_rows', rawRecords, 'stable_id');
    const staleRawRecords = findStaleProductStorageRows(cachedRawRecords, rawRecords);
    await deleteStaleProductStorageRows(staleRawRecords);
  }

  await replaceSyncedRows('operations_buffer_notes', noteRecords, syncRunId);

  return {
    ok: true,
    syncRunId,
    inventoryCount: records.length,
    rawCount: rawRecords.length,
    productStorage: summarizeProductStorageRows(rawRows),
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

export function normalizeInventoryRowProductFields(row = {}) {
  const rawName = getRawStringByHeaders(row.raw_json, INVENTORY_PRODUCT_NAME_HEADERS);
  const rawCode = getRawStringByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.productCode);
  const currentName = clean(row.product_name);
  const productName = resolveDisplayProductName(currentName, rawName, rawCode);

  if (!productName || productName === currentName) {
    return row;
  }

  return {
    ...row,
    product_name: productName,
    product_key: normalizeProductKey(productName)
  };
}

export async function getOperationsDashboardData(options = {}) {
  const includeSettlement = options.includeSettlement !== false;
  const [inventoryRows, inventoryRawRows, bufferEvents, receivingEvents, receivingChecks, bufferNotes, settlementRows, generatedImagePaths] = await Promise.all([
    readSupabaseRows('operations_inventory_items', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('inbound_date', { ascending: false })
        .order('source_sheet_name', { ascending: true })
        .order('source_row_number', { ascending: true })
    ),
    includeSettlement
      ? readSupabaseRows('operations_inventory_raw_rows', query =>
          query
            .select('*')
            .eq('store_name', OPS_CONFIG.STORE_NAME)
            .order('outbound_date', { ascending: false })
            .order('source_row_number', { ascending: true })
            .limit(5000)
        )
      : Promise.resolve([]),
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
    ),
    readSupabaseRows('operations_buffer_notes', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('synced_at', { ascending: false })
        .limit(3000)
    ),
    includeSettlement
      ? readSupabaseRows('operations_settlement_items', query =>
          query
            .select('stable_id,drive_file_id,file_name,sheet_name,row_number,settlement_date,settlement_date_text,product_name,product_key,tax_status,settlement_count,supply_price_ex_vat,supply_price_vat_included,sale_price,hq_buffer_quantity,is_fresh_produce,raw_json,parsed_at')
            .eq('store_name', OPS_CONFIG.STORE_NAME)
            .order('settlement_date', { ascending: false })
            .order('file_name', { ascending: true })
            .order('row_number', { ascending: true })
            .limit(5000)
        )
      : Promise.resolve([]),
    readGeneratedProductImagePaths()
  ]);
  const normalizedInventoryRows = inventoryRows
    .map(normalizeInventoryRowProductFields)
    .filter(isUsableInventoryProductRow);
  const normalizedInventoryRawRows = inventoryRawRows
    .map(normalizeInventoryRowProductFields)
    .filter(isUsableInventoryProductRow);
  const hqBufferFallbackAggregates = needsSettlementHqBufferFallback(normalizedInventoryRows)
    ? includeSettlement
      ? buildSettlementBufferAggregate(settlementRows)
      : await readSettlementBufferAggregate()
    : null;
  const dashboardInventoryRows = applySettlementHqBufferFallback(
    normalizedInventoryRows,
    hqBufferFallbackAggregates
  );
  const settlementPickupDateRange = getSettlementPickupDateRange(settlementRows);
  const settlementOrderImageRows = settlementPickupDateRange
    ? await readSupabaseRowsPaged('order_cache', query =>
        query
          .select('product_name,image_url,pickup_date_text,pickup_date_value')
          .eq('store_name', OPS_CONFIG.STORE_NAME)
          .gte('pickup_date_value', settlementPickupDateRange.min)
          .lte('pickup_date_value', settlementPickupDateRange.max)
          .not('image_url', 'is', null)
          .order('pickup_date_value', { ascending: false })
      )
    : [];
  const orderPickupDateValues = getInventoryPickupDateValues(dashboardInventoryRows);
  const orderRows = orderPickupDateValues.length
    ? await readSupabaseRowsPaged('order_cache', query =>
        query
          .select('customer_label,product_name,quantity,price,image_url,order_date_text,pickup_date_text,pickup_date_value,source_row_number')
          .eq('store_name', OPS_CONFIG.STORE_NAME)
          .in('pickup_date_value', orderPickupDateValues)
      )
    : [];
  const orderAggregates = buildOrderAggregates(orderRows);
  const dashboardImageMap = buildDashboardImageMap(orderRows, generatedImagePaths);

  const dashboardItems = mergeArchivedDashboardItems(buildDashboardItems(
    dashboardInventoryRows,
    bufferEvents,
    receivingEvents,
    receivingChecks,
    bufferNotes,
    orderAggregates,
    dashboardImageMap
  ));
  const storageRequestItems = buildStorageRequestItems(dashboardItems, bufferEvents);
  const todayKey = getKstDateKey();
  const inboundInventoryItems = dashboardItems
    .filter(item => isCurrentInventoryListSource(item.sourceSheetName));
  const inboundAllItems = dashboardItems
    .filter(item => isActiveInventoryListSource(item.sourceSheetName));
  const salesInventoryItems = dashboardItems
    .filter(item => isActiveInventoryListSource(item.sourceSheetName))
    .filter(isGroupSaleItem);
  const inboundDateOptions = buildSalesDateOptions(inboundAllItems);
  const orderCustomersByKey = buildOrderCustomersByKey(
    orderAggregates,
    new Set(salesInventoryItems.map(dashboardProductDateKey).filter(Boolean))
  );
  const salesDateOptions = buildSalesDateOptions(salesInventoryItems);
  const defaultSalesDateKey = getDefaultSalesDateKey(salesDateOptions, todayKey);
  const latestInboundDate = inboundInventoryItems
    .map(item => item.inboundDateKey)
    .filter(Boolean)
    .sort()
    .pop() || todayKey;
  const staleCutoffDateKey = formatDateKey(addDays(dateFromKey(todayKey) || getKstDate(), -2));
  const staleHistoryStartDateKey = formatDateKey(addDays(dateFromKey(staleCutoffDateKey) || getKstDate(), -7));
  const todayInboundItems = inboundInventoryItems
    .filter(item => item.inboundDateKey === todayKey)
    .sort(sortInboundItems);

  return {
    ok: true,
    storeName: OPS_CONFIG.STORE_NAME,
    todayKey,
    latestInboundDate,
    staleCutoffDateKey,
    staleHistoryStartDateKey,
    defaultSalesDateKey,
    salesDateOptions,
    inboundDateOptions,
    orderCustomersByKey,
    salesAllItems: salesInventoryItems.sort(sortInboundItems),
    inboundAllItems: inboundAllItems.sort(sortInboundItems),
    inboundItems: todayInboundItems,
    latestInboundItems: todayInboundItems.length
      ? []
      : inboundInventoryItems
          .filter(item => item.inboundDateKey === latestInboundDate)
          .sort(sortInboundItems),
    storageRequestItems,
    settlementReview: includeSettlement
      ? buildSettlementReview(
          normalizedInventoryRows,
          normalizedInventoryRawRows,
          settlementRows,
          generatedImagePaths,
          settlementOrderImageRows
        )
      : null,
    settlementReviewLoaded: includeSettlement,
    generatedAt: new Date().toISOString()
  };
}

export async function getOperationsSettlementReviewData(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();

  if (!force && SETTLEMENT_REVIEW_CACHE_MS > 0) {
    if (settlementReviewCache.data && settlementReviewCache.expiresAt > now) {
      return {
        ...settlementReviewCache.data,
        cached: true,
        generatedAt: new Date().toISOString()
      };
    }

    if (settlementReviewCache.promise) {
      return settlementReviewCache.promise;
    }
  }

  const promise = buildOperationsSettlementReviewData().then(data => {
    if (SETTLEMENT_REVIEW_CACHE_MS > 0) {
      settlementReviewCache.data = data;
      settlementReviewCache.expiresAt = Date.now() + SETTLEMENT_REVIEW_CACHE_MS;
    }

    return data;
  });

  if (!force && SETTLEMENT_REVIEW_CACHE_MS > 0) {
    settlementReviewCache.promise = promise.finally(() => {
      settlementReviewCache.promise = null;
    });
    return settlementReviewCache.promise;
  }

  return promise;
}

async function buildOperationsSettlementReviewData() {
  const [inventoryRows, inventoryRawRows, settlementRows, generatedImagePaths] = await Promise.all([
    readSupabaseRows('operations_inventory_items', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('inbound_date', { ascending: false })
        .order('source_sheet_name', { ascending: true })
        .order('source_row_number', { ascending: true })
    ),
    readSupabaseRows('operations_inventory_raw_rows', query =>
      query
        .select('*')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('outbound_date', { ascending: false })
        .order('source_row_number', { ascending: true })
        .limit(5000)
    ),
    readSupabaseRows('operations_settlement_items', query =>
      query
        .select('stable_id,drive_file_id,file_name,sheet_name,row_number,settlement_date,settlement_date_text,product_name,product_key,tax_status,settlement_count,supply_price_ex_vat,supply_price_vat_included,sale_price,hq_buffer_quantity,is_fresh_produce,raw_json,parsed_at')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .order('settlement_date', { ascending: false })
        .order('file_name', { ascending: true })
        .order('row_number', { ascending: true })
        .limit(5000)
    ),
    readGeneratedProductImagePaths()
  ]);
  const normalizedInventoryRows = inventoryRows
    .map(normalizeInventoryRowProductFields)
    .filter(isUsableInventoryProductRow);
  const normalizedInventoryRawRows = inventoryRawRows
    .map(normalizeInventoryRowProductFields)
    .filter(isUsableInventoryProductRow);
  const settlementPickupDateRange = getSettlementPickupDateRange(settlementRows);
  const settlementOrderImageRows = settlementPickupDateRange
    ? await readSupabaseRowsPaged('order_cache', query =>
        query
          .select('product_name,image_url,pickup_date_text,pickup_date_value')
          .eq('store_name', OPS_CONFIG.STORE_NAME)
          .gte('pickup_date_value', settlementPickupDateRange.min)
          .lte('pickup_date_value', settlementPickupDateRange.max)
          .not('image_url', 'is', null)
          .order('pickup_date_value', { ascending: false })
      )
    : [];

  return {
    ok: true,
    settlementOnly: true,
    storeName: OPS_CONFIG.STORE_NAME,
    todayKey: getKstDateKey(),
    settlementReview: buildSettlementReview(
      normalizedInventoryRows,
      normalizedInventoryRawRows,
      settlementRows,
      generatedImagePaths,
      settlementOrderImageRows
    ),
    settlementReviewLoaded: true,
    generatedAt: new Date().toISOString()
  };
}

export async function generateSettlementProductImages({ limit = 8, category = '', dryRun = false } = {}) {
  const normalizedLimit = Math.max(1, Math.min(20, Number(limit || 8)));
  const normalizedCategory = clean(category);
  const dashboard = await getOperationsDashboardData();
  const targets = getSettlementImageTargets(dashboard.settlementReview?.items || [], normalizedCategory)
    .slice(0, normalizedLimit);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      count: targets.length,
      targets: targets.map(target => ({
        productName: target.productName,
        productKey: target.productKey,
        category: target.category,
        dateKey: target.dateKey
      }))
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY 환경변수가 없습니다.');
  }

  await ensureProductImageBucket();

  const generated = [];
  const errors = [];

  const concurrency = Math.max(1, Math.min(5, Number(process.env.OPENAI_IMAGE_CONCURRENCY || 3)));
  await runWithConcurrency(targets, concurrency, async target => {
    try {
      const prompt = buildProductImagePrompt(target);
      const result = await generateOpenAIProductImage(prompt);
      const imageProductKey = target.imageProductKey || target.productKey;
      const path = productImageStoragePath(imageProductKey);
      const imageBuffer = Buffer.from(result.b64Json, 'base64');
      const { error: uploadError } = await supabaseAdmin.storage
        .from(OPS_CONFIG.PRODUCT_IMAGE_BUCKET)
        .upload(path, imageBuffer, {
          contentType: 'image/webp',
          upsert: true
        });

      if (uploadError) throw uploadError;
      rememberGeneratedProductImagePath(path);

      generated.push({
        productName: target.productName,
        imageProductName: target.imageProductName || target.productName,
        productKey: imageProductKey,
        category: target.category,
        imageUrl: getProductImagePublicUrl(imageProductKey),
        model: result.model,
        path
      });
    } catch (error) {
      errors.push({
        productName: target.productName,
        productKey: target.productKey,
        message: error.message || String(error)
      });
    }
  });

  return {
    ok: errors.length === 0,
    generatedCount: generated.length,
    errorCount: errors.length,
    generated,
    errors
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
}

function getSettlementImageTargets(items = [], category = '') {
  const seen = new Set();
  const categoryOrder = {
    '과일': 1,
    '야채': 2,
    '상시': 3,
    '특이항목': 4,
    '비공구': 5
  };

  return (items || [])
    .filter(item => item.category !== '공구')
    .filter(item => ['과일', '야채', '상시', '특이항목'].includes(item.category))
    .filter(item => !category || item.category === category)
    .filter(item => item.needsGeneratedImage)
    .filter(item => {
      const imageProductKey = item.imageProductKey || item.productKey;
      if (!imageProductKey || seen.has(imageProductKey)) return false;
      seen.add(imageProductKey);
      return true;
    })
    .sort((a, b) => {
      const categoryDiff = (categoryOrder[a.category] || 9) - (categoryOrder[b.category] || 9);
      if (categoryDiff) return categoryDiff;
      return String(b.dateKey || '').localeCompare(String(a.dateKey || ''));
    });
}

function buildSettlementReview(
  inventoryRows = [],
  inventoryRawRows = [],
  settlementRows = [],
  generatedImagePaths = new Set(),
  orderImageRows = []
) {
  const inventoryByProductDate = new Map();
  const inventoryByProduct = new Map();
  const inventoryDatedByProduct = new Map();
  const rawByProductDate = new Map();
  const rawDatedByProduct = new Map();
  const imageByProduct = new Map();
  const generatedImageKeyByImageKey = buildGeneratedProductImageKeyMap(settlementRows, generatedImagePaths);

  inventoryRows.forEach(row => {
    const productKey = row.product_key || normalizeProductKey(row.product_name);
    const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
    const dateKey = row.inbound_date || '';
    if (!productKey) return;

    const isPrimaryInventoryList = normalizeSheetName(row.source_sheet_name) === '입고리스트';

    if (row.image_url && !imageByProduct.has(productKey)) {
      imageByProduct.set(productKey, row.image_url);
    }
    if (row.image_url && imageProductKey && !imageByProduct.has(imageProductKey)) {
      imageByProduct.set(imageProductKey, row.image_url);
    }

    if (!isPrimaryInventoryList) return;

    addInventoryReviewAggregate(inventoryByProduct, productKey, '', row);
    if (!dateKey) return;
    const datedInventory = addInventoryReviewAggregate(inventoryByProductDate, productKey, dateKey, row);
    addDatedReviewAggregate(inventoryDatedByProduct, productKey, datedInventory);
  });

  inventoryRawRows.forEach(row => {
    const productKey = row.product_key || normalizeProductKey(row.product_name);
    const dateKey = row.outbound_date || '';
    if (!productKey || !dateKey) return;

    const datedRaw = addInventoryRawReviewAggregate(rawByProductDate, productKey, dateKey, row);
    addDatedReviewAggregate(rawDatedByProduct, productKey, datedRaw);
  });

  orderImageRows.forEach(row => {
    const productKey = normalizeProductKey(row.product_name);
    const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
    const imageUrl = clean(row.image_url);
    if (!productKey || !imageUrl) return;
    if (!imageByProduct.has(productKey)) {
      imageByProduct.set(productKey, imageUrl);
    }
    if (imageProductKey && !imageByProduct.has(imageProductKey)) {
      imageByProduct.set(imageProductKey, imageUrl);
    }
  });

  const items = settlementRows.map(row => {
    const productKey = row.product_key || normalizeProductKey(row.product_name);
    const imageProductName = stripProductDateSuffix(row.product_name || '');
    const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
    const dateKey = row.settlement_date || '';
    const exactInventory = inventoryByProductDate.get(aggregateKey(productKey, dateKey));
    const inventory = exactInventory || findClosestReviewAggregate(inventoryDatedByProduct, productKey, dateKey);
    const exactRawInventory = rawByProductDate.get(aggregateKey(productKey, dateKey));
    const rawInventory = exactRawInventory || findClosestReviewAggregate(rawDatedByProduct, productKey, dateKey);
    const productInventory = inventory || inventoryByProduct.get(aggregateKey(productKey, ''));
    const settlementQuantity = Number(row.settlement_count || 0);
    const inventoryListQuantity = Number(inventory?.inboundQuantity || 0);
    const inventoryRawQuantity = Number(rawInventory?.quantity || 0);
    const hasInventoryMatch = Boolean(inventory);
    const hasRawInventoryMatch = Boolean(rawInventory);
    const inventoryListDiffQuantity = settlementQuantity - inventoryListQuantity;
    const inventoryRawDiffQuantity = settlementQuantity - inventoryRawQuantity;
    const listMatchesSettlement = hasInventoryMatch && Math.abs(inventoryListDiffQuantity) <= 0.0001;
    const rawMatchesSettlement = hasRawInventoryMatch && Math.abs(inventoryRawDiffQuantity) <= 0.0001;
    const listRawDiffQuantity = inventoryListQuantity - inventoryRawQuantity;
    const listRawMismatch = hasInventoryMatch && hasRawInventoryMatch && Math.abs(listRawDiffQuantity) > 0.0001;
    const mismatch = listRawMismatch ||
      (hasInventoryMatch
        ? !listMatchesSettlement
        : hasRawInventoryMatch
          ? !rawMatchesSettlement
          : true);
    const diffQuantity = hasInventoryMatch
      ? inventoryListDiffQuantity
      : hasRawInventoryMatch
        ? inventoryRawDiffQuantity
        : settlementQuantity;
    const salesTypes = Array.from(new Set([
      ...setToArray(productInventory?.salesTypes),
      ...setToArray(rawInventory?.salesTypes)
    ]));
    const storageMethods = Array.from(new Set([
      ...setToArray(productInventory?.storageMethods),
      ...setToArray(rawInventory?.storageMethods)
    ]));
    const productCodes = Array.from(new Set([
      ...setToArray(productInventory?.productCodes),
      ...setToArray(rawInventory?.productCodes)
    ]));
    const groupSaleDates = Array.from(new Set([
      ...setToArray(rawInventory?.groupSaleDates)
    ]));
    const category = classifySettlementItem(row, productInventory || rawInventory);
    const generatedImageKey = generatedImageKeyByImageKey.get(imageProductKey) || '';
    const generatedImageUrl = generatedImageKey
      ? getProductImagePublicUrl(generatedImageKey)
      : '';
    const imageUrl = category === 'CS'
      ? CS_SETTLEMENT_IMAGE_URL
      : inventory?.imageUrl || imageByProduct.get(productKey) || imageByProduct.get(imageProductKey) || generatedImageUrl;

    return {
      id: row.stable_id,
      dateKey,
      dateText: row.settlement_date_text || row.settlement_date || '',
      productName: row.product_name || '',
      productKey,
      imageProductName,
      imageProductKey,
      category,
      fileName: row.file_name || '',
      sheetName: row.sheet_name || '',
      rowNumber: row.row_number || '',
      taxStatus: row.tax_status || '',
      settlementQuantity,
      inventoryQuantity: inventoryListQuantity,
      inventoryListQuantity,
      inventoryRawQuantity,
      diffQuantity,
      inventoryListDiffQuantity,
      inventoryRawDiffQuantity,
      listRawDiffQuantity,
      hasInventoryMatch,
      hasRawInventoryMatch,
      inventoryMatchDateKey: inventory?.dateKey || '',
      rawInventoryMatchDateKey: rawInventory?.dateKey || '',
      inventoryMatchIsExact: Boolean(exactInventory),
      rawInventoryMatchIsExact: Boolean(exactRawInventory),
      mismatch,
      listRawMismatch,
      mismatchReason: listRawMismatch
        ? '입고리스트와 입고 raw 수량이 다릅니다.'
        : !hasInventoryMatch && rawMatchesSettlement
          ? ''
          : mismatch
            ? '정산 수량과 입고 수량이 다릅니다.'
            : '',
      supplyPriceExVat: Number(row.supply_price_ex_vat || 0),
      supplyPriceVatIncluded: Number(row.supply_price_vat_included || productInventory?.supplyPrice || rawInventory?.supplyPrice || 0),
      salePrice: Number(row.sale_price || 0),
      hqBufferQuantity: Number(row.hq_buffer_quantity || productInventory?.hqBufferQuantity || rawInventory?.hqBufferQuantity || 0),
      isFreshProduce: isFreshProduceSettlementItem(row),
      rawSettlementType: getSettlementRawType(row.raw_json),
      salesTypes,
      storageMethods,
      productCodes,
      groupSaleDates,
      orderQuantity: Number(productInventory?.orderQuantity || rawInventory?.orderQuantity || 0),
      rawOrderQuantity: Number(rawInventory?.orderQuantity || 0),
      rawHqBufferQuantity: Number(rawInventory?.hqBufferQuantity || 0),
      rawSupplyPrice: Number(rawInventory?.supplyPrice || 0),
      inventorySourceRows: inventory?.sourceRows || [],
      rawInventorySourceRows: rawInventory?.sourceRows || [],
      imageUrl,
      generatedImageUrl,
      needsGeneratedImage: category !== 'CS' && !imageUrl,
      extraFields: extractSettlementExtraFields(row.raw_json)
    };
  });

  const dateGroups = buildSettlementDateGroups(items);
  return {
    totalItems: items.length,
    totalDates: dateGroups.length,
    mismatchCount: items.filter(item => item.mismatch).length,
    nonGroupCount: items.filter(item => item.category !== '공구').length,
    missingImageCount: items.filter(item => item.needsGeneratedImage && item.category !== '공구').length,
    latestDateKey: dateGroups[0]?.dateKey || '',
    dateGroups,
    items
  };
}

function addInventoryReviewAggregate(map, productKey, dateKey, row) {
  const key = aggregateKey(productKey, dateKey);
  const current = map.get(key) || {
    productKey,
    productName: row.product_name || '',
    dateKey,
    inboundQuantity: 0,
    orderQuantity: 0,
    hqBufferQuantity: 0,
    supplyPrice: 0,
    productCodes: new Set(),
    salesTypes: new Set(),
    storageMethods: new Set(),
    imageUrl: row.image_url || '',
    sourceRows: []
  };

  current.inboundQuantity += Number(row.inbound_quantity || 0);
  current.orderQuantity += Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.orderQuantity) || 0);
  current.hqBufferQuantity += Number(row.hq_buffer_quantity || 0);
  current.supplyPrice = Number(row.supply_price || current.supplyPrice || 0);
  const productCode = getRawStringByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.productCode);
  if (productCode) current.productCodes.add(productCode);
  if (row.sales_type) current.salesTypes.add(row.sales_type);
  if (row.storage_method) current.storageMethods.add(normalizeStorageMethod(row.storage_method));
  current.imageUrl = current.imageUrl || row.image_url || '';
  current.sourceRows.push({
    sourceSheetName: row.source_sheet_name || '',
    sourceRowNumber: row.source_row_number || '',
    inboundQuantity: Number(row.inbound_quantity || 0),
    orderQuantity: Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.orderQuantity) || 0),
    hqBufferQuantity: Number(row.hq_buffer_quantity || 0),
    supplyPrice: Number(row.supply_price || 0),
    productCode
  });
  map.set(key, current);
  return current;
}

function addInventoryRawReviewAggregate(map, productKey, dateKey, row) {
  const key = aggregateKey(productKey, dateKey);
  const current = map.get(key) || {
    productKey,
    productName: row.product_name || '',
    dateKey,
    quantity: 0,
    orderQuantity: 0,
    hqBufferQuantity: 0,
    supplyPrice: 0,
    productCodes: new Set(),
    groupSaleDates: new Set(),
    salesTypes: new Set(),
    storageMethods: new Set(),
    sourceRows: []
  };

  current.quantity += Number(row.quantity || 0);
  current.orderQuantity += Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.orderQuantity) || 0);
  current.hqBufferQuantity += Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.hqBufferQuantity) || 0);
  current.supplyPrice = Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.supplyPrice) || current.supplyPrice || 0);
  const groupSaleDate = getRawStringByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.groupSaleDate);
  const productCode = getRawStringByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.productCode);
  if (groupSaleDate) current.groupSaleDates.add(groupSaleDate);
  if (productCode) current.productCodes.add(productCode);
  if (row.sales_type) current.salesTypes.add(row.sales_type);
  if (row.storage_method) current.storageMethods.add(normalizeStorageMethod(row.storage_method));
  current.sourceRows.push({
    sourceSheetName: row.source_sheet_name || '입고 raw',
    sourceRowNumber: row.source_row_number || '',
    quantity: Number(row.quantity || 0),
    orderQuantity: Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.orderQuantity) || 0),
    hqBufferQuantity: Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.hqBufferQuantity) || 0),
    supplyPrice: Number(getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.supplyPrice) || 0),
    groupSaleDate,
    productCode
  });
  map.set(key, current);
  return current;
}

function addDatedReviewAggregate(map, productKey, aggregate) {
  if (!productKey || !aggregate?.dateKey) return;
  const rows = map.get(productKey) || [];
  if (!rows.some(row => row.dateKey === aggregate.dateKey)) {
    rows.push(aggregate);
  }
  rows.sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
  map.set(productKey, rows);
}

function findClosestReviewAggregate(map, productKey, dateKey, maxDays = 14) {
  const targetDate = dateFromKey(dateKey);
  const rows = map.get(productKey) || [];
  if (!targetDate || !rows.length) return null;

  return rows
    .map(row => {
      const rowDate = dateFromKey(row.dateKey);
      const dayDiff = rowDate ? diffDays(targetDate, rowDate) : Number.POSITIVE_INFINITY;
      return {
        row,
        absDiff: Math.abs(dayDiff),
        futureRank: dayDiff >= 0 ? 0 : 1
      };
    })
    .filter(candidate => candidate.absDiff <= maxDays)
    .sort((a, b) => {
      if (a.absDiff !== b.absDiff) return a.absDiff - b.absDiff;
      return a.futureRank - b.futureRank;
    })[0]?.row || null;
}

async function readGeneratedProductImagePaths() {
  const bucket = OPS_CONFIG.PRODUCT_IMAGE_BUCKET;
  const now = Date.now();

  if (
    generatedProductImagePathsCache.paths &&
    generatedProductImagePathsCache.expiresAt > now
  ) {
    return new Set(generatedProductImagePathsCache.paths);
  }

  try {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .list('settlement', {
        limit: 1000,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) return new Set();

    const paths = new Set((data || [])
      .filter(file => file?.name)
      .map(file => `settlement/${file.name}`));
    generatedProductImagePathsCache.paths = paths;
    generatedProductImagePathsCache.expiresAt = now + GENERATED_IMAGE_PATHS_CACHE_MS;

    return new Set(paths);
  } catch {
    return new Set();
  }
}

function rememberGeneratedProductImagePath(path) {
  const cleanPath = clean(path);
  if (!cleanPath) return;
  const paths = generatedProductImagePathsCache.paths || new Set();
  paths.add(cleanPath);
  generatedProductImagePathsCache.paths = paths;
  generatedProductImagePathsCache.expiresAt = Date.now() + GENERATED_IMAGE_PATHS_CACHE_MS;
}

async function ensureProductImageBucket() {
  const bucket = OPS_CONFIG.PRODUCT_IMAGE_BUCKET;
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) throw listError;

  if (!(buckets || []).some(item => item.name === bucket)) {
    const { error } = await supabaseAdmin.storage.createBucket(bucket, {
      public: true,
      allowedMimeTypes: ['image/webp', 'image/png', 'image/jpeg'],
      fileSizeLimit: 5242880
    });
    if (error) throw error;
    return;
  }

  await supabaseAdmin.storage.updateBucket(bucket, {
    public: true,
    allowedMimeTypes: ['image/webp', 'image/png', 'image/jpeg'],
    fileSizeLimit: 5242880
  });
}

function hasGeneratedProductImage(paths, productKey) {
  return paths?.has?.(productImageStoragePath(productKey));
}

function buildGeneratedProductImageKeyMap(settlementRows = [], generatedImagePaths = new Set()) {
  const candidatesByImageKey = new Map();

  settlementRows.forEach(row => {
    const productKey = row.product_key || normalizeProductKey(row.product_name);
    const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
    if (!imageProductKey || !productKey) return;

    if (!candidatesByImageKey.has(imageProductKey)) {
      candidatesByImageKey.set(imageProductKey, new Set());
    }
    candidatesByImageKey.get(imageProductKey).add(productKey);
  });

  const imageKeyMap = new Map();
  candidatesByImageKey.forEach((productKeys, imageProductKey) => {
    if (hasGeneratedProductImage(generatedImagePaths, imageProductKey)) {
      imageKeyMap.set(imageProductKey, imageProductKey);
      return;
    }

    for (const productKey of productKeys) {
      if (hasGeneratedProductImage(generatedImagePaths, productKey)) {
        imageKeyMap.set(imageProductKey, productKey);
        return;
      }
    }
  });

  return imageKeyMap;
}

function getProductImagePublicUrl(productKey) {
  const { data } = supabaseAdmin.storage
    .from(OPS_CONFIG.PRODUCT_IMAGE_BUCKET)
    .getPublicUrl(productImageStoragePath(productKey));

  return data?.publicUrl || '';
}

function productImageStoragePath(productKey) {
  const digest = crypto
    .createHash('sha256')
    .update(`${OPS_CONFIG.STORE_NAME}::${productKey || ''}`)
    .digest('hex')
    .slice(0, 40);

  return `settlement/${digest}.webp`;
}

function buildProductImagePrompt(item) {
  const productName = item.imageProductName || item.productName;
  const categoryHint = item.category === '과일'
    ? 'Fresh fruit photo that clearly matches the named fruit.'
    : item.category === '야채'
      ? 'Fresh vegetable photo that clearly matches the named vegetable.'
      : item.category === '상시'
      ? 'Everyday retail product photo, clean ecommerce style.'
      : 'Accurate retail product-style image based on the product name.';

  return [
    'Create a high-quality square ecommerce product image for a Korean local market operations app.',
    `Product name: ${productName}.`,
    `Category: ${item.category}.`,
    categoryHint,
    'Use a realistic product or produce presentation on a clean warm white background.',
    'No text, no labels with readable writing, no logos, no watermark, no hands, no people.',
    'The product should be centered, easy to recognize at small card size, bright natural lighting.'
  ].join(' ');
}

async function generateOpenAIProductImage(prompt) {
  const preferredModel = resolveOpenAIImageModel();
  const fallbackModel = preferredModel === 'gpt-image-1-mini' ? 'gpt-image-1' : 'gpt-image-1-mini';

  try {
    return await requestOpenAIImage(prompt, preferredModel);
  } catch (error) {
    if (preferredModel !== fallbackModel && /model|not found|does not exist|invalid/i.test(error.message || '')) {
      return requestOpenAIImage(prompt, fallbackModel);
    }

    throw error;
  }
}

async function requestOpenAIImage(prompt, model) {
  const controller = new AbortController();
  const timeoutMs = Math.max(30000, Number(process.env.OPENAI_IMAGE_TIMEOUT_MS || 180000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt,
        size: '1024x1024',
        quality: clean(process.env.OPENAI_IMAGE_QUALITY) || 'low',
        output_format: 'webp',
        n: 1
      })
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`OpenAI image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI image generation failed (${response.status})`);
  }

  const b64Json = data?.data?.[0]?.b64_json;
  if (!b64Json) {
    throw new Error('OpenAI 이미지 응답에 b64_json이 없습니다.');
  }

  return {
    b64Json,
    model
  };
}

function resolveOpenAIImageModel() {
  const model = clean(process.env.OPS_OPENAI_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL);
  if (!model || /mini/i.test(model)) return 'gpt-image-1-mini';
  if (process.env.OPENAI_IMAGE_ALLOW_NON_MINI === '1') return model;
  // Operations product images are utility thumbnails, so keep this path cost-safe by default.
  return 'gpt-image-1-mini';
}

function buildSettlementDateGroups(items = []) {
  const grouped = new Map();

  items.forEach(item => {
    const dateKey = item.dateKey || '';
    const current = grouped.get(dateKey) || {
      dateKey,
      label: formatDateLabel(dateKey, item.dateText),
      count: 0,
      mismatchCount: 0,
      nonGroupCount: 0,
      totalQuantity: 0
    };

    current.count += 1;
    current.totalQuantity += Number(item.settlementQuantity || 0);
    if (item.mismatch) current.mismatchCount += 1;
    if (item.category !== '공구') current.nonGroupCount += 1;
    grouped.set(dateKey, current);
  });

  return Array.from(grouped.values())
    .sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
}

function classifySettlementItem(row, inventory) {
  const rawType = normalizeSettlementType(getSettlementRawType(row.raw_json));
  const salesTypes = Array.from(inventory?.salesTypes || []);
  const normalizedSalesTypes = salesTypes.map(normalizeSalesType).join(' ');

  if (isCsSettlementItem(row)) return 'CS';
  if (rawType === '과일' && isVegetableSettlementItem(row)) return '야채';
  if (rawType) return rawType;
  if (normalizedSalesTypes.includes('공구')) return '공구';
  if (normalizedSalesTypes.includes('상시')) return '상시';
  if (isFreshProduceSettlementItem(row)) {
    return isVegetableSettlementItem(row) ? '야채' : '과일';
  }
  if (inventory) return '비공구';
  return '특이항목';
}

function getSettlementRawType(rawJson) {
  const raw = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const direct = clean(
    raw['공구/상시'] ||
    raw['공구상시'] ||
    raw['구분'] ||
    raw['분류'] ||
    raw['카테고리']
  );
  if (direct) return direct;

  const typeEntry = Object.entries(raw).find(([key]) =>
    /공구|상시|구분|분류|카테고리/i.test(clean(key))
  );
  return clean(typeEntry?.[1]);
}

function normalizeSettlementType(value) {
  const text = clean(value).replace(/\s+/g, '');
  if (!text) return '';
  if (/CS|씨에스|전농|불량|파손|반품|환불|교환|누락|오배송|클레임|컴플레인|보상|폐기|하자/i.test(text)) return 'CS';
  if (/공구/.test(text)) return '공구';
  if (/상시/.test(text)) return '상시';
  if (/야채|채소/.test(text)) return '야채';
  if (/과일|농산/.test(text)) return '과일';
  if (/특이|기타|비고/.test(text)) return '특이항목';
  return '';
}

function isCsSettlementItem(row) {
  const raw = row?.raw_json && typeof row.raw_json === 'object' ? row.raw_json : {};
  const text = [
    row?.product_name,
    getSettlementRawType(raw),
    ...Object.entries(raw).flatMap(([key, value]) => [key, value])
  ].map(value => clean(value)).join(' ');
  const jeonnongHintText = [
    row?.product_name,
    getSettlementRawType(raw),
    ...Object.entries(raw)
      .filter(([key]) => /상품|품명|제품|비고|메모|사유|내용|구분|분류|카테고리|특이|CS|씨에스|고객|클레임|불량|파손|반품|환불|교환|누락|오배송/i.test(clean(key)))
      .map(([, value]) => value)
  ].map(value => clean(value)).join(' ');

  return /CS|씨에스|불량|파손|파손건|반품|환불|교환|누락|오배송|클레임|컴플레인|보상|폐기|하자|변질|훼손|오염/i.test(text) ||
    /전농/.test(jeonnongHintText);
}

function isFreshProduceSettlementItem(row) {
  const productName = row.product_name || '';
  const normalized = normalizeProductKey(productName);
  if (/탈수기|클리너|고데기|패치|괄사|스프레이|마스크|세트|기기|용기|행주|수세미|코트|청소|욕실|관절|화장품/.test(normalized)) {
    return false;
  }

  return /과일|야채|채소|농산|복숭아|수박|살구|사과|포도|망고|토마토|버섯|참외|자두|오이|상추|감자|고구마|양파|파프리카|딸기|바나나|블루베리|레몬|배|귤/.test(normalized);
}

function isVegetableSettlementItem(row) {
  const normalized = normalizeProductKey(row.product_name || '');
  if (!normalized) return false;

  return /야채|채소|버섯|오이|상추|깻잎|감자|고구마|양파|파프리카|대파|쪽파|애호박|호박|콩나물|숙주|마늘|고추|가지|무|배추|양배추|브로콜리|샐러드|시금치|부추|당근|연근|우엉|쌈채|느타리|팽이|새송이/.test(normalized);
}

function extractSettlementExtraFields(rawJson) {
  const raw = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const ignored = new Set([
    '상품명',
    '제품명',
    '품명',
    '상품',
    '면세',
    '과세',
    '세금',
    '부가세',
    '정산서개수',
    '정산수량',
    '수량',
    '개수',
    'vat별도',
    'vat 별도',
    '공급가별도',
    '공급가(vat별도)',
    '공급가vat포함',
    'vat포함',
    'vat 포함',
    '공급가포함',
    '공급가(vat포함)',
    '판매가',
    '매출가',
    '본사버퍼',
    '추가수량',
    '추가수량상시판매필요',
    '버퍼',
    '공구/상시',
    '공구상시',
    '구분',
    '분류',
    '카테고리',
    '정산일',
    '날짜',
    '일자',
    '입고일'
  ]);

  return Object.entries(raw)
    .map(([key, value]) => [clean(key), clean(value)])
    .filter(([key, value]) => key && value && !ignored.has(key))
    .slice(0, 8)
    .map(([key, value]) => ({ key, value }));
}

function buildStaleDateGroups(items) {
  const grouped = new Map();

  items.forEach(item => {
    if (!item.inboundDateKey) return;
    const current = grouped.get(item.inboundDateKey) || {
      dateKey: item.inboundDateKey,
      label: formatDateLabel(item.inboundDateKey, item.inboundDateText),
      count: 0,
      totalQuantity: 0,
      items: []
    };

    current.count += 1;
    current.totalQuantity += Number(item.inboundQuantity || 0);
    current.items.push(item);
    grouped.set(item.inboundDateKey, current);
  });

  return Array.from(grouped.values())
    .map(group => ({
      ...group,
      items: group.items.sort(sortInboundItems)
    }))
    .sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
}

function buildSalesDateOptions(items) {
  const grouped = new Map();

  items.forEach(item => {
    if (!item.inboundDateKey) return;

    const current = grouped.get(item.inboundDateKey) || {
      dateKey: item.inboundDateKey,
      label: formatDateLabel(item.inboundDateKey, item.inboundDateText),
      count: 0,
      totalQuantity: 0,
      sheetNames: new Set()
    };

    current.count += 1;
    current.totalQuantity += Number(item.inboundQuantity || 0);
    current.sheetNames.add(item.sourceSheetName || '');
    grouped.set(item.inboundDateKey, current);
  });

  return Array.from(grouped.values())
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
    .map(option => ({
      dateKey: option.dateKey,
      label: option.label,
      count: option.count,
      totalQuantity: option.totalQuantity,
      sheetNames: Array.from(option.sheetNames).filter(Boolean)
    }));
}

function getDefaultSalesDateKey(options, todayKey) {
  if (!options.length) return todayKey;
  return options[0].dateKey || todayKey;
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

export async function createStorageRequestEvent({
  inventoryStableId,
  productName,
  productKey,
  pickupDateKey,
  pickupDateText,
  storageMethod,
  imageUrl,
  salePrice,
  quantity,
  customerLabel,
  customerDigits4,
  locationMemo,
  visitDateText,
  requestMemo,
  storageGroupId,
  status = 'completed'
}) {
  const stableId = clean(inventoryStableId);
  const inventory = stableId ? await getInventoryItemByStableId(stableId) : null;
  const normalizedQuantity = Number(quantity || 0);
  const normalizedStatus = status === 'pending' ? 'pending' : 'completed';
  const normalizedProductName = clean(inventory?.product_name || productName);
  const normalizedProductKey = clean(inventory?.product_key || productKey || normalizeProductKey(normalizedProductName));

  if (!normalizedProductName || !normalizedProductKey) {
    throw new Error('보관 상품 정보가 없습니다.');
  }

  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
    throw new Error('보관 수량이 올바르지 않습니다.');
  }

  const memoPayload = {
    type: 'storage_request',
    status: normalizedStatus,
    storageGroupId: clean(storageGroupId),
    customerLabel: clean(customerLabel),
    customerDigits4: clean(customerDigits4).replace(/\D/g, '').slice(-4),
    quantity: normalizedQuantity,
    productName: normalizedProductName,
    productKey: normalizedProductKey,
    pickupDateKey: clean(inventory?.inbound_date || pickupDateKey),
    pickupDateText: clean(inventory?.inbound_date_text || pickupDateText),
    storageMethod: normalizeStorageMethod(inventory?.storage_method || storageMethod),
    imageUrl: clean(inventory?.image_url || imageUrl),
    salePrice: Number(inventory?.sale_price || salePrice || 0),
    locationMemo: clean(locationMemo),
    visitDateText: clean(visitDateText),
    requestMemo: clean(requestMemo),
    completedAt: normalizedStatus === 'completed' ? new Date().toISOString() : ''
  };

  const { data, error } = await supabaseAdmin
    .from('operations_buffer_events')
    .insert({
      store_name: OPS_CONFIG.STORE_NAME,
      inventory_stable_id: inventory?.stable_id || null,
      product_key: normalizedProductKey,
      product_name: normalizedProductName,
      delta_quantity: normalizedQuantity,
      actor_memo: JSON.stringify(memoPayload),
      event_source: normalizedStatus === 'pending' ? 'storage_request_pending' : 'storage_request'
    })
    .select('event_id, created_at')
    .single();

  if (error) throw withOpsSchemaHint(error);

  return { ok: true, eventId: data?.event_id || '', createdAt: data?.created_at || '' };
}

export async function completeStorageRequestEvent({ eventId, locationMemo, visitDateText, requestMemo }) {
  const result = await updateStorageRequestEvents({
    eventIds: [eventId],
    status: 'completed',
    locationMemo,
    visitDateText,
    requestMemo
  });

  return { ok: true, completedAt: result.completedAt };
}

export async function updateStorageRequestEvents({
  eventIds,
  status,
  locationMemo,
  visitDateText,
  requestMemo,
  items = []
}) {
  const ids = Array.isArray(eventIds)
    ? eventIds.map(id => clean(id)).filter(Boolean)
    : [clean(eventIds)].filter(Boolean);
  const normalizedStatus = ['pending', 'picked_up'].includes(status) ? status : 'completed';

  if (!ids.length) {
    throw new Error('수정할 보관요청 기록을 찾지 못했습니다.');
  }

  const quantityByEventId = new Map(
    (Array.isArray(items) ? items : [])
      .map(item => [clean(item.eventId), Number(item.quantity || 0)])
      .filter(([eventId, quantity]) => eventId && Number.isFinite(quantity) && quantity > 0)
  );

  const { data: events, error: readError } = await supabaseAdmin
    .from('operations_buffer_events')
    .select('*')
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .in('event_id', ids)
    .in('event_source', ['storage_request_pending', 'storage_request', 'storage_request_picked_up']);

  if (readError) throw withOpsSchemaHint(readError);
  if (!events?.length) {
    throw new Error('보관요청 기록을 찾지 못했습니다.');
  }

  const completedAt = new Date().toISOString();
  const pickedUpAt = new Date().toISOString();

  for (const event of events) {
    const parsed = parseStorageRequestMemo(event.actor_memo);
    const quantity = quantityByEventId.get(clean(event.event_id))
      || Number(event.delta_quantity || parsed.quantity || 0);
    const memoPayload = {
      type: 'storage_request',
      status: normalizedStatus,
      storageGroupId: parsed.storageGroupId,
      customerLabel: parsed.customerLabel,
      customerDigits4: parsed.customerDigits4,
      quantity,
      productName: parsed.productName || event.product_name || '',
      productKey: parsed.productKey || event.product_key || '',
      pickupDateKey: parsed.pickupDateKey,
      pickupDateText: parsed.pickupDateText,
      storageMethod: parsed.storageMethod,
      imageUrl: parsed.imageUrl,
      salePrice: parsed.salePrice,
      locationMemo: locationMemo == null ? parsed.locationMemo : clean(locationMemo),
      visitDateText: visitDateText == null ? parsed.visitDateText : clean(visitDateText),
      requestMemo: requestMemo == null ? parsed.requestMemo : clean(requestMemo),
      completedAt: normalizedStatus === 'completed' || normalizedStatus === 'picked_up' ? (parsed.completedAt || completedAt) : '',
      pickedUpAt: normalizedStatus === 'picked_up' ? pickedUpAt : (parsed.pickedUpAt || '')
    };

    const { error } = await supabaseAdmin
      .from('operations_buffer_events')
      .update({
        event_source: storageRequestEventSourceForStatus(normalizedStatus),
        delta_quantity: quantity,
        actor_memo: JSON.stringify(memoPayload)
      })
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .eq('event_id', event.event_id);

    if (error) throw withOpsSchemaHint(error);
  }

  return { ok: true, completedAt };
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
  const rootFiles = await listDriveFolderFiles(drive, OPS_CONFIG.SETTLEMENT_DRIVE_FOLDER_ID);
  const completedFolders = await listDriveChildFoldersByName(
    drive,
    OPS_CONFIG.SETTLEMENT_DRIVE_FOLDER_ID,
    COMPLETED_SETTLEMENT_FOLDER_NAME
  );
  const completedCutoffIso = getDriveModifiedCutoffIso(COMPLETED_SETTLEMENT_LOOKBACK_DAYS);
  const completedFiles = [];

  for (const folder of completedFolders) {
    const folderFiles = await listDriveFolderFiles(drive, folder.id, {
      modifiedAfterIso: completedCutoffIso
    });
    completedFiles.push(...folderFiles);
  }

  return dedupeDriveFiles([...rootFiles, ...completedFiles])
    .sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
}

async function listDriveFolderFiles(drive, folderId, { modifiedAfterIso = '' } = {}) {
  const files = [];
  let pageToken = undefined;
  const modifiedFilter = modifiedAfterIso ? ` and modifiedTime >= '${modifiedAfterIso}'` : '';

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false${modifiedFilter}`,
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

async function listDriveChildFoldersByName(drive, parentFolderId, folderName) {
  const folders = [];
  let pageToken = undefined;
  const escapedName = escapeDriveQueryValue(folderName);

  do {
    const response = await drive.files.list({
      q: `'${parentFolderId}' in parents and trashed=false and mimeType='${DRIVE_FOLDER_MIME_TYPE}' and name='${escapedName}'`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)',
      pageSize: 20,
      orderBy: 'modifiedTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken
    });

    folders.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return folders;
}

function dedupeDriveFiles(files) {
  const byId = new Map();

  (files || []).forEach(file => {
    if (!file?.id || byId.has(file.id)) return;
    byId.set(file.id, file);
  });

  return Array.from(byId.values());
}

function getDriveModifiedCutoffIso(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(0, Number(days || 0)));
  return cutoff.toISOString();
}

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
    valueRenderOption: 'FORMULA'
  });
  const map = new Map();

  (response.data.values || []).forEach(row => {
    const productName = cleanNonFormula(row[0]);
    if (!productName) return;
    const productKey = normalizeProductKey(productName);
    const imageProductKey = normalizeProductImageKey(productName) || productKey;

    const imageInfo = {
      productName,
      pickupDateText: sheetDateValueToText(row[2]),
      salePrice: parseNumber(cleanNonFormula(row[3])),
      imageUrl: cleanNonFormula(row[4])
    };

    map.set(productKey, imageInfo);
    if (imageProductKey && !map.has(imageProductKey)) map.set(imageProductKey, imageInfo);
  });

  return map;
}

async function readCachedProductImageMap(inventoryRows = []) {
  const dateValues = [...new Set((inventoryRows || [])
    .map(row => dateKeyToNumber(row.inboundDateKey))
    .filter(Boolean))];
  const map = new Map();

  if (!dateValues.length) return map;

  const rows = await readSupabaseRowsPaged('order_cache', query =>
    query
      .select('product_name,price,image_url,pickup_date_text,pickup_date_value')
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .in('pickup_date_value', dateValues)
      .not('image_url', 'is', null)
      .order('pickup_date_value', { ascending: false })
  );

  rows.forEach(row => {
    const productName = clean(row.product_name);
    const productKey = normalizeProductKey(productName);
    const imageProductKey = normalizeProductImageKey(productName) || productKey;
    const imageUrl = clean(row.image_url);
    if (!productKey || !imageUrl) return;

    const imageInfo = {
      productName,
      pickupDateText: clean(row.pickup_date_text),
      salePrice: Number(row.price || 0),
      imageUrl
    };

    if (!map.has(productKey)) map.set(productKey, imageInfo);
    if (imageProductKey && !map.has(imageProductKey)) map.set(imageProductKey, imageInfo);
  });

  return map;
}

function mergeProductImageMaps(...maps) {
  const merged = new Map();

  maps.forEach(map => {
    (map || new Map()).forEach((nextInfo, key) => {
      if (!key) return;

      const currentInfo = merged.get(key) || {};
      merged.set(key, {
        ...currentInfo,
        ...nextInfo,
        imageUrl: nextInfo.imageUrl || currentInfo.imageUrl || '',
        salePrice: Number(nextInfo.salePrice || currentInfo.salePrice || 0),
        pickupDateText: nextInfo.pickupDateText || currentInfo.pickupDateText || '',
        productName: nextInfo.productName || currentInfo.productName || ''
      });
    });
  });

  return merged;
}

async function readRawOrderBufferNotes(syncRunId) {
  if (!OPS_CONFIG.ORDER_SPREADSHEET_ID) return [];

  const sheets = await getSheetsClient();
  const start = Math.max(1, OPS_CONFIG.RAW_READ_START_ROW);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: OPS_CONFIG.ORDER_SPREADSHEET_ID,
    range: `${OPS_CONFIG.RAW_SHEET_NAME}!A${start}:K`,
    valueRenderOption: 'FORMULA'
  });

  const rows = (response.data.values || []).flatMap((row, index) => {
    const noteText = cleanNonFormula(row[8]);
    const parsedBufferQuantity = parseBufferNoteQuantity(noteText);
    const productName = cleanProductName(row[5]);

    if (!productName || !noteText || !/버퍼/.test(noteText)) return [];

    const pickupDateText = sheetDateValueToText(row[9]);
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
      raw: rowToObject(['공구일자', '가격', '이미지 URL', '주문일자', '고객명', '주문상품', '수량', '아군 주문', '비고', '픽업일', 'K'], row.map(cleanNonFormula)),
      syncRunId
    }];
  });

  await hydrateBufferNoteDatesFromOrderCache(rows);

  return rows;
}

async function hydrateBufferNoteDatesFromOrderCache(rows = []) {
  const rowNumbers = [...new Set(rows
    .map(row => Number(row.sourceRowNumber || 0))
    .filter(Number.isInteger))];

  if (!rowNumbers.length) return;

  const cachedByRowNumber = new Map();
  for (let i = 0; i < rowNumbers.length; i += 500) {
    const chunk = rowNumbers.slice(i, i + 500);
    const { data, error } = await supabaseAdmin
      .from('order_cache')
      .select('source_row_number,pickup_date_text,pickup_date_value')
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .eq('source_sheet_name', OPS_CONFIG.RAW_SHEET_NAME)
      .in('source_row_number', chunk);

    if (error) throw error;

    (data || []).forEach(row => {
      cachedByRowNumber.set(Number(row.source_row_number), row);
    });
  }

  rows.forEach(row => {
    const cached = cachedByRowNumber.get(Number(row.sourceRowNumber || 0));
    if (!cached) return;

    const pickupDateText = clean(cached.pickup_date_text);
    const pickupDateKey =
      dateValueToDateKey(cached.pickup_date_value) ||
      parseDateText(pickupDateText)?.dateKey ||
      '';

    if (pickupDateText) {
      row.pickupDateText = pickupDateText;
      row.raw = {
        ...(row.raw || {}),
        '픽업일': pickupDateText
      };
    }

    if (pickupDateKey) row.pickupDateKey = pickupDateKey;
  });
}

async function readInventoryListRows() {
  const sheets = await getSheetsClient();
  const sheetRows = await Promise.all(INVENTORY_LIST_SHEETS.map(async sheetInfo => {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetInfo.name)}!${INVENTORY_LIST_RANGE}`,
        valueRenderOption: 'FORMATTED_VALUE'
      });
      return parseInventorySheetRows(sheetInfo, response.data.values || []);
    } catch (error) {
      if (isMissingSheetRangeError(error)) {
        console.warn(`inventory list sheet skipped (${sheetInfo.name}):`, error.message);
        return [];
      }
      throw error;
    }
  }));

  return sheetRows.flat();
}

async function readInventoryRawRows() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    range: `${quoteSheetName('입고 raw')}!${INVENTORY_RAW_RANGE}`,
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const rows = response.data.values || [];
  return parseInventoryRawSheetRows(rows);
}

function parseInventoryRawSheetRows(rows) {
  const headerIndex = findHeaderRowIndex(rows, ['보관', '상품명', '출고수량']);
  if (headerIndex < 0) return [];

  const originalHeader = rows[headerIndex] || [];
  const header = originalHeader.map(normalizeHeader);
  const columns = {
    storageMethod: resolveHeaderIndex(header, ['보관방법', '보관'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.storageMethod),
    productName: resolveHeaderIndex(header, ['상품명', '제품명', '품명', '상품이름'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.productName),
    salesType: resolveHeaderIndex(header, ['구분', '공구상시', '공구/상시', '분류', '카테고리'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.salesType),
    outboundDate: resolveHeaderIndex(header, ['출고일', '출고 날짜', '출고날짜', '날짜', '일자'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.outboundDate),
    quantity: resolveHeaderIndex(header, ['출고수량', '출고 수량', '출고량', '수량'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.quantity),
    packageUnit: resolveHeaderIndex(header, ['포장단위', '포장 단위', '포장'], INVENTORY_RAW_ROW_FALLBACK_COLUMNS.packageUnit),
    groupSaleDate: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.groupSaleDate, INVENTORY_RAW_ROW_FALLBACK_COLUMNS.groupSaleDate),
    productCode: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.productCode, INVENTORY_RAW_ROW_FALLBACK_COLUMNS.productCode),
    orderQuantity: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.orderQuantity, INVENTORY_RAW_ROW_FALLBACK_COLUMNS.orderQuantity),
    hqBufferQuantity: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.hqBufferQuantity, INVENTORY_RAW_ROW_FALLBACK_COLUMNS.hqBufferQuantity),
    supplyPrice: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.supplyPrice, INVENTORY_RAW_ROW_FALLBACK_COLUMNS.supplyPrice)
  };

  const parsed = [];

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const productName = cleanProductName(row[columns.productName]);
    if (!productName) continue;

    const sourceRowNumber = rowIndex + 1;
    const outboundDateText = clean(row[columns.outboundDate]);
    const outboundDate = parseDateText(outboundDateText);
    const raw = rowToObject(originalHeader, row);
    const groupSaleDateText = clean(row[columns.groupSaleDate]);
    const productCode = clean(row[columns.productCode]);
    const orderQuantityText = clean(row[columns.orderQuantity]);
    const hqBufferQuantityText = clean(row[columns.hqBufferQuantity]);
    const hasValidHqBufferQuantity = columns.hqBufferQuantity >= 0 && isNumericCellValue(hqBufferQuantityText);
    const supplyPriceText = clean(row[columns.supplyPrice]);

    setRawAlias(raw, '공구일', groupSaleDateText);
    setRawAlias(raw, '상품코드', productCode);
    setRawAlias(raw, '발주수량', orderQuantityText);
    setRawAlias(raw, '본사버퍼', hqBufferQuantityText);
    setRawAlias(raw, '공급가', supplyPriceText);

    parsed.push({
      stableId: stableHash(OPS_CONFIG.INVENTORY_SPREADSHEET_ID, '입고 raw', sourceRowNumber),
      sourceSheetName: '입고 raw',
      sourceRowNumber,
      storageMethod: normalizeStorageMethod(row[columns.storageMethod]),
      productName,
      salesType: clean(row[columns.salesType]),
      outboundDateText,
      outboundDateKey: outboundDate?.dateKey || '',
      quantity: parseNumber(row[columns.quantity]),
      packageUnit: clean(row[columns.packageUnit]),
      groupSaleDateText,
      productCode,
      orderQuantity: parseNumber(row[columns.orderQuantity]),
      hqBufferQuantity: parseNumber(row[columns.hqBufferQuantity]),
      hasValidHqBufferQuantity,
      supplyPrice: parseNumber(row[columns.supplyPrice]),
      raw
    });
  }

  return parsed;
}

function parseInventorySheetRows(sheetInfo, rows) {
  const headerIndex = findHeaderRowIndex(rows, ['보관', '상품명', '입고수량']);
  if (headerIndex < 0) return [];

  const originalHeader = rows[headerIndex] || [];
  const header = originalHeader.map(normalizeHeader);
  const isNewLayout = isNewInventoryListLayout(header);
  const columns = {
    productCode: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.productCode, isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.productCode : -1),
    storageMethod: resolveHeaderIndex(header, ['보관방법', '보관'], isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.storageMethod : -1),
    productName: resolveHeaderIndex(header, ['상품명', '제품명', '품명', '상품이름'], isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.productName : -1),
    salesType: resolveHeaderIndex(header, ['구분', '공구상시', '공구/상시', '분류', '카테고리'], isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.salesType : -1),
    inboundDate: resolveHeaderIndex(header, ['입고일', '입고 날짜', '입고날짜', '날짜', '일자']),
    inboundQuantity: resolveHeaderIndex(header, ['입고수량', '입고 수량', '입고량', '수량'], isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.inboundQuantity : -1),
    packageUnit: resolveHeaderIndex(header, ['포장단위', '포장 단위', '포장'], isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.packageUnit : -1),
    orderQuantity: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.orderQuantity, isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.orderQuantity : -1),
    hqBufferQuantity: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.hqBufferQuantity, isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.hqBufferQuantity : -1),
    supplyPrice: resolveHeaderIndex(header, INVENTORY_RAW_HEADERS.supplyPrice, isNewLayout ? INVENTORY_NEW_LAYOUT_FALLBACK_COLUMNS.supplyPrice : -1)
  };

  const parsed = [];

  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const productName = cleanProductName(row[columns.productName]);
    if (!productName) continue;

    const inboundDate = resolveInventoryInboundDate(row[columns.inboundDate], sheetInfo);
    const sourceRowNumber = rowIndex + 1;
    const raw = rowToObject(originalHeader, row);
    const productCode = clean(row[columns.productCode]);
    const orderQuantityText = clean(row[columns.orderQuantity]);
    const hqBufferQuantityText = clean(row[columns.hqBufferQuantity]);
    const hasValidHqBufferQuantity = columns.hqBufferQuantity >= 0 && isNumericCellValue(hqBufferQuantityText);
    const supplyPriceText = clean(row[columns.supplyPrice]);

    setRawAlias(raw, '상품코드', productCode);
    setRawAlias(raw, '입고일', inboundDate.text);
    setRawAlias(raw, '발주수량', orderQuantityText);
    setRawAlias(raw, '본사버퍼', hqBufferQuantityText);
    setRawAlias(raw, '공급가', supplyPriceText);

    parsed.push({
      stableId: createInventoryItemStableId({
        sourceSheetName: sheetInfo.name,
        sourceRowNumber,
        productName,
        inboundDateKey: inboundDate.dateKey
      }),
      sourceSheetName: sheetInfo.name,
      sourceRowNumber,
      productCode,
      storageMethod: normalizeStorageMethod(row[columns.storageMethod]),
      productName,
      salesType: clean(row[columns.salesType]),
      inboundDateText: inboundDate.text,
      inboundDateKey: inboundDate.dateKey,
      inboundQuantity: parseNumber(row[columns.inboundQuantity]),
      packageUnit: clean(row[columns.packageUnit]),
      orderQuantity: parseNumber(row[columns.orderQuantity]),
      hqBufferQuantity: parseNumber(row[columns.hqBufferQuantity]),
      supplyPrice: parseNumber(row[columns.supplyPrice]),
      hasOrderQuantity: columns.orderQuantity >= 0,
      hasHqBufferQuantity: columns.hqBufferQuantity >= 0,
      hasValidHqBufferQuantity,
      hasSupplyPrice: columns.supplyPrice >= 0,
      dDayOffset: sheetInfo.dDayOffset,
      raw
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

  return buildSettlementBufferAggregate(rows);
}

function buildSettlementBufferAggregate(rows = []) {
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

function needsSettlementHqBufferFallback(inventoryRows = []) {
  return inventoryRows.some(row => shouldUseSettlementHqBufferFallback(row));
}

function shouldUseSettlementHqBufferFallback(row) {
  return !isNumericCellValue(getRawStringByHeaders(row?.raw_json, INVENTORY_RAW_HEADERS.hqBufferQuantity));
}

function applySettlementHqBufferFallback(inventoryRows = [], settlementAggregates = null) {
  if (!settlementAggregates) return inventoryRows;

  return inventoryRows.map(row => {
    if (!shouldUseSettlementHqBufferFallback(row)) return row;

    const settlementInfo = getSettlementAggregateForProductDate(
      settlementAggregates,
      row.product_key,
      row.inbound_date || ''
    );
    const hqBufferQuantity = Number(settlementInfo?.hqBufferQuantity || 0);

    return {
      ...row,
      hq_buffer_quantity: hqBufferQuantity
    };
  });
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
    if (isExcludedOrderCustomer(row.customer_label)) return;

    const productKey = normalizeProductKey(row.product_name);
    const dateKey = dateValueToDateKey(row.pickup_date_value) ||
      parseDateText(row.pickup_date_text)?.dateKey ||
      '';
    if (!productKey || !dateKey) return;

    const key = aggregateKey(productKey, dateKey);
    const current = aggregates.get(key) || {
      orderQuantity: 0,
      orderLineCount: 0,
      customers: []
    };
    const quantity = Number(row.quantity || 0);

    current.orderQuantity += quantity;
    current.orderLineCount += 1;
    current.customers.push({
      customerLabel: clean(row.customer_label) || '닉네임 비어있음',
      quantity,
      noteText: '',
      pickupDateText: clean(row.pickup_date_text),
      orderDateText: clean(row.order_date_text),
      sourceRowNumber: Number(row.source_row_number || 0)
    });

    aggregates.set(key, current);
  });

  const result = new Map();
  aggregates.forEach((aggregate, key) => {
    aggregate.customers.sort((a, b) => Number(a.sourceRowNumber || 0) - Number(b.sourceRowNumber || 0));
    result.set(key, {
      orderQuantity: aggregate.orderQuantity,
      orderLineCount: aggregate.orderLineCount,
      customers: aggregate.customers
    });
  });

  return result;
}

function buildOrderCustomersByKey(orderAggregates = new Map(), allowedKeys = null) {
  const customersByKey = {};

  orderAggregates.forEach((aggregate, key) => {
    if (allowedKeys && !allowedKeys.has(key)) return;
    if (!Array.isArray(aggregate.customers) || !aggregate.customers.length) return;
    customersByKey[key] = aggregate.customers;
  });

  return customersByKey;
}

function dateValueToDateKey(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return '';
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dateKeyToNumber(dateKey) {
  const text = clean(dateKey).replace(/\D/g, '');
  return /^\d{8}$/.test(text) ? Number(text) : 0;
}

function buildDashboardImageMap(orderRows = [], generatedImagePaths = new Set()) {
  const byProductDate = new Map();
  const byProduct = new Map();
  const byDate = new Map();

  (orderRows || []).forEach(row => {
    const imageUrl = clean(row.image_url);
    if (!isUsableProductImageUrl(imageUrl)) return;

    const productName = clean(row.product_name);
    const productKey = normalizeProductKey(productName);
    const imageProductKey = normalizeProductImageKey(productName) || productKey;
    const dateKey = dateValueToDateKey(row.pickup_date_value) || parseDateKey(row.pickup_date_text);
    if (!productKey) return;

    const imageInfo = {
      productName,
      productKey,
      imageProductKey,
      dateKey,
      imageUrl,
      salePrice: Number(row.price || 0)
    };

    addDashboardImageInfo(byProduct, productKey, '', imageInfo);
    if (imageProductKey && imageProductKey !== productKey) {
      addDashboardImageInfo(byProduct, imageProductKey, '', imageInfo);
    }

    if (!dateKey) return;
    addDashboardImageInfo(byProductDate, productKey, dateKey, imageInfo);
    if (imageProductKey && imageProductKey !== productKey) {
      addDashboardImageInfo(byProductDate, imageProductKey, dateKey, imageInfo);
    }

    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(imageInfo);
  });

  return { byProductDate, byProduct, byDate, generatedImagePaths };
}

function addDashboardImageInfo(map, productKey, dateKey, imageInfo) {
  const key = dateKey ? aggregateKey(productKey, dateKey) : productKey;
  if (!key || map.has(key)) return;
  map.set(key, imageInfo);
}

function findDashboardImageInfo(row, imageMap = {}) {
  const productKey = row.product_key || normalizeProductKey(row.product_name);
  const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
  const dateKey = row.inbound_date || '';
  const productDateKey = aggregateKey(productKey, dateKey);
  const imageProductDateKey = aggregateKey(imageProductKey, dateKey);

  return imageMap.byProductDate?.get(productDateKey) ||
    imageMap.byProductDate?.get(imageProductDateKey) ||
    imageMap.byProduct?.get(productKey) ||
    imageMap.byProduct?.get(imageProductKey) ||
    findGeneratedDashboardImageInfo(row, imageMap.generatedImagePaths) ||
    findClosestDashboardImageInfo(row, imageMap.byDate) ||
    {};
}

function findGeneratedDashboardImageInfo(row, generatedImagePaths = new Set()) {
  const productKey = row.product_key || normalizeProductKey(row.product_name);
  const imageProductKey = normalizeProductImageKey(row.product_name) || productKey;
  const keys = [imageProductKey, productKey].filter(Boolean);

  for (const key of keys) {
    if (hasGeneratedProductImage(generatedImagePaths, key)) {
      return {
        productName: row.product_name,
        productKey: key,
        imageProductKey: key,
        dateKey: row.inbound_date || '',
        imageUrl: getProductImagePublicUrl(key),
        salePrice: 0
      };
    }
  }

  return null;
}

function findClosestDashboardImageInfo(row, byDate = new Map()) {
  const dateKey = row.inbound_date || '';
  const candidates = byDate?.get?.(dateKey) || [];
  if (!dateKey || !candidates.length) return null;

  const scored = candidates
    .map(candidate => ({
      candidate,
      score: getProductImageMatchScore(row.product_name, candidate.productName)
    }))
    .filter(item => item.score >= 50)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 8) return null;
  return scored[0].candidate;
}

function getProductImageMatchScore(productName, candidateName) {
  const productKey = normalizeProductImageKey(productName);
  const candidateKey = normalizeProductImageKey(candidateName);
  if (!productKey || !candidateKey) return 0;
  if (productKey === candidateKey) return 100;

  const shorter = productKey.length <= candidateKey.length ? productKey : candidateKey;
  const longer = productKey.length > candidateKey.length ? productKey : candidateKey;
  if (shorter.length >= 6 && longer.includes(shorter)) return 88;

  const productTokens = getProductImageTokens(productKey);
  const candidateTokens = getProductImageTokens(candidateKey);
  if (productTokens.length < 2 || candidateTokens.length < 2) return 0;

  const candidateSet = new Set(candidateTokens);
  const matchCount = productTokens.filter(token => candidateSet.has(token)).length;
  if (matchCount < 2) return 0;

  return (matchCount / productTokens.length) * 60 +
    (matchCount / candidateTokens.length) * 25 +
    Math.min(matchCount, 5);
}

function getProductImageTokens(value) {
  return normalizeProductImageKey(value)
    .split(/[\s/,+·_-]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
    .filter(token => !/^\d+$/.test(token));
}

function isUsableProductImageUrl(value) {
  const url = clean(value);
  if (!url || url === '0' || /^#N\/?A$/i.test(url)) return false;
  if (url === OPS_CONFIG.IMAGE_FALLBACK_URL || /\/store-purchase-icon\.png(?:$|\?)/.test(url)) return false;
  return /^https?:\/\//i.test(url) || url.startsWith('/');
}

function resolveDashboardImageUrl(rowImageUrl, imageInfo = {}) {
  const currentUrl = clean(rowImageUrl);
  if (isUsableProductImageUrl(currentUrl)) return currentUrl;
  return isUsableProductImageUrl(imageInfo.imageUrl) ? imageInfo.imageUrl : OPS_CONFIG.IMAGE_FALLBACK_URL;
}

function buildDashboardItems(inventoryRows, bufferEvents, receivingEvents, receivingChecks, bufferNotes, orderAggregates, dashboardImageMap = {}) {
  const inventoryByStableId = new Map(inventoryRows.map(row => [row.stable_id, row]));
  const validBufferEvents = bufferEvents.filter(event =>
    bufferEventMatchesInventoryRow(event, inventoryByStableId.get(event.inventory_stable_id))
  );
  const validReceivingEvents = receivingEvents.filter(event =>
    receivingEventMatchesInventoryRow(event, inventoryByStableId.get(event.inventory_stable_id))
  );
  const validReceivingChecks = receivingChecks.filter(check =>
    receivingCheckMatchesInventoryRow(check, inventoryByStableId.get(check.inventory_stable_id))
  );
  const bufferAdjustmentEvents = validBufferEvents.filter(event => !isStorageRequestEvent(event));
  const storageRequestEvents = validBufferEvents.filter(isStorageRequestEvent);
  const bufferByItem = groupBySum(bufferAdjustmentEvents, 'inventory_stable_id', 'delta_quantity');
  const receivingByItem = groupBySum(validReceivingEvents, 'inventory_stable_id', 'counted_quantity');
  const bufferHistoryByItem = groupByRows(bufferAdjustmentEvents, 'inventory_stable_id');
  const storageRequestByItem = groupByRows(storageRequestEvents, 'inventory_stable_id');
  const bufferNotesByItem = groupBufferNotesByInventoryItem(bufferNotes, inventoryRows);
  const receivingCheckByItem = new Map(validReceivingChecks.map(row => [row.inventory_stable_id, row]));

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
    const inventoryOrderQuantity = getRawNumberByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.orderQuantity);
    const customerOrderQuantity = Number(orderInfo.orderQuantity || 0);
    const productCode = getRawStringByHeaders(row.raw_json, INVENTORY_RAW_HEADERS.productCode);
    const physicalRemainingQuantity = Math.max(
      0,
      inboundQuantity - bufferUsedQuantity
    );
    const imageInfo = findDashboardImageInfo(row, dashboardImageMap);
    const salePrice = Number(row.sale_price || 0) || Number(imageInfo.salePrice || 0);

    return {
      id: row.stable_id,
      sourceSheetName: row.source_sheet_name,
      sourceRowNumber: row.source_row_number,
      productName: row.product_name,
      productKey: row.product_key,
      productCode,
      storageMethod: normalizeStorageMethod(row.storage_method),
      salesType: row.sales_type || '',
      inboundDateKey: row.inbound_date || '',
      inboundDateText: row.inbound_date_text || '',
      inboundQuantity,
      remainingQuantity: physicalRemainingQuantity,
      physicalRemainingQuantity,
      packageUnit: row.package_unit || '',
      supplyPrice: Number(row.supply_price || 0),
      salePrice,
      imageUrl: resolveDashboardImageUrl(row.image_url, imageInfo),
      ourBufferQuantity: Number(row.our_buffer_quantity || 0),
      hqBufferQuantity: Number(row.hq_buffer_quantity || 0),
      initialBufferQuantity,
      bufferRemainingQuantity,
      bufferUsedQuantity,
      customerOrderQuantity,
      sheetOrderQuantity: inventoryOrderQuantity == null ? null : Number(inventoryOrderQuantity || 0),
      orderQuantitySource: inventoryOrderQuantity == null ? 'orders' : 'inventory_sheet',
      orderLineCount: Number(orderInfo.orderLineCount || 0),
      orderCustomerKey: aggregateKey(row.product_key, row.inbound_date || ''),
      countedQuantity,
      isReceivingComplete,
      completedAt: receivingCheck?.completed_at || '',
      dDayOffset: row.d_day_offset,
      bufferHistory: (bufferHistoryByItem.get(row.stable_id) || []).slice(0, 120).map(event => ({
        deltaQuantity: Number(event.delta_quantity || 0),
        actorMemo: event.actor_memo || '',
        eventSource: event.event_source || '',
        createdAt: event.created_at
      })),
      storageRequests: (storageRequestByItem.get(row.stable_id) || []).slice(0, 80).map(event => ({
        ...parseStorageRequestMemo(event.actor_memo),
        eventId: event.event_id || '',
        inventoryStableId: event.inventory_stable_id || '',
        quantity: Number(event.delta_quantity || 0),
        eventSource: event.event_source || '',
        status: storageRequestStatusFromEventSource(event.event_source),
        createdAt: event.created_at
      })),
      ourBufferNotes: (bufferNotesByItem.get(row.stable_id) || []).slice(0, 120).map(note => ({
        noteText: note.note_text || '',
        quantity: Number(note.parsed_buffer_quantity || 0),
        customerLabel: clean(note.raw_json?.['고객명'] || note.raw_json?.customerName || ''),
        customerDigits4: clean(note.raw_json?.['고객명'] || note.raw_json?.customerName || '').replace(/\D/g, '').slice(-4),
        pickupDateText: note.pickup_date_text || '',
        sourceSheetName: note.source_sheet_name || '',
        sourceRowNumber: note.source_row_number || '',
        syncedAt: note.synced_at || ''
      }))
    };
  });
}

function mergeArchivedDashboardItems(items = []) {
  const activeItems = [];
  const archivedItems = [];

  items.forEach(item => {
    if (isArchivedInventorySource(item.sourceSheetName)) {
      archivedItems.push(item);
      return;
    }

    activeItems.push(item);
  });

  const activeByProductDate = new Map();
  activeItems.forEach(item => {
    const key = dashboardProductDateKey(item);
    if (key && !activeByProductDate.has(key)) activeByProductDate.set(key, item);
  });

  const unmatchedArchivedItems = [];
  archivedItems.forEach(item => {
    const target = activeByProductDate.get(dashboardProductDateKey(item));
    if (!target) {
      unmatchedArchivedItems.push(item);
      return;
    }

    mergeDashboardItemState(target, item);
  });

  return [...activeItems, ...unmatchedArchivedItems];
}

function mergeDashboardItemState(target, source) {
  target.bufferHistory = mergeUniqueRows(
    target.bufferHistory,
    source.bufferHistory,
    event => `${event.createdAt || ''}|${event.deltaQuantity || 0}|${event.actorMemo || ''}|${event.eventSource || ''}`
  );
  target.storageRequests = mergeUniqueRows(
    target.storageRequests,
    source.storageRequests,
    request => request.eventId || `${request.createdAt || ''}|${request.customerLabel || ''}|${request.quantity || 0}`
  );
  target.ourBufferNotes = mergeUniqueRows(
    target.ourBufferNotes,
    source.ourBufferNotes,
    note => `${note.sourceSheetName || ''}|${note.sourceRowNumber || ''}|${note.noteText || ''}`
  );

  target.countedQuantity = Number(target.countedQuantity || 0) + Number(source.countedQuantity || 0);
  target.isReceivingComplete = Boolean(target.isReceivingComplete || source.isReceivingComplete);
  target.completedAt = latestText(target.completedAt, source.completedAt);

  recomputeDashboardItemQuantities(target);
}

function recomputeDashboardItemQuantities(item) {
  const bufferDelta = (item.bufferHistory || [])
    .reduce((sum, event) => sum + Number(event.deltaQuantity || 0), 0);
  const initialBufferQuantity = Number(item.initialBufferQuantity || 0);
  const inboundQuantity = Number(item.inboundQuantity || 0);
  const bufferRemainingQuantity = Math.max(0, initialBufferQuantity + bufferDelta);
  const bufferUsedQuantity = Math.max(0, initialBufferQuantity - bufferRemainingQuantity);

  item.bufferRemainingQuantity = bufferRemainingQuantity;
  item.bufferUsedQuantity = bufferUsedQuantity;
  item.remainingQuantity = Math.max(0, inboundQuantity - bufferUsedQuantity);
  item.physicalRemainingQuantity = item.remainingQuantity;
}

function mergeUniqueRows(targetRows = [], sourceRows = [], getKey = row => JSON.stringify(row)) {
  const map = new Map();

  [...(targetRows || []), ...(sourceRows || [])].forEach(row => {
    const key = getKey(row);
    if (!key || map.has(key)) return;
    map.set(key, row);
  });

  return Array.from(map.values());
}

function dashboardProductDateKey(item) {
  return aggregateKey(item.productKey, item.inboundDateKey || '');
}

function latestText(a, b) {
  return [clean(a), clean(b)].filter(Boolean).sort().pop() || '';
}

function buildStorageRequestItems(dashboardItems = [], bufferEvents = []) {
  const attachedEventIds = new Set();
  const attachedItems = [];

  dashboardItems.forEach(item => {
    const requests = Array.isArray(item.storageRequests) ? item.storageRequests : [];
    if (!requests.length) return;

    requests.forEach(request => {
      if (request.eventId) attachedEventIds.add(request.eventId);
    });
    attachedItems.push(item);
  });

  const standaloneItems = bufferEvents
    .filter(isStorageRequestEvent)
    .filter(event => !attachedEventIds.has(clean(event.event_id)))
    .map(event => {
      const parsed = parseStorageRequestMemo(event.actor_memo);
      const productName = parsed.productName || event.product_name || '상품명 없음';
      const productKey = parsed.productKey || event.product_key || normalizeProductKey(productName);
      const storageMethod = normalizeStorageMethod(parsed.storageMethod);
      const pickupDateKey = parsed.pickupDateKey || '';
      const pickupDateText = parsed.pickupDateText || pickupDateKey;
      const request = {
        ...parsed,
        eventId: event.event_id || '',
        inventoryStableId: event.inventory_stable_id || '',
        quantity: Number(event.delta_quantity || parsed.quantity || 0),
        eventSource: event.event_source || '',
        status: storageRequestStatusFromEventSource(event.event_source),
        createdAt: event.created_at,
        productName,
        productKey,
        storageMethod,
        imageUrl: parsed.imageUrl || OPS_CONFIG.IMAGE_FALLBACK_URL,
        salePrice: Number(parsed.salePrice || 0),
        pickupDateKey,
        pickupDateText
      };

      return {
        id: `storage:${event.event_id}`,
        sourceSheetName: '',
        sourceRowNumber: 0,
        productName,
        productKey,
        storageMethod,
        salesType: '',
        inboundDateKey: pickupDateKey,
        inboundDateText: pickupDateText,
        inboundQuantity: 0,
        remainingQuantity: 0,
        physicalRemainingQuantity: 0,
        packageUnit: '',
        supplyPrice: 0,
        salePrice: Number(parsed.salePrice || 0),
        imageUrl: parsed.imageUrl || OPS_CONFIG.IMAGE_FALLBACK_URL,
        ourBufferQuantity: 0,
        hqBufferQuantity: 0,
        initialBufferQuantity: 0,
        bufferRemainingQuantity: 0,
        bufferUsedQuantity: 0,
        customerOrderQuantity: 0,
        orderLineCount: 0,
        countedQuantity: 0,
        isReceivingComplete: false,
        completedAt: '',
        dDayOffset: null,
        bufferHistory: [],
        storageRequests: [request],
        ourBufferNotes: []
      };
    });

  return [...attachedItems, ...standaloneItems];
}

function isStorageRequestEvent(event) {
  return ['storage_request', 'storage_request_pending', 'storage_request_picked_up'].includes(event?.event_source || '');
}

function bufferEventMatchesInventoryRow(event, inventoryRow) {
  if (!inventoryRow) return true;

  const eventProductKey = clean(event?.product_key);
  const inventoryProductKey = clean(inventoryRow.product_key);
  if (eventProductKey && inventoryProductKey && eventProductKey !== inventoryProductKey) return false;
  if (!timestampMatchesInventoryDate(event?.created_at, inventoryRow.inbound_date)) return false;

  if (isStorageRequestEvent(event)) {
    const parsed = parseStorageRequestMemo(event.actor_memo);
    const eventPickupDateKey = clean(parsed.pickupDateKey);
    const inventoryDateKey = clean(inventoryRow.inbound_date);

    if (eventPickupDateKey && inventoryDateKey && eventPickupDateKey !== inventoryDateKey) return false;
  }

  return true;
}

function receivingEventMatchesInventoryRow(event, inventoryRow) {
  if (!inventoryRow) return true;
  return timestampMatchesInventoryDate(event?.created_at, inventoryRow.inbound_date);
}

function receivingCheckMatchesInventoryRow(check, inventoryRow) {
  if (!inventoryRow) return true;
  return timestampMatchesInventoryDate(check?.completed_at || check?.updated_at, inventoryRow.inbound_date);
}

function timestampMatchesInventoryDate(timestamp, inventoryDateKey) {
  const eventDateKey = timestampToKstDateKey(timestamp);
  const dateKey = clean(inventoryDateKey);

  if (!eventDateKey || !dateKey) return true;
  return eventDateKey >= dateKey;
}

function timestampToKstDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  const year = part('year');
  const month = part('month');
  const day = part('day');

  return year && month && day ? `${year}-${month}-${day}` : '';
}

function storageRequestEventSourceForStatus(status) {
  if (status === 'pending') return 'storage_request_pending';
  if (status === 'picked_up') return 'storage_request_picked_up';
  return 'storage_request';
}

function storageRequestStatusFromEventSource(source) {
  if (source === 'storage_request_pending') return 'pending';
  if (source === 'storage_request_picked_up') return 'picked_up';
  return 'completed';
}

function isCurrentInventoryListSource(sourceSheetName) {
  return normalizeSheetName(sourceSheetName) === '입고리스트';
}

function isActiveInventoryListSource(sourceSheetName) {
  const normalized = normalizeSheetName(sourceSheetName);
  if (isArchivedInventorySource(normalized)) return false;

  return INVENTORY_LIST_SHEETS.some(sheet => normalizeSheetName(sheet.name) === normalized);
}

function isArchivedInventorySource(sourceSheetName) {
  return normalizeSheetName(sourceSheetName).includes('#history:');
}

function groupBufferNotesByInventoryItem(bufferNotes = [], inventoryRows = []) {
  const notesByProductDate = new Map();

  bufferNotes.forEach(note => {
    const key = aggregateKey(note.product_key, note.pickup_date || '');
    if (!key) return;

    if (!notesByProductDate.has(key)) notesByProductDate.set(key, []);
    notesByProductDate.get(key).push(note);
  });

  const result = new Map();
  inventoryRows.forEach(row => {
    result.set(
      row.stable_id,
      notesByProductDate.get(aggregateKey(row.product_key, row.inbound_date || '')) || []
    );
  });

  return result;
}

function parseStorageRequestMemo(value) {
  try {
    const parsed = JSON.parse(clean(value) || '{}');

    if (parsed?.type === 'storage_request') {
      return {
        status: clean(parsed.status),
        storageGroupId: clean(parsed.storageGroupId),
        customerLabel: clean(parsed.customerLabel),
        customerDigits4: clean(parsed.customerDigits4),
        quantity: Number(parsed.quantity || 0),
        productName: clean(parsed.productName),
        productKey: clean(parsed.productKey),
        pickupDateKey: clean(parsed.pickupDateKey),
        pickupDateText: clean(parsed.pickupDateText),
        storageMethod: clean(parsed.storageMethod),
        imageUrl: clean(parsed.imageUrl),
        salePrice: Number(parsed.salePrice || 0),
        locationMemo: clean(parsed.locationMemo),
        visitDateText: clean(parsed.visitDateText),
        requestMemo: clean(parsed.requestMemo),
        completedAt: clean(parsed.completedAt),
        pickedUpAt: clean(parsed.pickedUpAt)
      };
    }
  } catch {
  }

  return {
    status: '',
    storageGroupId: '',
    customerLabel: clean(value),
    customerDigits4: '',
    quantity: 0,
    productName: '',
    productKey: '',
    pickupDateKey: '',
    pickupDateText: '',
    storageMethod: '',
    imageUrl: '',
    salePrice: 0,
    locationMemo: '',
    visitDateText: '',
    requestMemo: '',
    completedAt: '',
    pickedUpAt: ''
  };
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

async function getStorageRequestEventById(eventId) {
  const { data, error } = await supabaseAdmin
    .from('operations_buffer_events')
    .select('*')
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .eq('event_id', clean(eventId))
    .in('event_source', ['storage_request_pending', 'storage_request', 'storage_request_picked_up'])
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

async function archiveInventoryRowsWithChangedStableIds(records = []) {
  const nextBySource = new Map();

  records.forEach(record => {
    const key = inventorySourceKey(record);
    if (key) nextBySource.set(key, record.stable_id);
  });

  if (!nextBySource.size) return;

  const sourceSheetNames = [...new Set(records.map(record => clean(record.source_sheet_name)).filter(Boolean))];
  const sourceRowNumbers = [...new Set(records
    .map(record => Number(record.source_row_number || 0))
    .filter(Number.isInteger)
  )];
  const rowsToArchiveById = new Map();

  for (const sourceSheetName of sourceSheetNames) {
    for (let i = 0; i < sourceRowNumbers.length; i += 500) {
      const rowChunk = sourceRowNumbers.slice(i, i + 500);
      const { data, error } = await supabaseAdmin
        .from('operations_inventory_items')
        .select('stable_id,source_spreadsheet_id,source_sheet_name,source_row_number')
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .eq('source_spreadsheet_id', OPS_CONFIG.INVENTORY_SPREADSHEET_ID)
        .eq('source_sheet_name', sourceSheetName)
        .in('source_row_number', rowChunk);

      if (error) throw withOpsSchemaHint(error);

      (data || []).forEach(row => {
        const nextStableId = nextBySource.get(inventorySourceKey(row));
        if (nextStableId && row.stable_id !== nextStableId) {
          rowsToArchiveById.set(row.stable_id, row);
        }
      });
    }
  }

  const rowsToArchive = [...rowsToArchiveById.values()];
  const archivedRows = [];

  try {
    for (const row of rowsToArchive) {
      const { error } = await supabaseAdmin
        .from('operations_inventory_items')
        .update({
          source_sheet_name: archivedInventorySheetName(row.source_sheet_name, row.stable_id)
        })
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .eq('stable_id', row.stable_id);

      if (error) throw withOpsSchemaHint(error);
      archivedRows.push(row);
    }
  } catch (error) {
    try {
      await restoreArchivedInventoryRows(archivedRows);
    } catch (restoreError) {
      console.error('operations inventory partial archive rollback failed:', restoreError);
    }
    throw error;
  }

  return archivedRows;
}

async function restoreArchivedInventoryRows(rows = []) {
  for (const row of rows) {
    const archivedSheetName = archivedInventorySheetName(row.source_sheet_name, row.stable_id);
    const { error } = await supabaseAdmin
      .from('operations_inventory_items')
      .update({
        source_sheet_name: row.source_sheet_name
      })
      .eq('store_name', OPS_CONFIG.STORE_NAME)
      .eq('stable_id', row.stable_id)
      .eq('source_sheet_name', archivedSheetName);

    if (error) throw withOpsSchemaHint(error);
  }
}

async function deleteExpiredInventoryHistoryRows(syncRunId) {
  const retentionDays = Math.max(1, Number(INVENTORY_HISTORY_RETENTION_DAYS || 7));
  const cutoffDateKey = formatDateKey(addDays(getKstDate(), -retentionDays));
  const { error } = await supabaseAdmin
    .from('operations_inventory_items')
    .delete()
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .eq('source_spreadsheet_id', OPS_CONFIG.INVENTORY_SPREADSHEET_ID)
    .neq('sync_run_id', syncRunId)
    .lt('inbound_date', cutoffDateKey);

  if (error) throw withOpsSchemaHint(error);
}

async function deleteInvalidInventoryProductRows() {
  const invalidProductKeys = SPREADSHEET_ERROR_VALUES
    .map(value => clean(value).toLowerCase())
    .filter(Boolean);
  const { error } = await supabaseAdmin
    .from('operations_inventory_items')
    .delete()
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .eq('source_spreadsheet_id', OPS_CONFIG.INVENTORY_SPREADSHEET_ID)
    .in('product_name', SPREADSHEET_ERROR_VALUES);

  if (error) throw withOpsSchemaHint(error);

  if (!invalidProductKeys.length) return;

  const { error: keyError } = await supabaseAdmin
    .from('operations_inventory_items')
    .delete()
    .eq('store_name', OPS_CONFIG.STORE_NAME)
    .eq('source_spreadsheet_id', OPS_CONFIG.INVENTORY_SPREADSHEET_ID)
    .in('product_key', invalidProductKeys);

  if (keyError) throw withOpsSchemaHint(keyError);
}

function archivedInventorySheetName(sourceSheetName, stableId) {
  return `${clean(sourceSheetName)}#history:${clean(stableId).slice(0, 12)}`;
}

function dedupeInventoryRecords(records = []) {
  const byStableId = new Map();

  records.forEach(record => {
    const stableId = clean(record?.stable_id);
    if (!stableId || byStableId.has(stableId)) return;
    byStableId.set(stableId, record);
  });

  return [...byStableId.values()];
}

function inventorySourceKey(row) {
  const spreadsheetId = clean(row?.source_spreadsheet_id || OPS_CONFIG.INVENTORY_SPREADSHEET_ID);
  const sheetName = clean(row?.source_sheet_name);
  const rowNumber = Number(row?.source_row_number || 0);

  if (!spreadsheetId || !sheetName || !Number.isInteger(rowNumber) || rowNumber <= 0) return '';

  return `${spreadsheetId}::${sheetName}::${rowNumber}`;
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

async function deleteStaleProductStorageRows(records, chunkSize = 500) {
  const groups = new Map();

  records.forEach(record => {
    const sourceSheetName = clean(record.source_sheet_name);
    const syncRunId = clean(record.sync_run_id);
    const stableId = clean(record.stable_id);
    if (!sourceSheetName || !stableId) return;

    const key = `${sourceSheetName}::${syncRunId || '(null)'}`;
    const group = groups.get(key) || { sourceSheetName, syncRunId, stableIds: [] };
    group.stableIds.push(stableId);
    groups.set(key, group);
  });

  for (const group of groups.values()) {
    for (let index = 0; index < group.stableIds.length; index += chunkSize) {
      let query = supabaseAdmin
        .from('operations_inventory_raw_rows')
        .delete()
        .eq('store_name', OPS_CONFIG.STORE_NAME)
        .eq('source_sheet_name', group.sourceSheetName)
        .in('stable_id', group.stableIds.slice(index, index + chunkSize));

      query = group.syncRunId
        ? query.eq('sync_run_id', group.syncRunId)
        : query.is('sync_run_id', null);

      const { error } = await query;
      if (error) throw withOpsSchemaHint(error);
    }
  }
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
    .filter(row => isActiveInventoryListSource(row.source_sheet_name))
    .map(row => dateKeyToNumber(row.inbound_date))
    .filter(Boolean))];
}

function getSettlementPickupDateRange(rows) {
  const dates = (rows || [])
    .map(row => dateFromKey(row.settlement_date))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  if (!dates.length) return null;

  return {
    min: dateKeyToNumber(formatDateKey(addDays(dates[0], -21))),
    max: dateKeyToNumber(formatDateKey(addDays(dates[dates.length - 1], 21)))
  };
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

function setToArray(value) {
  if (!value) return [];
  if (value instanceof Set) return Array.from(value).filter(Boolean);
  if (Array.isArray(value)) return value.filter(Boolean);
  return [];
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

function resolveHeaderIndex(headers, candidates, fallbackIndex = -1) {
  const headerIndex = findHeaderIndex(headers, candidates);
  return headerIndex >= 0 ? headerIndex : fallbackIndex;
}

function isNewInventoryListLayout(headers) {
  const firstHeader = headers[0] || '';
  const text = headers.join(' ');
  return firstHeader.includes(normalizeHeader('상품코드')) ||
    text.includes(normalizeHeader('발주수량')) ||
    text.includes(normalizeHeader('본사버퍼')) ||
    text.includes(normalizeHeader('공급가'));
}

function resolveInventoryInboundDate(value, sheetInfo = {}) {
  const text = clean(value);
  const parsed = parseDateText(text);
  if (parsed?.dateKey) {
    return {
      text,
      dateKey: parsed.dateKey
    };
  }

  const date = addDays(getKstDate(), Number(sheetInfo.dDayOffset || 0));
  const dateKey = formatDateKey(date);
  return {
    text: text || formatDateLabel(dateKey, dateKey),
    dateKey
  };
}

function setRawAlias(raw, key, value) {
  const text = clean(value);
  if (!text || clean(raw?.[key])) return;
  raw[key] = text;
}

function getRawStringByHeaders(rawJson, candidates) {
  const entry = getRawEntryByHeaders(rawJson, candidates);
  return entry ? clean(entry.value) : '';
}

function getRawNumberByHeaders(rawJson, candidates) {
  const entry = getRawEntryByHeaders(rawJson, candidates);
  return entry ? parseNumber(entry.value) : null;
}

function getRawEntryByHeaders(rawJson, candidates) {
  const raw = rawJson && typeof rawJson === 'object' ? rawJson : {};
  const normalizedCandidates = candidates.map(normalizeHeader).filter(Boolean);

  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = normalizeHeader(key);
    if (!normalizedKey) continue;
    if (normalizedCandidates.some(candidate => normalizedKey.includes(candidate))) {
      return { key, value };
    }
  }

  return null;
}

function quoteSheetName(sheetName) {
  return `'${clean(sheetName).replace(/'/g, "''")}'`;
}

function isMissingSheetRangeError(error) {
  const message = [
    error?.message,
    error?.response?.data?.error?.message,
    ...(Array.isArray(error?.errors) ? error.errors.map(item => item?.message) : [])
  ].filter(Boolean).join(' ');

  return /Unable to parse range|No grid with id|Range .* not found|시트.*찾을 수|범위.*찾을 수/i.test(message);
}

function cleanNonFormula(value) {
  const text = clean(value);
  return text.startsWith('=') || isSpreadsheetErrorValue(text) ? '' : text;
}

function cleanProductName(value) {
  const text = clean(value);
  return text.startsWith('=') || isSpreadsheetErrorValue(text) ? '' : text;
}

function isSpreadsheetErrorValue(value) {
  const text = clean(value).toUpperCase();
  if (!text) return false;
  if (SPREADSHEET_ERROR_VALUES.includes(text)) return true;
  return /^#(?:N\/?A|VALUE|REF|DIV\/0|NAME|NUM|NULL|ERROR|CALC|SPILL|FIELD)(?:!|\?)?$/.test(text);
}

function isUsableInventoryProductRow(row = {}) {
  return Boolean(cleanProductName(row.product_name) && normalizeProductKey(row.product_name));
}

function sheetDateValueToText(value) {
  const serial = sheetSerialNumber(value);
  if (serial != null) return serialToDisplayText(serial);

  return cleanNonFormula(value);
}

function sheetSerialNumber(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n < 20000 || n > 80000) return null;

  return Math.floor(n);
}

function serialToDisplayText(serial) {
  const date = new Date(Date.UTC(1899, 11, 30 + Number(serial || 0)));
  if (Number.isNaN(date.getTime())) return '';

  return `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}`;
}

function normalizeHeader(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/[()[\]{}]/g, '')
    .toLowerCase();
}

function normalizeStorageMethod(value) {
  return normalizeVerifiedStorageMethod(value) || '';
}

function normalizeProductKey(value) {
  return normalizeProductStorageKey(cleanProductName(value));
}

function normalizeProductImageKey(value) {
  return normalizeProductKey(stripProductDateSuffix(value));
}

function resolveDisplayProductName(currentName, rawName, rawCode = '') {
  const name = cleanProductName(currentName);
  const candidate = cleanProductName(rawName);
  const code = clean(rawCode);

  if (!candidate || looksLikeProductCode(candidate)) return name;
  if (!name) return candidate;
  if (looksLikeProductCode(name)) return candidate;
  if (code && normalizeHeader(name) === normalizeHeader(code)) return candidate;

  return name;
}

function looksLikeProductCode(value) {
  const text = cleanProductName(value)
    .replace(/^코드\s*/i, '')
    .replace(/\s+/g, '');

  if (!text) return false;
  return /^GGM[0-9A-Z]+(?:\^\d+)?$/i.test(text) ||
    /^[A-Z]{2,}\d{6,}(?:\^\d+)?$/i.test(text);
}

function stripProductDateSuffix(value) {
  return clean(value)
    .replace(/\s*[\(\[\{]\s*(?:20\d{2}\s*[./년-]\s*)?\d{1,2}\s*(?:[./월-])\s*\d{1,2}\s*(?:일)?\s*(?:입고|픽업)?\s*[\)\]\}]\s*/g, ' ')
    .replace(/\s*[\(\[\{]\s*\d{1,2}\s*월\s*\d{1,2}\s*(?:일)?\s*(?:입고|픽업)?\s*[\)\]\}]\s*/g, ' ')
    .replace(/\s+(?:20\d{2}\s*[./년-]\s*)?\d{1,2}\s*(?:[./월-])\s*\d{1,2}\s*(?:일)?\s*(?:입고|픽업)?\s*$/g, '')
    .replace(/\s+\d{1,2}\s*월\s*\d{1,2}\s*(?:일)?\s*(?:입고|픽업)?\s*$/g, '')
    .replace(/\s+/g, ' ')
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

function isNumericCellValue(value) {
  const raw = clean(value);
  if (!raw) return false;
  if (isSpreadsheetErrorValue(raw)) return false;

  const text = raw
    .replace(/,/g, '')
    .replace(/원|개|ea|EA/g, '')
    .replace(/[^\d.-]/g, '');
  if (!text || !/[0-9]/.test(text)) return false;

  const number = Number(text);
  return Number.isFinite(number);
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

function createInventoryItemStableId({ sourceSheetName, sourceRowNumber, productName, inboundDateKey }) {
  return stableHash(
    'inventory-item-v3',
    OPS_CONFIG.INVENTORY_SPREADSHEET_ID,
    sourceRowNumber,
    clean(inboundDateKey),
    normalizeProductKey(productName)
  );
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

function normalizeSalesType(value) {
  return clean(value).replace(/\s+/g, '');
}

function normalizeCustomerForOrderCount(value) {
  return clean(value).replace(/\s+/g, '');
}

function isExcludedOrderCustomer(value) {
  return ORDER_COUNT_EXCLUDED_CUSTOMERS.has(normalizeCustomerForOrderCount(value));
}

function isGroupSaleItem(item) {
  const salesType = normalizeSalesType(item?.salesType);
  return salesType.includes('공구') && !salesType.includes('상시');
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
