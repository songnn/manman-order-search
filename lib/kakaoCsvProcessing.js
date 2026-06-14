import crypto from 'node:crypto';
import { toDateKey } from './dashboard/parseOrders.js';
import { supabaseAdmin } from './supabaseAdmin.js';

const KAKAO_TABLES = {
  uploads: 'kakao_csv_uploads',
  messages: 'kakao_csv_messages',
  events: 'kakao_member_events',
  matches: 'order_message_matches'
};

const KAKAO_DB_COLUMNS = {
  [KAKAO_TABLES.uploads]: [
    'upload_id',
    'file_hash',
    'store_name',
    'order_date',
    'start_at',
    'end_at',
    'uploaded_at',
    'source',
    'file_name',
    'file_size',
    'mime_type',
    'message_count',
    'window_message_count',
    'join_count',
    'leave_count',
    'order_candidate_message_count',
    'raw_order_count',
    'matched_order_count',
    'unmatched_csv_order_count',
    'unmatched_raw_order_count',
    'avg_ordered_at',
    'first_ordered_at',
    'first_order_after_minutes',
    'notes'
  ],
  [KAKAO_TABLES.messages]: [
    'upload_id',
    'message_id',
    'file_hash',
    'store_name',
    'order_date',
    'message_at',
    'date_raw',
    'csv_row_number',
    'message_index',
    'user_name',
    'normalized_user',
    'message',
    'message_type',
    'member_subject',
    'source'
  ],
  [KAKAO_TABLES.events]: [
    'upload_id',
    'message_id',
    'event_type',
    'member_subject',
    'message_at',
    'date_raw',
    'user_name',
    'normalized_user',
    'message'
  ],
  [KAKAO_TABLES.matches]: [
    'csv_upload_id',
    'csv_message_id',
    'raw_order_stable_id',
    'store_name',
    'order_date',
    'customer_name',
    'normalized_customer',
    'product_name',
    'normalized_product_name',
    'quantity',
    'occurrence_index',
    'actual_ordered_at',
    'message_raw',
    'match_confidence',
    'match_method',
    'matched_at',
    'current_source_row_number',
    'source_sheet_name'
  ]
};

const STORE_NAME = process.env.STORE_NAME || '전농래미안크레시티점';
const RAW_SHEET_NAME = process.env.RAW_SHEET_NAME || 'Raw_주문입력';

export function getKakaoCsvExpectedToken() {
  return process.env.KAKAO_CSV_INGEST_TOKEN || process.env.ADMIN_DASHBOARD_TOKEN || '03064';
}

function debugKakaoCsvStep(step, detail = {}) {
  if (!process.env.DEBUG_KAKAO_CSV_PROCESSING) return;
  console.log(`[kakao-csv] ${step}`, detail);
}

export async function ingestKakaoCsvUpload(body) {
  const fileContent = getFileContent(body);
  if (!fileContent.trim()) {
    throw Object.assign(new Error('fileContent 또는 base64File이 필요합니다.'), { statusCode: 400 });
  }

  const storeName = clean(body.storeName || body.store_name || STORE_NAME);
  const orderDate = normalizeDateKey(body.orderDate || body.order_date);
  if (!orderDate) {
    throw Object.assign(new Error('orderDate가 필요합니다.'), { statusCode: 400 });
  }

  const startAt = normalizeDateTimeText(body.startAt || body.start_at);
  const endAt = normalizeDateTimeText(body.endAt || body.end_at);
  const uploadedAt = normalizeDateTimeText(body.uploadedAt || body.uploaded_at) || formatDateTime(new Date());
  const fileHash = hashText(fileContent);
  const uploadId = makeUploadId({ fileHash, storeName, orderDate, startAt, endAt });
  const meta = {
    uploadId,
    fileHash,
    storeName,
    orderDate,
    startAt,
    endAt,
    uploadedAt,
    source: clean(body.source || 'google_apps_script'),
    fileName: clean(body.fileName || body.file_name),
    fileSize: toNumber(body.fileSize ?? body.file_size) || Buffer.byteLength(fileContent, 'utf8'),
    mimeType: clean(body.mimeType || body.mime_type)
  };

  debugKakaoCsvStep('parse:start');
  const parsedMessages = normalizeKakaoMessages(parseKakaoMessages(fileContent), meta);
  debugKakaoCsvStep('parse:done', { messageCount: parsedMessages.length });
  const targetMessages = shouldImportFullCsv(body)
    ? parsedMessages
    : parsedMessages.filter(message => isInsideWindow(message, meta));
  const memberEvents = extractMemberEvents(targetMessages, meta);
  const shouldMatchRawOrdersOnUpload = process.env.KAKAO_CSV_MATCH_ON_UPLOAD !== '0';
  debugKakaoCsvStep('raw-orders:start', { enabled: shouldMatchRawOrdersOnUpload });
  const rawOrders = shouldMatchRawOrdersOnUpload ? await readRawOrdersForUpload(meta) : [];
  debugKakaoCsvStep('raw-orders:done', { rawOrderCount: rawOrders.length });
  debugKakaoCsvStep('analyze:start', {
    targetMessageCount: targetMessages.length,
    memberEventCount: memberEvents.length
  });
  const analysis = analyzeAndMatchOrders({
    meta,
    messages: targetMessages,
    rawOrders,
    memberEvents
  });
  debugKakaoCsvStep('analyze:done', { matchCount: analysis.matches.length });
  const uploadSummary = buildUploadSummary(meta, parsedMessages, targetMessages, memberEvents, analysis);
  debugKakaoCsvStep('summary:ready', {
    messageCount: uploadSummary.message_count,
    windowMessageCount: uploadSummary.window_message_count
  });

  debugKakaoCsvStep('supabase:write:start');
  await replaceKakaoUploadInSupabase({
    uploadSummary,
    messages: targetMessages,
    memberEvents,
    matches: analysis.matches
  });
  debugKakaoCsvStep('supabase:write:done');

  return {
    ok: true,
    uploadId,
    fileHash,
    messageCount: parsedMessages.length,
    windowMessageCount: targetMessages.length,
    joinCount: memberEvents.filter(event => event.event_type === 'join').length,
    leaveCount: memberEvents.filter(event => event.event_type === 'leave').length,
    matchedOrderCount: analysis.matches.length,
    unmatchedCsvOrderCount: analysis.unmatchedCsvOrderCount,
    unmatchedRawOrderCount: analysis.unmatchedRawOrderCount
  };
}

