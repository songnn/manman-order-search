import {
  STORAGE_TYPES,
  buildAdaptiveProductPlan,
  chunkItemsIntoRows
} from './tv-pickup-layout.js';

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
const state = {
  data: null,
  fingerprint: '',
  pageIndex: 0,
  pageCount: 1,
  productPages: [{ '상온': [], '냉장': [], '냉동': [] }],
  productPlan: null,
  layoutSignature: '',
  pageTimer: 0,
  layoutFrame: 0,
  refreshTimer: 0,
  tenOClockTimer: 0,
  loading: false
};

const elements = {
  canvas: document.getElementById('tvCanvas'),
  pickupDate: document.getElementById('pickupDate'),
  updateTime: document.getElementById('updateTime'),
  summaryCards: document.getElementById('summaryCards'),
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
  if (state.data) scheduleProductLayout();
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
    refreshProductLayout();
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

  const grouped = state.productPages[state.pageIndex] || state.productPages[0] || groupItems([]);
  const pageLayout = state.productPlan?.pageLayouts[state.pageIndex]
    || state.productPlan?.pageLayouts[0]
    || null;
  applyPageLayout(pageLayout);
  elements.canvas.style.setProperty(
    '--product-card-size',
    `${Math.max(0, state.productPlan?.cardSize || 0)}px`
  );
  STORAGE_TYPES.forEach(storageType => {
    renderZone(storageType, grouped[storageType] || [], data.summary || {}, pageLayout);
  });

  elements.pageIndicator.hidden = state.pageCount <= 1;
  elements.pageIndicator.textContent = `${state.pageIndex + 1}/${state.pageCount}`;
}

function renderHeader(data) {
  elements.pickupDate.textContent = data.effectiveDateLabel || data.effectiveDate || '픽업일 확인 중';
  const updateLabel = formatUpdateTime(data.updatedAt || data.generatedAt);
  const staleLabel = data.stale ? ' · 마지막 정상 정보' : '';
  elements.updateTime.textContent = `${updateLabel}${staleLabel}`;
  elements.updateTime.classList.toggle('is-stale', Boolean(data.stale));
}

function renderSummary(summary) {
  const total = Number(summary.totalProducts || 0);
  const byStorage = summary.byStorage || {};

  elements.summaryCards.innerHTML = [
    `<span class="summary-card summary-card--total">
      <strong>${number(total)}종</strong>
      <span>총 픽업상품</span>
    </span>`,
    ...STORAGE_TYPES.map(storageType => {
      const asset = STORAGE_ASSETS[storageType];
      return `<span class="summary-card">
        <img src="${asset.white}" alt="">
        <strong>${number(byStorage[storageType] || 0)}종</strong>
        <span>${storageType}</span>
      </span>`;
    })
  ].join('');
}

function applyPageLayout(pageLayout) {
  const trackCount = Math.max(1, Number(pageLayout?.trackCount || 12));
  const rowHeights = Array.isArray(pageLayout?.rowHeights)
    ? pageLayout.rowHeights
    : [Math.max(1, elements.zonesLayout.clientHeight)];

  elements.zonesLayout.style.setProperty('--zone-grid-tracks', String(trackCount));
  elements.zonesLayout.style.gridTemplateRows = rowHeights
    .map(height => `${Math.max(1, Number(height || 0))}px`)
    .join(' ');
  elements.zonesLayout.dataset.layoutTemplate = pageLayout?.templateKey || 'stacked';
}

