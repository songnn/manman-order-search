import { ingestKakaoCsvUpload } from './kakaoCsvProcessing.js';
import { getSheetsClient, getSpreadsheetId } from './googleSheetsClient.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  STORE_NAME: process.env.STORE_NAME || '전농래미안크레시티점',
  INDEX_SHEET_NAME: process.env.ORDER_INDEX_SHEET_NAME || '발주요청(Index)',
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  INDEX_DATE_COL: 1,
  INDEX_PRODUCT_COL: 4,
  RAW_WRITE_START_COL: 4,
  RAW_WRITE_COL_COUNT: 4,
  RAW_BUFFER_COL: 9,
  DEFAULT_START_TIME: '08:00',
  DEFAULT_CHUNK_SIZE: 15,
  MIN_CHUNK_SIZE: 5,
  MAX_CHUNK_SIZE: 25,
  INDEX_FAST_RECENT_ROWS: 5000,
  PRODUCT_LOAD_CACHE_SECONDS: 120,
  OPENAI_ENDPOINT: 'https://api.openai.com/v1/responses',
  DEFAULT_MODEL: process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o'
};

const cacheStore = globalThis.__manmanOrderCollectorCache ||= new Map();
const settingsStore = globalThis.__manmanOrderCollectorSettings ||= {
  allyNicknames: parseEnvList(process.env.ORDER_COLLECTOR_ALLY_NICKNAMES)
};

export async function runOrderCollectorAction(action, payload = {}) {
  switch (action) {
    case 'getInitialData':
      return getInitialData();
    case 'getProductsForDateForUi':
      return getProductsForDateForUi(payload.dateStr ?? payload, payload.holidayStartStr, payload.holidayEndStr);
    case 'prepareCsvJob':
      return prepareCsvJob(payload);
    case 'processJobChunk':
      return processJobChunk(payload);
    case 'reviewIssueCandidatesWithAI':
      return reviewIssueCandidatesWithAI(payload);
    case 'reviewMissingOrdersWithAI':
      return reviewMissingOrdersWithAI(payload);
    case 'reviewMissingItemsForOneMessage':
      return reviewMissingItemsForOneMessage(payload);
    case 'resolvePastOrderRowsForWrite':
      return resolvePastOrderRowsForWrite(payload);
    case 'writeFinalRows':
      return writeFinalRows(payload);
    case 'searchIndexProductsForUi':
      return searchIndexProductsForUi(payload);
    case 'uploadKakaoCsvOriginal':
      return uploadKakaoCsvOriginal(payload);
    case 'getAllyNicknames':
      return getAllyNicknames();
    case 'saveAllyNicknames':
      return saveAllyNicknames(payload);
    default:
      throw new Error(`지원하지 않는 자동 주문수집 액션입니다: ${action}`);
  }
}

export function isOrderCollectorAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN || '03064';
  const token =
    req.headers['x-admin-token'] ||
    req.query?.token ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  return Boolean(expected && token === expected);
}

function getInitialData() {
  return {
    today: formatDateKey(getSeoulToday()),
    defaultStartTime: CONFIG.DEFAULT_START_TIME,
    defaultChunkSize: CONFIG.DEFAULT_CHUNK_SIZE,
    maxChunkSize: CONFIG.MAX_CHUNK_SIZE,
    hasApiKey: Boolean(getOpenAIKey_()),
    model: getOpenAIModel_(),
    storeName: CONFIG.STORE_NAME
  };
}

function getAllyNicknames() {
  return settingsStore.allyNicknames || [];
}

function saveAllyNicknames(payload) {
  const names = Array.isArray(payload) ? payload : payload?.names;
  const cleaned = Array.from(new Set((names || [])
    .map(cleanCellText_)
    .filter(Boolean)));

  settingsStore.allyNicknames = cleaned;
  return { ok: true, names: cleaned };
}

async function getProductsForDateForUi(dateStr, holidayStartStr, holidayEndStr) {
  const startedAt = Date.now();
  const lastRow = await getIndexSheetLastRow_();
  const cacheKey = makeProductLoadCacheKey_(dateStr, holidayStartStr, holidayEndStr, lastRow);
  const cached = getCachedValue_(cacheKey);

  if (cached) {
    return {
      ...cached,
      cached: true,
      loadMs: Date.now() - startedAt
    };
  }

  const validDateKeys = getValidProductDateKeysForOrderDate_(dateStr, holidayStartStr, holidayEndStr);
  const holidayRange = normalizeHolidayRange_(holidayStartStr, holidayEndStr);

  const buildResult = (snapshot, usedFallback) => {
    const products = getProductNamesFromSnapshotForDateKeys_(snapshot, validDateKeys);
    const previousDayRecords = getPreviousDayProductRecordsFromSnapshot_(
      snapshot,
      dateStr,
      holidayStartStr,
      holidayEndStr,
      products
    );
    const previousDayProducts = previousDayRecords.map(record => record.productName);

    return {
      dateStr,
      holidayStartStr: holidayRange.startKey || '',
      holidayEndStr: holidayRange.endKey || '',
      validDateKeys,
      count: products.length,
      products,
      previousDayDateStr: getPreviousDateKey_(dateStr),
      previousDayProductCount: previousDayProducts.length,
      previousDayProducts,
      previousDayProductRecords: previousDayRecords,
      combinedCount: mergeProductNames_(products, previousDayProducts).length,
      indexLastRow: snapshot.lastRow || 0,
      indexStartRow: snapshot.startRow || 1,
      indexRowCount: snapshot.rowCount || 0,
      indexReadMs: snapshot.loadMs || 0,
      loadMs: Date.now() - startedAt,
      optimized: true,
      recentRows: CONFIG.INDEX_FAST_RECENT_ROWS,
      usedFallback: Boolean(usedFallback),
      cached: false
    };
  };

  let snapshot = await getIndexProductSnapshot_({
    includeMeta: false,
    recentRows: CONFIG.INDEX_FAST_RECENT_ROWS
  });
  let result = buildResult(snapshot, false);

  if (!result.products.length && !result.previousDayProducts.length && snapshot.isRecentSnapshot) {
    snapshot = await getIndexProductSnapshot_({
      includeMeta: false,
      recentRows: 0
    });
    result = buildResult(snapshot, true);
  }

  putCachedValue_(cacheKey, result, CONFIG.PRODUCT_LOAD_CACHE_SECONDS);
  return result;
}

async function prepareCsvJob(payload) {
  validatePayloadForPrepare_(payload);

  const orderDate = parseInputDate_(payload.dateStr);
  const orderDateText = formatOrderDateText_(orderDate);
  const startDateTime = makeDateTime_(payload.dateStr, payload.startTime || CONFIG.DEFAULT_START_TIME);
  const endDateTime = makeOptionalEndDateTime_(payload.endDateStr, payload.endTime);

  if (endDateTime && endDateTime.getTime() < startDateTime.getTime()) {
    throw new Error('수집 마감일시는 수집 시작일시보다 빠를 수 없습니다.');
  }

  const startRow = Number(payload.startRow);
  const requestedChunkSize = Number(payload.chunkSize || CONFIG.DEFAULT_CHUNK_SIZE);
  const chunkSize = Math.max(CONFIG.MIN_CHUNK_SIZE, Math.min(requestedChunkSize, CONFIG.MAX_CHUNK_SIZE));

  let productNames = [];
  let baseProductNames = [];
  let previousDayProductNames = [];
  let previousDayProductRecords = [];
  let indexReadMs = 0;
  let indexLastRow = 0;
  let productSource = 'preloaded';

  if (Array.isArray(payload.preloadedProductNames) && payload.preloadedProductNames.length) {
    productNames = payload.preloadedProductNames.map(cleanCellText_).filter(Boolean);
    baseProductNames = (payload.preloadedBaseProductNames || []).map(cleanCellText_).filter(Boolean);
    previousDayProductNames = (payload.preloadedPreviousDayProductNames || []).map(cleanCellText_).filter(Boolean);
    previousDayProductRecords = Array.isArray(payload.preloadedPreviousDayProductRecords)
      ? payload.preloadedPreviousDayProductRecords
      : [];
  } else {
    productSource = 'index-read';
    const indexSnapshot = await getIndexProductSnapshot_({
      includeMeta: false,
      recentRows: CONFIG.INDEX_FAST_RECENT_ROWS
    });
    const baseProductDateKeys = getValidProductDateKeysForOrderDate_(
      payload.dateStr,
      payload.holidayStartStr,
      payload.holidayEndStr
    );
    baseProductNames = getProductNamesFromSnapshotForDateKeys_(indexSnapshot, baseProductDateKeys);
    previousDayProductRecords = getPreviousDayProductRecordsFromSnapshot_(
      indexSnapshot,
      payload.dateStr,
      payload.holidayStartStr,
      payload.holidayEndStr,
      baseProductNames
    );

    if (!baseProductNames.length && !previousDayProductRecords.length && indexSnapshot.isRecentSnapshot) {
      const fullSnapshot = await getIndexProductSnapshot_({
        includeMeta: false,
        recentRows: 0
      });
      baseProductNames = getProductNamesFromSnapshotForDateKeys_(fullSnapshot, baseProductDateKeys);
      previousDayProductRecords = getPreviousDayProductRecordsFromSnapshot_(
        fullSnapshot,
        payload.dateStr,
        payload.holidayStartStr,
        payload.holidayEndStr,
        baseProductNames
      );
      indexReadMs = fullSnapshot.loadMs || 0;
      indexLastRow = fullSnapshot.lastRow || 0;
    } else {
      indexReadMs = indexSnapshot.loadMs || 0;
      indexLastRow = indexSnapshot.lastRow || 0;
    }

    previousDayProductNames = previousDayProductRecords.map(record => record.productName);
    productNames = mergeProductNames_(baseProductNames, previousDayProductNames);
  }

  productNames = mergeProductNamesWithCustom_(productNames, payload.customProducts || []);

  if (!productNames.length) {
    throw new Error('해당 공구날짜와 하루 전 공구상품을 모두 확인했지만 상품을 찾지 못했습니다. 발주요청(Index) A열 날짜와 D열 상품명을 확인해주세요.');
  }

  const csvRows = parseCsvText_(payload.csvText);
  const messages = filterMessagesFromCsv_(csvRows, startDateTime, endDateTime);
  const chunks = chunkArray_(messages, chunkSize);

  return {
    ok: true,
    dateStr: payload.dateStr,
    orderDateText,
    endDateStr: String(payload.endDateStr || '').trim(),
    endTime: String(payload.endTime || '').trim(),
    startRow,
    productNames,
    baseProductNames,
    previousDayDateStr: getPreviousDateKey_(payload.dateStr),
    previousDayProductNames,
    previousDayProductRecords,
    indexReadMs,
    indexLastRow,
    productSource,
    productCount: productNames.length,
    baseProductCount: baseProductNames.length,
    previousDayProductCount: previousDayProductNames.length,
    csvMessageCount: csvRows.length,
    targetMessageCount: messages.length,
    chunkSize,
    chunkCount: chunks.length,
    chunks,
    stateRows: [],
    soldOutProducts: [],
    report: makeEmptyReport_([])
  };
}

async function processJobChunk(payload) {
  if (!payload) throw new Error('AI 처리 데이터가 비어 있습니다.');
  if (!payload.chunk) throw new Error('처리할 AI 묶음이 없습니다.');
  if (!payload.productNames || !payload.productNames.length) throw new Error('상품리스트가 없습니다.');

  const state = stateRowsToMap_(payload.stateRows || []);
  const report = payload.report || makeEmptyReport_([]);
  const soldOutProducts = payload.soldOutProducts || [];
  const productNames = payload.productNames;
  const orderDateText = payload.orderDateText;
  const manualSoldOutRules = normalizeSoldOutRules_(payload.soldOutRules || []);
  const usersInChunk = Array.from(new Set(payload.chunk.map(message => message.user).filter(Boolean)));
  const previousStateForUsers = buildStateSummaryForUsers_(state, usersInChunk);

  const aiResult = await callOpenAIParser_({
    chunk: payload.chunk,
    chunkIndex: Number(payload.chunkIndex || 0),
    totalChunks: Number(payload.totalChunks || 1),
    orderDateText,
    productNames,
    previousDayProductNames: payload.previousDayProductNames || [],
    previousStateForUsers,
    soldOutProducts
  });

  applyAiResultToState_({
    aiResult,
    state,
    report,
    productNames,
    orderDateText,
    soldOutProducts,
    manualSoldOutRules
  });

  return {
    ok: true,
    chunkIndex: Number(payload.chunkIndex || 0),
    totalChunks: Number(payload.totalChunks || 1),
    stateRows: mapToStateRows_(state),
    report,
    soldOutProducts,
    aiEventCount: (aiResult.events || []).length
  };
}

