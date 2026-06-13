const TOKEN_KEY = 'mm_admin_dashboard_token';
const ALLY_CUSTOMERS_KEY = 'mm_admin_dashboard_ally_customers';
const ALLY_CUSTOMERS_VERSION_KEY = 'mm_admin_dashboard_ally_customers_version';
const ALLY_CUSTOMERS_DEFAULT_VERSION = '2026-06-03-v2';
const DEFAULT_ALLY_CUSTOMERS = [
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
const RECENT_DAYS = [1, 3, 7, 14, 30];
const MODE_LABELS = {
  recent: '최근 기간',
  week: '주간',
  month: '월간',
  total: '누적 분석',
  custom: '직접 기간'
};
const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="116" height="116" viewBox="0 0 116 116">
      <rect width="116" height="116" rx="24" fill="#EEF2F7"/>
      <path d="M34 73l16-17 12 12 9-10 12 15H34z" fill="#B7C0CD"/>
      <circle cx="46" cy="43" r="7" fill="#CBD5E1"/>
    </svg>
  `);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  data: null,
  mode: 'recent',
  days: 7,
  basis: 'groupDate',
  weekYear: new Date().getFullYear(),
  weekMonth: new Date().getMonth() + 1,
  weekIndex: 1,
  monthYear: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  customFrom: '',
  customTo: '',
  totalView: 'customer',
  customerQuery: '',
  orderMetric: 'quantity',
  orderChart: null,
  revenueChart: null,
  loading: false,
  allyCustomers: []
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  seedDefaults();
  bindEvents();
  renderStaticControls();
  renderModePanels();
  renderAllyCustomers();

  if (state.token) {
    showApp();
    fetchDashboardData();
  } else {
    showAuth();
  }
});

function cacheElements() {
  els.auth = document.querySelector('[data-auth]');
  els.app = document.querySelector('[data-app]');
  els.authForm = document.querySelector('[data-auth-form]');
  els.tokenInput = document.querySelector('[data-token-input]');
  els.authError = document.querySelector('[data-auth-error]');
  els.basis = document.querySelector('[data-basis]');
  els.refresh = document.querySelector('[data-refresh]');
  els.logout = document.querySelector('[data-logout]');
  els.status = document.querySelector('[data-status]');
  els.modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
  els.modePanels = Array.from(document.querySelectorAll('[data-mode-panel]'));
  els.recentButtons = document.querySelector('[data-recent-buttons]');
  els.weekMonthButtons = document.querySelector('[data-week-month-buttons]');
  els.weekButtons = document.querySelector('[data-week-buttons]');
  els.monthYearButtons = document.querySelector('[data-month-year-buttons]');
  els.monthButtons = document.querySelector('[data-month-buttons]');
  els.totalViewButtons = Array.from(document.querySelectorAll('[data-total-view]'));
  els.customerSearchForm = document.querySelector('[data-customer-search-form]');
  els.customerSearch = document.querySelector('[data-customer-search]');
  els.customRangeForm = document.querySelector('[data-custom-range-form]');
  els.customFrom = document.querySelector('[data-custom-from]');
  els.customTo = document.querySelector('[data-custom-to]');
  els.currentPeriod = document.querySelector('[data-current-period]');
  els.orderMetric = document.querySelector('[data-order-metric]');
  els.orderCanvas = document.querySelector('[data-order-chart]');
  els.revenueCanvas = document.querySelector('[data-revenue-chart]');
  els.orderChartTitle = document.querySelector('[data-order-chart-title]');
  els.revenueChartTitle = document.querySelector('[data-revenue-chart-title]');
  els.customerQuantityTitle = document.querySelector('[data-customer-quantity-title]');
  els.customerRevenueTitle = document.querySelector('[data-customer-revenue-title]');
  els.productQuantityTitle = document.querySelector('[data-product-quantity-title]');
  els.productRevenueTitle = document.querySelector('[data-product-revenue-title]');
  els.customerQuantity = document.querySelector('[data-customer-quantity]');
  els.customerRevenue = document.querySelector('[data-customer-revenue]');
  els.productQuantity = document.querySelector('[data-product-quantity]');
  els.productRevenue = document.querySelector('[data-product-revenue]');
  els.totalDetailSection = document.querySelector('[data-total-detail-section]');
  els.customerDetail = document.querySelector('[data-customer-detail]');
  els.warningCount = document.querySelector('[data-warning-count]');
  els.warnings = document.querySelector('[data-warnings]');
  els.allyForm = document.querySelector('[data-ally-form]');
  els.allyInput = document.querySelector('[data-ally-input]');
  els.allyList = document.querySelector('[data-ally-list]');
  els.allyReset = document.querySelector('[data-ally-reset]');
}

function seedDefaults() {
  state.allyCustomers = loadAllyCustomers();
  els.customFrom.value = toInputDate(addDays(new Date(), -6));
  els.customTo.value = toInputDate(new Date());
}

function bindEvents() {
  els.authForm.addEventListener('submit', event => {
    event.preventDefault();
    const token = els.tokenInput.value.trim();

    if (!token) {
      els.authError.textContent = '관리자 토큰을 입력해주세요.';
      return;
    }

    state.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    showApp();
    fetchDashboardData();
  });

  els.refresh.addEventListener('click', () => fetchDashboardData());
  els.logout.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.data = null;
    showAuth();
  });

  els.basis.addEventListener('change', () => {
    state.basis = els.basis.value;
    fetchDashboardData();
  });

  els.modeButtons.forEach(button => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      state.customerQuery = state.mode === 'total' ? state.customerQuery : '';
      renderModePanels();
      fetchDashboardData();
    });
  });

  els.totalViewButtons.forEach(button => {
    button.addEventListener('click', () => {
      state.totalView = button.dataset.totalView;
      renderTotalViewButtons();
      renderDashboard();
    });
  });

  els.customerSearchForm.addEventListener('submit', event => {
    event.preventDefault();
    state.mode = 'total';
    state.customerQuery = els.customerSearch.value.trim();
    renderModePanels();
    fetchDashboardData();
  });

  els.customRangeForm.addEventListener('submit', event => {
    event.preventDefault();
    state.mode = 'custom';
    state.customFrom = els.customFrom.value;
    state.customTo = els.customTo.value;
    renderModePanels();
    fetchDashboardData();
  });

  els.orderMetric.addEventListener('change', () => {
    state.orderMetric = els.orderMetric.value;
    renderCharts();
  });

  els.allyForm.addEventListener('submit', event => {
    event.preventDefault();
    addAllyCustomer(els.allyInput.value);
  });

  els.allyReset.addEventListener('click', () => {
    state.allyCustomers = [...DEFAULT_ALLY_CUSTOMERS];
    saveAllyCustomers();
    renderAllyCustomers();
    fetchDashboardData();
  });
}

async function fetchDashboardData() {
  if (state.loading) return;

  state.loading = true;
  setStatus('데이터를 불러오는 중입니다...');

  try {
    const params = buildRequestParams();
    const response = await fetch(`/api/admin-dashboard-data?${params.toString()}`, {
      headers: {
        'x-admin-token': state.token
      }
    });
    const data = await response.json();

    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = '';
      showAuth('관리자 토큰이 없거나 올바르지 않습니다.');
      return;
    }

    if (!response.ok || !data.ok) {
      throw new Error(data.detail || data.error || '대시보드 데이터를 불러오지 못했습니다.');
    }

    state.data = data;
    hydrateSelectionFromOptions();
    renderDashboard();
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

function buildRequestParams() {
  const params = new URLSearchParams({
    mode: state.mode,
    basis: state.basis,
    excludedCustomers: JSON.stringify(state.allyCustomers)
  });

  if (state.mode === 'recent') {
    params.set('days', String(state.days));
  }

  if (state.mode === 'week') {
    params.set('year', String(state.weekYear));
    params.set('month', String(state.weekMonth));
    params.set('weekIndex', String(state.weekIndex));
  }

  if (state.mode === 'month') {
    params.set('year', String(state.monthYear));
    params.set('month', String(state.month));
  }

  if (state.mode === 'custom') {
    params.set('from', state.customFrom || els.customFrom.value);
    params.set('to', state.customTo || els.customTo.value);
  }

  if (state.mode === 'total' && state.customerQuery) {
    params.set('customerQuery', state.customerQuery);
  }

  return params;
}

function hydrateSelectionFromOptions() {
  const options = state.data?.options;
  if (!options) return;

  if (!options.months.some(item => item.year === state.weekYear && item.month === state.weekMonth)) {
    const last = options.months[options.months.length - 1];
    if (last) {
      state.weekYear = last.year;
      state.weekMonth = last.month;
      state.monthYear = last.year;
      state.month = last.month;
    }
  }
}

function renderDashboard() {
  if (!state.data) return;

  renderStaticControls();
  renderKpis();
  renderCharts();
  renderRankings();
  renderTotalDetail();
  renderWarnings();
  updateStatusLine();
}

function renderStaticControls() {
  renderModeButtons();
  renderRecentButtons();
  renderWeekMonthButtons();
  renderWeekButtons();
  renderMonthYearButtons();
  renderMonthButtons();
  renderTotalViewButtons();
}

function renderModeButtons() {
  els.modeButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.mode === state.mode);
  });
}

function renderModePanels() {
  els.modePanels.forEach(panel => {
    panel.classList.toggle('is-hidden', panel.dataset.modePanel !== state.mode);
  });
  renderModeButtons();
}

function renderRecentButtons() {
  els.recentButtons.innerHTML = RECENT_DAYS.map(days => `
    <button class="chip-button ${state.mode === 'recent' && state.days === days ? 'is-active' : ''}" type="button" data-days="${days}">
      ${days === 1 ? '어제' : `최근 ${days}일`}
    </button>
  `).join('');

  els.recentButtons.querySelectorAll('[data-days]').forEach(button => {
    button.addEventListener('click', () => {
      state.mode = 'recent';
      state.days = Number(button.dataset.days);
      renderModePanels();
      fetchDashboardData();
    });
  });
}

function renderWeekMonthButtons() {
  const months = getAvailableMonths();

  els.weekMonthButtons.innerHTML = months.map(item => `
    <button class="chip-button ${state.weekYear === item.year && state.weekMonth === item.month ? 'is-active' : ''}" type="button" data-year="${item.year}" data-month="${item.month}">
      ${item.year}년 ${item.month}월
    </button>
  `).join('');

  els.weekMonthButtons.querySelectorAll('[data-year]').forEach(button => {
    button.addEventListener('click', () => {
      state.mode = 'week';
      state.weekYear = Number(button.dataset.year);
      state.weekMonth = Number(button.dataset.month);
      state.weekIndex = 1;
      renderModePanels();
      fetchDashboardData();
    });
  });
}

function renderWeekButtons() {
  const ranges = getMonthWeekRanges(state.weekYear, state.weekMonth);
  if (!ranges.length) {
    els.weekButtons.innerHTML = '<div class="ranking-empty">어제까지 집계 가능한 주간 데이터가 없습니다.</div>';
    return;
  }

  if (ranges.length && state.weekIndex > ranges.length) {
    state.weekIndex = ranges.length;
  }

  els.weekButtons.innerHTML = ranges.map(range => `
    <button class="week-chip ${state.weekIndex === range.weekIndex ? 'is-active' : ''}" type="button" data-week-index="${range.weekIndex}">
      <span>${range.label}</span>
      <small>${range.rangeLabel}</small>
    </button>
  `).join('');

  els.weekButtons.querySelectorAll('[data-week-index]').forEach(button => {
    button.addEventListener('click', () => {
      state.mode = 'week';
      state.weekIndex = Number(button.dataset.weekIndex);
      renderModePanels();
      fetchDashboardData();
    });
  });
}

function renderMonthYearButtons() {
  const years = getAvailableYears();

  els.monthYearButtons.innerHTML = years.map(year => `
    <button class="chip-button ${state.monthYear === year ? 'is-active' : ''}" type="button" data-year="${year}">
      ${year}년
    </button>
  `).join('');

  els.monthYearButtons.querySelectorAll('[data-year]').forEach(button => {
    button.addEventListener('click', () => {
      state.mode = 'month';
      state.monthYear = Number(button.dataset.year);
      const firstMonth = getAvailableMonths().find(item => item.year === state.monthYear);
      if (firstMonth) state.month = firstMonth.month;
      renderModePanels();
      fetchDashboardData();
    });
  });
}

function renderMonthButtons() {
  const months = getAvailableMonths().filter(item => item.year === state.monthYear);

  els.monthButtons.innerHTML = months.map(item => `
    <button class="chip-button ${state.monthYear === item.year && state.month === item.month ? 'is-active' : ''}" type="button" data-year="${item.year}" data-month="${item.month}">
      ${item.month}월
    </button>
  `).join('');

  els.monthButtons.querySelectorAll('[data-month]').forEach(button => {
    button.addEventListener('click', () => {
      state.mode = 'month';
      state.monthYear = Number(button.dataset.year);
      state.month = Number(button.dataset.month);
      renderModePanels();
      fetchDashboardData();
    });
  });
}

function renderTotalViewButtons() {
  els.totalViewButtons.forEach(button => {
    button.classList.toggle('is-active', button.dataset.totalView === state.totalView);
  });
}

function renderKpis() {
  const summary = state.data.summary;
  const series = getChartSeries();

  setText('[data-kpi="quantity"]', `${formatNumber(summary.quantity)}개`);
  setText('[data-kpi="orderCount"]', `${formatNumber(summary.orderCount)}건`);
  setText('[data-kpi="revenue"]', formatWon(summary.revenue));
  setText('[data-kpi="customerCount"]', `${formatNumber(summary.customerCount)}명`);
  setText('[data-kpi="productCount"]', `${formatNumber(summary.productCount)}개`);
  renderSparkline('[data-sparkline="quantity"]', series.map(item => item.quantity));
  renderSparkline('[data-sparkline="orderCount"]', series.map(item => item.orderCount));
  renderSparkline('[data-sparkline="revenue"]', series.map(item => item.revenue));
  renderSparkline('[data-sparkline="customerCount"]', series.map(() => summary.customerCount));
  renderSparkline('[data-sparkline="productCount"]', series.map(() => summary.productCount));
}

function renderCharts() {
  if (!state.data || typeof Chart === 'undefined') return;

  const series = getChartSeries();
  const labels = series.map(item => getSeriesPointLabel(item));
  const orderLabel = state.orderMetric === 'quantity' ? '주문수량' : '주문건수';
  const orderData = series.map(item => item[state.orderMetric]);
  const revenueData = series.map(item => item.revenue);

  els.orderChartTitle.textContent =
    state.mode === 'total' ? '월별 주문수량 추이' : '일별 주문수량 그래프';
  els.revenueChartTitle.textContent =
    state.mode === 'total' ? '월별 주문금액 추이' : '일별 주문금액 그래프';

  state.orderChart = upsertLineChart(state.orderChart, els.orderCanvas, {
    labels,
    label: orderLabel,
    data: orderData,
    borderColor: '#0051A0',
    backgroundColor: 'rgba(0, 81, 160, 0.12)',
    yFormatter: value => formatNumber(value)
  });

  state.revenueChart = upsertLineChart(state.revenueChart, els.revenueCanvas, {
    labels,
    label: '주문금액',
    data: revenueData,
    borderColor: '#0F9F6E',
    backgroundColor: 'rgba(15, 159, 110, 0.12)',
    yFormatter: value => compactWon(value)
  });
}

function renderRankings() {
  const label = state.data.period?.label || MODE_LABELS[state.mode];
  const rankings = state.data.rankings;
  const isTotal = state.mode === 'total';

  els.customerQuantityTitle.textContent = isTotal
    ? '고객 누적 주문수량 TOP 10'
    : `${label} 고객 주문수량 TOP 10`;
  els.customerRevenueTitle.textContent = isTotal
    ? '고객 누적 주문금액 TOP 10'
    : `${label} 고객 주문금액 TOP 10`;
  els.productQuantityTitle.textContent = isTotal
    ? '상품 누적 주문수량 TOP 10'
    : `${label} 상품 주문수량 TOP 10`;
  els.productRevenueTitle.textContent = isTotal
    ? '상품 누적 매출 TOP 10'
    : `${label} 상품 매출 TOP 10`;

  renderCustomerRanking(els.customerQuantity, rankings.customersByQuantity || [], 'quantity');
  renderCustomerRanking(els.customerRevenue, rankings.customersByRevenue || [], 'revenue');
  renderProductRanking(els.productQuantity, rankings.productsByQuantity || [], 'quantity');
  renderProductRanking(els.productRevenue, rankings.productsByRevenue || [], 'revenue');
}

function renderCustomerRanking(container, items, metric) {
  if (!items.length) {
    container.innerHTML = emptyRankingMessage();
    return;
  }

  container.innerHTML = items.slice(0, 10).map(item => {
    const value = metric === 'revenue' ? formatWon(item.revenue) : `${formatNumber(item.quantity)}개`;
    return `
      <article class="ranking-item">
        <span class="rank-badge">${item.rank}</span>
        <div class="ranking-main">
          <p class="ranking-title">${escapeHtml(item.customerName)}</p>
          <div class="ranking-meta">
            <span>수량 ${formatNumber(item.quantity)}개</span>
            <span>건수 ${formatNumber(item.orderCount)}건</span>
            <span>금액 ${formatWon(item.revenue)}</span>
            <span>마지막 ${formatDateShort(item.lastOrderDate)}</span>
          </div>
        </div>
        <strong class="ranking-value">${value}</strong>
      </article>
    `;
  }).join('');
}

function renderProductRanking(container, items, metric) {
  if (!items.length) {
    container.innerHTML = emptyRankingMessage();
    return;
  }

  container.innerHTML = items.slice(0, 10).map(item => {
    const value = metric === 'revenue' ? formatWon(item.revenue) : `${formatNumber(item.quantity)}개`;
    const imageUrl = item.imageUrl || PLACEHOLDER_IMAGE;
    return `
      <article class="ranking-item">
        <span class="rank-badge">${item.rank}</span>
        <img class="product-thumb" src="${escapeAttribute(imageUrl)}" alt="" loading="lazy" decoding="async" onerror="this.src='${PLACEHOLDER_IMAGE}'" />
        <div class="ranking-main">
          <p class="ranking-title">${escapeHtml(item.productName)}</p>
          <div class="ranking-meta">
            <span>수량 ${formatNumber(item.quantity)}개</span>
            <span>건수 ${formatNumber(item.orderCount)}건</span>
            <span>고객 ${formatNumber(item.customerCount)}명</span>
            <span>마지막 ${formatDateShort(item.lastOrderDate)}</span>
          </div>
        </div>
        <strong class="ranking-value">${value}</strong>
      </article>
    `;
  }).join('');
}

function renderTotalDetail() {
  const shouldShow = state.mode === 'total';
  els.totalDetailSection.classList.toggle('is-hidden', !shouldShow);

  if (!shouldShow) return;

  if (state.totalView === 'product') {
    els.customerDetail.innerHTML = `
      <div class="panel-head">
        <div>
          <p class="eyebrow">Products</p>
          <h2>상품 누적 분석</h2>
        </div>
      </div>
      <p class="ally-description">상품 누적 랭킹은 위 상품 주문수량/매출 TOP 10에서 확인할 수 있습니다. 상세 검색은 다음 단계에서 확장할 수 있도록 API 구조를 준비해 두었습니다.</p>
    `;
    return;
  }

  const detail = state.data.totals?.customerDetail;

  if (!state.customerQuery) {
    els.customerDetail.innerHTML = `
      <div class="panel-head">
        <div>
          <p class="eyebrow">Customer Search</p>
          <h2>고객 누적 상세</h2>
        </div>
      </div>
      <div class="ranking-empty">고객명 또는 뒤 4자리를 검색하면 누적 상세가 표시됩니다.</div>
    `;
    return;
  }

  if (!detail) {
    els.customerDetail.innerHTML = `
      <div class="panel-head">
        <div>
          <p class="eyebrow">Customer Search</p>
          <h2>검색 결과 없음</h2>
        </div>
      </div>
      <div class="ranking-empty">"${escapeHtml(state.customerQuery)}"에 해당하는 고객을 찾지 못했습니다.</div>
    `;
    return;
  }

  els.customerDetail.innerHTML = `
    <div class="panel-head">
      <div>
        <p class="eyebrow">Customer Detail</p>
        <h2>${escapeHtml(detail.customerName)}</h2>
      </div>
    </div>
    <div class="detail-summary">
      ${detailMetric('총 주문수량', `${formatNumber(detail.quantity)}개`)}
      ${detailMetric('총 주문건수', `${formatNumber(detail.orderCount)}건`)}
      ${detailMetric('총 주문금액', formatWon(detail.revenue))}
      ${detailMetric('평균 주문금액', formatWon(detail.averageOrderValue))}
      ${detailMetric('첫 주문일', formatDateShort(detail.firstOrderDate))}
      ${detailMetric('마지막 주문일', formatDateShort(detail.lastOrderDate))}
      ${detailMetric('최다 주문 상품', detail.topProduct || '-')}
      ${detailMetric('상품 종류 수', `${formatNumber(detail.productTypeCount)}종`)}
    </div>
    <div class="detail-grid">
      <section>
        <h3>많이 주문한 상품 TOP 5</h3>
        <div class="mini-list">
          ${(detail.topProducts || []).map(item => miniRow(item.productName, `${formatNumber(item.quantity)}개 · ${formatWon(item.revenue)}`)).join('') || emptyMiniRow()}
        </div>
      </section>
      <section>
        <h3>최근 주문 내역</h3>
        <div class="mini-list">
          ${(detail.recentOrders || []).map(item => miniRow(`${formatDateShort(item.date)} · ${item.productName}`, `${formatNumber(item.quantity)}개`)).join('') || emptyMiniRow()}
        </div>
      </section>
    </div>
  `;
}

function renderWarnings() {
  const warnings = state.data.warnings || [];
  const totalWarningCount = state.data.meta.totalWarningCount ?? warnings.length;
  els.warningCount.textContent = `선택 기간 ${formatNumber(warnings.length)}건 / 전체 ${formatNumber(totalWarningCount)}건`;

  if (!warnings.length) {
    els.warnings.innerHTML = '<div class="ranking-empty">확인 필요 데이터가 없습니다.</div>';
    return;
  }

  els.warnings.innerHTML = warnings.slice(0, 100).map(warning => `
    <article class="warning-item">
      <strong>${formatNumber(warning.rowNumber)}행</strong>
      <span>${escapeHtml(warning.reason)}</span>
      <span>${escapeHtml(warning.basisDate || '-')}</span>
      <span>${escapeHtml(warning.customerName || '-')} · ${escapeHtml(warning.productName || '-')}</span>
    </article>
  `).join('');
}

function renderAllyCustomers() {
  if (!els.allyList) return;

  if (!state.allyCustomers.length) {
    els.allyList.innerHTML = '<div class="ranking-empty">아군 제외 목록이 비어 있습니다.</div>';
    return;
  }

  els.allyList.innerHTML = state.allyCustomers.map((name, index) => `
    <span class="ally-chip">
      <span>${escapeHtml(name)}</span>
      <span class="ally-chip-actions">
        <button type="button" data-ally-edit="${index}">수정</button>
        <button type="button" data-ally-delete="${index}">삭제</button>
      </span>
    </span>
  `).join('');

  els.allyList.querySelectorAll('[data-ally-edit]').forEach(button => {
    button.addEventListener('click', () => editAllyCustomer(Number(button.dataset.allyEdit)));
  });

  els.allyList.querySelectorAll('[data-ally-delete]').forEach(button => {
    button.addEventListener('click', () => deleteAllyCustomer(Number(button.dataset.allyDelete)));
  });
}

function addAllyCustomer(value) {
  const name = String(value || '').trim();
  if (!name) return;

  if (state.allyCustomers.some(item => normalizeAllyName(item) === normalizeAllyName(name))) {
    els.allyInput.value = '';
    return;
  }

  state.allyCustomers = [...state.allyCustomers, name];
  els.allyInput.value = '';
  saveAllyCustomers();
  renderAllyCustomers();
  fetchDashboardData();
}

function editAllyCustomer(index) {
  const current = state.allyCustomers[index];
  if (!current) return;

  const next = window.prompt('수정할 아군 닉네임을 입력해주세요.', current);
  if (next == null) return;

  const name = next.trim();
  if (!name) return;

  state.allyCustomers = state.allyCustomers.map((item, itemIndex) =>
    itemIndex === index ? name : item
  );
  saveAllyCustomers();
  renderAllyCustomers();
  fetchDashboardData();
}

function deleteAllyCustomer(index) {
  state.allyCustomers = state.allyCustomers.filter((_, itemIndex) => itemIndex !== index);
  saveAllyCustomers();
  renderAllyCustomers();
  fetchDashboardData();
}

function upsertLineChart(chart, canvas, config) {
  const chartData = {
    labels: config.labels,
    datasets: [{
      label: config.label,
      data: config.data,
      borderColor: config.borderColor,
      backgroundColor: config.backgroundColor,
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 5,
      fill: true,
      tension: 0.34
    }]
  };

  if (chart) {
    chart.data = chartData;
    chart.options.scales.y.ticks.callback = config.yFormatter;
    chart.update();
    return chart;
  }

  return new Chart(canvas, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => `${config.label}: ${config.yFormatter(context.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#6B7280', maxTicksLimit: 9 }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#EEF2F7' },
          ticks: { color: '#6B7280', callback: config.yFormatter }
        }
      }
    }
  });
}