export async function readKakaoCsvStore() {
  try {
    const uploads = await readSupabaseRows(KAKAO_TABLES.uploads, query =>
      query.select('*').order('uploaded_at', { ascending: false }).limit(20),
      { paginate: false }
    );
    const uploadIds = uploads.map(row => row.upload_id).filter(Boolean);

    if (!uploadIds.length) {
      return { uploads: [], messages: [], memberEvents: [], orderMatches: [] };
    }

    const [messages, events, matches] = await Promise.all([
      readSupabaseRows(KAKAO_TABLES.messages, query =>
        query.select('*').in('upload_id', uploadIds).order('message_index', { ascending: true })
      ),
      readSupabaseRows(KAKAO_TABLES.events, query =>
        query.select('*').in('upload_id', uploadIds).order('message_at', { ascending: true })
      ),
      readSupabaseRows(KAKAO_TABLES.matches, query =>
        query.select('*').in('csv_upload_id', uploadIds).order('actual_ordered_at', { ascending: true })
      )
    ]);

    return {
      uploads: uploads.map(normalizeUploadRecord).filter(row => row.uploadId),
      messages: messages.map(normalizeMessageRecord).filter(row => row.uploadId && row.messageId),
      memberEvents: events.map(normalizeEventRecord).filter(row => row.uploadId && row.eventType),
      orderMatches: matches.map(normalizeMatchRecord).filter(row => row.uploadId && row.rawOrderStableId)
    };
  } catch (error) {
    if (/Unable to parse range|not found|찾을 수|No grid/i.test(error.message)) {
      return { uploads: [], messages: [], memberEvents: [], orderMatches: [] };
    }

    console.warn('readKakaoCsvStore failed:', error.message);
    return { uploads: [], messages: [], memberEvents: [], orderMatches: [] };
  }
}

export async function reanalyzeKakaoCsvMatches(options = {}) {
  const store = await readKakaoCsvStore();
  const maxUploads = Number(options.maxUploads || 20);
  const uploads = [...store.uploads]
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')))
    .slice(0, maxUploads);

  if (!uploads.length) {
    return { ok: true, uploadCount: 0, matchCount: 0 };
  }

  let totalMatches = 0;
  for (const upload of uploads) {
    const meta = uploadToMeta(upload);
    const messages = store.messages.filter(message => message.uploadId === upload.uploadId);
    const memberEvents = store.memberEvents
      .filter(event => event.uploadId === upload.uploadId)
      .map(eventToDbObject);
    const rawOrders = await readRawOrdersForUpload(meta);
    const analysis = analyzeAndMatchOrders({
      meta,
      messages: messages.map(messageToPipelineObject),
      rawOrders,
      memberEvents
    });
    const targetMessages = messages.map(messageToPipelineObject);

    await replaceSupabaseMatches(upload.uploadId, analysis.matches);
    await updateSupabaseUploadSummary(buildUploadSummary(meta, messages, targetMessages, memberEvents, analysis));
    totalMatches += analysis.matches.length;
  }

  return { ok: true, uploadCount: uploads.length, matchCount: totalMatches };
}