async function reviewIssueCandidatesWithAI(payload) {
  if (!payload) throw new Error('AI 최종 검토 데이터가 비어 있습니다.');

  const productNames = payload.productNames || [];
  const candidates = (payload.candidates || []).filter(Boolean).slice(0, 120);

  if (!productNames.length) throw new Error('상품리스트가 없습니다.');
  if (!candidates.length) return { ok: true, decisions: [] };

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'decision', 'productName', 'confidence', 'reason'],
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['promote_to_order', 'keep_needs_check'] },
            productName: { type: 'string', enum: [''].concat(productNames) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          }
        }
      }
    }
  };

  const prompt = JSON.stringify({
    task: '확인필요 주문 후보를 마지막으로 한 번 더 검토해서 AI 주문 후보 승격 여부를 결정한다.',
    strictRules: [
      '각 candidate의 id마다 decisions 항목을 1개씩 만든다.',
      'promote_to_order는 고객 원문이 productNames의 한 상품과 사실상 동일한 경우에만 사용한다.',
      '옵션, 맛, 종류, 용량, 묶음 구분이 애매하면 keep_needs_check다.',
      '지난 공구주문, 상품리스트 없음, 품절마감, 취소/정정/수정 관련 후보는 승격하지 않는다.',
      'promote_to_order의 confidence는 반드시 0.94 이상이다.',
      '임의 상품명은 만들지 않는다.'
    ],
    productNames,
    candidates
  });

  const parsed = await callOpenAIJson_({
    schemaName: 'issue_final_review',
    schema,
    developerContent: '너는 카카오톡 공동구매 주문 확인필요 후보의 최종 검수 AI다. 반드시 JSON Schema에 맞는 JSON만 출력한다.',
    prompt,
    maxOutputTokens: 12000
  });

  return {
    ok: true,
    model: getOpenAIModel_(),
    reviewedCount: candidates.length,
    decisions: parsed.decisions || []
  };
}

function reviewMissingOrdersWithAI(payload) {
  if (!payload) throw new Error('누락 검토 데이터가 비어 있습니다.');

  const productNames = payload.productNames || [];
  const rawMessages = (payload.sourceMessages || []).filter(message => message && message.message);
  const processedRows = (payload.processedRows || []).filter(Boolean);

  if (!productNames.length) throw new Error('상품리스트가 없습니다.');
  if (!rawMessages.length) throw new Error('검토할 CSV 메시지가 없습니다.');

  const processedBySource = {};
  processedRows.forEach(row => {
    const key = String(Number(row.sourceIndex) || row.sourceIndex || 'unknown');
    if (!processedBySource[key]) processedBySource[key] = [];
    processedBySource[key].push({
      productName: cleanCellText_(row.productName),
      quantity: Number(row.quantity) || 1,
      rawName: cleanCellText_(row.rawName || row.rawExpression || row.message || ''),
      action: cleanCellText_(row.action || '')
    });
  });

  const missedItems = [];
  let checkedMessageCount = 0;

  rawMessages.forEach(message => {
    if (!isLikelyOrderMessageForMissingReview_(message)) return;
    checkedMessageCount += 1;

    const sourceIndex = Number(message.sourceIndex) || 0;
    const done = processedBySource[String(sourceIndex)] || [];
    const parts = extractOrderPartsForMissingReview_(message.message, productNames);
    if (!parts.length) return;

    const doneProductSet = new Set(done.map(row => normalizeForHint_(row.productName)).filter(Boolean));
    const doneRawSet = new Set(done.map(row => normalizeForHint_(row.rawName)).filter(Boolean));

    const definiteMisses = [];
    parts.forEach(part => {
      const productKey = normalizeForHint_(part.suggestedProductName || '');
      const rawKey = normalizeForHint_(part.rawName || '');
      if (productKey && !doneProductSet.has(productKey)) {
        definiteMisses.push(part);
      } else if (!productKey && rawKey && !doneRawSet.has(rawKey) && done.length < parts.length) {
        definiteMisses.push(part);
      }
    });

    const misses = definiteMisses.length ? definiteMisses : (parts.length > done.length ? parts.slice(done.length) : []);
    misses.forEach(part => {
      missedItems.push({
        sourceIndex,
        csvRowNumber: Number(message.csvRowNumber) || 0,
        dateRaw: cleanCellText_(message.dateRaw),
        user: cleanCellText_(message.user),
        message: cleanCellText_(message.message),
        rawName: cleanCellText_(part.rawName || message.message),
        quantity: Number(part.quantity) > 0 ? Number(part.quantity) : 1,
        suggestedProductName: productNames.includes(part.suggestedProductName) ? part.suggestedProductName : '',
        confidence: Number(part.confidence || 0),
        reason: `로컬 누락검토: 원문 주문 후보 ${parts.length}개 대비 입력 ${done.length}개`
      });
    });
  });

  return {
    ok: true,
    model: 'local-count-review',
    checkedMessageCount,
    originalMessageCount: rawMessages.length,
    processedLineCount: processedRows.length,
    missedItems,
    reviewNotes: [
      'OpenAI 호출 없이 sourceIndex별 원문 주문 후보 수와 실제 입력 라인 수를 비교했습니다.',
      '누락 의심 항목은 확인필요 주문후보에 추가되며, 사람이 최종 확인 후 입력합니다.'
    ]
  };
}

async function reviewMissingItemsForOneMessage(payload) {
  if (!payload) throw new Error('원문 재검토 데이터가 비어 있습니다.');

  let productNames = (payload.productNames || []).map(cleanCellText_).filter(Boolean);
  productNames = mergeProductNamesWithCustom_(productNames, payload.customProducts || []);
  productNames = Array.from(new Set(productNames));

  const sourceMessage = payload.sourceMessage || {};
  const existingItems = (payload.existingItems || []).map(item => ({
    productName: cleanCellText_(item.productName || ''),
    manualProductName: cleanCellText_(item.manualProductName || ''),
    rawName: cleanCellText_(item.rawName || item.rawExpression || ''),
    quantity: Number(item.quantity || 0) || 0,
    action: cleanCellText_(item.action || '')
  }));

  if (!sourceMessage.message && !sourceMessage.rawName) {
    return { ok: true, missingItems: [] };
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['missingItems', 'reason'],
    properties: {
      missingItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rawName', 'quantity', 'suggestedProductName', 'confidence', 'suggestedAction', 'reason'],
          properties: {
            rawName: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
            suggestedProductName: { type: 'string', enum: [''].concat(productNames) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            suggestedAction: { type: 'string', enum: ['include', 'past_order'] },
            reason: { type: 'string' }
          }
        }
      },
      reason: { type: 'string' }
    }
  };

  const prompt = JSON.stringify({
    task: '한 개의 카카오톡 주문 원문을 다시 읽고, 이미 만들어진 주문카드에 없는 누락 주문 항목만 찾아낸다.',
    sourceMessage: {
      customer: cleanCellText_(sourceMessage.customer || sourceMessage.user || ''),
      dateRaw: cleanCellText_(sourceMessage.dateRaw || ''),
      csvRowNumber: cleanCellText_(sourceMessage.csvRowNumber || ''),
      sourceIndex: cleanCellText_(sourceMessage.sourceIndex || ''),
      message: cleanCellText_(sourceMessage.message || sourceMessage.rawName || '')
    },
    existingItems,
    productNames,
    strictRules: [
      'sourceMessage.message 안의 주문 표현을 모두 상품별로 나눈다.',
      'existingItems에 이미 같은 상품/수량/표현으로 카드가 있는 주문은 missingItems에 다시 넣지 않는다.',
      '현재 productNames에 없거나 지난 공구상품으로 보이면 suggestedProductName은 빈 문자열, suggestedAction은 past_order로 둔다.',
      '상품이 애매해도 rawName과 quantity는 반드시 분리한다.',
      '가격, 날짜, g/ml/kg/개입/인분 같은 스펙 숫자는 수량으로 보지 않는다.',
      '임의 상품명은 만들지 않는다.'
    ]
  });

  const parsed = await callOpenAIJson_({
    schemaName: 'single_message_missing_items_result',
    schema,
    developerContent: '너는 카카오톡 주문 원문에서 누락된 주문카드만 찾아내는 검수 AI다. 반드시 JSON Schema에 맞는 JSON만 출력한다.',
    prompt,
    maxOutputTokens: 6000
  });

  return {
    ok: true,
    missingItems: (parsed.missingItems || []).filter(item => Number(item.quantity || 0) > 0),
    reason: parsed.reason || ''
  };
}

async function resolvePastOrderRowsForWrite(payload) {
  if (!payload) throw new Error('지난공구주문 매칭 데이터가 비어 있습니다.');

  let productNames = Array.isArray(payload.productNames)
    ? payload.productNames.map(cleanCellText_).filter(Boolean)
    : [];

  if (!productNames.length) {
    const baseProductNames = Array.isArray(payload.baseProductNames)
      ? payload.baseProductNames.map(cleanCellText_).filter(Boolean)
      : [];
    const previousDayProductNames = Array.isArray(payload.previousDayProductNames)
      ? payload.previousDayProductNames.map(cleanCellText_).filter(Boolean)
      : [];
    productNames = mergeProductNames_(baseProductNames, previousDayProductNames);
  }

  productNames = mergeProductNamesWithCustom_(productNames, payload.customProducts || []);
  const productSet = new Set(productNames.map(cleanCellText_).filter(Boolean));
  const previousDayProductRecords = Array.isArray(payload.previousDayProductRecords)
    ? payload.previousDayProductRecords
    : [];
  const previousDayProductNameSet = new Set(
    (payload.previousDayProductNames || previousDayProductRecords.map(record => record.productName) || [])
      .map(normalizeForHint_)
      .filter(Boolean)
  );

  const startedAt = Date.now();
  const rows = await enrichPastOrderRowsWithAI_(payload.dateStr, payload.rows || [], productSet, {
    previousDayProductRecords,
    previousDayProductNameSet
  });

  return {
    ok: true,
    rows,
    totalRows: rows.length,
    pastOrderCount: rows.filter(row => cleanCellText_(row.action || '') === 'past_order' || row.allowBlankProduct === true).length,
    aiCheckedCount: rows.filter(row => row.pastOrderAiChecked === true).length,
    aiMatchedCount: rows.filter(row => row.pastOrderAiMatched === true).length,
    fastResolvedCount: rows.filter(row => row.pastOrderFastResolved === true).length,
    previousDayMemoCount: rows.filter(row => cleanCellText_(row.pastOrderMemo || '').includes('하루전공구')).length,
    elapsedMs: Date.now() - startedAt
  };
}

