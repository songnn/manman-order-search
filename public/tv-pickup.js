const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1152;
const API_URL = '/api/tv-pickup';
const REFRESH_INTERVAL_MS = 30 * 1000;
const PAGE_INTERVAL_MS = 18 * 1000;
const CACHE_KEY = 'manman-tv-pickup-v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_FALLBACK_URL = '/store-purchase-icon.png';
const STORAGE_ASSETS = Object.freeze({
  '상온': {
    dark: '/storage-dark-ambient.svg',
    white: '/storage-ambient.webp',
    zoneId: 'ambientZone',
    elementId: 'ambientProducts',
    countId: 'ambientCount'
  },
  '냉장': {
    dark: '/storage-dark-refrigerated.svg',
    white: '/storage-refrigerated-a2ca1185.webp',
    compactWhite: '/storage-refrigerated-78e338ae.webp',
    zoneId: 'chilledZone',
    elementId: 'chilledProducts',
    countId: 'chilledCount'
  },
  '냉동': {
    dark: '/storage-dark-frozen-v3-electric.svg',
    white: '/storage-frozen.webp',
    zoneId: 'frozenZone',
    elementId: 'frozenProducts',
    countId: 'frozenCount'
  }
});
const STORAGE_TYPES = ['상온', '냉장', '냉동'];

const state = {
  data: null,
  fingerprint: '',
  pageIndex: 0,
  pageCount: 1,
  pageTimer: 0,
  layoutFrame: 0,
  refreshTimer: 0,
  tenOClockTimer: 0,
  zoneRows: 5,
  zoneCapacities: { '상온': 40, '냉장': 40, '냉동': 40 },
  loading: false
};

const elements = {
  canvas: document.getElementById('tvCanvas'),
  pickupDate: document.getElementById('pickupDate'),
  updateTime: document.getElementById('updateTime'),
  summaryCards: document.getElementById('summaryCards'),
  pageIndicator: document.getElementById('pageIndicator')
};

function fillViewport() {
  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const scale = Math.min(
    viewportWidth / DESIGN_WIDTH,
    viewportHeight / DESIGN_HEIGHT
  );
  const logicalWidth = Math.ceil(viewportWidth / scale);
  const logicalHeight = Math.ceil(viewportHeight / scale);

  elements.canvas.style.setProperty('--tv-canvas-width', `${logicalWidth}px`);
  elements.canvas.style.setProperty('--tv-canvas-height', `${logicalHeight}px`);
  elements.canvas.style.setProperty('--tv-canvas-scale', String(scale));
}

function handleViewportChange() {
  fillViewport();
  scheduleZoneLayout();
}

async function loadBoardData(options = {}) {
  if (state.loading) return;
  state.loading = true;

  try {
    const response = await fetch(API_URL, {
      cache: 'no-cache',
      headers: { Accept: 'application/json' }
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.message || '픽업 안내 데이터를 불러오지 못했습니다.');
    }

    saveCachedPayload(payload);
    applyPayload(payload, options);
  } catch (error) {
    console.warn('tv pickup refresh failed:', error);
    if (!state.data) {
      const cached = readCachedPayload();
      if (cached) applyPayload({ ...cached, stale: true }, { force: true });
    }
    markStale();
  } finally {
    state.loading = false;
  }
}

function applyPayload(payload, options = {}) {
  const fingerprint = buildFingerprint(payload);
  const changed = options.force || fingerprint !== state.fingerprint;
  state.data = payload;

  if (changed) {
    state.fingerprint = fingerprint;
    state.pageIndex = 0;
    state.pageCount = getPageCount(payload.items || []);
    renderBoard();
    startPageRotation();
    return;
  }

  renderHeader(payload);
}

function renderBoard() {
  const data = state.data;
  if (!data) return;

  renderHeader(data);
  renderSummary(data.summary || {});

  const grouped = groupItems(data.items || []);
  STORAGE_TYPES.forEach(storageType => {
    renderZone(storageType, grouped[storageType] || [], data.summary || {});
  });

  elements.pageIndicator.hidden = state.pageCount <= 1;
  elements.pageIndicator.textContent = `${state.pageIndex + 1}/${state.pageCount}`;
  scheduleZoneLayout();
}

function renderHeader(data) {
  elements.pickupDate.textContent = data.effectiveDateLabel || data.effectiveDate || '픽업일 확인 중';
  const updateLabel = formatUpdateTime(data.updatedAt || data.generatedAt);
  const fallbackLabel = data.isFallbackDate ? ' · 직전 영업일 유지' : '';
  const staleLabel = data.stale ? ' · 마지막 정상 정보' : '';
  elements.updateTime.textContent = `${updateLabel}${fallbackLabel}${staleLabel}`;
  elements.updateTime.classList.toggle('is-stale', Boolean(data.stale));
}