export function isKakaoCsvUploadAuthorized(req) {
  const expectedToken = getKakaoCsvExpectedToken();
  if (!expectedToken) return false;

  const headerToken =
    req.headers['x-kakao-csv-token'] ||
    req.headers['x-admin-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  return headerToken === expectedToken;
}

function shouldImportFullCsv(body) {
  if (String(body.importMode || body.import_mode || '').toLowerCase() === 'window') return false;
  if (body.fullSync === false || body.full_sync === false) return false;
  return true;
}

async function readRawOrdersForUpload(meta) {
  const orderDateValue = dateKeyToNumber(meta.orderDate);
  const rows = await readSupabaseRows('order_cache', query => {
    let scopedQuery = query
      .select('*')
      .eq('store_name', meta.storeName || STORE_NAME)
      .order('source_row_number', { ascending: true });

    if (orderDateValue && process.env.KAKAO_CSV_MATCH_ORDER_DATE_ONLY === '1') {
      scopedQuery = scopedQuery.eq('order_date_value', orderDateValue);
    }

    return scopedQuery;
  });

  return buildRawOrdersFromOrderCache(rows, meta);
}

function buildRawOrdersFromOrderCache(rows, meta) {
  const occurrence = new Map();

  return (rows || [])
    .map(row => {
      const orderDate = dateValueToDateKey(row.order_date_value) || normalizeDateKey(row.order_date_text);
      const normalizedCustomer = normalizeName(row.customer_label);
      const normalizedProduct = normalizeProduct(row.product_name);
      const quantity = Number(row.quantity || 0);
      const key = [
        meta.storeName,
        orderDate,
        normalizedCustomer,
        normalizedProduct,
        quantity
      ].join('|');
      const occurrenceIndex = (occurrence.get(key) || 0) + 1;
      occurrence.set(key, occurrenceIndex);
      const rawOrderStableId = sha256(`${key}|${occurrenceIndex}`).slice(0, 32);

      return {
        rawOrderStableId,
        storeName: meta.storeName,
        orderDate,
        customerName: row.customer_label,
        normalizedCustomer,
        productName: row.product_name,
        normalizedProduct,
        quantity,
        occurrenceIndex,
        currentSourceRowNumber: row.source_row_number,
        sourceSheetName: row.source_sheet_name || RAW_SHEET_NAME
      };
    })
    .filter(order => order.normalizedCustomer && order.normalizedProduct && order.quantity > 0)
    .sort((a, b) => Number(a.currentSourceRowNumber || 0) - Number(b.currentSourceRowNumber || 0));
}

function analyzeAndMatchOrders({ meta, messages, rawOrders, memberEvents }) {
  const nowText = formatDateTime(new Date());
  const matchedMessageIds = new Set();
  const usedMessageIdsByRaw = new Set();
  const lastMessageIndexByCustomer = new Map();
  const orderCandidateMessageIds = new Set();
  const rawOrderProductTokens = buildRawOrderProductTokenSet(rawOrders);
  const matches = [];

  const messagesByCustomer = new Map();
  messages.forEach(message => {
    if (message.message_type !== 'join' && message.message_type !== 'leave' && isOrderLikeMessage(message, rawOrderProductTokens)) {
      orderCandidateMessageIds.add(message.message_id);
    }

    if (!message.normalized_user) return;
    if (!messagesByCustomer.has(message.normalized_user)) {
      messagesByCustomer.set(message.normalized_user, []);
    }
    messagesByCustomer.get(message.normalized_user).push(message);
  });

  messagesByCustomer.forEach(list => {
    list.sort((a, b) => a.message_sort_time - b.message_sort_time || a.message_index - b.message_index);
  });

  rawOrders.forEach(order => {
    const candidates = (messagesByCustomer.get(order.normalizedCustomer) || [])
      .filter(message => message.message_type !== 'join' && message.message_type !== 'leave')
      .filter(message => !usedMessageIdsByRaw.has(`${order.rawOrderStableId}|${message.message_id}`))
      .map(message => scoreOrderMessage(order, message))
      .filter(candidate => candidate.score >= 0.62)
      .sort((a, b) => {
        const lastIndex = lastMessageIndexByCustomer.get(order.normalizedCustomer) ?? -1;
        const aAfter = a.message.message_index > lastIndex ? 0 : 1;
        const bAfter = b.message.message_index > lastIndex ? 0 : 1;
        if (aAfter !== bAfter) return aAfter - bAfter;
        return b.score - a.score || a.message.message_index - b.message.message_index;
      });

    const best = candidates[0];
    if (!best) return;

    usedMessageIdsByRaw.add(`${order.rawOrderStableId}|${best.message.message_id}`);
    matchedMessageIds.add(best.message.message_id);
    orderCandidateMessageIds.add(best.message.message_id);
    lastMessageIndexByCustomer.set(order.normalizedCustomer, best.message.message_index);

    matches.push({
      csv_upload_id: meta.uploadId,
      csv_message_id: best.message.message_id,
      raw_order_stable_id: order.rawOrderStableId,
      store_name: meta.storeName,
      order_date: order.orderDate,
      customer_name: order.customerName,
      normalized_customer: order.normalizedCustomer,
      product_name: order.productName,
      normalized_product_name: order.normalizedProduct,
      quantity: order.quantity,
      occurrence_index: order.occurrenceIndex,
      actual_ordered_at: best.message.message_at,
      message_raw: best.message.message,
      match_confidence: Math.round(best.score * 1000) / 1000,
      match_method: best.method,
      matched_at: nowText,
      current_source_row_number: order.currentSourceRowNumber,
      source_sheet_name: order.sourceSheetName
    });
  });

  const unmatchedCsvOrderCount = Array.from(orderCandidateMessageIds)
    .filter(messageId => !matchedMessageIds.has(messageId)).length;
  const unmatchedRawOrderCount = rawOrders.length - new Set(matches.map(match => match.raw_order_stable_id)).size;

  return {
    matches,
    orderCandidateMessageCount: orderCandidateMessageIds.size,
    unmatchedCsvOrderCount,
    unmatchedRawOrderCount,
    firstOrderedAt: getFirstOrderedAt(matches),
    avgOrderedAt: getAverageOrderedAt(matches),
    firstOrderAfterMinutes: getFirstOrderAfterMinutes(meta, matches),
    rawOrderCount: rawOrders.length,
    joinCount: memberEvents.filter(event => event.event_type === 'join').length,
    leaveCount: memberEvents.filter(event => event.event_type === 'leave').length
  };
}

function scoreOrderMessage(order, message) {
  const messageText = normalizeMessageForMatch(message.message);
  const productScore = productSimilarity(order.productName, message.message);
  const quantityScore = quantityMatches(message.message, order.quantity) ? 1 : order.quantity === 1 ? 0.64 : 0;
  const sequenceScore = 0.7;
  const score = productScore * 0.58 + quantityScore * 0.28 + sequenceScore * 0.14;
  const method = productScore >= 0.95
    ? 'exact_product_quantity_sequence'
    : productScore >= 0.72
      ? 'product_similarity_quantity_sequence'
      : 'token_quantity_sequence';

  if (!messageText) return { message, score: 0, method };
  return { message, score, method };
}

function productSimilarity(productName, message) {
  const compactProduct = normalizeProduct(productName);
  const compactMessage = normalizeProduct(message);
  if (!compactProduct || !compactMessage) return 0;
  if (compactMessage.includes(compactProduct)) return 1;

  const coreTokens = productTokens(productName);
  const hitCount = coreTokens.filter(token => compactMessage.includes(token)).length;
  const tokenScore = coreTokens.length ? Math.min(1, hitCount / Math.min(coreTokens.length, 3)) : 0;
  const diceScore = diceCoefficient(compactProduct, compactMessage);

  return Math.max(tokenScore, diceScore);
}

function productTokens(value) {
  return clean(value)
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[0-9]+(?:g|kg|ml|l|개입|매|팩|봉|세트|인분|구|입|년|월|일)/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map(normalizeProduct)
    .filter(token => token.length >= 2 && !/^\d+$/.test(token))
    .slice(0, 8);
}

function quantityMatches(message, quantity) {
  const q = Number(quantity || 0);
  if (!q) return false;
  const compact = clean(message).replace(/,/g, '');
  const patterns = [
    new RegExp(`(^|[^0-9])${q}\\s*(개|봉|팩|세트|병|통|박스|줄|개요|요)?([^0-9]|$)`),
    new RegExp(`x\\s*${q}([^0-9]|$)`, 'i')
  ];

  return patterns.some(pattern => pattern.test(compact));
}

function buildRawOrderProductTokenSet(rawOrders) {
  const tokens = new Set();
  rawOrders.forEach(order => {
    productTokens(order.productName).forEach(token => tokens.add(token));
  });
  return tokens;
}

function isOrderLikeMessage(message, rawOrderProductTokens) {
  const text = clean(message.message);
  if (!text) return false;
  if (/님이\s*(들어왔습니다|나갔습니다)/.test(text)) return false;
  if (/메시지가 삭제되었습니다|관리자가 메시지를 가렸습니다/.test(text)) return false;
  if (/^사진\s*\d+\s*장$|^동영상\s*\d+\s*개$/.test(text)) return false;
  if (/\d+\s*(개|봉|팩|세트|병|통|박스|줄)?/.test(text)) return true;

  const normalized = normalizeProduct(text);
  for (const token of rawOrderProductTokens) {
    if (normalized.includes(token)) return true;
  }
  return false;
}

function extractMemberEvents(messages, meta) {
  return messages
    .map(message => {
      const match = clean(message.message).match(/(.+?)님이\s*(들어왔습니다|나갔습니다)/);
      if (!match) return null;
      const memberSubject = clean(match[1].replace(/^["“”'‘’]+|["“”'‘’]+$/g, ''));
      const eventType = match[2] === '들어왔습니다' ? 'join' : 'leave';

      message.message_type = eventType;
      message.member_subject = memberSubject;

      return {
        upload_id: meta.uploadId,
        message_id: message.message_id,
        event_type: eventType,
        member_subject: memberSubject,
        message_at: message.message_at,
        date_raw: message.date_raw,
        user_name: message.user_name,
        normalized_user: normalizeName(memberSubject || message.user_name),
        message: message.message
      };
    })
    .filter(Boolean);
}

function normalizeKakaoMessages(rows, meta) {
  const occurrenceCounts = new Map();

  return rows.map((row, index) => {
    const key = [
      clean(row.dateRaw),
      clean(row.user),
      clean(row.message)
    ].join('|');
    const sameBaseIndex = (occurrenceCounts.get(key) || 0) + 1;
    occurrenceCounts.set(key, sameBaseIndex);

    return normalizeParsedMessage(row, index, meta, sameBaseIndex);
  });
}

function normalizeParsedMessage(row, index, meta, sameBaseIndex) {
  const date = parseKakaoDate(row.dateRaw);
  const messageId = sha256([
    meta.storeName,
    clean(row.dateRaw),
    clean(row.user),
    clean(row.message),
    sameBaseIndex
  ].join('|')).slice(0, 32);

  return {
    upload_id: meta.uploadId,
    message_id: messageId,
    file_hash: meta.fileHash,
    store_name: meta.storeName,
    order_date: meta.orderDate,
    message_at: date ? formatDateTime(date) : '',
    message_sort_time: date ? date.getTime() : index,
    date_raw: clean(row.dateRaw),
    csv_row_number: row.rowNumber || '',
    message_index: index + 1,
    user_name: clean(row.user),
    normalized_user: normalizeName(row.user),
    message: clean(row.message),
    message_type: 'message',
    member_subject: '',
    source: meta.source
  };
}

function parseKakaoMessages(content) {
  const cleaned = String(content || '').replace(/^\uFEFF/, '');
  if (looksLikeKakaoTxt(cleaned)) return parseKakaoTxt(cleaned);
  return parseKakaoCsv(cleaned);
}

function parseKakaoCsv(content) {
  const commaRows = parseDelimited(content, ',');
  const tabRows = commaRows.length && commaRows[0].length === 1 && commaRows[0][0].includes('\t')
    ? parseDelimited(content, '\t')
    : commaRows;
  const rows = tabRows;
  if (!rows.length) return [];

  const header = rows[0].map(cell => clean(cell).replace(/^\uFEFF/, '').toLowerCase());
  const dateIdx = findHeaderIndex(header, ['date', 'datetime', '일시', '날짜']);
  const userIdx = findHeaderIndex(header, ['user', 'sender', 'name', '사용자', '고객명', '닉네임']);
  const msgIdx = findHeaderIndex(header, ['message', 'text', 'content', '메시지', '내용']);
  if (dateIdx < 0 || userIdx < 0 || msgIdx < 0) return parseKakaoTxt(content);

  return rows.slice(1)
    .map((row, index) => ({
      rowNumber: index + 2,
      dateRaw: clean(row[dateIdx]),
      user: clean(row[userIdx]),
      message: clean(row[msgIdx])
    }))
    .filter(row => row.dateRaw || row.user || row.message);
}

function parseKakaoTxt(content) {
  const lines = String(content || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const rows = [];
  let currentDate = null;
  let current = null;

  const flush = () => {
    if (!current) return;
    current.message = clean(current.message);
    if (current.dateRaw || current.user || current.message) rows.push(current);
    current = null;
  };

  lines.forEach((line, index) => {
    const dateMatch = String(line || '').match(/^-{5,}\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s+[^\-]+)?\s*-{5,}\s*$/);
    if (dateMatch) {
      flush();
      currentDate = {
        year: Number(dateMatch[1]),
        month: Number(dateMatch[2]),
        day: Number(dateMatch[3])
      };
      return;
    }

    const msgMatch = String(line || '').match(/^\[([^\]]+)\]\s+\[(오전|오후|AM|PM)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s?(.*)$/i);
    if (msgMatch && currentDate) {
      flush();
      const second = msgMatch[5] || '00';
      current = {
        rowNumber: index + 1,
        dateRaw: `${currentDate.year}. ${currentDate.month}. ${currentDate.day} ${msgMatch[2]} ${msgMatch[3]}:${msgMatch[4]}${second !== '00' ? ':' + second : ''}`,
        user: clean(msgMatch[1]),
        message: clean(msgMatch[6])
      };
      return;
    }

    if (!current) return;
    if (/^만만마켓.*카카오톡 대화$/.test(line)) return;
    if (/^저장한 날짜\s*:/.test(line)) return;
    current.message += (current.message ? '\n' : '') + String(line || '');
  });

  flush();
  return rows.filter(row => row.dateRaw && row.user && row.message);
}

function parseDelimited(content, delimiter = ',') {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') {
      value += char;
    }
  }

  row.push(value);
  rows.push(row);
  return rows.filter(item => item.some(cell => clean(cell)));
}

function looksLikeKakaoTxt(text) {
  const sample = String(text || '').slice(0, 20000);
  if (/^-{5,}\s*\d{4}년\s*\d{1,2}월\s*\d{1,2}일/m.test(sample)) return true;
  if (/\[[^\]\n]{1,80}\]\s+\[(오전|오후|AM|PM)\s*\d{1,2}:\d{2}/i.test(sample)) return true;
  return /카카오톡 대화|저장한 날짜\s*:/.test(sample);
}

function parseKakaoDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 4) return null;

  const year = Number(nums[0]);
  const month = Number(nums[1]);
  const day = Number(nums[2]);
  let hour = Number(nums[3]);
  const minute = Number(nums[4] || 0);
  const second = Number(nums[5] || 0);
  const isPm = /오후|PM/i.test(raw);
  const isAm = /오전|AM/i.test(raw);

  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function buildUploadSummary(meta, allMessages, windowMessages, memberEvents, analysis) {
  return {
    upload_id: meta.uploadId,
    file_hash: meta.fileHash,
    store_name: meta.storeName,
    order_date: meta.orderDate,
    start_at: meta.startAt,
    end_at: meta.endAt,
    uploaded_at: meta.uploadedAt,
    source: meta.source,
    file_name: meta.fileName,
    file_size: meta.fileSize,
    mime_type: meta.mimeType,
    message_count: allMessages.length,
    window_message_count: windowMessages.length,
    join_count: memberEvents.filter(event => event.event_type === 'join').length,
    leave_count: memberEvents.filter(event => event.event_type === 'leave').length,
    order_candidate_message_count: analysis.orderCandidateMessageCount,
    raw_order_count: analysis.rawOrderCount,
    matched_order_count: analysis.matches.length,
    unmatched_csv_order_count: analysis.unmatchedCsvOrderCount,
    unmatched_raw_order_count: analysis.unmatchedRawOrderCount,
    avg_ordered_at: analysis.avgOrderedAt,
    first_ordered_at: analysis.firstOrderedAt,
    first_order_after_minutes: analysis.firstOrderAfterMinutes === '' ? null : analysis.firstOrderAfterMinutes,
    notes: '원본 CSV/TXT 서버 분석'
  };
}

async function replaceKakaoUploadInSupabase({ uploadSummary, messages, memberEvents, matches }) {
  const uploadId = uploadSummary.upload_id;

  await deleteSupabaseRows(KAKAO_TABLES.matches, 'csv_upload_id', uploadId);
  await deleteSupabaseRows(KAKAO_TABLES.events, 'upload_id', uploadId);
  await deleteSupabaseRows(KAKAO_TABLES.messages, 'upload_id', uploadId);

  await upsertSupabaseRows(KAKAO_TABLES.uploads, [uploadSummary], 'upload_id');
  await upsertSupabaseRows(KAKAO_TABLES.messages, messages, 'message_id');
  await upsertSupabaseRows(KAKAO_TABLES.events, memberEvents, 'message_id');
  await upsertSupabaseRows(KAKAO_TABLES.matches, matches, 'csv_upload_id,raw_order_stable_id');
}

async function replaceSupabaseMatches(uploadId, matches) {
  await deleteSupabaseRows(KAKAO_TABLES.matches, 'csv_upload_id', uploadId);
  await upsertSupabaseRows(KAKAO_TABLES.matches, matches, 'csv_upload_id,raw_order_stable_id');
}

async function updateSupabaseUploadSummary(summary) {
  await upsertSupabaseRows(KAKAO_TABLES.uploads, [summary], 'upload_id');
}

async function readSupabaseRows(tableName, buildQuery, options = {}) {
  if (options.paginate === false) {
    const query = buildQuery(supabaseAdmin.from(tableName));
    const { data, error } = await query;
    if (error) {
      if (isMissingSupabaseKakaoTableError(error)) {
        console.warn(`Supabase table missing: ${tableName}. Run docs/supabase-kakao-csv-schema.sql`);
        return [];
      }
      throw error;
    }
    return data || [];
  }

  const pageSize = Number(options.pageSize || 1000);
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const query = buildQuery(supabaseAdmin.from(tableName)).range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) {
      if (isMissingSupabaseKakaoTableError(error)) {
        console.warn(`Supabase table missing: ${tableName}. Run docs/supabase-kakao-csv-schema.sql`);
        return [];
      }
      throw error;
    }

    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function deleteSupabaseRows(tableName, columnName, value) {
  const { error } = await supabaseAdmin
    .from(tableName)
    .delete()
    .eq(columnName, value);

  if (error) throw withSupabaseSchemaHint(error);
}

async function upsertSupabaseRows(tableName, rows, onConflict, chunkSize = 500) {
  if (!rows.length) return;
  const dbRows = rows.map(row => pickSupabaseColumns(tableName, row));

  for (let i = 0; i < dbRows.length; i += chunkSize) {
    const { error } = await supabaseAdmin
      .from(tableName)
      .upsert(dbRows.slice(i, i + chunkSize), { onConflict });

    if (error) throw withSupabaseSchemaHint(error);
  }
}

function pickSupabaseColumns(tableName, row) {
  const columns = KAKAO_DB_COLUMNS[tableName];
  if (!columns) return row;

  return columns.reduce((picked, column) => {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      picked[column] = row[column];
    }
    return picked;
  }, {});
}