async function writeFinalRows(payload) {
  if (!payload) throw new Error('입력 데이터가 비어 있습니다.');
  if (!payload.dateStr) throw new Error('공구날짜가 없습니다. 다시 분석 후 입력해주세요.');
  if (!payload.startRow || Number(payload.startRow) < 1) throw new Error('Raw_주문입력 시작 행을 확인해주세요.');

  const startRow = Number(payload.startRow);
  let baseProductNames = Array.isArray(payload.baseProductNames)
    ? payload.baseProductNames.map(cleanCellText_).filter(Boolean)
    : [];
  let previousDayProductRecords = Array.isArray(payload.previousDayProductRecords)
    ? payload.previousDayProductRecords
    : [];
  let previousDayProductNames = Array.isArray(payload.previousDayProductNames)
    ? payload.previousDayProductNames.map(cleanCellText_).filter(Boolean)
    : [];
  let indexProductNameSet = null;

  if (!baseProductNames.length && !previousDayProductRecords.length) {
    const indexSnapshot = await getIndexProductSnapshot_();
    const baseProductDateKeys = getValidProductDateKeysForOrderDate_(
      payload.dateStr,
      payload.holidayStartStr,
      payload.holidayEndStr
    );
    baseProductNames = getProductNamesFromSnapshotForDateKeys_(indexSnapshot, baseProductDateKeys);
    previousDayProductRecords = getPreviousDayProductRecordsFromSnapshot_(
      indexSnapshot,
      payload.dateStr,
      payload.holidayStartStr,
      payload.holidayEndStr,
      baseProductNames
    );
    previousDayProductNames = previousDayProductRecords.map(record => record.productName);
    indexProductNameSet = getIndexProductNameSetFromSnapshot_(indexSnapshot);
  }

  if (!previousDayProductNames.length && previousDayProductRecords.length) {
    previousDayProductNames = previousDayProductRecords.map(record => record.productName).filter(Boolean);
  }

  let productNames = mergeProductNames_(baseProductNames, previousDayProductNames);
  const customProducts = normalizeCustomProducts_(payload.customProducts || []);
  productNames = mergeProductNamesWithCustom_(productNames, customProducts);
  const productSet = new Set(productNames.map(cleanCellText_).filter(Boolean));
  const customProductMap = makeCustomProductMap_(customProducts);

  if (!indexProductNameSet) {
    indexProductNameSet = new Set(
      mergeProductNames_(baseProductNames, previousDayProductNames)
        .map(normalizeForHint_)
        .filter(Boolean)
    );
  }

  const previousDayProductMap = makeProductRecordMapByName_(previousDayProductRecords);
  const allyNames = Array.isArray(payload.allyNames) ? payload.allyNames : getAllyNicknames();
  const allySet = new Set(allyNames.map(normalizeAllyName_).filter(Boolean));
  const inputRows = payload.skipPastOrderAi === true
    ? (payload.rows || []).map(row => ({ ...row }))
    : await enrichPastOrderRowsWithAI_(payload.dateStr, payload.rows || [], productSet, {
        previousDayProductRecords,
        previousDayProductNameSet: new Set(previousDayProductNames.map(normalizeForHint_).filter(Boolean))
      });

  const normalizedRows = inputRows
    .filter(Boolean)
    .map(row => {
      const orderDateText = cleanCellText_(row.orderDateText);
      const customer = cleanCellText_(row.customer);
      const action = cleanCellText_(row.action || 'include');
      const isPastOrder = action === 'past_order' || row.allowBlankProduct === true;
      const isSoldOutClosed = action === 'soldout_closed' || row.soldOutClosed === true;
      const manualProductNameRaw = cleanCellText_(row.manualProductName || '');
      const selectedProductNameRaw = cleanCellText_(row.productName || '');
      const manualSplit = splitManualProductNameAndQuantity_(manualProductNameRaw, productSet);
      const manualProductNameClean = manualSplit.productName || manualProductNameRaw;
      const aiPastMatched = isPastOrder && row.pastOrderAiMatched === true && selectedProductNameRaw;
      const productName = aiPastMatched ? selectedProductNameRaw : (manualProductNameClean || selectedProductNameRaw);
      const quantity = Number(manualSplit.quantity || row.quantity);
      const customMeta = findCustomProductMeta_(customProductMap, productName);
      const previousDayRecord = findProductRecordByName_(previousDayProductMap, productName);
      const isPreviousDayProduct = Boolean(previousDayRecord && !customMeta);
      const pastOrderRawName = cleanCellText_(row.rawName || row.rawExpression || row.message || '');
      const userMemo = cleanCellText_(row.memo || '');
      const isAlly = allySet.has(normalizeAllyName_(customer));

      let bufferText = '';
      let bufferColor = '#000000';

      if (isSoldOutClosed) {
        bufferText = `품절마감상품 : ${customer}`;
        bufferColor = '#d93025';
      } else if (isPastOrder) {
        const ref = pastOrderRawName || cleanCellText_(row.message || '');
        bufferText = cleanCellText_(row.pastOrderMemo) || (ref ? `지난공구주문(참조:"${truncateForMemo_(ref, 80)}")` : '지난공구주문');
        bufferColor = '#d93025';
      } else if (isPreviousDayProduct) {
        const label = previousDayRecord.dateText || (previousDayRecord.dateKey ? formatShortKoreanDate_(parseInputDate_(previousDayRecord.dateKey)) : '하루전');
        bufferText = `${label}공구상품`;
        bufferColor = '#d93025';
      } else if (isAlly && quantity > 0) {
        bufferText = `버퍼 ${quantity}`;
      }

      if (userMemo) {
        bufferText = bufferText ? `${bufferText}\n메모: ${userMemo}` : `메모: ${userMemo}`;
      }

      return {
        orderDateText,
        customer,
        productName,
        quantity,
        action,
        isPastOrder,
        isSoldOutClosed,
        isAlly,
        bufferText,
        bufferColor,
        price: cleanCellText_(row.price || (customMeta ? customMeta.priceOverride : '')),
        imageUrl: cleanCellText_(row.imageUrl || (customMeta ? customMeta.imageUrlOverride : '')),
        pickupDate: cleanCellText_(row.pickupDate || (customMeta ? customMeta.pickupDateOverride : '')),
        customProductInputEnabled: customMeta ? customMeta.includeInOrder !== false : true,
        forceProductName: Boolean(customMeta && customMeta.fromIndex !== true && !indexProductNameSet.has(normalizeForHint_(productName))),
        isPreviousDayProduct
      };
    })
    .filter(row => row.customProductInputEnabled !== false)
    .filter(row => row.orderDateText && row.customer && Number.isFinite(row.quantity) && row.quantity > 0);

  if (!normalizedRows.length) throw new Error('입력할 주문 라인이 없습니다.');

  const invalidRows = normalizedRows.filter(row => {
    if (!row.orderDateText || !row.customer || !Number.isFinite(row.quantity) || row.quantity < 1) return true;
    if (row.isPastOrder && !row.productName) return false;
    return !row.productName;
  });

  if (invalidRows.length) {
    throw new Error(
      '상품명/고객명/수량이 비어 있거나 잘못된 행이 있습니다. 화면에서 빨간 테두리 주문카드를 먼저 수정해주세요.\n' +
      JSON.stringify(invalidRows.slice(0, 10))
    );
  }

  const sheetRows = normalizedRows.map(row => [
    row.orderDateText,
    row.isSoldOutClosed ? '' : row.customer,
    row.productName,
    row.quantity
  ]);
  const bufferTexts = normalizedRows.map(row => [row.bufferText]);
  const bufferColors = normalizedRows.map(row => [row.bufferColor]);
  const extraCells = normalizedRows.map(row => ({
    price: row.price,
    imageUrl: row.imageUrl,
    pickupDate: row.pickupDate,
    forceProductName: row.forceProductName === true
  }));

  await writeRowsToRawSheet_(startRow, sheetRows, bufferTexts, bufferColors, extraCells);

  return {
    ok: true,
    startRow,
    lastRow: startRow + sheetRows.length - 1,
    writtenLineCount: sheetRows.length,
    allyBufferLineCount: normalizedRows.filter(row => row.bufferText && !row.isSoldOutClosed && !row.isPastOrder).length,
    pastOrderLineCount: normalizedRows.filter(row => row.isPastOrder).length,
    soldOutClosedLineCount: normalizedRows.filter(row => row.isSoldOutClosed).length,
    customProductLineCount: normalizedRows.filter(row => findCustomProductMeta_(customProductMap, row.productName)).length,
    previousDayLineCount: normalizedRows.filter(row => row.isPreviousDayProduct).length
  };
}

async function searchIndexProductsForUi(payload) {
  const query = cleanCellText_(payload && payload.query || '');
  const records = await getIndexProductRecords_();
  const q = normalizeForHint_(query);
  const filtered = records
    .filter(record => !q || normalizeForHint_(record.productName).includes(q))
    .slice(0, 80);

  return { ok: true, count: filtered.length, items: filtered };
}

async function uploadKakaoCsvOriginal(payload) {
  try {
    if (!payload) return { ok: false, error: '업로드 데이터가 비어 있습니다.' };

    const dateStr = String(payload.dateStr || '').trim();
    const startTime = String(payload.startTime || CONFIG.DEFAULT_START_TIME || '').trim();
    const endDateStr = String(payload.endDateStr || '').trim();
    const endTime = String(payload.endTime || '').trim();
    const startAt = dateStr && startTime ? formatDateTimeText_(makeDateTime_(dateStr, startTime)) : '';
    const endAt = endDateStr && endTime ? formatDateTimeText_(makeDateTime_(endDateStr, endTime)) : '';

    const result = await ingestKakaoCsvUpload({
      fileContent: String(payload.fileContent || ''),
      fileName: String(payload.fileName || '').trim(),
      fileSize: payload.fileSize || '',
      mimeType: String(payload.mimeType || '').trim(),
      storeName: String(payload.storeName || CONFIG.STORE_NAME).trim(),
      orderDate: dateStr,
      startAt,
      endAt,
      uploadedAt: formatDateTimeText_(new Date()),
      source: 'vercel_order_collector'
    });

    return {
      ok: true,
      uploadId: result.uploadId || '',
      fileHash: result.fileHash || '',
      messageCount: result.messageCount || 0,
      matchedOrderCount: result.matchedOrderCount || 0,
      data: result
    };
  } catch (err) {
    console.warn('카톡 CSV 원본 업로드 실패:', err);
    return { ok: false, error: err.message };
  }
}

async function getIndexProductSnapshot_(options = {}) {
  const startedAt = Date.now();
  const includeMeta = options.includeMeta !== false;
  const recentRows = Number(options.recentRows || 0);
  const lastRow = await getIndexSheetLastRow_();

  if (lastRow < 1) {
    return {
      records: [],
      lastRow: 0,
      startRow: 1,
      rowCount: 0,
      includeMeta,
      recentRows,
      isRecentSnapshot: false,
      loadMs: Date.now() - startedAt
    };
  }

  const INDEX_PICKUP_COL = 6;
  const INDEX_PRICE_COL = 7;
  const INDEX_IMAGE_COL = 8;
  const maxCol = includeMeta
    ? Math.max(CONFIG.INDEX_PRODUCT_COL, INDEX_PICKUP_COL, INDEX_PRICE_COL, INDEX_IMAGE_COL)
    : Math.max(CONFIG.INDEX_DATE_COL, CONFIG.INDEX_PRODUCT_COL);
  const useRecent = recentRows > 0 && lastRow > recentRows;
  const startRow = useRecent ? lastRow - recentRows + 1 : 1;
  const rowCount = lastRow - startRow + 1;
  const values = await getSheetValues_(
    CONFIG.INDEX_SHEET_NAME,
    startRow,
    1,
    rowCount,
    maxCol,
    'FORMATTED_VALUE'
  );

  const records = [];
  let carriedDate = null;
  let carriedDateKey = '';

  values.forEach((row, idx) => {
    const dateDisplay = row[CONFIG.INDEX_DATE_COL - 1];

    if (dateDisplay !== '' && dateDisplay != null) {
      const parsedDate = tryParseSheetDate_(dateDisplay);
      if (parsedDate) {
        carriedDate = parsedDate;
        carriedDateKey = normalizeDateKey_(parsedDate);
      }
    }

    const productName = cleanCellText_(row[CONFIG.INDEX_PRODUCT_COL - 1]);

    if (!productName) return;
    if (/상품명|\(Indx\)/i.test(productName)) return;

    records.push({
      productName,
      pickupDate: includeMeta ? cleanCellText_(row[INDEX_PICKUP_COL - 1] || '') : '',
      price: includeMeta ? cleanCellText_(row[INDEX_PRICE_COL - 1] || '') : '',
      imageUrl: includeMeta ? cleanCellText_(row[INDEX_IMAGE_COL - 1] || '') : '',
      dateKey: carriedDateKey,
      dateText: carriedDate ? formatOrderDateText_(carriedDate) : '',
      rowNumber: startRow + idx
    });
  });

  return {
    records,
    lastRow,
    startRow,
    rowCount,
    includeMeta,
    recentRows,
    isRecentSnapshot: useRecent,
    loadMs: Date.now() - startedAt
  };
}

async function getIndexProductRecords_() {
  const snapshot = await getIndexProductSnapshot_({ includeMeta: true, recentRows: 0 });
  const latestByName = new Map();

  (snapshot.records || []).forEach(record => {
    const key = normalizeForHint_(record.productName);
    if (!key) return;

    const prev = latestByName.get(key);
    if (
      !prev ||
      String(record.dateKey || '') > String(prev.dateKey || '') ||
      (
        String(record.dateKey || '') === String(prev.dateKey || '') &&
        Number(record.rowNumber || 0) > Number(prev.rowNumber || 0)
      )
    ) {
      latestByName.set(key, record);
    }
  });

  return Array.from(latestByName.values())
    .sort((a, b) =>
      String(b.dateKey || '').localeCompare(String(a.dateKey || '')) ||
      a.productName.localeCompare(b.productName, 'ko')
    );
}

