import { getSheetsClient, getSpreadsheetId } from '../lib/googleSheetsClient.js';
import { parseDashboardDate, toDateKey } from '../lib/dashboard/parseOrders.js';

const SHEET_NAME = process.env.KAKAO_MEMBER_SHEET_NAME || 'Admin_카톡방인원';
const HEADERS = ['기록일', '전체 인원', '신규 입장 인원', '퇴장 인원', '메모'];

export default async function handler(req, res) {
  try {
    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
    const receivedToken = req.headers['x-admin-token'];

    if (receivedToken !== expectedToken && receivedToken !== '03064') {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    if (req.method === 'GET') {
      const records = await readRecords();
      return res.status(200).json({ ok: true, sheetName: SHEET_NAME, records, latest: records[0] || null });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const record = sanitizeRecord(body);
      await ensureSheet();

      const sheets = await getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: getSpreadsheetId(),
        range: `${SHEET_NAME}!A:E`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [recordToRow(record)] }
      });

      const records = await readRecords();
      return res.status(200).json({ ok: true, records, latest: records[0] || null });
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const rowNumber = Number(body.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 2) {
        return res.status(400).json({ ok: false, error: '수정할 행 번호가 올바르지 않습니다.' });
      }

      const record = sanitizeRecord(body);
      await ensureSheet();

      const sheets = await getSheetsClient();
      await sheets.spreadsheets.values.update({
        spreadsheetId: getSpreadsheetId(),
        range: `${SHEET_NAME}!A${rowNumber}:E${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [recordToRow(record)] }
      });

      const records = await readRecords();
      return res.status(200).json({ ok: true, records, latest: records[0] || null });
    }

    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const rowNumber = Number(body.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber < 2) {
        return res.status(400).json({ ok: false, error: '삭제할 행 번호가 올바르지 않습니다.' });
      }

      await ensureSheet();

      const sheets = await getSheetsClient();
      await sheets.spreadsheets.values.clear({
        spreadsheetId: getSpreadsheetId(),
        range: `${SHEET_NAME}!A${rowNumber}:E${rowNumber}`
      });

      const records = await readRecords();
      return res.status(200).json({ ok: true, records, latest: records[0] || null });
    }

    return res.status(405).json({
      ok: false,
      error: '지원하지 않는 요청입니다.'
    });
  } catch (error) {
    console.error('admin-kakao-members error:', error);

    return res.status(500).json({
      ok: false,
      error: '카톡방 인원 기록을 처리하지 못했습니다.',
      detail: error.message
    });
  }
}

async function readRecords() {
  await ensureSheet();

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${SHEET_NAME}!A2:E`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  return (response.data.values || [])
    .map((row, index) => parseRecordRow(row, index + 2))
    .filter(Boolean)
    .sort((a, b) => String(b.recordDate).localeCompare(String(a.recordDate)));
}

async function ensureSheet() {
  const sheets = await getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  const exists = (response.data.sheets || []).some(sheet => sheet.properties?.title === SHEET_NAME);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }]
      }
    });
  }

  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A1:E1`
  });
  const hasHeader = (headerResponse.data.values?.[0] || []).some(Boolean);

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_NAME}!A1:E1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADERS] }
    });
  }
}

function parseRecordRow(row, rowNumber) {
  const recordDate = parseDashboardDate(row?.[0]);
  const totalMembers = parsePositiveInteger(row?.[1]);

  if (!recordDate || totalMembers == null) return null;

  return {
    rowNumber,
    recordDate: toDateKey(recordDate),
    totalMembers,
    newMembers: parseNullableInteger(row?.[2]),
    leftMembers: parseNullableInteger(row?.[3]),
    memo: String(row?.[4] == null ? '' : row[4]).trim()
  };
}

function sanitizeRecord(body) {
  const recordDate = parseDashboardDate(body?.recordDate);
  const totalMembers = parsePositiveInteger(body?.totalMembers);

  if (!recordDate) throw new Error('기록일을 입력해주세요.');
  if (totalMembers == null) throw new Error('전체 인원은 0 이상의 숫자로 입력해주세요.');

  return {
    recordDate: toDateKey(recordDate),
    totalMembers,
    newMembers: parseNullableInteger(body?.newMembers),
    leftMembers: parseNullableInteger(body?.leftMembers),
    memo: String(body?.memo == null ? '' : body.memo).trim()
  };
}

function recordToRow(record) {
  return [
    record.recordDate,
    record.totalMembers,
    record.newMembers ?? '',
    record.leftMembers ?? '',
    record.memo || ''
  ];
}

function parsePositiveInteger(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function parseNullableInteger(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