function renderZone(storageType, items, summary, pageLayout) {
  const config = STORAGE_ASSETS[storageType];
  const zone = document.getElementById(config.zoneId);
  const grid = document.getElementById(config.elementId);
  const count = document.getElementById(config.countId);
  const total = Number(summary.byStorage?.[storageType] || 0);
  const ready = Number(summary.readyByStorage?.[storageType] || 0);
  const visibleItems = items;
  const zoneLayout = pageLayout?.zones?.[storageType] || null;
  const columns = Math.max(1, Number(zoneLayout?.columns || 1));
  const fallbackZoneHeight = Math.max(1, elements.zonesLayout.clientHeight / STORAGE_TYPES.length);
  const zoneHeight = Math.max(1, Number(zoneLayout?.height || fallbackZoneHeight));
  const cardSize = Math.max(
    0,
    Number(zoneLayout?.cardSize || state.productPlan?.cardSize || 0)
  );
  const fallbackRow = STORAGE_TYPES.indexOf(storageType) + 1;

  zone.style.setProperty('--zone-height', `${zoneHeight}px`);
  zone.style.setProperty('--zone-card-size', `${cardSize}px`);
  zone.style.gridColumn = zoneLayout
    ? `${zoneLayout.columnStart} / span ${zoneLayout.columnSpan}`
    : '1 / -1';
  zone.style.gridRow = String(zoneLayout?.row || fallbackRow);
  zone.dataset.compactHeader = String(Boolean(zoneLayout?.compactHeader));
  count.textContent = ready === total
    ? `${number(total)}종`
    : `${number(ready)}/${number(total)}종`;
  grid.classList.remove('is-changing');
  grid.classList.toggle('is-empty', !visibleItems.length);

  if (visibleItems.length) {
    const rows = chunkItemsIntoRows(visibleItems, columns);
    grid.innerHTML = rows
      .map(row => `<div class="product-row" style="--row-columns: ${row.length}">
        ${row.map(renderProductCard).join('')}
      </div>`)
      .join('');
  } else {
    const isOnAnotherPage = total > 0 && state.pageCount > 1;
    const message = isOnAnotherPage
      ? '이 보관존 상품은 다른 화면에 있습니다.'
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

function scheduleProductLayout() {
  if (state.layoutFrame) window.cancelAnimationFrame(state.layoutFrame);
  state.layoutFrame = window.requestAnimationFrame(() => {
    state.layoutFrame = 0;
    const changed = refreshProductLayout();
    if (changed) {
      renderBoard();
      startPageRotation();
    } else {
      clampProductNames();
    }
  });
}

function readLayoutMetrics() {
  const styles = window.getComputedStyle(elements.canvas);
  return {
    zoneGap: parseFloat(styles.getPropertyValue('--zone-layout-gap')) || 4,
    gridGap: parseFloat(styles.getPropertyValue('--product-grid-gap')) || 4,
    zoneInlineChrome: parseFloat(styles.getPropertyValue('--zone-inline-chrome')) || 10,
    zoneBlockChrome: parseFloat(styles.getPropertyValue('--zone-block-chrome')) || 75,
    compactZoneBlockChrome:
      parseFloat(styles.getPropertyValue('--zone-compact-block-chrome')) || 139,
    zoneGridTracks: parseFloat(styles.getPropertyValue('--zone-grid-tracks')) || 12,
    minZoneTrackSpan:
      parseFloat(styles.getPropertyValue('--zone-min-track-span')) || 3,
    emptyZoneContentHeight: parseFloat(styles.getPropertyValue('--empty-zone-content-height')) || 24,
    productNameHeight: parseFloat(styles.getPropertyValue('--product-name-height')) || 42
  };
}

function refreshProductLayout() {
  if (!state.data) return false;

  const layoutWidth = elements.zonesLayout.clientWidth;
  const layoutHeight = elements.zonesLayout.clientHeight;
  if (layoutWidth <= 0 || layoutHeight <= 0) return false;

  const productPlan = buildAdaptiveProductPlan(
    state.data.items || [],
    layoutWidth,
    layoutHeight,
    readLayoutMetrics()
  );
  const layoutSignature = JSON.stringify({
    pageCount: productPlan.pageCount,
    cardSize: productPlan.cardSize,
    pageCounts: productPlan.pageCounts,
    pageLayouts: productPlan.pageLayouts.map(layout => ({
      templateKey: layout.templateKey,
      rowHeights: layout.rowHeights,
      zones: Object.fromEntries(STORAGE_TYPES.map(storageType => {
        const zone = layout.zones[storageType];
        return [storageType, {
          row: zone.row,
          columnStart: zone.columnStart,
          columnSpan: zone.columnSpan,
          columns: zone.columns,
          rows: zone.rows,
          cardSize: zone.cardSize,
          height: zone.height,
          compactHeader: zone.compactHeader
        }];
      }))
    }))
  });
  const changed = layoutSignature !== state.layoutSignature;

  state.productPlan = productPlan;
  state.productPages = productPlan.pages;
  state.pageCount = state.productPages.length;
  state.layoutSignature = layoutSignature;
  if (state.pageIndex >= state.pageCount) state.pageIndex = 0;
  return changed;
}

function clampProductNames(root = document) {
  root.querySelectorAll('.product-card__name-text').forEach(element => {
    const fullName = element.dataset.fullName || element.textContent || '';
    const characters = Array.from(fullName);
    element.textContent = fullName;

    const maximumTextHeight = Math.max(
      element.clientHeight,
      parseFloat(window.getComputedStyle(element).maxHeight) || 0
    );
    const fits = () =>
      element.scrollHeight <= maximumTextHeight + 4 &&
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
document.fonts?.ready.then(() => {
  clampProductNames();
}).catch(() => {});