async function getIndexSheetLastRow_() {
  const cached = getCachedValue_('indexLastRow');
  if (cached) return cached;

  const sheets = await getSheetsClient_();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId_(),
    range: `'${escapeSheetName_(CONFIG.INDEX_SHEET_NAME)}'!A:H`,
    valueRenderOption: 'FORMATTED_VALUE',
    majorDimension: 'ROWS'
  });

  const values = response.data.values || [];
  let lastRow = values.length;
  while (lastRow > 0) {
    const row = values[lastRow - 1] || [];
    if (row.some(value => cleanCellText_(value))) break;
    lastRow -= 1;
  }

  putCachedValue_('indexLastRow', lastRow, 30);
  return lastRow;
}

async function getSheetValues_(sheetName, startRow, startCol, rowCount, colCount, valueRenderOption = 'FORMATTED_VALUE') {
  const sheets = await getSheetsClient_();
  const endRow = startRow + rowCount - 1;
  const endCol = startCol + colCount - 1;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId_(),
    range: `'${escapeSheetName_(sheetName)}'!${columnToLetter_(startCol)}${startRow}:${columnToLetter_(endCol)}${endRow}`,
    valueRenderOption,
    majorDimension: 'ROWS'
  });
  const values = response.data.values || [];

  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = values[rowIndex] || [];
    return Array.from({ length: colCount }, (_, colIndex) => row[colIndex] ?? '');
  });
}

async function writeRowsToRawSheet_(startRow, rows, bufferTexts, bufferColors, extraCells) {
  const sheets = await getSheetsClient_();
  const spreadsheetId = getSpreadsheetId_();
  const rowCount = rows.length;
  const endRow = startRow + rowCount - 1;
  const sheetInfo = await getSheetInfo_(CONFIG.RAW_SHEET_NAME);

  if (endRow > sheetInfo.rowCount) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId: sheetInfo.sheetId,
              dimension: 'ROWS',
              startIndex: sheetInfo.rowCount,
              endIndex: endRow
            },
            inheritFromBefore: true
          }
        }]
      }
    });
  }

  const data = [
    {
      range: `'${escapeSheetName_(CONFIG.RAW_SHEET_NAME)}'!D${startRow}:G${endRow}`,
      values: rows
    }
  ];

  if (bufferTexts?.length) {
    data.push({
      range: `'${escapeSheetName_(CONFIG.RAW_SHEET_NAME)}'!I${startRow}:I${endRow}`,
      values: bufferTexts
    });
  }

  const formulaTargets = [
    { col: 2, key: 'price' },
    { col: 3, key: 'imageUrl' },
    { col: 10, key: 'pickupDate' }
  ];

  for (const target of formulaTargets) {
    const template = await findNearestFormulaAbove_(CONFIG.RAW_SHEET_NAME, startRow, target.col);
    const targetValues = (extraCells || []).map((cell, index) => {
      const override = cleanCellText_(cell?.[target.key]);
      if (override) return [override];
      if (!template.formula) return [''];

      const rowNumber = startRow + index;
      return [shiftFormulaRows_(template.formula, rowNumber - template.rowNumber)];
    });

    if (targetValues.some(row => cleanCellText_(row[0]))) {
      data.push({
        range: `'${escapeSheetName_(CONFIG.RAW_SHEET_NAME)}'!${columnToLetter_(target.col)}${startRow}:${columnToLetter_(target.col)}${endRow}`,
        values: targetValues
      });
    }
  }

  const requests = [];

  (extraCells || []).forEach((cell, index) => {
    if (cell?.forceProductName === true) {
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetInfo.sheetId,
            startRowIndex: startRow + index - 1,
            endRowIndex: startRow + index,
            startColumnIndex: 5,
            endColumnIndex: 6
          },
          cell: { dataValidation: null },
          fields: 'dataValidation'
        }
      });
    }
  });

  if (bufferColors?.length) {
    bufferColors.forEach((row, index) => {
      const color = hexToRgb_(row?.[0] || '#000000');
      requests.push({
        repeatCell: {
          range: {
            sheetId: sheetInfo.sheetId,
            startRowIndex: startRow + index - 1,
            endRowIndex: startRow + index,
            startColumnIndex: CONFIG.RAW_BUFFER_COL - 1,
            endColumnIndex: CONFIG.RAW_BUFFER_COL
          },
          cell: {
            userEnteredFormat: {
              textFormat: {
                foregroundColor: color
              }
            }
          },
          fields: 'userEnteredFormat.textFormat.foregroundColor'
        }
      });
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests }
    });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data
    }
  });
}

async function findNearestFormulaAbove_(sheetName, startRow, col) {
  const lookback = Math.min(300, Math.max(0, startRow - 1));
  if (!lookback) return { formula: '', rowNumber: 0 };

  const fromRow = startRow - lookback;
  const values = await getSheetValues_(
    sheetName,
    fromRow,
    col,
    lookback,
    1,
    'FORMULA'
  );

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const formula = String(values[i]?.[0] || '').trim();
    if (formula.startsWith('=')) {
      return {
        formula,
        rowNumber: fromRow + i
      };
    }
  }

  return { formula: '', rowNumber: 0 };
}

function shiftFormulaRows_(formula, rowOffset) {
  const source = String(formula || '');
  const offset = Number(rowOffset) || 0;
  if (!source || !offset) return source;

  let result = '';
  let chunk = '';
  let inString = false;

  function flushChunk() {
    if (!chunk) return;
    result += shiftFormulaRowsInChunk_(chunk, offset);
    chunk = '';
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === '"') {
      if (inString) {
        result += ch;
        if (source[i + 1] === '"') {
          result += source[i + 1];
          i += 1;
          continue;
        }
        inString = false;
        continue;
      }

      flushChunk();
      result += ch;
      inString = true;
      continue;
    }

    if (inString) {
      result += ch;
    } else {
      chunk += ch;
    }
  }

  flushChunk();
  return result;
}

function shiftFormulaRowsInChunk_(chunk, rowOffset) {
  return String(chunk || '').replace(
    /(^|[^A-Za-z0-9_.$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)\b/g,
    (match, prefix, colAbs, colLetters, rowAbs, rowNumberText) => {
      if (rowAbs === '$') return match;

      const rowNumber = Number(rowNumberText);
      if (!Number.isFinite(rowNumber) || rowNumber < 1) return match;

      const nextRow = Math.max(1, rowNumber + rowOffset);
      return `${prefix}${colAbs}${colLetters}${rowAbs}${nextRow}`;
    }
  );
}

async function getSheetInfo_(sheetName) {
  const sheets = await getSheetsClient_();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId_(),
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'
  });
  const sheet = (response.data.sheets || []).find(item => item.properties?.title === sheetName);
  if (!sheet) throw new Error(`${sheetName} 시트를 찾지 못했습니다.`);

  return {
    sheetId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties?.rowCount || 0,
    columnCount: sheet.properties.gridProperties?.columnCount || 0
  };
}

function getProductNamesFromSnapshotForDateKeys_(snapshot, targetKeys) {
  const targetSet = new Set(targetKeys || []);
  if (!targetSet.size) return [];

  const products = [];
  const seen = new Set();

  (snapshot?.records || []).forEach(record => {
    if (!targetSet.has(record.dateKey)) return;

    const productName = cleanCellText_(record.productName);
    if (!productName || seen.has(productName)) return;

    seen.add(productName);
    products.push(productName);
  });

  return products;
}

function getLatestProductRecordsFromSnapshotForDateKeys_(snapshot, targetKeys) {
  const targetSet = new Set(targetKeys || []);
  if (!targetSet.size) return [];

  const latestByName = new Map();

  (snapshot?.records || []).forEach(record => {
    if (!targetSet.has(record.dateKey)) return;

    const productName = cleanCellText_(record.productName);
    const key = normalizeForHint_(productName);
    if (!key) return;

    const prev = latestByName.get(key);
    if (
      !prev ||
      String(record.dateKey || '') > String(prev.dateKey || '') ||
      (
        String(record.dateKey || '') === String(prev.dateKey || '') &&
        Number(record.rowNumber || 0) > Number(prev.rowNumber || 0)
      )
    ) {
      latestByName.set(key, {
        productName,
        pickupDate: cleanCellText_(record.pickupDate || ''),
        price: cleanCellText_(record.price || ''),
        imageUrl: cleanCellText_(record.imageUrl || ''),
        dateKey: record.dateKey || '',
        dateText: record.dateText || '',
        rowNumber: record.rowNumber || 0
      });
    }
  });

  return Array.from(latestByName.values())
    .sort((a, b) =>
      String(a.dateKey || '').localeCompare(String(b.dateKey || '')) ||
      a.productName.localeCompare(b.productName, 'ko')
    );
}

function getPreviousDayProductRecordsFromSnapshot_(snapshot, dateStr, holidayStartStr, holidayEndStr, currentProductNames) {
  const previousDateKey = getPreviousDateKey_(dateStr);
  if (!previousDateKey) return [];

  const currentSet = new Set(
    (currentProductNames || [])
      .map(normalizeForHint_)
      .filter(Boolean)
  );
  const targetKeys = getValidProductDateKeysForOrderDate_(previousDateKey, holidayStartStr, holidayEndStr);
  const records = getLatestProductRecordsFromSnapshotForDateKeys_(snapshot, targetKeys);

  return records.filter(record => {
    const key = normalizeForHint_(record.productName);
    return key && !currentSet.has(key);
  });
}

function getValidProductDateKeysForOrderDate_(dateStr, holidayStartStr, holidayEndStr) {
  const targetDate = parseInputDate_(dateStr);

  if (!isWeekendOrConfiguredHoliday_(targetDate, holidayStartStr, holidayEndStr)) {
    return [normalizeDateKey_(targetDate)];
  }

  let blockStart = targetDate;
  while (true) {
    const prev = addDays_(blockStart, -1);
    if (!isWeekendOrConfiguredHoliday_(prev, holidayStartStr, holidayEndStr)) break;
    blockStart = prev;
  }

  const includeStart = addDays_(blockStart, -1);
  const validDates = [];
  let cursor = includeStart;

  while (cursor.getTime() <= targetDate.getTime()) {
    validDates.push(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate()));
    cursor = addDays_(cursor, 1);
  }

  return validDates.map(normalizeDateKey_);
}

function isWeekendOrConfiguredHoliday_(date, holidayStartStr, holidayEndStr) {
  const day = date.getDay();
  if (day === 0 || day === 6) return true;
  return isConfiguredHoliday_(date, holidayStartStr, holidayEndStr);
}

function isConfiguredHoliday_(date, holidayStartStr, holidayEndStr) {
  const range = normalizeHolidayRange_(holidayStartStr, holidayEndStr);
  if (!range.startKey || !range.endKey) return false;

  const key = normalizeDateKey_(date);
  return key >= range.startKey && key <= range.endKey;
}

function normalizeHolidayRange_(holidayStartStr, holidayEndStr) {
  const startRaw = String(holidayStartStr || '').trim();
  const endRaw = String(holidayEndStr || '').trim();

  if (!startRaw) return { startKey: '', endKey: '' };

  const start = parseInputDate_(startRaw);
  const end = endRaw ? parseInputDate_(endRaw) : parseInputDate_(startRaw);
  let startKey = normalizeDateKey_(start);
  let endKey = normalizeDateKey_(end);

  if (endKey < startKey) {
    [startKey, endKey] = [endKey, startKey];
  }

  return { startKey, endKey };
}

function validatePayloadForPrepare_(payload) {
  if (!payload) throw new Error('요청 데이터가 비어 있습니다.');
  if (!payload.dateStr) throw new Error('공구날짜를 입력해주세요.');
  if (!payload.startRow || Number(payload.startRow) < 1) throw new Error('Raw_주문입력 시작 행을 1 이상의 숫자로 입력해주세요.');
  if (!payload.csvText) throw new Error('CSV 파일 내용이 비어 있습니다.');
  if (!getOpenAIKey_()) throw new Error('OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.');
}

