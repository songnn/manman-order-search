export const COLUMN_MAP = {
  groupDate: 0,
  price: 1,
  imageUrl: 2,
  orderDate: 3,
  customerName: 4,
  productName: 5,
  quantity: 6,
  pickupDate: 9
};

const EXCLUDED_PRODUCT_PREFIXES = ['⚠️', '❌'];

export function parseDashboardRows(rows, options = {}) {
  const columnMap = {
    ...COLUMN_MAP,
    ...(options.columnMap || {})
  };
  const basis = options.basis || 'groupDate';
  const baseDate = options.baseDate || getSeoulToday();
  const startRowNumber = Number(options.startRowNumber || 1);
  const warnings = [];
  const validRows = [];
  const hasHeader = looksLikeHeaderRow(rows?.[0]);

  (rows || []).forEach((row, rowIndex) => {
    if (hasHeader && rowIndex === 0) return;

    const rowNumber = startRowNumber + rowIndex;
    const raw = {
      groupDate: readCell(row, columnMap.groupDate),
      price: readCell(row, columnMap.price),
      imageUrl: readCell(row, columnMap.imageUrl),
      orderDate: readCell(row, columnMap.orderDate),
      customerName: readCell(row, columnMap.customerName),
      productName: readCell(row, columnMap.productName),
      quantity: readCell(row, columnMap.quantity),
      pickupDate: readCell(row, columnMap.pickupDate)
    };

    if (isEmptyRawRow(raw)) return;

    const customerName = clean(raw.customerName);
    const productName = clean(raw.productName);
    const imageUrl = clean(raw.imageUrl);
    const price = parsePrice(raw.price);
    const quantity = parseQuantity(raw.quantity);
    const groupDate = parseDashboardDate(raw.groupDate, baseDate);
    const orderDate = parseDashboardDate(raw.orderDate, baseDate);
    const pickupDate = parseDashboardDate(raw.pickupDate, baseDate);
    const basisDate = { groupDate, orderDate, pickupDate }[basis];
    const warningBase = {
      rowNumber,
      customerName,
      productName
    };

    if (!productName) {
      warnings.push({ ...warningBase, reason: '주문상품 없음' });
      return;
    }

    if (EXCLUDED_PRODUCT_PREFIXES.some(prefix => productName.startsWith(prefix))) {
      warnings.push({ ...warningBase, reason: '제외 상품 표시' });
      return;
    }

    if (price == null) {
      warnings.push({ ...warningBase, reason: '가격 없음 또는 숫자 아님' });
      return;
    }

    if (quantity == null) {
      warnings.push({ ...warningBase, reason: '수량 없음 또는 숫자 아님' });
      return;
    }

    if (quantity <= 0) {
      warnings.push({ ...warningBase, reason: '수량 0 이하' });
      return;
    }

    if (!basisDate) {
      warnings.push({ ...warningBase, reason: '기준 날짜 없음 또는 형식 오류' });
      return;
    }

    validRows.push({
      rowNumber,
      groupDate,
      orderDate,
      pickupDate,
      basisDate,
      price,
      revenue: price * quantity,
      imageUrl,
      customerName,
      productName,
      quantity,
      raw
    });
  });

  return { validRows, warnings };
}

export function parseDashboardDate(value, baseDate = getSeoulToday()) {
  if (value == null || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return normalizeDate(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return parseSerialDate(value);
  }

  const raw = clean(value);
  if (!raw) return null;

  const numeric = Number(raw);
  if (
    Number.isFinite(numeric) &&
    /^\d+(\.\d+)?$/.test(raw) &&
    numeric > 20000 &&
    numeric < 90000
  ) {
    return parseSerialDate(numeric);
  }

  const normalized = raw
    .replace(/\s+/g, ' ')
    .replace(/[년.]/g, '-')
    .replace(/월/g, '-')
    .replace(/일/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[./]/g, '-')
    .trim();

  const nums = normalized.match(/\d+/g);
  if (!nums || nums.length < 2) return null;

  let year;
  let month;
  let day;

  if (nums.length >= 3 && Number(nums[0]) > 999) {
    year = Number(nums[0]);
    month = Number(nums[1]);
    day = Number(nums[2]);
  } else {
    month = Number(nums[0]);
    day = Number(nums[1]);
    year = inferYearForMonthDay(month, day, baseDate);
  }

  if (!isValidDateParts(year, month, day)) return null;

  return new Date(year, month - 1, day);
}

export function parsePrice(value) {
  const raw = clean(value);
  if (!raw) return null;

  const normalized = raw.replace(/[^\d.-]/g, '');
  if (!normalized) return null;

  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseQuantity(value) {
  const raw = clean(value);
  if (!raw) return null;

  const normalized = raw.replace(/[^\d.-]/g, '');
  if (!normalized) return null;

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function getSeoulToday() {
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

export function toDateKey(date) {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function parseSerialDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400 * 1000;
  const date = new Date(utcValue);

  if (Number.isNaN(date.getTime())) return null;

  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function inferYearForMonthDay(month, day, baseDate) {
  let year = baseDate.getFullYear();
  const currentMonth = baseDate.getMonth() + 1;

  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return year;
}

function isValidDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function looksLikeHeaderRow(row) {
  if (!Array.isArray(row)) return false;
  const text = row.map(cell => clean(cell)).join('|');

  return /공구일자|가격|이미지|주문일자|고객명|주문상품|수량|픽업일/.test(text);
}

function isEmptyRawRow(raw) {
  return Object.values(raw).every(value => !clean(value));
}

function readCell(row, index) {
  if (!Array.isArray(row)) return '';
  return row[index] == null ? '' : row[index];
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