function renderSummary(summary) {
  const total = Number(summary.totalProducts || 0);
  const ready = Number(summary.readyProducts || 0);
  const pending = Number(summary.pendingProducts || 0);
  const byStorage = summary.byStorage || {};

  elements.summaryCards.innerHTML = [
    `<span class="summary-card summary-card--total">
      <strong>${number(total)}종</strong>
      <span>오늘 픽업 상품</span>
      <em>${pending > 0 ? `입고 대기 ${number(pending)}종` : `${number(ready)}종 준비 완료`}</em>
    </span>`,
    ...STORAGE_TYPES.map(storageType => {
      const asset = STORAGE_ASSETS[storageType];
      return `<span class="summary-card">
        <img src="${asset.white}" alt="">
        <strong>${number(byStorage[storageType] || 0)}</strong>
        <span>${storageType}</span>
      </span>`;
    })
  ].join('');
}

function renderZone(storageType, items, summary) {
  const config = STORAGE_ASSETS[storageType];
  const zone = document.getElementById(config.zoneId);
  const grid = document.getElementById(config.elementId);
  const count = document.getElementById(config.countId);
  const total = Number(summary.byStorage?.[storageType] || 0);
  const ready = Number(summary.readyByStorage?.[storageType] || 0);
  const capacity = Math.max(1, state.zoneCapacities[storageType] || 1);
  const start = state.pageIndex * capacity;
  const visibleItems = items.slice(start, start + capacity);

  zone.style.setProperty('--zone-weight', String(getZoneWeight(items.length, state.zoneRows)));
  count.textContent = ready === total
    ? `${number(total)}종`
    : `${number(ready)}/${number(total)}종`;
  grid.classList.remove('is-changing');

  if (visibleItems.length) {
    grid.innerHTML = visibleItems.map(renderProductCard).join('');
  } else {
    const isAnotherPage = items.length > 0 && state.pageIndex > 0;
    const message = isAnotherPage
      ? '이 보관존 상품은 이전 화면에 있습니다.'
      : total > ready
        ? `입고 확인 중 · 대기 ${number(total - ready)}종`
        : '오늘 해당 보관 상품이 없습니다.';
    grid.innerHTML = `<div class="product-empty">${escapeHtml(message)}</div>`;
  }

  window.requestAnimationFrame(() => grid.classList.add('is-changing'));
}

function renderProductCard(item) {
  const imageUrl = safeImageUrl(item.imageUrl);
  return `<article class="product-card" aria-label="${escapeHtml(item.displayName)}">
    <img
      class="product-card__image"
      src="${escapeHtml(imageUrl)}"
      alt=""
      referrerpolicy="no-referrer"
      onerror="this.onerror=null;this.src='${IMAGE_FALLBACK_URL}'"
    >
    <h2 class="product-card__name">${escapeHtml(item.displayName)}</h2>
  </article>`;
}

function groupItems(items) {
  const grouped = { '상온': [], '냉장': [], '냉동': [] };
  items.forEach(item => {
    if (grouped[item.storageType]) grouped[item.storageType].push(item);
  });
  return grouped;
}

function getPageCount(items) {
  const grouped = groupItems(items);
  return Math.max(
    1,
    ...STORAGE_TYPES.map(storageType =>
      Math.ceil(grouped[storageType].length / Math.max(1, state.zoneCapacities[storageType] || 1))
    )
  );
}

function getZoneWeight(itemCount, visibleRows = 5) {
  const rows = Math.max(1, Number(visibleRows || 0));
  return Math.max(1, Math.ceil(Number(itemCount || 0) / rows));
}

function calculateGridShape(gridWidth, gridHeight, cardWidth, cardHeight, gridGap) {
  const columns = Math.max(1, Math.floor((gridWidth + gridGap) / (cardWidth + gridGap)));
  const rows = Math.max(1, Math.floor((gridHeight + gridGap) / (cardHeight + gridGap)));
  return { columns, rows, capacity: columns * rows };
}

function calculateGridCapacity(gridWidth, gridHeight, cardWidth, cardHeight, gridGap) {
  return calculateGridShape(gridWidth, gridHeight, cardWidth, cardHeight, gridGap).capacity;
}

function scheduleZoneLayout() {
  if (state.layoutFrame) window.cancelAnimationFrame(state.layoutFrame);
  state.layoutFrame = window.requestAnimationFrame(() => {
    state.layoutFrame = 0;
    refreshZoneCapacities();
  });
}