function parseCsvText_(csvText) {
  const cleaned = String(csvText || '').replace(/^\uFEFF/, '');
  if (!cleaned.trim()) throw new Error('업로드한 파일 내용이 비어 있습니다.');

  if (looksLikeKakaoTxt_(cleaned)) {
    const kakaoRows = parseKakaoTxtText_(cleaned);
    if (!kakaoRows.length) {
      throw new Error('카카오톡 TXT 파일로 보이지만 메시지를 읽지 못했습니다. 파일 형식을 확인해주세요.');
    }
    return kakaoRows;
  }

  let rows = parseDelimitedText_(cleaned, ',');

  if (rows.length && rows[0].length === 1 && rows[0][0].includes('\t')) {
    rows = parseDelimitedText_(cleaned, '\t');
  }

  if (!rows.length) throw new Error('CSV를 읽지 못했습니다.');

  const header = rows[0].map(value => String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase());
  const dateIdx = findHeaderIndex_(header, ['date', 'datetime', '일시', '날짜']);
  const userIdx = findHeaderIndex_(header, ['user', 'sender', 'name', '사용자', '고객명', '닉네임']);
  const msgIdx = findHeaderIndex_(header, ['message', 'text', 'content', '메시지', '내용']);

  if (dateIdx < 0 || userIdx < 0 || msgIdx < 0) {
    const kakaoRows = parseKakaoTxtText_(cleaned);
    if (kakaoRows.length) return kakaoRows;

    throw new Error(
      'CSV 헤더에서 Date, User, Message 열을 찾지 못했습니다.\n' +
      'CSV는 Date/User/Message 헤더가 필요하고, 카카오톡 TXT는 "[닉네임] [오전 8:10] 메시지" 형식이어야 합니다.'
    );
  }

  return rows.slice(1).map((row, index) => ({
    rowNumber: index + 2,
    dateRaw: String(row[dateIdx] || '').trim(),
    user: String(row[userIdx] || '').trim(),
    message: String(row[msgIdx] || '').trim()
  })).filter(row => row.dateRaw || row.user || row.message);
}

function parseDelimitedText_(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows.filter(item => item.some(value => String(value || '').trim()));
}

function looksLikeKakaoTxt_(text) {
  const sample = String(text || '').slice(0, 20000);
  if (/^-{5,}\s*\d{4}년\s*\d{1,2}월\s*\d{1,2}일/m.test(sample)) return true;
  if (/\[[^\]\n]{1,80}\]\s+\[(오전|오후|AM|PM)\s*\d{1,2}:\d{2}/i.test(sample)) return true;
  if (/카카오톡 대화|저장한 날짜\s*:/.test(sample)) return true;
  return false;
}

function parseKakaoTxtText_(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const rows = [];
  let currentDate = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    current.message = String(current.message || '').trim();
    if (current.dateRaw || current.user || current.message) rows.push(current);
    current = null;
  };

  lines.forEach((line, idx) => {
    const rawLine = String(line || '');
    const dateMatch = rawLine.match(/^-{5,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s+[^\-]+)?\s*-{5,}\s*$/);
    if (dateMatch) {
      flush();
      currentDate = { y: Number(dateMatch[1]), m: Number(dateMatch[2]), d: Number(dateMatch[3]) };
      return;
    }

    const msgMatch = rawLine.match(/^\[([^\]]+)\]\s+\[(오전|오후|AM|PM)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s?(.*)$/i);
    if (msgMatch && currentDate) {
      flush();
      const ss = msgMatch[5] || '00';
      current = {
        rowNumber: idx + 1,
        dateRaw: `${currentDate.y}. ${currentDate.m}. ${currentDate.d} ${msgMatch[2]} ${msgMatch[3]}:${msgMatch[4]}${ss !== '00' ? `:${ss}` : ''}`,
        user: String(msgMatch[1] || '').trim(),
        message: String(msgMatch[6] || '').trim()
      };
      return;
    }

    if (current) {
      if (/^만만마켓.*카카오톡 대화$/.test(rawLine)) return;
      if (/^저장한 날짜\s*:/.test(rawLine)) return;
      current.message += (current.message ? '\n' : '') + rawLine;
    }
  });

  flush();
  return rows.filter(row => row.dateRaw && row.user && row.message);
}

function filterMessagesFromCsv_(rows, startDateTime, endDateTime) {
  const filtered = [];
  rows.forEach((row, idx) => {
    const dt = parseKakaoDate_(row.dateRaw);
    if (!dt) return;
    if (dt.getTime() < startDateTime.getTime()) return;
    if (endDateTime && dt.getTime() > endDateTime.getTime()) return;
    if (isHardExcludedMessage_(row)) return;

    filtered.push({
      sourceIndex: idx + 1,
      csvRowNumber: row.rowNumber,
      dateRaw: row.dateRaw,
      dateIso: formatDateTimeText_(dt),
      user: row.user,
      message: row.message
    });
  });
  return filtered;
}

function isHardExcludedMessage_(row) {
  const msg = String(row.message || '').trim();
  const user = String(row.user || '').trim();

  if (!msg) return true;
  if (/오픈채팅봇|카카오톡|kakaotalk/i.test(user)) return true;
  if (/님이\s*(들어왔습니다|나갔습니다)/.test(msg)) return true;
  if (/메시지가 삭제되었습니다|관리자가 메시지를 가렸습니다/.test(msg)) return true;
  if (/^사진\s*\d+\s*장$/.test(msg)) return true;
  if (/^동영상\s*\d+\s*개$/.test(msg)) return true;
  return false;
}

async function callOpenAIParser_(params) {
  const schema = buildParserSchema_(params.productNames);
  const prompt = buildParserPrompt_(params);

  return callOpenAIJson_({
    schemaName: 'order_parse_result',
    schema,
    developerContent: '너는 카카오톡 공동구매 주문 CSV를 분석하는 주문 집계 엔진이다. 반드시 제공된 JSON Schema에 맞는 JSON만 출력한다. 임의 상품명 생성은 금지한다. 확인필요 후보도 마지막으로 한 번 더 검토해서, productNames 중 정식 상품명과 정말 정확히 매칭된다고 확신할 때만 finalReviewDecision을 promote_to_order로 둔다. 조금이라도 애매하면 keep_needs_check다.',
    prompt,
    maxOutputTokens: 10000
  });
}

function buildParserPrompt_(params) {
  return JSON.stringify({
    task: '카카오톡 공동구매 주문 메시지를 분석해 주문 후보를 시간순으로 추출한다.',
    chunkInfo: {
      chunkIndex: params.chunkIndex + 1,
      totalChunks: params.totalChunks
    },
    orderDateTextToWriteInRawColumnD: params.orderDateText,
    strictRules: [
      'messages 배열의 원본 순서를 반드시 유지한다.',
      '실제 고객 주문 또는 주문 후보만 추출한다.',
      '전농래미안크레시티점 부점장, 전농래미안크레시티점 점장, 점장, 부점장, 운영자, 관리자 메시지는 ignore 처리한다.',
      '상품명과 수량이 함께 있는 고객 메시지는 주문으로 본다.',
      '상품명만 있고 수량이 없지만 명백한 주문이면 수량 1로 본다.',
      '한 메시지에 여러 상품이 있으면 상품별로 items 또는 unmatchedItems를 나눈다.',
      '상품명이 productNames 배열에 있는 정식 상품명으로 확실히 매칭되면 eventType add + items에 넣는다.',
      '상품명이 애매하거나 상품리스트에 없으면 eventType needs_check로 두고 unmatchedItems에 rawName, quantity, suggestedProductName, suggestionConfidence, finalReviewDecision, reason을 반드시 넣는다.',
      'needs_check도 마지막으로 productNames 전체와 비교하고, 확실히 같으면 finalReviewDecision=promote_to_order로 둔다.',
      '옵션/맛/종류가 애매하면 keep_needs_check다.',
      '상품 설명의 숫자, g/ml/kg/개입/가격/날짜 숫자는 주문 수량으로 세지 않는다.',
      '총주문/총수량 표현은 기존 주문을 대체하지 않는다.',
      '정정/취소/변경은 임의 삭제하지 말고 needs_check 또는 cancel로 둔다.',
      'productName은 productNames 배열 안에 있는 값과 완전히 동일해야 한다.',
      'previousDayProductNames는 오늘 상품은 아니지만 하루 전 공구상품으로, 고객 주문에서 명확하면 정식 후보처럼 매칭한다.'
    ],
    eventTypeGuide: {
      add: '정식 상품명으로 확실히 매칭된 일반 주문',
      needs_check: '상품명/수량/의도/날짜/맛 구분이 애매하지만 주문 가능성이 있는 메시지',
      cancel: '취소/삭제/빼주세요 성격의 메시지',
      ignore: '운영자 공지, 상품 설명, 픽업 안내, 문의, 후기, 잡담, 입퇴장, 삭제 메시지',
      set_total: '사용하지 않는다',
      replace: '사용하지 않는다'
    },
    productNames: params.productNames,
    previousDayProductNames: params.previousDayProductNames || [],
    previousStateForUsers: params.previousStateForUsers || {},
    soldOutProductsSoFar: params.soldOutProducts,
    messages: params.chunk
  });
}

function buildParserSchema_(productNames) {
  const productEnum = productNames;
  const itemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['productName', 'quantity', 'rawExpression', 'confidence'],
    properties: {
      productName: { type: 'string', enum: productEnum },
      quantity: { type: 'integer', minimum: 1 },
      rawExpression: { type: 'string' },
      confidence: { type: 'number' }
    }
  };
  const cancelItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['productName', 'quantity', 'rawExpression', 'confidence'],
    properties: {
      productName: { type: 'string' },
      quantity: { type: 'integer', minimum: 0 },
      rawExpression: { type: 'string' },
      confidence: { type: 'number' }
    }
  };
  const unmatchedItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['rawName', 'quantity', 'suggestedProductName', 'suggestionConfidence', 'finalReviewDecision', 'reason'],
    properties: {
      rawName: { type: 'string' },
      quantity: { type: 'integer', minimum: 0 },
      suggestedProductName: { type: 'string' },
      suggestionConfidence: { type: 'number', minimum: 0, maximum: 1 },
      finalReviewDecision: { type: 'string', enum: ['promote_to_order', 'keep_needs_check'] },
      reason: { type: 'string' }
    }
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['events', 'soldOutNotices', 'chunkNotes'],
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceIndex',
            'csvRowNumber',
            'dateRaw',
            'user',
            'message',
            'eventType',
            'items',
            'cancelItems',
            'unmatchedItems',
            'soldOutPossible',
            'needsCheckReason',
            'notes'
          ],
          properties: {
            sourceIndex: { type: 'integer' },
            csvRowNumber: { type: 'integer' },
            dateRaw: { type: 'string' },
            user: { type: 'string' },
            message: { type: 'string' },
            eventType: { type: 'string', enum: ['add', 'set_total', 'replace', 'cancel', 'ignore', 'needs_check'] },
            items: { type: 'array', items: itemSchema },
            cancelItems: { type: 'array', items: cancelItemSchema },
            unmatchedItems: { type: 'array', items: unmatchedItemSchema },
            soldOutPossible: { type: 'boolean' },
            needsCheckReason: { type: 'string' },
            notes: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      soldOutNotices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceIndex', 'productName', 'rawText'],
          properties: {
            sourceIndex: { type: 'integer' },
            productName: { type: 'string' },
            rawText: { type: 'string' }
          }
        }
      },
      chunkNotes: { type: 'array', items: { type: 'string' } }
    }
  };
}