function withSupabaseSchemaHint(error) {
  if (!isMissingSupabaseKakaoTableError(error)) return error;

  const wrapped = new Error(
    'Supabase 카톡 CSV 테이블이 없습니다. docs/supabase-kakao-csv-schema.sql을 Supabase SQL Editor에서 먼저 실행해주세요.'
  );
  wrapped.statusCode = 500;
  wrapped.cause = error;
  return wrapped;
}

function isMissingSupabaseKakaoTableError(error) {
  return error?.code === 'PGRST205' || /Could not find the table/i.test(error?.message || '');
}

function normalizeUploadRecord(row) {
  return {
    uploadId: clean(row.upload_id),
    fileHash: clean(row.file_hash),
    storeName: clean(row.store_name),
    orderDate: clean(row.order_date),
    startAt: clean(row.start_at),
    endAt: clean(row.end_at),
    uploadedAt: clean(row.uploaded_at),
    source: clean(row.source),
    fileName: clean(row.file_name),
    fileSize: toNumber(row.file_size),
    mimeType: clean(row.mime_type),
    messageCount: toNumber(row.message_count),
    windowMessageCount: toNumber(row.window_message_count),
    joinCount: toNumber(row.join_count),
    leaveCount: toNumber(row.leave_count),
    orderCandidateMessageCount: toNumber(row.order_candidate_message_count),
    rawOrderCount: toNumber(row.raw_order_count),
    matchedOrderCount: toNumber(row.matched_order_count),
    unmatchedCsvOrderCount: toNumber(row.unmatched_csv_order_count),
    unmatchedRawOrderCount: toNumber(row.unmatched_raw_order_count),
    avgOrderedAt: clean(row.avg_ordered_at),
    firstOrderedAt: clean(row.first_ordered_at),
    firstOrderAfterMinutes:
      row.first_order_after_minutes == null || row.first_order_after_minutes === ''
        ? null
        : toNumber(row.first_order_after_minutes),
    notes: clean(row.notes)
  };
}

