import { searchOrders } from '../lib/orders.js';

const STORE_DISPLAY_NAME = '만만마켓 잠원메이플자이점';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      message: 'GET 요청만 가능합니다.'
    });
  }

  try {
    const query = getQuery_(req);
    const phoneLast4 = sanitizeFourDigitInput_(query.phoneLast4 || query.keyword || '');
    const pickupDateKey = String(query.pickupDate || '').trim();
    const selectedCustomerLabel = String(query.customerLabel || query.selectedCustomerLabel || '').trim();

    if (!/^\d{4}$/.test(phoneLast4) || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDateKey)) {
      return res.status(400).json({
        ok: false,
        message: '휴대폰 끝 4자리와 픽업일 정보가 필요합니다.'
      });
    }

    const result = await searchOrders(phoneLast4, selectedCustomerLabel);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        message: result.message || '주문 정보를 불러오지 못했습니다.'
      });
    }

    if (result.requiresCustomerSelection) {
      return res.status(409).json({
        ok: false,
        message: '동일한 끝번호의 고객이 있어 고객 선택이 필요합니다.'
      });
    }

    const items = (result.items || []).filter(item => getDateKeyFromText_(item.pickupDate) === pickupDateKey);
    const pickupDate = dateFromKey_(pickupDateKey);

    if (!pickupDate || !items.length) {
      return res.status(404).json({
        ok: false,
        message: '해당 픽업일의 주문 상품이 없습니다.'
      });
    }

    const productHash = hashString_(JSON.stringify(items.map(item => ({
      productName: item.productName || '',
      quantity: Number(item.quantity || 0),
      price: Number(item.price || 0),
      pickupDate: item.pickupDate || ''
    }))));

    const calendar = createPickupCalendarIcs_({
      date: pickupDate,
      dateKey: pickupDateKey,
      customerKey: hashString_(result.selectedCustomerLabel || result.searched || phoneLast4),
      productHash,
      items
    });

    const filename = `manman-pickup-${pickupDateKey}.ics`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return res.status(200).send(calendar);
  } catch (error) {
    console.error('pickup-calendar error:', error);

    return res.status(500).json({
      ok: false,
      message: '캘린더 파일을 생성하지 못했습니다.',
      detail: error.message
    });
  }
}

function getQuery_(req) {
  return req.query || {};
}

function sanitizeFourDigitInput_(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 4);
}

function createPickupCalendarIcs_({ date, dateKey, customerKey, productHash, items }) {
  const productTypeCount = items.length;
  const totalQuantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const startDate = new Date(date);
  const endDate = new Date(date);

  startDate.setHours(10, 0, 0, 0);
  endDate.setDate(endDate.getDate() + 1);
  endDate.setHours(0, 0, 0, 0);

  const summary = `🛍️ [만만마켓 픽업] ${formatCalendarDateCompact_(date)} · 상품 ${productTypeCount}종 · 총 ${totalQuantity}개`;
  const description = buildPickupCalendarDescription_(date, items, productTypeCount, totalQuantity);
  const uid = `manman-pickup-${dateKey.replace(/-/g, '')}-${customerKey}-${productHash}@manmanmarket.store`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ManmanMarket//Pickup Calendar//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDateTime_(new Date())}`,
    `SUMMARY:${escapeIcsText_(summary)}`,
    `DESCRIPTION:${escapeIcsText_(description)}`,
    `LOCATION:${escapeIcsText_(STORE_DISPLAY_NAME)}`,
    `DTSTART:${formatIcsLocalDateTime_(startDate)}`,
    `DTEND:${formatIcsLocalDateTime_(endDate)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText_(summary)}`,
    'TRIGGER:PT0S',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText_(summary)}`,
    'TRIGGER;RELATED=START:PT3H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  return `${lines.map(foldIcsLine_).join('\r\n')}\r\n`;
}

function buildPickupCalendarDescription_(date, items, productTypeCount, totalQuantity) {
  const productLines = sortItems_(items).map(item => {
    const qty = Number(item.quantity || 0);
    return `✅ ${item.productName || '상품명 미정'}, ${qty}개`;
  });

  return [
    `🎈 ${STORE_DISPLAY_NAME} 픽업`,
    '',
    `🛍️ 픽업상품 : ${productTypeCount}종`,
    `🎁 총 개수 : ${totalQuantity}개`,
    '',
    '🍀 픽업상품 목록 🍀',
    '',
    ...productLines.flatMap(line => [line, ''])
  ].join('\n');
}

function sortItems_(items) {
  return [...items].sort((a, b) => {
    const aOrder = Number(a.orderDateValue || 0);
    const bOrder = Number(b.orderDateValue || 0);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.productName || '').localeCompare(String(b.productName || ''), 'ko');
  });
}

function formatCalendarDateCompact_(date) {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getMonth() + 1}/${date.getDate()}(${weekdays[date.getDay()]})`;
}

function formatCalendarDateLong_(date) {
  const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdays[date.getDay()]})`;
}

function formatIcsLocalDateTime_(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

function formatIcsDateTime_(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}

function escapeIcsText_(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldIcsLine_(line) {
  const parts = [];
  let current = '';

  for (const char of Array.from(String(line || ''))) {
    if (Buffer.byteLength(current + char, 'utf8') > 75) {
      parts.push(current);
      current = ` ${char}`;
    } else {
      current += char;
    }
  }

  if (current) parts.push(current);
  return parts.join('\r\n');
}

function dateFromKey_(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function getDateKeyFromText_(text) {
  const date = parseDateText_(text);
  if (!date) return '';

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function parseDateText_(text) {
  const raw = String(text || '').trim();
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
    month = Number(nums[0]);
    day = Number(nums[1]);
    year = inferYearForMonthDay_(month);
  }

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferYearForMonthDay_(month) {
  const today = getKstToday_();
  let year = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  if (currentMonth === 12 && month === 1) year += 1;
  if (currentMonth === 1 && month === 12) year -= 1;

  return year;
}

function getKstToday_() {
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

function hashString_(value) {
  const text = String(value || '');
  let hash = 5381;

  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }

  return (hash >>> 0).toString(36);
}
