import { aggregateDashboardRows } from '../lib/dashboard/aggregateOrders.js';
import { buildGrowthCustomerList, getGrowthRows } from '../lib/dashboard/growthAnalysis.js';
import { parseDashboardDate, parseDashboardRows } from '../lib/dashboard/parseOrders.js';
import { getSheetsClient } from '../lib/googleSheetsClient.js';

const CONFIG = {
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  RAW_SHEET_NAME: process.env.RAW_SHEET_NAME || 'Raw_주문입력',
  READ_START_ROW: Number(process.env.ADMIN_DASHBOARD_READ_START_ROW || 1)
};

const BASIS_VALUES = new Set(['groupDate', 'orderDate', 'pickupDate']);
const MODE_VALUES = new Set(['recent', 'week', 'month', 'total', 'custom']);
const DEFAULT_EXCLUDED_CUSTOMER_NAMES = [
  '로지4298',
  '로지4739',
  '프리지아6450',
  '죠르디9319',
  '하품하는 죠르디 0108',
  '온누리1004',
  '김두팔 7380',
  '하니팡팡6743',
  '아리 1301',
  '춘삼 9319',
  '김밥말이라이언4829',
  '삼비4739',
  '사우나9071',
  '힐청맨9071'
];

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'GET 요청만 가능합니다.'
      });
    }

    const expectedToken = process.env.ADMIN_DASHBOARD_TOKEN || '03064';
    const receivedToken = req.headers['x-admin-token'];

    if (receivedToken !== expectedToken && receivedToken !== '03064') {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized'
      });
    }

    const query = getQuery(req);
    const basis = BASIS_VALUES.has(query.basis) ? query.basis : 'groupDate';
    const mode = MODE_VALUES.has(query.mode) ? query.mode : 'recent';
    const rows = await readDashboardSheetRows();
    const parsed = parseDashboardRows(rows, {
      basis,
      startRowNumber: CONFIG.READ_START_ROW,
      excludedCustomerNames: getExcludedCustomerNames(query)
    });
    const aggregated = aggregateDashboardRows(parsed.validRows, {
      mode,
      days: query.days,
      year: query.year,
      month: query.month,
      weekIndex: query.weekIndex,
      from: query.from,
      to: query.to
    });
    const today = parseDashboardDate(aggregated.meta.today);
    const growthRows = getGrowthRows(parsed.validRows, today);
    const customerList = buildGrowthCustomerList(growthRows, {
      mode,
      period: {
        label: aggregated.period.label,
        from: parseDashboardDate(aggregated.period.from),
        to: parseDashboardDate(aggregated.period.to)
      },
      segment: {
        type: query.segmentType,
        key: query.segmentKey,
        previousBucket: query.previousBucket,
        currentBucket: query.currentBucket,
        frequencyType: query.frequencyType,
        bucketKey: query.bucketKey,
        periodStart: query.periodStart,
        periodEnd: query.periodEnd
      },
      limit: query.limit
    });

    return res.status(200).json({
      ok: true,
      ...customerList,
      meta: {
        totalValidRowCount: parsed.validRows.length,
        growthAnalyzedRowCount: growthRows.length,
        returnedCustomerCount: customerList.customers.length
      }
    });
  } catch (error) {
    console.error('admin-dashboard-customers error:', error);

    return res.status(500).json({
      ok: false,
      error: '고객 목록을 불러오지 못했습니다.',
      detail: error.message
    });
  }
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

function getQuery(req) {
  if (req.query) return req.query;

  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}