function getChartSeries() {
  if (!state.data) return [];
  if (state.mode === 'total') return state.data.series.monthly || [];
  return state.data.series.daily || [];
}

function getSeriesPointLabel(item) {
  if (item.month) return formatMonthLabel(item.month);
  return compactDate(item.date);
}

function getAvailableMonths() {
  const months = state.data?.options?.months || [];
  if (months.length) return months;

  const today = new Date();
  return [
    { year: today.getFullYear(), month: today.getMonth() + 1, label: `${today.getMonth() + 1}월` }
  ];
}

function getAvailableYears() {
  const years = state.data?.options?.years || [];
  if (years.length) return years;

  return [new Date().getFullYear()];
}

function getMonthWeekRanges(year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const reportEndDate = getReportEndDate();
  const ranges = [];
  let cursor = new Date(monthStart);

  while (cursor.getTime() <= monthEnd.getTime() && cursor.getTime() <= reportEndDate.getTime()) {
    const weekStart = startOfWeekMonday(cursor);
    const weekEnd = addDays(weekStart, 6);
    const from = weekStart.getTime() > monthStart.getTime() ? weekStart : monthStart;
    const monthClampedTo = weekEnd.getTime() < monthEnd.getTime() ? weekEnd : monthEnd;
    const to = monthClampedTo.getTime() < reportEndDate.getTime() ? monthClampedTo : reportEndDate;

    ranges.push({
      weekIndex: ranges.length + 1,
      label: `${month}월 ${ranges.length + 1}주차`,
      rangeLabel: `${from.getMonth() + 1}.${from.getDate()} ~ ${to.getMonth() + 1}.${to.getDate()}`
    });

    cursor = addDays(to, 1);
  }

  return ranges;
}