function applyAiResultToState_(params) {
  const { aiResult, state, report, productNames, orderDateText, soldOutProducts, manualSoldOutRules } = params;
  const productSet = new Set(productNames);
  const soldOutRules = manualSoldOutRules || [];

  (aiResult.soldOutNotices || []).forEach(notice => {
    if (notice.productName && productSet.has(notice.productName) && !soldOutProducts.includes(notice.productName)) {
      soldOutProducts.push(notice.productName);
    }
    report.soldOutNotices.push(notice);
  });

  (aiResult.chunkNotes || []).forEach(note => report.chunkNotes.push(note));

  (aiResult.events || []).forEach(originalEvent => {
    const event = normalizeAiEventType_(originalEvent);

    if (event.soldOutPossible) {
      report.soldOutPossibleOrders.push({
        sourceIndex: event.sourceIndex,
        csvRowNumber: event.csvRowNumber,
        dateRaw: event.dateRaw,
        user: event.user,
        message: event.message,
        items: event.items || [],
        unmatchedItems: event.unmatchedItems || [],
        reason: event.needsCheckReason || '품절 이후 주문 가능성'
      });
    }

    if (event.eventType === 'ignore') return;

    const split = splitAiReviewedUnmatchedItems_(event, productSet);

    if (split.promotedItems.length) {
      const promotedBySoldOut = splitItemsByManualSoldOut_(event, split.promotedItems, soldOutRules);

      if (promotedBySoldOut.allowedItems.length) {
        addItemsToState_(state, {
          ...event,
          eventType: 'add',
          items: promotedBySoldOut.allowedItems,
          unmatchedItems: [],
          notes: (event.notes || []).concat(['AI finalReviewDecision=promote_to_order로 확인필요 후보를 주문 후보로 승격'])
        }, orderDateText, productSet);
      }

      if (promotedBySoldOut.soldOutItems.length) {
        report.needsCheck.push(makeEventReport_({
          ...event,
          eventType: 'needs_check',
          items: promotedBySoldOut.soldOutItems,
          cancelItems: [],
          unmatchedItems: [],
          needsCheckReason: '품절마감 이후 들어온 주문'
        }, '품절마감 이후 들어온 주문'));
      }
    }

    if (event.eventType === 'cancel') {
      const reportEvent = { ...event, unmatchedItems: split.remainingUnmatchedItems };
      report.needsCheck.push(makeEventReport_(reportEvent, '취소/차감 메시지 확인 필요'));
      report.correctionLogs.push(makeEventReport_(reportEvent, '취소/차감 메시지 확인 필요'));
      return;
    }

    if (event.eventType === 'needs_check') {
      if (split.remainingUnmatchedItems.length || !split.promotedItems.length) {
        report.needsCheck.push(makeEventReport_({
          ...event,
          unmatchedItems: split.remainingUnmatchedItems
        }, split.promotedItems.length ? '일부 항목은 AI 주문 후보로 승격, 남은 항목 확인 필요' : '사람 확인 필요'));
      }
      return;
    }

    if (event.eventType === 'add') {
      const addBySoldOut = splitItemsByManualSoldOut_(event, event.items || [], soldOutRules);

      if (addBySoldOut.allowedItems.length) {
        addItemsToState_(state, { ...event, items: addBySoldOut.allowedItems }, orderDateText, productSet);
      }

      if (addBySoldOut.soldOutItems.length) {
        report.needsCheck.push(makeEventReport_({
          ...event,
          eventType: 'needs_check',
          items: addBySoldOut.soldOutItems,
          cancelItems: [],
          unmatchedItems: [],
          needsCheckReason: '품절마감 이후 들어온 주문'
        }, '품절마감 이후 들어온 주문'));
      }

      if (split.remainingUnmatchedItems.length) {
        report.needsCheck.push(makeEventReport_({
          ...event,
          eventType: 'needs_check',
          items: [],
          cancelItems: [],
          unmatchedItems: split.remainingUnmatchedItems,
          needsCheckReason: event.needsCheckReason || '일부 상품명 매칭 확인 필요'
        }, '일부 상품명 매칭 확인 필요'));
      }
      return;
    }

    report.needsCheck.push(makeEventReport_(event, '알 수 없는 eventType'));
  });
}

function normalizeAiEventType_(event) {
  if (event.eventType === 'set_total' || event.eventType === 'replace') {
    event.eventType = 'add';
    event.notes = event.notes || [];
    event.notes.push('set_total/replace는 사용하지 않으므로 add로 보정');
  }

  if (/전농래미안크레시티점\s*(부점장|점장)|부점장|점장|운영자|관리자/.test(String(event.user || ''))) {
    event.eventType = 'ignore';
    event.items = [];
    event.cancelItems = [];
    event.unmatchedItems = [];
    event.notes = event.notes || [];
    event.notes.push('운영자/점장/부점장 메시지 제외');
  }

  return event;
}

function splitAiReviewedUnmatchedItems_(event, productSet) {
  const promotedItems = [];
  const remainingUnmatchedItems = [];

  (event.unmatchedItems || []).forEach(item => {
    const suggestedProductName = cleanCellText_(item.suggestedProductName || '');
    const confidence = Number(item.suggestionConfidence || 0);
    const decision = String(item.finalReviewDecision || '');
    const quantity = Number(item.quantity || 0);

    const shouldPromote =
      decision === 'promote_to_order' &&
      suggestedProductName &&
      productSet.has(suggestedProductName) &&
      confidence >= 0.92 &&
      quantity > 0;

    if (shouldPromote) {
      promotedItems.push({
        productName: suggestedProductName,
        quantity,
        rawExpression: item.rawName || event.message || '',
        confidence
      });
    } else {
      remainingUnmatchedItems.push(item);
    }
  });

  return { promotedItems, remainingUnmatchedItems };
}

function normalizeSoldOutRules_(rules) {
  const normalized = [];
  (rules || []).forEach((rule, idx) => {
    const productName = cleanCellText_(rule.productName);
    const cutoffRaw = cleanCellText_(rule.cutoffDateTime || rule.cutoff || '');
    if (!productName || !cutoffRaw) return;

    const cutoffDate = parseSoldOutCutoffDate_(cutoffRaw);
    if (!cutoffDate) return;

    normalized.push({
      id: cleanCellText_(rule.id || `soldout_${idx}`),
      productName,
      cutoffDateTime: cutoffRaw,
      cutoffMs: cutoffDate.getTime()
    });
  });
  return normalized;
}

function parseSoldOutCutoffDate_(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  }

  match = raw.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  }

  return null;
}

function splitItemsByManualSoldOut_(event, items, soldOutRules) {
  const activeRules = soldOutRules || [];
  if (!activeRules.length || !(items || []).length) {
    return { allowedItems: items || [], soldOutItems: [] };
  }

  const eventDate = parseKakaoDate_(event.dateRaw);
  if (!eventDate) return { allowedItems: items || [], soldOutItems: [] };

  const eventMs = eventDate.getTime();
  const allowedItems = [];
  const soldOutItems = [];

  (items || []).forEach(item => {
    const rule = activeRules.find(r => r.productName === item.productName && eventMs >= r.cutoffMs);
    if (rule) {
      soldOutItems.push({ ...item, soldOutCutoffDateTime: rule.cutoffDateTime });
    } else {
      allowedItems.push(item);
    }
  });

  return { allowedItems, soldOutItems };
}

function addItemsToState_(state, event, orderDateText, productSet) {
  (event.items || []).forEach((item, itemIndex) => {
    if (!productSet.has(item.productName)) return;
    if (!item.quantity || item.quantity < 1) return;

    const lineKey = makeOrderLineKey_(event, item, itemIndex);
    state.set(lineKey, {
      lineKey,
      customer: event.user,
      productName: item.productName,
      quantity: Number(item.quantity),
      firstSourceIndex: event.sourceIndex,
      sourceIndexes: [event.sourceIndex],
      csvRowNumber: event.csvRowNumber,
      dateRaw: event.dateRaw,
      dateIso: event.dateIso || '',
      message: event.message || '',
      rawExpression: item.rawExpression || '',
      orderDateText
    });
  });
}

function makeOrderLineKey_(event, item, itemIndex) {
  return [
    event.sourceIndex || '',
    event.csvRowNumber || '',
    event.user || '',
    item.productName || '',
    item.rawExpression || '',
    itemIndex
  ].join('|||');
}

function stateRowsToMap_(stateRows) {
  const map = new Map();
  (stateRows || []).forEach((row, idx) => {
    if (!row || !row.customer || !row.productName) return;
    const lineKey = row.lineKey || [
      row.firstSourceIndex || '',
      row.csvRowNumber || '',
      row.customer || '',
      row.productName || '',
      row.rawExpression || '',
      idx
    ].join('|||');

    map.set(lineKey, {
      lineKey,
      customer: row.customer,
      productName: row.productName,
      quantity: Number(row.quantity) || 0,
      firstSourceIndex: Number(row.firstSourceIndex) || 999999999,
      sourceIndexes: row.sourceIndexes || [],
      csvRowNumber: row.csvRowNumber || '',
      dateRaw: row.dateRaw || '',
      dateIso: row.dateIso || '',
      message: row.message || '',
      rawExpression: row.rawExpression || '',
      orderDateText: row.orderDateText || ''
    });
  });
  return map;
}

function mapToStateRows_(state) {
  return Array.from(state.values())
    .filter(row => row.quantity > 0)
    .sort((a, b) => Number(a.firstSourceIndex || 0) - Number(b.firstSourceIndex || 0));
}

function buildStateSummaryForUsers_(state, users) {
  const userSet = new Set(users || []);
  const byUser = {};
  state.forEach(row => {
    if (!userSet.has(row.customer)) return;
    if (!byUser[row.customer]) byUser[row.customer] = [];
    byUser[row.customer].push({ productName: row.productName, quantity: row.quantity });
  });
  return byUser;
}

async function enrichPastOrderRowsWithAI_(dateStr, rows, productSet, options = {}) {
  const clonedRows = (rows || []).map(row => ({ ...row }));
  const knownProductSet = productSet || new Set();
  const previousDayProductRecords = Array.isArray(options.previousDayProductRecords) ? options.previousDayProductRecords : [];
  const previousDayProductMap = makeProductRecordMapByName_(previousDayProductRecords);
  const previousDayProductNameSet = options.previousDayProductNameSet ||
    new Set(previousDayProductRecords.map(record => normalizeForHint_(record.productName)).filter(Boolean));
  const targets = [];

  clonedRows.forEach((row, idx) => {
    const action = cleanCellText_(row.action || '');
    const isPast = action === 'past_order' || row.allowBlankProduct === true;
    if (!isPast) return;
    if (row.pastOrderAiChecked === true || row.pastOrderFastResolved === true || cleanCellText_(row.pastOrderMemo || '')) return;

    const manualProductNameRaw = cleanCellText_(row.manualProductName || '');
    const selectedProductName = cleanCellText_(row.productName || '');
    const selectedKey = normalizeForHint_(selectedProductName);

    if (!manualProductNameRaw && selectedKey && previousDayProductNameSet.has(selectedKey)) {
      const record = findProductRecordByName_(previousDayProductMap, selectedProductName);
      const label = record?.dateText || (record?.dateKey ? formatShortKoreanDate_(parseInputDate_(record.dateKey)) : '하루전');
      const rawRef = cleanCellText_(row.rawName || row.rawExpression || row.message || '');
      const memoParts = [`${label}공구상품`, '하루전공구 자동후보', `선택상품:"${truncateForMemo_(selectedProductName, 80)}"`];
      if (rawRef) memoParts.push(`원문:"${truncateForMemo_(rawRef, 80)}"`);
      clonedRows[idx].productName = selectedProductName;
      clonedRows[idx].pastOrderAiChecked = false;
      clonedRows[idx].pastOrderAiMatched = false;
      clonedRows[idx].pastOrderFastResolved = true;
      clonedRows[idx].pastOrderMemo = memoParts.join(' / ');
      return;
    }

    targets.push({ row, idx });
  });

  if (!targets.length) return clonedRows;

  const catalog = await getPastOrderProductCatalog_(dateStr, 5);
  if (!catalog.length) {
    targets.forEach(target => applyManualOrSelectedPastOrderFallback_(clonedRows, target.idx, knownProductSet, '최근 5일 공구상품 목록 없음'));
    return clonedRows;
  }

  const catalogProductSet = new Set(catalog.map(item => cleanCellText_(item.productName)).filter(Boolean));
  const catalogByName = new Map();
  catalog.forEach(item => {
    const key = normalizeForHint_(item.productName);
    if (!key) return;
    const list = catalogByName.get(key) || [];
    list.push(item);
    catalogByName.set(key, list);
  });

  const aiTargets = [];
  targets.forEach(target => {
    const manualProductNameRaw = cleanCellText_(target.row.manualProductName || '');
    const selectedProductName = cleanCellText_(target.row.productName || '');
    const manualSplit = splitManualProductNameAndQuantity_(manualProductNameRaw, catalogProductSet);
    const candidateName = cleanCellText_(manualSplit.productName || manualProductNameRaw || selectedProductName);
    const exactMatches = candidateName ? (catalogByName.get(normalizeForHint_(candidateName)) || []) : [];

    if (candidateName && exactMatches.length === 1) {
      const found = exactMatches[0];
      const rawRef = cleanCellText_(target.row.rawName || target.row.rawExpression || target.row.message || '');
      const memoParts = [`${found.dateLabel}공구상품으로추정`, '정확상품명 빠른매칭'];
      if (manualProductNameRaw) memoParts.push(`수기입력:"${truncateForMemo_(manualProductNameRaw, 80)}"`);
      if (selectedProductName && selectedProductName !== manualProductNameRaw) memoParts.push(`선택상품:"${truncateForMemo_(selectedProductName, 80)}"`);
      if (rawRef) memoParts.push(`원문:"${truncateForMemo_(rawRef, 80)}"`);
      clonedRows[target.idx].productName = found.productName;
      if (manualSplit.quantity) clonedRows[target.idx].quantity = manualSplit.quantity;
      clonedRows[target.idx].pastOrderAiChecked = false;
      clonedRows[target.idx].pastOrderAiMatched = true;
      clonedRows[target.idx].pastOrderFastResolved = true;
      clonedRows[target.idx].pastOrderMemo = memoParts.join(' / ');
      return;
    }

    aiTargets.push(target);
  });

  if (!aiTargets.length) return clonedRows;

  const candidates = aiTargets.map(target => ({
    rowIndex: target.idx,
    customer: cleanCellText_(target.row.customer),
    dateRaw: cleanCellText_(target.row.dateRaw),
    csvRowNumber: cleanCellText_(target.row.csvRowNumber),
    rawName: cleanCellText_(target.row.rawName || target.row.rawExpression || target.row.message || ''),
    message: cleanCellText_(target.row.message || ''),
    manualProductName: cleanCellText_(target.row.manualProductName || ''),
    selectedProductName: cleanCellText_(target.row.productName || ''),
    quantity: Number(target.row.quantity) || 1
  }));
  const decisions = await reviewPastOrderRowsWithAIInBatches_(catalog, candidates, 20);
  const byIndex = new Map((decisions || []).map(decision => [Number(decision.rowIndex), decision]));

  aiTargets.forEach(target => {
    const decision = byIndex.get(target.idx);
    const matchedProductName = cleanCellText_(decision?.productName);
    const matchedDateKey = cleanCellText_(decision?.dateKey);
    const confidence = Number(decision?.confidence || 0);

    if (decision?.decision === 'matched' && matchedProductName && matchedDateKey && confidence >= 0.86) {
      const found = catalog.find(item => item.productName === matchedProductName && item.dateKey === matchedDateKey);
      const dateLabel = found ? found.dateLabel : matchedDateKey;
      const manualRef = cleanCellText_(target.row.manualProductName || '');
      const rawRef = cleanCellText_(target.row.rawName || target.row.rawExpression || target.row.message || '');
      const memoParts = [`${dateLabel}공구상품으로추정`];
      if (manualRef) memoParts.push(`수기입력:"${truncateForMemo_(manualRef, 80)}"`);
      if (rawRef) memoParts.push(`원문:"${truncateForMemo_(rawRef, 80)}"`);
      clonedRows[target.idx].productName = matchedProductName;
      clonedRows[target.idx].pastOrderAiChecked = true;
      clonedRows[target.idx].pastOrderAiMatched = true;
      clonedRows[target.idx].pastOrderFastResolved = false;
      clonedRows[target.idx].pastOrderMemo = memoParts.join(' / ');
      return;
    }

    applyManualOrSelectedPastOrderFallback_(clonedRows, target.idx, knownProductSet, decision ? `AI확인불가:${cleanCellText_(decision.reason || 'unmatched')}` : 'AI응답없음');
  });

  return clonedRows;
}

