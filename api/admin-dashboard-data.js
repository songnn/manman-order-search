import { google } from 'googleapis';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateDashboardRows } from '../lib/dashboard/aggregateOrders.js';
import { parseDashboardRows } from '../lib/dashboard/parseOrders.js';

loadLocalEnv();

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  READ_START_ROW: Number(
    process.env.ADMIN_DASHBOARD_READ_START_ROW ||
      process.env.RAW_READ_START_ROW ||
      1
  )
};

const BASIS_VALUES = new Set(['groupDate', 'orderDate', 'pickupDate']);
const DEFAULT_EXCLUDED_CUSTOMER_NAMES = [
  '로지4298',
  '로지4739',
  '프리지아6450',
  '죠르디9319',
  '하품하는 죠르디 0108',
  '온누리1004',
  '김두팔 7380',
  '하니팡팡6743'
];

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'GET 요청만 가능합니다.'
      });
    }

    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN;
    const receivedToken = req.headers['x-admin-token'];

    if (!expectedToken || receivedToken !== expectedToken) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const query = getQuery(req);
    const basis = BASIS_VALUES.has(query.basis) ? query.basis : 'groupDate';
    const excludedCustomerNames = getExcludedCustomerNames(query);
    const rows = await readDashboardSheetRows();
    const parsed = parseDashboardRows(rows, {
      basis,
      startRowNumber: CONFIG.READ_START_ROW,
      excludedCustomerNames
    });
    const aggregated = aggregateDashboardRows(parsed.validRows, {
      from: query.from,
      to: query.to
    });

    return res.status(200).json({
      ok: true,
      basis,
      sheetName: CONFIG.RAW_SHEET_NAME,
      summary: aggregated.summary,
      series: aggregated.series,
      rankings: aggregated.rankings,
      warnings: parsed.warnings,
      meta: {
        ...aggregated.meta,
        validRowCount: parsed.validRows.length,
        warningCount: parsed.warnings.length,
        readStartRow: CONFIG.READ_START_ROW,
        excludedAllyRowCount: parsed.excludedAllyRowCount,
        excludedCustomerNames
      }
    });
  } catch (error) {
    console.error('admin-dashboard-data error:', error);

    return res.status(500).json({
      ok: false,
      error: '관리자 대시보드 데이터를 불러오지 못했습니다.',
      detail: error.message
    });
  }
}

function getExcludedCustomerNames(query) {
  if (!Object.prototype.hasOwnProperty.call(query, 'excludedCustomers')) {
    return DEFAULT_EXCLUDED_CUSTOMER_NAMES;
  }

  const raw = Array.isArray(query.excludedCustomers)
    ? query.excludedCustomers[0]
    : query.excludedCustomers;

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeCustomerNames(parsed);
  } catch {
    // Fallback to comma-separated values below.
  }

  return sanitizeCustomerNames(String(raw).split(','));
}

function sanitizeCustomerNames(names) {
  return Array.from(
    new Set(
      names
        .map(name => String(name == null ? '' : name).trim())
        .filter(Boolean)
    )
  );
}

async function getSheetsClient() {
  if (!process.env.GOOGLE_CLIENT_EMAIL) {
    throw new Error('GOOGLE_CLIENT_EMAIL 환경변수가 없습니다.');
  }

  if (!process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_PRIVATE_KEY 환경변수가 없습니다.');
  }

  if (!CONFIG.SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID 환경변수가 없습니다.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  return google.sheets({ version: 'v4', auth });
}

async function readDashboardSheetRows() {
  const sheets = await getSheetsClient();
  const start = Math.max(1, Number(CONFIG.READ_START_ROW || 1));

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: `${CONFIG.RAW_SHEET_NAME}!A${start}:J`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  return response.data.values || [];
}

function getQuery(req) {
  if (req.query) return req.query;

  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function loadLocalEnv() {
  const envPath = join(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf8');

  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;

    const [, key, rawValue] = match;
    if (process.env[key]) return;

    process.env[key] = unquoteEnvValue(rawValue);
  });
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