function getReportEndDate() {
  if (state.data?.meta?.reportEndDate) return parseLocalDate(state.data.meta.reportEndDate);

  return addDays(new Date(), -1);
}

function startOfWeekMonday(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function renderSparkline(selector, values) {
  const el = document.querySelector(selector);
  const sliced = values.slice(-14);

  if (!el || sliced.length < 2) {
    if (el) el.innerHTML = '';
    return;
  }

  const max = Math.max(...sliced);
  const min = Math.min(...sliced);
  const range = max - min || 1;
  const points = sliced.map((value, index) => {
    const x = (index / (sliced.length - 1)) * 100;
    const y = 34 - ((value - min) / range) * 28;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  el.innerHTML = `
    <svg viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${points.join(' ')}" fill="none" stroke="#0051A0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
    </svg>
  `;
}

function loadAllyCustomers() {
  const raw = localStorage.getItem(ALLY_CUSTOMERS_KEY);
  if (!raw) {
    localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(DEFAULT_ALLY_CUSTOMERS));
    localStorage.setItem(ALLY_CUSTOMERS_VERSION_KEY, ALLY_CUSTOMERS_DEFAULT_VERSION);
    return [...DEFAULT_ALLY_CUSTOMERS];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const savedVersion = localStorage.getItem(ALLY_CUSTOMERS_VERSION_KEY);
      const shouldMergeDefaults = savedVersion !== ALLY_CUSTOMERS_DEFAULT_VERSION;
      const customers = shouldMergeDefaults
        ? uniqueAllyCustomers([...parsed, ...DEFAULT_ALLY_CUSTOMERS])
        : uniqueAllyCustomers(parsed);

      localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(customers));
      localStorage.setItem(ALLY_CUSTOMERS_VERSION_KEY, ALLY_CUSTOMERS_DEFAULT_VERSION);
      return customers;
    }
  } catch {
    // Restore defaults below.
  }

  localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(DEFAULT_ALLY_CUSTOMERS));
  localStorage.setItem(ALLY_CUSTOMERS_VERSION_KEY, ALLY_CUSTOMERS_DEFAULT_VERSION);
  return [...DEFAULT_ALLY_CUSTOMERS];
}