function refreshZoneCapacities() {
  if (!state.data) return;

  const styles = window.getComputedStyle(elements.canvas);
  const cardWidth = parseFloat(styles.getPropertyValue('--product-card-width')) || 120;
  const cardHeight = parseFloat(styles.getPropertyValue('--product-card-height')) || 164;
  const gridGap = parseFloat(styles.getPropertyValue('--product-grid-gap')) || 8;
  const nextCapacities = {};
  let nextZoneRows = Infinity;
  let changed = false;

  STORAGE_TYPES.forEach(storageType => {
    const grid = document.getElementById(STORAGE_ASSETS[storageType].elementId);
    const shape = calculateGridShape(
      grid.clientWidth,
      grid.clientHeight,
      cardWidth,
      cardHeight,
      gridGap
    );
    nextCapacities[storageType] = shape.capacity;
    nextZoneRows = Math.min(nextZoneRows, shape.rows);
    if (shape.capacity !== state.zoneCapacities[storageType]) changed = true;
  });

  nextZoneRows = Number.isFinite(nextZoneRows) ? nextZoneRows : 1;
  if (nextZoneRows !== state.zoneRows) changed = true;
  if (!changed) return;

  state.zoneRows = nextZoneRows;
  state.zoneCapacities = nextCapacities;
  state.pageCount = getPageCount(state.data.items || []);
  if (state.pageIndex >= state.pageCount) state.pageIndex = 0;
  renderBoard();
  startPageRotation();
}

function startPageRotation() {
  if (state.pageTimer) window.clearInterval(state.pageTimer);
  state.pageTimer = 0;
  if (state.pageCount <= 1) return;

  state.pageTimer = window.setInterval(() => {
    state.pageIndex = (state.pageIndex + 1) % state.pageCount;
    renderBoard();
  }, PAGE_INTERVAL_MS);
}

function startAutoRefresh() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    loadBoardData().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

function scheduleTenOClockRefresh() {
  if (state.tenOClockTimer) window.clearTimeout(state.tenOClockTimer);
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA-u-hc-h23', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  const localNow = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  let nextTen = Date.UTC(parts.year, parts.month - 1, parts.day, 10, 0, 0);
  if (nextTen <= localNow) nextTen += 24 * 60 * 60 * 1000;
  const delay = Math.max(1000, nextTen - localNow + 250);

  state.tenOClockTimer = window.setTimeout(() => {
    loadBoardData({ force: true }).catch(() => {});
    scheduleTenOClockRefresh();
  }, delay);
}

function buildFingerprint(payload) {
  return JSON.stringify({
    effectiveDate: payload.effectiveDate,
    stale: Boolean(payload.stale),
    summary: payload.summary,
    items: (payload.items || []).map(item => [
      item.pickupDate,
      item.displayName,
      item.imageUrl,
      item.storageType,
      item.status,
      item.sortOrder,
      item.updatedAt
    ])
  });
}

function saveCachedPayload(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      payload
    }));
  } catch {
  }
}

function readCachedPayload() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!cached?.payload || Date.now() - Number(cached.savedAt || 0) > CACHE_MAX_AGE_MS) {
      return null;
    }
    return cached.payload;
  } catch {
    return null;
  }
}

function markStale() {
  if (!state.data) {
    elements.updateTime.textContent = '입고 데이터 연결을 다시 시도하고 있습니다.';
  } else {
    elements.updateTime.textContent = `${formatUpdateTime(state.data.updatedAt)} · 마지막 정상 정보`;
  }
  elements.updateTime.classList.add('is-stale');
}

function formatUpdateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '오전 10시 기준 자동 갱신';
  return `${new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)} 업데이트`;
}

function safeImageUrl(value) {
  const url = String(value || '').trim();
  return /^(?:https?:\/\/|\/(?!\/))/i.test(url) ? url : IMAGE_FALLBACK_URL;
}

function number(value) {
  return new Intl.NumberFormat('ko-KR').format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

handleViewportChange();
window.addEventListener('resize', handleViewportChange, { passive: true });
window.visualViewport?.addEventListener('resize', handleViewportChange, { passive: true });
window.addEventListener('focus', () => loadBoardData().catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadBoardData().catch(() => {});
});

const cachedPayload = readCachedPayload();
if (cachedPayload) applyPayload({ ...cachedPayload, stale: true }, { force: true });
loadBoardData({ force: true }).catch(() => {});
startAutoRefresh();
scheduleTenOClockRefresh();