function applyManualOrSelectedPastOrderFallback_(rows, idx, productSet, note) {
  const row = rows[idx] || {};
  const knownSet = productSet || new Set();
  const manualProductNameRaw = cleanCellText_(row.manualProductName || '');
  const selectedProductName = cleanCellText_(row.productName || '');
  const baseProductName = manualProductNameRaw || selectedProductName;
  const rawRef = cleanCellText_(row.rawName || row.rawExpression || row.message || '');

  rows[idx].pastOrderAiChecked = true;
  rows[idx].pastOrderAiMatched = false;

  if (baseProductName) {
    const split = splitManualProductNameAndQuantity_(baseProductName, knownSet);
    rows[idx].productName = split.productName || baseProductName;
    if (split.quantity) rows[idx].quantity = split.quantity;
  }

  const memoParts = [note || '지난공구주문'];
  if (manualProductNameRaw) memoParts.push(`수기입력:"${truncateForMemo_(manualProductNameRaw, 80)}"`);
  if (selectedProductName && selectedProductName !== manualProductNameRaw) memoParts.push(`선택상품:"${truncateForMemo_(selectedProductName, 80)}"`);
  if (rawRef) memoParts.push(`원문:"${truncateForMemo_(rawRef, 80)}"`);
  rows[idx].pastOrderMemo = memoParts.join(' / ');
}

async function getPastOrderProductCatalog_(dateStr, daysBack) {
  const baseDate = parseInputDate_(dateStr);
  const dateKeys = [];
  for (let i = 1; i <= Number(daysBack || 5); i += 1) {
    dateKeys.push(normalizeDateKey_(addDays_(baseDate, -i)));
  }

  const lastRow = await getIndexSheetLastRow_();
  const cacheKey = ['pastOrderCatalog:v1', dateStr, daysBack, lastRow].join('|');
  const cached = getCachedValue_(cacheKey);
  if (cached?.catalog) return cached.catalog;

  let byDate = await getProductsByExactDateKeys_(dateKeys, { recentRows: CONFIG.INDEX_FAST_RECENT_ROWS });
  const hasAny = dateKeys.some(dateKey => (byDate[dateKey] || []).length > 0);
  if (!hasAny) {
    byDate = await getProductsByExactDateKeys_(dateKeys, { recentRows: 0 });
  }

  const catalog = [];
  dateKeys.forEach(dateKey => {
    const dateObj = parseInputDate_(dateKey);
    const dateLabel = formatShortKoreanDate_(dateObj);
    (byDate[dateKey] || []).forEach(productName => {
      catalog.push({ dateKey, dateLabel, productName });
    });
  });

  putCachedValue_(cacheKey, { catalog }, CONFIG.PRODUCT_LOAD_CACHE_SECONDS);
  return catalog;
}

async function getProductsByExactDateKeys_(dateKeys, options) {
  const targetKeySet = new Set(dateKeys || []);
  const result = {};
  (dateKeys || []).forEach(key => result[key] = []);
  if (!targetKeySet.size) return result;

  const snapshot = await getIndexProductSnapshot_({
    includeMeta: false,
    recentRows: Number(options?.recentRows || 0)
  });

  (snapshot.records || []).forEach(record => {
    const dateKey = cleanCellText_(record.dateKey || '');
    if (!targetKeySet.has(dateKey)) return;

    const productName = cleanCellText_(record.productName || '');
    if (productName && !result[dateKey].includes(productName)) {
      result[dateKey].push(productName);
    }
  });

  return result;
}

async function reviewPastOrderRowsWithAIInBatches_(catalog, candidates, batchSize) {
  const list = candidates || [];
  const size = Math.max(1, Math.min(Number(batchSize || 20), 30));
  const decisions = [];

  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    const batchDecisions = await reviewPastOrderRowsWithAI_(catalog, batch);
    (batchDecisions || []).forEach(decision => decisions.push(decision));
  }

  return decisions;
}

async function reviewPastOrderRowsWithAI_(catalog, candidates) {
  if (!catalog.length || !candidates.length) return [];

  const productEnum = Array.from(new Set(catalog.map(item => item.productName)));
  const dateKeyEnum = Array.from(new Set(catalog.map(item => item.dateKey)));
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rowIndex', 'decision', 'dateKey', 'productName', 'confidence', 'reason'],
          properties: {
            rowIndex: { type: 'integer' },
            decision: { type: 'string', enum: ['matched', 'unmatched'] },
            dateKey: { type: 'string', enum: [''].concat(dateKeyEnum) },
            productName: { type: 'string', enum: [''].concat(productEnum) },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' }
          }
        }
      }
    }
  };
  const prompt = JSON.stringify({
    task: '지난 공구주문으로 분류된 고객 주문메시지를 최근 5일 상품리스트와 대조해 실제 상품명을 찾는다.',
    strictRules: [
      '각 candidate마다 decisions 항목을 1개씩 만든다.',
      '수기 주문명은 고객 원문보다 더 중요한 단서로 보고 catalog와 우선 대조한다.',
      'matched일 때 productName과 dateKey는 catalog 안의 값과 완전히 동일해야 한다.',
      '축약어, 띄어쓰기 차이, 흔한 오타 수준이면 matched 가능하다.',
      '유사 상품이 여러 개라 날짜/옵션/맛/종류가 헷갈리면 unmatched로 둔다.',
      'matched는 confidence 0.86 이상일 때만 사용한다.',
      '임의 상품명은 만들지 않는다.'
    ],
    catalog,
    candidates
  });

  const parsed = await callOpenAIJson_({
    schemaName: 'past_order_match_result',
    schema,
    developerContent: '너는 지난 공구주문 원문을 최근 5일 공구상품 목록과 매칭하는 AI다. 반드시 JSON Schema에 맞는 JSON만 출력한다.',
    prompt,
    maxOutputTokens: 12000
  });

  return parsed.decisions || [];
}

async function callOpenAIJson_({ schemaName, schema, developerContent, prompt, maxOutputTokens }) {
  const apiKey = getOpenAIKey_();
  if (!apiKey) throw new Error('OPENAI_API_KEY 환경변수가 설정되어 있지 않습니다.');

  const body = {
    model: getOpenAIModel_(),
    input: [
      { role: 'developer', content: developerContent },
      { role: 'user', content: prompt }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema
      }
    },
    temperature: 0,
    max_output_tokens: maxOutputTokens || 10000
  };
  const responseText = await fetchOpenAIWithRetry_(body, apiKey);
  const data = JSON.parse(responseText);
  const outputText = extractOutputText_(data);
  if (!outputText) throw new Error('OpenAI 응답에서 output_text를 찾지 못했습니다.');

  try {
    return JSON.parse(outputText);
  } catch (err) {
    throw new Error(
      `OpenAI JSON 파싱 실패: ${err.message}\n\n` +
      `응답 앞부분:\n${outputText.slice(0, 1000)}\n\n` +
      `응답 끝부분:\n${outputText.slice(-700)}`
    );
  }
}

async function fetchOpenAIWithRetry_(body, apiKey) {
  const maxAttempts = 4;
  const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
  let waitMs = 6000;
  let lastText = '';
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(CONFIG.OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      lastText = text;

      if (response.ok) return text;
      if (!retryableStatuses.has(response.status) || attempt >= maxAttempts) {
        throw new Error(`OpenAI API 오류(${response.status}): ${text.slice(0, 1200)}`);
      }

      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const retryMatch = text.match(/try again in\s+([\d.]+)\s*s/i);
      const suggestedMs = retryAfter > 0
        ? retryAfter * 1000 + 1500
        : (retryMatch ? Number(retryMatch[1]) * 1000 + 1500 : 0);
      const sleepMs = Math.min(Math.max(suggestedMs, waitMs) + Math.floor(Math.random() * 1200), 45000);
      await sleep_(sleepMs);
      waitMs = Math.ceil(waitMs * 1.8);
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      const retryableException = /timeout|timed out|connection reset|disconnect|socket|temporarily unavailable|service unavailable|dns/i.test(message);

      if (!retryableException || attempt >= maxAttempts) {
        throw err;
      }

      await sleep_(Math.min(waitMs + Math.floor(Math.random() * 1200), 45000));
      waitMs = Math.ceil(waitMs * 1.8);
    }
  }

  throw lastError || new Error(`OpenAI 연결 재시도 후에도 응답을 받지 못했습니다. ${lastText.slice(0, 500)}`);
}

function extractOutputText_(data) {
  if (data.output_text) return data.output_text;

  const chunks = [];
  (data.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.type === 'output_text' && content.text) {
        chunks.push(content.text);
      } else if (content.text) {
        chunks.push(content.text);
      }
    });
  });

  return chunks.join('').trim();
}

function findHeaderIndex_(header, candidates) {
  for (const candidate of candidates) {
    const idx = header.findIndex(value => value === candidate || value.includes(candidate));
    if (idx >= 0) return idx;
  }
  return -1;
}

function makeOptionalEndDateTime_(dateStr, timeStr) {
  const dateText = String(dateStr || '').trim();
  const timeText = String(timeStr || '').trim();

  if (!dateText && !timeText) return null;
  if (!dateText || !timeText) {
    throw new Error('수집 마감일시를 사용하려면 마감 날짜와 시간을 모두 입력해주세요.');
  }

  return makeDateTime_(dateText, timeText);
}