function saveAllyCustomers() {
  state.allyCustomers = uniqueAllyCustomers(state.allyCustomers);
  localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(state.allyCustomers));
  localStorage.setItem(ALLY_CUSTOMERS_VERSION_KEY, ALLY_CUSTOMERS_DEFAULT_VERSION);
}

function uniqueAllyCustomers(names) {
  const seen = new Set();
  const result = [];

  names.forEach(name => {
    const cleanName = String(name == null ? '' : name).trim();
    const key = normalizeAllyName(cleanName);
    if (!cleanName || seen.has(key)) return;
    seen.add(key);
    result.push(cleanName);
  });

  return result;
}

function updateStatusLine() {
  const data = state.data;
  const pointCount = getChartSeries().length;

  els.currentPeriod.textContent = data.period?.label || '-';
  setStatus(
    `${data.sheetName} · ${MODE_LABELS[state.mode] || data.mode} · 기준 ${getBasisLabel(data.basis)} · 그래프 ${formatNumber(pointCount)}구간 · 오늘 제외 ${formatNumber(data.meta.excludedTodayRowCount)}행 · 아군 제외 ${formatNumber(data.meta.excludedAllyRowCount)}행 · 유효 ${formatNumber(data.meta.validRowCount)}행 · 확인 필요 ${formatNumber(data.meta.warningCount)}건`
  );
}