function normalizeMessageRecord(row) {
  return {
    uploadId: clean(row.upload_id),
    messageId: clean(row.message_id),
    fileHash: clean(row.file_hash),
    storeName: clean(row.store_name),
    orderDate: clean(row.order_date),
    messageAt: clean(row.message_at),
    messageAtDate: parseDateTime(row.message_at),
    dateRaw: clean(row.date_raw),
    csvRowNumber: toNumber(row.csv_row_number),
    messageIndex: toNumber(row.message_index),
    userName: clean(row.user_name),
    normalizedUser: clean(row.normalized_user),
    message: clean(row.message),
    messageType: clean(row.message_type),
    memberSubject: clean(row.member_subject),
    source: clean(row.source)
  };
}

function normalizeEventRecord(row) {
  return {
    uploadId: clean(row.upload_id),
    messageId: clean(row.message_id),
    eventType: clean(row.event_type),
    memberSubject: clean(row.member_subject),
    messageAt: clean(row.message_at),
    messageAtDate: parseDateTime(row.message_at),
    dateRaw: clean(row.date_raw),
    userName: clean(row.user_name),
    normalizedUser: clean(row.normalized_user) || normalizeName(row.member_subject || row.user_name),
    message: clean(row.message)
  };
}

function normalizeMatchRecord(row) {
  return {
    uploadId: clean(row.csv_upload_id),
    csvMessageId: clean(row.csv_message_id),
    rawOrderStableId: clean(row.raw_order_stable_id),
    storeName: clean(row.store_name),
    orderDate: clean(row.order_date),
    customerName: clean(row.customer_name),
    normalizedCustomer: clean(row.normalized_customer),
    productName: clean(row.product_name),
    normalizedProductName: clean(row.normalized_product_name),
    quantity: toNumber(row.quantity),
    occurrenceIndex: toNumber(row.occurrence_index),
    actualOrderedAt: clean(row.actual_ordered_at),
    actualOrderedAtDate: parseDateTime(row.actual_ordered_at),
    messageRaw: clean(row.message_raw),
    matchConfidence: toNumber(row.match_confidence),
    matchMethod: clean(row.match_method),
    matchedAt: clean(row.matched_at),
    currentSourceRowNumber: toNumber(row.current_source_row_number),
    sourceSheetName: clean(row.source_sheet_name)
  };
}

