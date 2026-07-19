const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1152;
const API_URL = '/api/tv-pickup';
const REFRESH_INTERVAL_MS = 30 * 1000;
const PAGE_INTERVAL_MS = 18 * 1000;
const CACHE_KEY = 'manman-tv-pickup-v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VISIBLE_PRODUCTS = 40;
const MAX_LAYOUT_ROWS = 8;
const IMAGE_FALLBACK_URL = '/store-purchase-icon.png';
const STORAGE_ASSETS = Object.freeze({
  '상온': {
    dark: '/storage-dark-ambient.svg',
    white: '/storage-ambient.webp',
    zoneId: 'ambientZone',
    elementId: 'ambientProducts'
  },
  '냉장': {
    dark: '/storage-dark-refrigerated.svg',
    white: '/storage-refrigerated-a2ca1185.webp',
    compactWhite: '/storage-refrigerated-78e338ae.webp',
    zoneId: 'chilledZone',
    elementId: 'chilledProducts'
  },
  '냉동': {
    dark: '/storage-dark-frozen-v3-electric.svg',
    white: '/storage-frozen.webp',
    zoneId: 'frozenZone',
    elementId: 'frozenProducts'
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
  zoneRows: 4,
  zoneColumns: { '상온': 1, '냉장': 1, '냉동': 1 },
  zoneCapacities: { '상온': 4, '냉장': 4, '냉동': 4 },
  loading: false
};

const elements = {
  canvas: document.getElementById('tvCanvas'),
  pickupDate: document.getElementById('pickupDate'),
  updateTime: document.getElementById('updateTime'),
  zonesLayout: document.getElementById('zonesLayout'),
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

  const grouped = groupItems(data.items || []);
  STORAGE_TYPES.forEach(storageType => {
    renderZone(storageType, grouped[storageType] || []);
  });

  elements.pageIndicator.hidden = state.pageCount <= 1;
  elements.pageIndicator.textContent = `${state.pageIndex + 1}/${state.pageCount}`;
  scheduleZoneLayout();
}

function renderHeader(data) {
  elements.pickupDate.textContent = data.effectiveDateLabel || data.effectiveDate || '픽업일 확인 중';
  const updateLabel = formatUpdateTime(data.updatedAt || data.generatedAt);
  const staleLabel = data.stale ? ' · 마지막 정상 정보' : '';
  elements.updateTime.textContent = `${updateLabel}${staleLabel}`;
  elements.updateTime.classList.toggle('is-stale', Boolean(data.stale));
}

function renderZone(storageType, items) {
  const config = STORAGE_ASSETS[storageType];
  const zone = document.getElementById(config.zoneId);
  const grid = document.getElementById(config.elementId);
  const columns = Math.max(1, state.zoneColumns[storageType] || 1);
  const capacity = Math.max(1, state.zoneCapacities[storageType] || 1);
  const start = state.pageIndex * capacity;
  const visibleItems = items.slice(start, start + capacity);

  zone.style.setProperty('--zone-columns', String(columns));
  grid.classList.remove('is-changing');

  if (visibleItems.length) {
    grid.innerHTML = visibleItems.map(renderProductCard).join('');
  } else {
    const isAnotherPage = items.length > 0 && state.pageIndex > 0;
    const message = isAnotherPage
      ? '이 보관존 상품은 이전 화면에 있습니다.'
      : '오늘 해당 보관 상품이 없습니다.';
    grid.innerHTML = `<div class="product-empty">${escapeHtml(message)}</div>`;
  }

  window.requestAnimationFrame(() => {
    clampProductNames(grid);
    grid.classList.add('is-changing');
  });
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
    <h2 class="product-card__name">
      <span
        class="product-card__name-text"
        data-full-name="${escapeHtml(item.displayName)}"
        title="${escapeHtml(item.displayName)}"
      >${escapeHtml(item.displayName)}</span>
    </h2>
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

function getZoneColumnCount(itemCount, visibleRows = 4) {
  const rows = Math.max(1, Number(visibleRows || 0));
  return Math.max(1, Math.ceil(Number(itemCount || 0) / rows));
}

function limitLayoutItemCounts(itemCounts, maxTotal = MAX_VISIBLE_PRODUCTS) {
  const counts = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, Math.max(0, Number(itemCounts[storageType] || 0))])
  );
  const total = STORAGE_TYPES.reduce((sum, storageType) => sum + counts[storageType], 0);
  if (total <= maxTotal) return counts;

  const positiveTypes = STORAGE_TYPES.filter(storageType => counts[storageType] > 0);
  const limited = Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, 0]));
  positiveTypes.forEach(storageType => {
    limited[storageType] = 1;
  });

  const remaining = Math.max(0, maxTotal - positiveTypes.length);
  const shares = positiveTypes.map(storageType => {
    const exact = counts[storageType] / total * remaining;
    const base = Math.floor(exact);
    limited[storageType] += base;
    return { storageType, remainder: exact - base };
  }).sort((a, b) => b.remainder - a.remainder);
  const allocated = STORAGE_TYPES.reduce((sum, storageType) => sum + limited[storageType], 0);

  for (let index = 0; index < maxTotal - allocated; index += 1) {
    limited[shares[index % shares.length].storageType] += 1;
  }

  return limited;
}