function showAuth(message = '') {
  els.auth.classList.remove('is-hidden');
  els.app.classList.add('is-hidden');
  els.authError.textContent = message;
  els.tokenInput.value = '';
  window.setTimeout(() => els.tokenInput.focus(), 0);
}

function showApp() {
  els.auth.classList.add('is-hidden');
  els.app.classList.remove('is-hidden');
  els.authError.textContent = '';
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('is-error', isError);
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value;
}

function detailMetric(label, value) {
  return `<div class="detail-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function miniRow(label, value) {
  return `<div class="mini-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function emptyMiniRow() {
  return '<div class="mini-row"><span>데이터 없음</span><strong>-</strong></div>';
}

function emptyRankingMessage() {
  return '<div class="ranking-empty">랭킹 데이터가 없습니다.</div>';
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function parseLocalDate(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return addDays(new Date(), -1);
  return new Date(year, month - 1, day);
}

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function compactDate(dateKey) {
  const [, month, day] = String(dateKey || '').split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : String(dateKey || '');
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || '').split('-');
  if (!year || !month) return String(monthKey || '');
  return `${Number(month)}월`;
}

function formatDateShort(dateKey) {
  if (!dateKey) return '-';
  const [year, month, day] = String(dateKey).split('-');
  if (!year || !month || !day) return String(dateKey);
  return `${Number(month)}/${Number(day)}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function formatWon(value) {
  return `${formatNumber(Math.round(Number(value || 0)))}원`;
}

function compactWon(value) {
  const n = Number(value || 0);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (n >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`;
  return formatWon(n);
}

function getBasisLabel(basis) {
  if (basis === 'pickupDate') return '픽업일자';
  if (basis === 'orderDate') return '주문일자';
  return '공구일자';
}

function normalizeAllyName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