function uploadToMeta(upload) {
  return {
    uploadId: upload.uploadId,
    fileHash: upload.fileHash,
    storeName: upload.storeName || STORE_NAME,
    orderDate: upload.orderDate,
    startAt: upload.startAt,
    endAt: upload.endAt,
    uploadedAt: upload.uploadedAt,
    source: upload.source || 'google_apps_script',
    fileName: upload.fileName,
    fileSize: upload.fileSize,
    mimeType: upload.mimeType
  };
}

function messageToPipelineObject(message) {
  return {
    upload_id: message.uploadId,
    message_id: message.messageId,
    file_hash: message.fileHash,
    store_name: message.storeName,
    order_date: message.orderDate,
    message_at: message.messageAt,
    message_sort_time: message.messageAtDate ? message.messageAtDate.getTime() : message.messageIndex,
    date_raw: message.dateRaw,
    csv_row_number: message.csvRowNumber,
    message_index: message.messageIndex,
    user_name: message.userName,
    normalized_user: message.normalizedUser,
    message: message.message,
    message_type: message.messageType,
    member_subject: message.memberSubject,
    source: message.source
  };
}

function eventToDbObject(event) {
  return {
    upload_id: event.uploadId,
    message_id: event.messageId,
    event_type: event.eventType,
    member_subject: event.memberSubject,
    message_at: event.messageAt,
    date_raw: event.dateRaw,
    user_name: event.userName,
    normalized_user: event.normalizedUser,
    message: event.message
  };
}