function parseKakaoDate_(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let normalized = raw
    .replace(/년|월/g, '.')
    .replace(/일/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const meridiemMatch = normalized.match(/(오전|오후|AM|PM)/i);
  const meridiem = meridiemMatch ? meridiemMatch[1].toLowerCase() : '';
  normalized = normalized.replace(/오전|오후|AM|PM/gi, '').trim();

  const match = normalized.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\.?\s+|\s+)?(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;

  let hour = match[4] !== undefined ? Number(match[4]) : 0;
  const minute = match[5] !== undefined ? Number(match[5]) : 0;
  const second = match[6] !== undefined ? Number(match[6]) : 0;

  if (meridiem === '오후' || meridiem === 'pm') {
    if (hour < 12) hour += 12;
  }
  if (meridiem === '오전' || meridiem === 'am') {
    if (hour === 12) hour = 0;
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, minute, second);
}

function parseInputDate_(dateStr) {
  const match = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`날짜 형식이 올바르지 않습니다: ${dateStr}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function tryParseSheetDate_(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30 + serial));
  }

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 2) return null;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    return new Date(Number(nums[0]), Number(nums[1]) - 1, Number(nums[2]));
  }

  const today = getSeoulToday();
  let year = today.getFullYear();
  const month = Number(nums[0]);
  const day = Number(nums[1]);
  const currentMonth = today.getMonth() + 1;
  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return new Date(year, month - 1, day);
}

function makeDateTime_(dateStr, timeStr) {
  const date = parseInputDate_(dateStr);
  const match = String(timeStr || '00:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`시간 형식이 올바르지 않습니다: ${timeStr}`);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
}

function normalizeDateKey_(date) {
  return formatDateKey(date);
}

function formatOrderDateText_(date) {
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}`;
}

function formatShortKoreanDate_(date) {
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getMonth() + 1}/${date.getDate()}(${days[date.getDay()]})`;
}

function getPreviousDateKey_(dateStr) {
  try {
    return normalizeDateKey_(addDays_(parseInputDate_(dateStr), -1));
  } catch {
    return '';
  }
}

function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function chunkArray_(arr, size) {
  const n = Math.max(1, Number(size || 1));
  const chunks = [];
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n));
  return chunks;
}

function mergeProductNames_(primary, secondary) {
  const merged = [];
  const seen = new Set();
  [primary || [], secondary || []].forEach(list => {
    list.forEach(name => {
      const cleaned = cleanCellText_(name);
      const key = normalizeForHint_(cleaned);
      if (!cleaned || seen.has(key)) return;
      seen.add(key);
      merged.push(cleaned);
    });
  });
  return merged;
}

function normalizeCustomProducts_(products) {
  return (products || [])
    .map(product => {
      const productName = cleanCellText_(product.productName || product.name || '');
      if (!productName) return null;

      const includeInOrder = product.includeInOrder !== false && product.include !== false && product.includeInOrder !== 'no';
      return {
        id: cleanCellText_(product.id || productName),
        productName,
        includeInOrder,
        fromIndex: product.fromIndex === true,
        priceOverride: cleanCellText_(product.priceOverride || product.price || ''),
        imageUrlOverride: cleanCellText_(product.imageUrlOverride || product.imageUrl || ''),
        pickupDateOverride: cleanCellText_(product.pickupDateOverride || product.pickupDate || '')
      };
    })
    .filter(Boolean);
}

function mergeProductNamesWithCustom_(productNames, customProducts) {
  const custom = normalizeCustomProducts_(customProducts)
    .map(product => product.productName)
    .filter(Boolean);
  return mergeProductNames_(productNames || [], custom);
}

function makeCustomProductMap_(customProducts) {
  const map = new Map();
  normalizeCustomProducts_(customProducts).forEach(product => {
    map.set(normalizeForHint_(product.productName), product);
  });
  return map;
}

function findCustomProductMeta_(customProductMap, productName) {
  return customProductMap.get(normalizeForHint_(productName)) || null;
}

function makeProductRecordMapByName_(records) {
  const map = new Map();
  (records || []).forEach(record => {
    const key = normalizeForHint_(record.productName);
    if (key) map.set(key, record);
  });
  return map;
}

function findProductRecordByName_(map, productName) {
  return map.get(normalizeForHint_(productName)) || null;
}

function getIndexProductNameSetFromSnapshot_(snapshot) {
  return new Set((snapshot?.records || []).map(record => normalizeForHint_(record.productName)).filter(Boolean));
}

function splitManualProductNameAndQuantity_(value, productSet) {
  const original = cleanCellText_(value);
  if (!original) return { productName: '', quantity: 0 };

  const knownSet = productSet || new Set();
  if (knownSet.has(original)) return { productName: original, quantity: 0 };

  const match = original.match(/^(.+?)[\s]*([0-9]+|ㅣ)\s*(개|팩|봉|세트|병|통)?$/);
  if (!match) return { productName: original, quantity: 0 };

  const candidateName = cleanCellText_(match[1]);
  const quantity = match[2] === 'ㅣ' ? 1 : Number(match[2]);

  if (!candidateName || !Number.isFinite(quantity) || quantity < 1) {
    return { productName: original, quantity: 0 };
  }

  if (knownSet.has(candidateName) || !knownSet.has(original)) {
    return { productName: candidateName, quantity };
  }

  return { productName: original, quantity: 0 };
}

function makeEventReport_(event, extraReason) {
  return {
    sourceIndex: event.sourceIndex,
    csvRowNumber: event.csvRowNumber,
    dateRaw: event.dateRaw,
    user: event.user,
    message: event.message,
    items: event.items || [],
    cancelItems: event.cancelItems || [],
    unmatchedItems: event.unmatchedItems || [],
    reason: extraReason || event.needsCheckReason || '',
    notes: event.notes || []
  };
}

function makeEmptyReport_(chunkNotes) {
  return {
    chunkNotes: chunkNotes || [],
    needsCheck: [],
    notInProductList: [],
    correctionLogs: [],
    soldOutNotices: [],
    soldOutPossibleOrders: []
  };
}

function isLikelyOrderMessageForMissingReview_(message) {
  const msg = cleanCellText_(message.message);
  const user = cleanCellText_(message.user);
  if (!msg) return false;
  if (/점장|부점장|운영자|관리자|매니저|오픈채팅봇/.test(user)) return false;
  if (/님이\s*(들어왔습니다|나갔습니다)|메시지가 삭제되었습니다|관리자가 메시지를 가렸습니다/.test(msg)) return false;
  if (/^사진\s*\d*\s*장?$|^동영상\s*\d*\s*개?$|^이모티콘$/.test(msg)) return false;
  if (/\?/.test(msg) && !/\d|ㅣ/.test(msg)) return false;
  if (/픽업|입고|공지|마감|품절|가격|공구가|원산지|보관|환불|안내/.test(msg) && msg.length > 80) return false;

  const hasQty = /(\d+|ㅣ)\s*(개|팩|봉|세트|병|통)?/.test(msg);
  const orderish = /주세요|주세용|주문|추가|개요|개용|부탁|할게|할께|요$|여$/.test(msg);
  return msg.length <= 220 && (hasQty || orderish);
}

function extractOrderPartsForMissingReview_(message, productNames) {
  const msg = cleanCellText_(message);
  if (!msg) return [];

  const normalizedLines = msg
    .replace(/[，、]/g, ',')
    .split(/[\n,]+/)
    .map(cleanCellText_)
    .filter(Boolean);
  const parts = [];

  normalizedLines.forEach(line => {
    const matches = Array.from(line.matchAll(/([가-힣A-Za-z][가-힣A-Za-z0-9\s·&+\-\/]{0,35}?)(\d+|ㅣ)\s*(개|팩|봉|세트|병|통)?(?=\s|$|[가-힣A-Za-z])/g));
    if (matches.length) {
      matches.forEach(match => {
        const rawName = cleanCellText_(match[1]).replace(/^(주문|추가|저도|저는|요|여)\s*/g, '').trim();
        if (!rawName || isSpecOnlyRawName_(rawName)) return;
        const quantity = String(match[2]) === 'ㅣ' ? 1 : Number(match[2]);
        parts.push(makeMissingReviewPart_(rawName, quantity, productNames));
      });
      return;
    }

    if (/주세요|주문|추가|부탁|할게|할께|요$|여$/.test(line) && line.length <= 60) {
      const rawName = line.replace(/(주세요|주문|추가|부탁|할게요|할께요|할게|할께|요|여)$/g, '').trim();
      if (rawName && !isSpecOnlyRawName_(rawName)) {
        parts.push(makeMissingReviewPart_(rawName, 1, productNames));
      }
    }
  });

  const seen = new Set();
  return parts.filter(part => {
    const key = `${normalizeForHint_(part.rawName)}|${part.quantity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeMissingReviewPart_(rawName, quantity, productNames) {
  const best = findBestProductForMissingReview_(rawName, productNames);
  return {
    rawName,
    quantity: Number(quantity) > 0 ? Number(quantity) : 1,
    suggestedProductName: best.productName,
    confidence: best.confidence
  };
}

function findBestProductForMissingReview_(rawName, productNames) {
  const raw = normalizeForHint_(stripSpecsForMissingReview_(rawName));
  if (!raw) return { productName: '', confidence: 0 };

  let bestProduct = '';
  let bestScore = 0;

  (productNames || []).forEach(product => {
    const productNorm = normalizeForHint_(stripSpecsForMissingReview_(product));
    if (!productNorm) return;

    let score = 0;
    if (productNorm.includes(raw) || raw.includes(productNorm)) score += 80;

    const rawTokens = makeMissingReviewTokens_(rawName);
    const productTokens = makeMissingReviewTokens_(product);
    rawTokens.forEach(token => {
      if (token.length >= 2 && productNorm.includes(token)) score += Math.min(20, token.length * 4);
    });
    productTokens.forEach(token => {
      if (token.length >= 2 && raw.includes(token)) score += Math.min(15, token.length * 3);
    });

    if (score > bestScore) {
      bestScore = score;
      bestProduct = product;
    }
  });

  if (bestScore >= 45) return { productName: bestProduct, confidence: Math.min(0.95, bestScore / 100) };
  return { productName: '', confidence: Math.min(0.5, bestScore / 100) };
}

function makeMissingReviewTokens_(value) {
  return stripSpecsForMissingReview_(value)
    .split(/[\s·,_\-\/]+/)
    .map(normalizeForHint_)
    .filter(value => value.length >= 2 && !/^\d+$/.test(value));
}

function stripSpecsForMissingReview_(value) {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[0-9]+(?:g|G|kg|KG|ml|mL|L|개입|매|팩|봉|세트|인분|년|월|일)/g, ' ')
    .replace(/[+\/"'“”‘’.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpecOnlyRawName_(rawName) {
  const normalized = normalizeForHint_(stripSpecsForMissingReview_(rawName));
  return !normalized || /^(개|팩|봉|세트|병|통|주문|추가)$/.test(normalized);
}

function truncateForMemo_(value, maxLen) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const limit = Number(maxLen || 80);
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function normalizeForHint_(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/["'“”‘’\[\]\(\),.\/]/g, '');
}

function normalizeAllyName_(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function cleanCellText_(value) {
  return String(value == null ? '' : value).trim();
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateTimeText_(date) {
  return `${formatDateKey(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getSeoulToday() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
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

function getOpenAIKey_() {
  return process.env.OPENAI_API_KEY || '';
}

function getOpenAIModel_() {
  return process.env.ORDER_COLLECTOR_OPENAI_MODEL || process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_MODEL || CONFIG.DEFAULT_MODEL;
}

async function getSheetsClient_() {
  return getSheetsClient();
}

function getSpreadsheetId_() {
  return CONFIG.SPREADSHEET_ID || getSpreadsheetId();
}

function escapeSheetName_(sheetName) {
  return String(sheetName || '').replace(/'/g, "''");
}

function columnToLetter_(columnNumber) {
  let n = Number(columnNumber);
  let result = '';
  while (n > 0) {
    const mod = (n - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    n = Math.floor((n - mod) / 26);
  }
  return result;
}

function hexToRgb_(hex) {
  const normalized = String(hex || '#000000').replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(char => char + char).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  const r = parseInt(value.slice(0, 2), 16) || 0;
  const g = parseInt(value.slice(2, 4), 16) || 0;
  const b = parseInt(value.slice(4, 6), 16) || 0;
  return { red: r / 255, green: g / 255, blue: b / 255 };
}

function getCachedValue_(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
}

function putCachedValue_(key, value, seconds) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + Math.max(1, Number(seconds || 60)) * 1000
  });
}

function makeProductLoadCacheKey_(dateStr, holidayStartStr, holidayEndStr, lastRow) {
  return [
    'productLoad:v4',
    String(dateStr || '').trim(),
    String(holidayStartStr || '').trim(),
    String(holidayEndStr || '').trim(),
    String(lastRow || 0)
  ].join('|');
}

function sleep_(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseEnvList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(cleanCellText_).filter(Boolean);
  } catch {
    // Comma fallback below.
  }
  return raw.split(',').map(cleanCellText_).filter(Boolean);
}