function calculateZoneLayoutCandidate(itemCounts, visibleRows, layoutWidth, gridHeight, metrics) {
  const columns = {};
  const capacities = {};
  const cardWidths = {};
  const requiredHeights = {};
  const zoneGap = Number(metrics.zoneGap || 0);
  const gridGap = Number(metrics.gridGap || 0);
  const zoneInlineChrome = Number(metrics.zoneInlineChrome || 0);
  const productNameHeight = Number(metrics.productNameHeight || 0);

  STORAGE_TYPES.forEach(storageType => {
    columns[storageType] = getZoneColumnCount(itemCounts[storageType], visibleRows);
    capacities[storageType] = columns[storageType] * visibleRows;
  });

  const totalColumns = STORAGE_TYPES.reduce(
    (sum, storageType) => sum + columns[storageType],
    0
  );
  const usableLayoutWidth = Math.max(1, layoutWidth - zoneGap * (STORAGE_TYPES.length - 1));
  let score = Number.POSITIVE_INFINITY;
  let overflow = 0;

  STORAGE_TYPES.forEach(storageType => {
    const columnCount = columns[storageType];
    const zoneWidth = usableLayoutWidth * columnCount / totalColumns;
    const gridWidth = Math.max(1, zoneWidth - zoneInlineChrome);
    const cardWidth = Math.max(
      1,
      (gridWidth - gridGap * Math.max(0, columnCount - 1)) / columnCount
    );
    const itemCount = Number(itemCounts[storageType] || 0);
    const actualRows = itemCount > 0 ? Math.ceil(itemCount / columnCount) : 0;
    const requiredHeight = actualRows > 0
      ? actualRows * (cardWidth + productNameHeight) + (actualRows - 1) * gridGap
      : 0;

    cardWidths[storageType] = cardWidth;
    requiredHeights[storageType] = requiredHeight;
    score = Math.min(score, cardWidth);
    overflow = Math.max(overflow, requiredHeight - gridHeight);
  });

  return {
    rows: visibleRows,
    columns,
    capacities,
    cardWidths,
    requiredHeights,
    score,
    overflow,
    fits: overflow <= 0.5
  };
}

function chooseZoneLayout(itemCounts, layoutWidth, gridHeight, metrics) {
  const limitedCounts = limitLayoutItemCounts(itemCounts);
  let bestFit = null;
  let bestFallback = null;

  for (let rows = 1; rows <= MAX_LAYOUT_ROWS; rows += 1) {
    const candidate = calculateZoneLayoutCandidate(
      limitedCounts,
      rows,
      layoutWidth,
      gridHeight,
      metrics
    );

    if (candidate.fits && (!bestFit || candidate.score > bestFit.score + 0.5)) {
      bestFit = candidate;
    }
    if (
      !bestFallback ||
      candidate.overflow < bestFallback.overflow - 0.5 ||
      (Math.abs(candidate.overflow - bestFallback.overflow) <= 0.5 && candidate.score > bestFallback.score)
    ) {
      bestFallback = candidate;
    }
  }

  return bestFit || bestFallback;
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
  const grids = STORAGE_TYPES.map(storageType =>
    document.getElementById(STORAGE_ASSETS[storageType].elementId)
  );
  const layoutWidth = elements.zonesLayout.clientWidth;
  const gridHeight = Math.min(...grids.map(grid => grid.clientHeight));
  if (layoutWidth <= 0 || gridHeight <= 0) return;

  const grouped = groupItems(state.data.items || []);
  const itemCounts = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, grouped[storageType].length])
  );
  const layout = chooseZoneLayout(itemCounts, layoutWidth, gridHeight, {
    zoneGap: parseFloat(styles.getPropertyValue('--zone-layout-gap')) || 4,
    gridGap: parseFloat(styles.getPropertyValue('--product-grid-gap')) || 4,
    zoneInlineChrome: parseFloat(styles.getPropertyValue('--zone-inline-chrome')) || 10,
    productNameHeight: parseFloat(styles.getPropertyValue('--product-name-height')) || 42
  });
  if (!layout) return;

  const changed = layout.rows !== state.zoneRows || STORAGE_TYPES.some(storageType =>
    layout.columns[storageType] !== state.zoneColumns[storageType] ||
    layout.capacities[storageType] !== state.zoneCapacities[storageType]
  );
  if (!changed) {
    clampProductNames();
    return;
  }

  state.zoneRows = layout.rows;
  state.zoneColumns = layout.columns;
  state.zoneCapacities = layout.capacities;
  state.pageCount = getPageCount(state.data.items || []);
  if (state.pageIndex >= state.pageCount) state.pageIndex = 0;
  renderBoard();
  startPageRotation();
}

function clampProductNames(root = document) {
  root.querySelectorAll('.product-card__name-text').forEach(element => {
    const fullName = element.dataset.fullName || element.textContent || '';
    const characters = Array.from(fullName);
    element.textContent = fullName;

    const fits = () =>
      element.scrollHeight <= element.clientHeight + 1 &&
      element.scrollWidth <= element.clientWidth + 1;
    if (fits()) return;

    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      element.textContent = `${characters.slice(0, middle).join('').trimEnd()}…`;
      if (fits()) low = middle;
      else high = middle - 1;
    }
    element.textContent = `${characters.slice(0, low).join('').trimEnd()}…`;
  });
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
document.fonts?.ready.then(() => {
  clampProductNames();
  scheduleZoneLayout();
}).catch(() => {});