function isInsideWindow(message, meta) {
  const messageDate = parseDateTime(message.message_at || message.messageAt);
  if (!messageDate) return true;
  const start = parseDateTime(meta.startAt);
  const end = parseDateTime(meta.endAt);
  if (start && messageDate.getTime() < start.getTime()) return false;
  if (end && messageDate.getTime() > end.getTime()) return false;
  return true;
}

function getFileContent(body) {
  if (body.fileContent != null) return String(body.fileContent);
  if (body.base64File) return Buffer.from(String(body.base64File), 'base64').toString('utf8');
  return '';
}

function makeUploadId({ fileHash, storeName, orderDate, startAt, endAt }) {
  return `kcu_${sha256([fileHash, storeName, orderDate, startAt, endAt].join('|')).slice(0, 24)}`;
}

function getFirstOrderedAt(matches) {
  const first = [...matches]
    .filter(match => match.actual_ordered_at)
    .sort((a, b) => String(a.actual_ordered_at).localeCompare(String(b.actual_ordered_at)))[0];
  return first?.actual_ordered_at || '';
}

function getAverageOrderedAt(matches) {
  const dates = matches
    .map(match => parseDateTime(match.actual_ordered_at))
    .filter(Boolean);
  if (!dates.length) return '';
  const avg = dates.reduce((sum, date) => sum + date.getTime(), 0) / dates.length;
  return formatDateTime(new Date(avg));
}

function getFirstOrderAfterMinutes(meta, matches) {
  const start = parseDateTime(meta.startAt);
  const first = parseDateTime(getFirstOrderedAt(matches));
  if (!start || !first) return '';
  return Math.max(0, Math.round((first.getTime() - start.getTime()) / 60000));
}

function parseDateTime(value) {
  const raw = clean(value);
  if (!raw) return null;
  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  const date = new Date(
    Number(nums[0]),
    Number(nums[1]) - 1,
    Number(nums[2]),
    Number(nums[3] || 0),
    Number(nums[4] || 0),
    Number(nums[5] || 0)
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateTimeText(value) {
  const date = parseDateTime(value);
  return date ? formatDateTime(date) : clean(value);
}

function normalizeDateKey(value) {
  const date = parseDateTime(value);
  if (date) return toDateKey(date);
  const raw = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return '';
}

function dateKeyToNumber(value) {
  const key = normalizeDateKey(value);
  return key ? Number(key.replace(/-/g, '')) : 0;
}

function dateValueToDateKey(value) {
  const raw = clean(value);
  if (!/^\d{8}$/.test(raw)) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function formatDateTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function normalizeMessageForMatch(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '');
}

function normalizeName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
}

function normalizeProduct(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/\s+/g, '');
}

function diceCoefficient(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  left.forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
  let intersection = 0;
  right.forEach(token => {
    const count = counts.get(token) || 0;
    if (!count) return;
    counts.set(token, count - 1);
    intersection += 1;
  });
  return (2 * intersection) / (left.length + right.length);
}

function bigrams(value) {
  const text = String(value || '');
  if (text.length < 2) return text ? [text] : [];
  const result = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    result.push(text.slice(i, i + 2));
  }
  return result;
}

function hashText(value) {
  return sha256(String(value || ''));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function findHeaderIndex(header, candidates) {
  for (const candidate of candidates) {
    const index = header.findIndex(item => item === candidate || item.includes(candidate));
    if (index >= 0) return index;
  }
  return -1;
}

function toNumber(value) {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
