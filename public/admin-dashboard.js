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
  weeklyFrequencyChart: null,
  monthlyFrequencyChart: null,
  drawerCustomers: [],
  drawerQuery: '',
  drawerSort: 'participation',
  loading: false,
  kakaoUploading: false,
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
  els.growthCurrentPeriod = document.querySelector('[data-growth-current-period]');
  els.growthPreviousPeriod = document.querySelector('[data-growth-previous-period]');
  els.growthProgress = document.querySelector('[data-growth-progress]');
  els.growthKpis = document.querySelector('[data-growth-kpis]');
  els.growthDrivers = document.querySelector('[data-growth-drivers]');
  els.growthDiagnosis = document.querySelector('[data-growth-diagnosis]');
  els.weeklyFrequencyCanvas = document.querySelector('[data-weekly-frequency-chart]');
  els.monthlyFrequencyCanvas = document.querySelector('[data-monthly-frequency-chart]');
  els.weeklyFrequencyMetrics = document.querySelector('[data-weekly-frequency-metrics]');
  els.monthlyFrequencyMetrics = document.querySelector('[data-monthly-frequency-metrics]');
  els.movementMetrics = document.querySelector('[data-movement-metrics]');
  els.movementMatrix = document.querySelector('[data-movement-matrix]');
  els.lifecycleCards = document.querySelector('[data-lifecycle-cards]');
  els.kakaoCsvStatus = document.querySelector('[data-kakao-csv-status]');
  els.kakaoCsvSummary = document.querySelector('[data-kakao-csv-summary]');
  els.kakaoHourBuckets = document.querySelector('[data-kakao-hour-buckets]');
  els.kakaoLeaveBuckets = document.querySelector('[data-kakao-leave-buckets]');
  els.kakaoMatchSamples = document.querySelector('[data-kakao-match-samples]');
  els.kakaoRecentLeavers = document.querySelector('[data-kakao-recent-leavers]');
  els.kakaoUploadDate = document.querySelector('[data-kakao-upload-date]');
  els.kakaoUploadStart = document.querySelector('[data-kakao-upload-start]');
  els.kakaoUploadFile = document.querySelector('[data-kakao-upload-file]');
  els.kakaoUploadFileLabel = document.querySelector('[data-kakao-upload-file-label]');
  els.kakaoUploadButton = document.querySelector('[data-kakao-upload-button]');
  els.kakaoUploadStatus = document.querySelector('[data-kakao-upload-status]');
  els.customerDrawer = document.querySelector('[data-customer-drawer]');
  els.customerDrawerTitle = document.querySelector('[data-customer-drawer-title]');
  els.customerDrawerSearch = document.querySelector('[data-customer-drawer-search]');
  els.customerDrawerSort = document.querySelector('[data-customer-drawer-sort]');
  els.customerDrawerExport = document.querySelector('[data-customer-drawer-export]');
  els.customerDrawerCount = document.querySelector('[data-customer-drawer-count]');
  els.customerDrawerList = document.querySelector('[data-customer-drawer-list]');
  els.customerDrawerCloseButtons = Array.from(document.querySelectorAll('[data-customer-drawer-close]'));
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
  if (els.kakaoUploadDate) els.kakaoUploadDate.value = toInputDate(new Date());
  if (els.kakaoUploadStart) els.kakaoUploadStart.value = '08:00';
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

  els.customerDrawerCloseButtons.forEach(button => {
    button.addEventListener('click', closeCustomerDrawer);
  });

  els.customerDrawerSearch.addEventListener('input', () => {
    state.drawerQuery = els.customerDrawerSearch.value.trim();
    renderCustomerDrawerList();
  });

  els.customerDrawerSort.addEventListener('change', () => {
    state.drawerSort = els.customerDrawerSort.value;
    renderCustomerDrawerList();
  });

  els.customerDrawerExport.addEventListener('click', exportDrawerCustomers);

  els.kakaoUploadFile?.addEventListener('change', () => {
    const file = els.kakaoUploadFile.files?.[0];
    if (!file) {
      els.kakaoUploadFileLabel.textContent = 'CSV/TXT 선택';
      return;
    }

    els.kakaoUploadFileLabel.textContent = file.name;
    const inferredDate = inferDateFromKakaoFileName(file.name);
    if (inferredDate && els.kakaoUploadDate) {
      els.kakaoUploadDate.value = inferredDate;
    }
    setKakaoUploadStatus('');
  });

  els.kakaoUploadButton?.addEventListener('click', handleKakaoCsvUpload);

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

async function handleKakaoCsvUpload() {
  if (state.kakaoUploading) return;

  const file = els.kakaoUploadFile?.files?.[0];
  const orderDate = els.kakaoUploadDate?.value || '';
  const startTime = els.kakaoUploadStart?.value || '08:00';

  if (!file) {
    setKakaoUploadStatus('CSV/TXT 파일을 선택해주세요.', true);
    return;
  }

  if (!orderDate) {
    setKakaoUploadStatus('공구날짜를 선택해주세요.', true);
    return;
  }

  state.kakaoUploading = true;
  els.kakaoUploadButton.disabled = true;
  setKakaoUploadStatus('업로드 중...');

  try {
    const fileContent = await readFileAsText(file);
    const response = await fetch('/api/kakao-csv-uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': state.token,
        'x-kakao-csv-token': state.token
      },
      body: JSON.stringify({
        fileContent,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'text/plain',
        storeName: '전농래미안크레시티점',
        orderDate,
        startAt: `${orderDate} ${startTime}`,
        endAt: `${nextInputDate(orderDate)} 00:00`,
        uploadedAt: formatLocalDateTime(new Date()),
        source: 'admin_dashboard_manual_upload'
      })
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.detail || data.error || 'CSV 업로드에 실패했습니다.');
    }

    setKakaoUploadStatus(
      `완료 · 메시지 ${formatNumber(data.windowMessageCount || data.messageCount || 0)}개 · 입장 ${formatNumber(data.joinCount || 0)} / 퇴장 ${formatNumber(data.leaveCount || 0)}`,
      false,
      true
    );
    await fetchDashboardData();
  } catch (error) {
    console.error(error);
    setKakaoUploadStatus(error.message, true);
  } finally {
    state.kakaoUploading = false;
    els.kakaoUploadButton.disabled = false;
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
  renderGrowthAnalysis();
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

function renderGrowthAnalysis() {
  const growth = state.data?.growthAnalysis;
  if (!growth) return;

  els.growthCurrentPeriod.textContent = formatPeriod(growth.currentPeriod);
  els.growthPreviousPeriod.textContent = formatPeriod(growth.previousPeriod);
  els.growthProgress.textContent = growth.isInProgress ? '진행 중 기간' : '완료 기간';
  els.growthDiagnosis.textContent = growth.diagnosis || '비교 가능한 이전 데이터가 부족합니다.';

  renderGrowthKpis(growth);
  renderGrowthDrivers(growth);
  renderFrequencyCharts();
  renderCustomerMovement();
  renderLifecycleCards();
  renderKakaoCsvAnalytics();
}

function renderGrowthKpis(growth) {
  const current = growth.current || {};
  const previous = growth.previous || {};
  const kpis = [
    ['공구매출', formatWon(current.revenue), formatWon(previous.revenue), growth.changes?.revenueRate, 'C × F × V'],
    ['구매 고객 수', `${formatNumber(current.activeCustomers)}명`, `${formatNumber(previous.activeCustomers)}명`, growth.changes?.customerRate, '선택 기간 1회 이상 구매'],
    ['활성 고객당 참여일수', `${formatDecimal(current.avgParticipationDays)}일`, `${formatDecimal(previous.avgParticipationDays)}일`, growth.changes?.frequencyRate, '고객별 서로 다른 공구일자'],
    ['활성 고객당 공구매출', formatWon(current.revenuePerActiveCustomer), formatWon(previous.revenuePerActiveCustomer), null, '공구매출 / 구매 고객 수'],
    ['참여 1일당 주문금액', formatWon(current.revenuePerParticipationDay), formatWon(previous.revenuePerParticipationDay), growth.changes?.valueRate, '공구매출 / 총 참여일수'],
    ['2회 이상 참여 고객', `${formatNumber(current.twoPlusCustomerCount)}명`, formatRate(current.twoPlusRate), null, '기간 내 2일 이상 참여 비율'],
    ['신규 구매 고객', `${formatNumber(current.newCustomerCount)}명`, '-', null, '전체 이력 최초 공구일자'],
    ['복귀 구매 고객', `${formatNumber(current.returningCustomerCount)}명`, '-', null, '직전 기간 미구매 후 재구매']
  ];

  els.growthKpis.innerHTML = kpis.map(([label, value, previousValue, change, note]) => `
    <article class="growth-kpi">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>이전 ${escapeHtml(previousValue)}${change == null ? '' : ` · ${formatSignedRate(change)}`}</small>
      <em>${escapeHtml(note)}</em>
    </article>
  `).join('');
}

function renderGrowthDrivers(growth) {
  const driver = growth.changes?.dominantDriver;
  const drivers = [
    ['customerRate', '구매 고객 수', 'customer'],
    ['frequencyRate', '고객당 참여일수', 'frequency'],
    ['valueRate', '참여 1일당 주문금액', 'value']
  ];

  els.growthDrivers.innerHTML = drivers.map(([key, label, driverKey]) => {
    const value = growth.changes?.[key];
    const isDominant = driver?.key === driverKey;

    return `
      <article class="driver-card ${isDominant ? 'is-dominant' : ''}">
        <span>${escapeHtml(label)}</span>
        <strong>${value == null ? '비교 불가' : formatSignedRate(value)}</strong>
        <small>${isDominant ? '주요 변화 요인' : '직전 동일 기간 대비'}</small>
      </article>
    `;
  }).join('');
}

function renderFrequencyCharts() {
  if (typeof Chart === 'undefined') return;

  const weekly = state.data?.participationFrequency?.weekly || [];
  const monthly = state.data?.participationFrequency?.monthly || [];

  state.weeklyFrequencyChart = upsertStackedBarChart(
    state.weeklyFrequencyChart,
    els.weeklyFrequencyCanvas,
    weekly,
    [
      ['one', '1일', '#0051A0'],
      ['two', '2일', '#0F9F6E'],
      ['three', '3일', '#F59E0B'],
      ['four', '4일', '#EF4444'],
      ['five', '5일', '#7C3AED'],
      ['six', '6일', '#0891B2'],
      ['seven', '7일', '#111827']
    ],
    'weekly'
  );

  state.monthlyFrequencyChart = upsertStackedBarChart(
    state.monthlyFrequencyChart,
    els.monthlyFrequencyCanvas,
    monthly,
    [
      ['one', '1회', '#0051A0'],
      ['two', '2회', '#0F9F6E'],
      ['three', '3회', '#F59E0B'],
      ['four', '4회', '#EF4444'],
      ['fiveToSeven', '5~7회', '#7C3AED'],
      ['eightToEleven', '8~11회', '#0891B2'],
      ['twelvePlus', '12회 이상', '#111827']
    ],
    'monthly'
  );

  renderFrequencyMetrics(els.weeklyFrequencyMetrics, weekly[weekly.length - 1], [
    ['1일 고객', item => `${formatNumber(item.buckets?.one)}명 · ${formatRate(item.oneRate)}`],
    ['2일 이상', item => formatRate(item.twoPlusRate)],
    ['3일 이상', item => formatRate(item.threePlusRate)],
    ['평균', item => `${formatDecimal(item.avgDays)}일`],
    ['중앙값', item => `${formatDecimal(item.medianDays)}일`]
  ]);

  renderFrequencyMetrics(els.monthlyFrequencyMetrics, monthly[monthly.length - 1], [
    ['1회 고객', item => `${formatNumber(item.buckets?.one)}명 · ${formatRate(item.oneRate)}`],
    ['2~3회', item => formatRate(percentLike((item.buckets?.two || 0) + (item.buckets?.three || 0), item.activeCustomers))],
    ['4회 이상', item => formatRate(item.fourPlusRate)],
    ['8회 이상', item => formatRate(item.eightPlusRate)],
    ['평균', item => `${formatDecimal(item.avgDays)}회`],
    ['중앙값', item => `${formatDecimal(item.medianDays)}회`]
  ]);
}

function renderFrequencyMetrics(container, item, metrics) {
  if (!item) {
    container.innerHTML = '<div class="ranking-empty compact-empty">빈도 데이터가 없습니다.</div>';
    return;
  }

  container.innerHTML = metrics.map(([label, getValue]) => `
    <div class="frequency-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(getValue(item))}</strong>
    </div>
  `).join('');
}

function renderCustomerMovement() {
  const movement = state.data?.customerMovement;
  if (!movement) return;

  const metrics = movement.metrics || {};
  const metricItems = [
    ['1회 → 2회+', metrics.oneToTwoPlusRate],
    ['2회+ 유지', metrics.twoPlusRetentionRate],
    ['2회+ → 1회', metrics.twoPlusToOneRate],
    ['활성 → 0회', metrics.churnRate],
    ['0회 → 활성', metrics.activationRate]
  ];

  els.movementMetrics.innerHTML = metricItems.map(([label, value]) => `
    <div class="movement-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${formatRate(value)}</strong>
    </div>
  `).join('');

  const currentLabels = ['0회', '1회', '2회', '3회 이상'];
  els.movementMatrix.innerHTML = `
    <div class="movement-cell movement-axis"></div>
    ${currentLabels.map(label => `<div class="movement-cell movement-axis">현재 ${label}</div>`).join('')}
    ${(movement.matrix || []).map(row => `
      <div class="movement-cell movement-axis">이전 ${escapeHtml(row.previousLabel)}</div>
      ${(row.cells || []).map(cell => `
        <button class="movement-cell movement-button" type="button" data-customer-segment="movement" data-previous-bucket="${escapeAttribute(row.previousBucket)}" data-current-bucket="${escapeAttribute(cell.currentBucket)}">
          <strong>${formatNumber(cell.count)}명</strong>
          <span>${formatRate(cell.rate)}</span>
        </button>
      `).join('')}
    `).join('')}
  `;

  els.movementMatrix.querySelectorAll('[data-customer-segment="movement"]').forEach(button => {
    button.addEventListener('click', () => openCustomerDrawerFromSegment({
      segmentType: 'movement',
      previousBucket: button.dataset.previousBucket,
      currentBucket: button.dataset.currentBucket
    }));
  });
}

function renderLifecycleCards() {
  const lifecycle = state.data?.lifecycle || {};
  const cards = [
    ['신규 고객', 'new', lifecycle.newCustomers?.count || 0],
    ['유지 고객', 'retained', lifecycle.retainedCustomers?.count || 0],
    ['복귀 고객', 'returning', lifecycle.returningCustomers?.count || 0],
    ['관심 필요 고객', 'atRisk', lifecycle.atRiskCustomers?.count || 0],
    ['휴면 고객', 'dormant', lifecycle.dormantCustomers?.count || 0],
    ['장기 휴면 고객', 'longDormant', lifecycle.longDormantCustomers?.count || 0]
  ];

  els.lifecycleCards.innerHTML = cards.map(([label, key, count]) => `
    <button class="lifecycle-card" type="button" data-customer-segment="lifecycle" data-segment-key="${escapeAttribute(key)}">
      <span>${escapeHtml(label)}</span>
      <strong>${formatNumber(count)}명</strong>
    </button>
  `).join('');

  els.lifecycleCards.querySelectorAll('[data-customer-segment="lifecycle"]').forEach(button => {
    button.addEventListener('click', () => openCustomerDrawerFromSegment({
      segmentType: 'lifecycle',
      segmentKey: button.dataset.segmentKey
    }));
  });
}

function renderKakaoCsvAnalytics() {
  const analytics = state.data?.kakaoCsvAnalytics;

  if (!analytics?.latestUpload) {
    if (els.kakaoCsvStatus) els.kakaoCsvStatus.textContent = 'CSV 기록 없음';
    if (els.kakaoCsvSummary) {
      els.kakaoCsvSummary.innerHTML =
        '<div class="ranking-empty compact-empty">아직 카톡 CSV 업로드 분석 기록이 없습니다.</div>';
    }
    if (els.kakaoHourBuckets) els.kakaoHourBuckets.innerHTML = '';
    if (els.kakaoLeaveBuckets) els.kakaoLeaveBuckets.innerHTML = '';
    if (els.kakaoMatchSamples) els.kakaoMatchSamples.innerHTML = '';
    if (els.kakaoRecentLeavers) els.kakaoRecentLeavers.innerHTML = '';
    return;
  }

  const latest = analytics.latestUpload;
  const events = analytics.memberEvents || {};
  const matching = analytics.matching || {};
  const latestDate = latest.orderDate || isoDateOnly(latest.uploadedAt);

  if (els.kakaoCsvStatus) {
    els.kakaoCsvStatus.textContent = `${formatDateShort(latestDate)} CSV 기준`;
  }

  if (els.kakaoCsvSummary) {
    els.kakaoCsvSummary.innerHTML = `
      ${kakaoMetric('최근 CSV', latest.fileName || latest.uploadId || '-')}
      ${kakaoMetric('CSV 주문 메시지', `${formatNumber(matching.csvOrderMessageCount || 0)}개`)}
      ${kakaoMetric('입장/퇴장', `${formatNumber(events.totalJoinCount || 0)}명 / ${formatNumber(events.totalLeaveCount || 0)}명`)}
      ${kakaoMetric('추정 현재 인원', `${formatNumber(events.estimatedCurrentMembers || 0)}명`)}
      ${kakaoMetric('입장 후 주문 전환율', formatRate(events.joinToOrderConversionRate || 0))}
      ${kakaoMetric('무구매 퇴장 비율', formatRate(events.recentZeroPurchaseLeaveRate || 0))}
      ${kakaoMetric('Raw 매칭', `${formatNumber(matching.matchedRawOrderCount || 0)} / ${formatNumber(matching.rawOrderCount || 0)}줄`)}
      ${kakaoMetric('미매칭 CSV/Raw', `${formatNumber(matching.unmatchedCsvOrderCount || 0)} / ${formatNumber(matching.unmatchedRawOrderCount || 0)}`)}
      ${kakaoMetric('평균 주문시각', compactDateTime(matching.avgOrderedAt))}
      ${kakaoMetric('첫 주문까지', matching.firstOrderAfterMinutes == null ? '-' : `${formatNumber(matching.firstOrderAfterMinutes)}분`)}
    `;
  }

  if (els.kakaoHourBuckets) {
    const hours = analytics.orderTimeline?.hourlyOrderCounts || [];
    els.kakaoHourBuckets.innerHTML = hours.length
      ? hours.map(item => `
          <article class="hour-bucket">
            <span>${escapeHtml(item.hour)}</span>
            <strong>${formatNumber(item.count)}건</strong>
          </article>
        `).join('')
      : '<div class="ranking-empty compact-empty">시간대별 실제 주문 데이터가 없습니다.</div>';
  }

  if (els.kakaoLeaveBuckets) {
    const buckets = analytics.leavePurchaseBuckets || [];
    els.kakaoLeaveBuckets.innerHTML = buckets.length
      ? buckets.map(bucket => `
          <article class="leave-bucket">
            <span>${escapeHtml(bucket.label)}</span>
            <strong>${formatNumber(bucket.count || 0)}명</strong>
            <small>${formatRate(bucket.rate || 0)}</small>
          </article>
        `).join('')
      : '<div class="ranking-empty compact-empty">최근 퇴장자 구매수 분포가 없습니다.</div>';
  }

  if (els.kakaoMatchSamples) {
    const samples = analytics.matchSamples || [];
    els.kakaoMatchSamples.innerHTML = samples.length
      ? `
        <div class="kakao-match-head">최근 매칭 결과</div>
        <div class="mini-list">
          ${samples.slice(0, 20).map(item => miniRow(
            `${item.customerName || '-'} · ${item.productName || '-'} × ${formatNumber(item.quantity || 0)}`,
            `${compactDateTime(item.actualOrderedAt)} · ${formatRate((item.matchConfidence || 0) * 100)} · ${item.matchMethod || '-'} · row ${item.currentSourceRowNumber || '-'}`
          )).join('')}
        </div>
      `
      : '<div class="ranking-empty compact-empty">매칭된 주문행이 없습니다.</div>';
  }

  if (els.kakaoRecentLeavers) {
    const leavers = analytics.recentLeavers || [];
    els.kakaoRecentLeavers.innerHTML = leavers.length
      ? `
        <div class="mini-list">
          ${leavers.slice(0, 20).map(item => miniRow(
            `${item.userName || '-'} · ${formatDateShort(isoDateOnly(item.leftAt) || item.leftAtRaw || '')}`,
            `누적 ${formatNumber(item.cumulativeQuantity || 0)}개 · ${formatWon(item.cumulativeRevenue || 0)}`
          )).join('')}
        </div>
      `
      : '<div class="ranking-empty compact-empty">최근 퇴장자 데이터가 없습니다.</div>';
  }
}

function kakaoMetric(label, value) {
  return `
    <div class="kakao-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
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

function upsertStackedBarChart(chart, canvas, items, buckets, frequencyType) {
  const labels = items.map(item => {
    const label = item.periodStart && item.periodEnd
      ? `${compactDate(item.periodStart)}~${compactDate(item.periodEnd)}`
      : '-';
    return item.isInProgress ? `${label} 진행 중` : label;
  });
  const datasets = buckets.map(([key, label, color]) => ({
    label,
    bucketKey: key,
    data: items.map(item => percentLike(item.buckets?.[key] || 0, item.activeCustomers)),
    counts: items.map(item => item.buckets?.[key] || 0),
    backgroundColor: color,
    borderRadius: 6,
    borderSkipped: false
  }));
  const chartData = { labels, datasets };
  const handleClick = (event, elements, chartInstance) => {
    const point = elements?.[0];
    if (!point) return;

    const item = items[point.index];
    const dataset = chartInstance.data.datasets[point.datasetIndex];
    if (!item || !dataset) return;

    openCustomerDrawerFromSegment({
      segmentType: 'frequency',
      frequencyType,
      bucketKey: dataset.bucketKey,
      periodStart: item.periodStart,
      periodEnd: item.periodEnd
    });
  };

  if (chart) {
    chart.data = chartData;
    chart.options.onClick = handleClick;
    chart.update();
    return chart;
  }

  return new Chart(canvas, {
    type: 'bar',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: true, mode: 'nearest' },
      onClick: handleClick,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 10,
            color: '#4B5563',
            font: { weight: 800 }
          }
        },
        tooltip: {
          callbacks: {
            label: context => {
              const count = context.dataset.counts?.[context.dataIndex] || 0;
              return `${context.dataset.label}: ${formatNumber(count)}명 · ${formatRate(context.parsed.y)}`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { color: '#6B7280', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }
        },
        y: {
          stacked: true,
          min: 0,
          max: 100,
          grid: { color: '#EEF2F7' },
          ticks: { color: '#6B7280', callback: value => `${value}%` }
        }
      }
    }
  });
}

async function openCustomerDrawerFromSegment(segmentParams) {
  openCustomerDrawer('고객 목록', [], true);

  try {
    const params = buildRequestParams();
    Object.entries(segmentParams || {}).forEach(([key, value]) => {
      if (value != null && value !== '') params.set(key, value);
    });
    params.set('limit', '500');

    const response = await fetch(`/api/admin-dashboard-customers?${params.toString()}`, {
      headers: {
        'x-admin-token': state.token
      }
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.detail || data.error || '고객 목록을 불러오지 못했습니다.');
    }

    openCustomerDrawer(data.title || '고객 목록', data.customers || []);
  } catch (error) {
    console.error(error);
    els.customerDrawerTitle.textContent = '고객 목록 오류';
    els.customerDrawerList.innerHTML = `
      <tr>
        <td colspan="7" class="customer-table-empty">${escapeHtml(error.message)}</td>
      </tr>
    `;
  }
}

function openCustomerDrawer(title, customers, isLoading = false) {
  state.drawerCustomers = Array.isArray(customers) ? customers : [];
  state.drawerQuery = '';
  els.customerDrawerTitle.textContent = title || '고객 목록';
  els.customerDrawerSearch.value = '';
  els.customerDrawerSort.value = state.drawerSort;
  els.customerDrawer.classList.add('is-open');
  els.customerDrawer.setAttribute('aria-hidden', 'false');

  if (isLoading) {
    els.customerDrawerCount.textContent = '불러오는 중';
    els.customerDrawerList.innerHTML = `
      <tr>
        <td colspan="7" class="customer-table-empty">고객 목록을 불러오는 중입니다...</td>
      </tr>
    `;
    return;
  }

  renderCustomerDrawerList();
}

function closeCustomerDrawer() {
  els.customerDrawer.classList.remove('is-open');
  els.customerDrawer.setAttribute('aria-hidden', 'true');
}

function renderCustomerDrawerList() {
  const customers = getVisibleDrawerCustomers();
  els.customerDrawerCount.textContent = `${formatNumber(customers.length)}명`;

  if (!customers.length) {
    els.customerDrawerList.innerHTML = `
      <tr>
        <td colspan="7" class="customer-table-empty">표시할 고객이 없습니다.</td>
      </tr>
    `;
    return;
  }

  els.customerDrawerList.innerHTML = customers.slice(0, 500).map(customer => `
    <tr>
      <td>${escapeHtml(customer.customerName || '-')}</td>
      <td>${escapeHtml(customer.customerDigits4 || '-')}</td>
      <td>${formatNumber(customer.currentParticipationDays)}일 / 이전 ${formatNumber(customer.previousParticipationDays)}일</td>
      <td>${formatWon(customer.currentRevenue)}</td>
      <td>${formatNumber(customer.cumulativeParticipationDays)}일 · ${formatWon(customer.cumulativeRevenue)}</td>
      <td>${escapeHtml((customer.recentProducts || []).join(', ') || '-')}</td>
      <td>${escapeHtml(customer.status || '-')}</td>
    </tr>
  `).join('');
}

function getVisibleDrawerCustomers() {
  const query = normalizeSearch(state.drawerQuery);
  const digits = String(state.drawerQuery || '').replace(/\D/g, '');
  const filtered = state.drawerCustomers.filter(customer => {
    if (!query && !digits) return true;

    const name = normalizeSearch(customer.customerName);
    const customerDigits = String(customer.customerDigits4 || customer.customerName || '').replace(/\D/g, '');

    return name.includes(query) || (digits && customerDigits.endsWith(digits.slice(-4)));
  });

  return [...filtered].sort((a, b) => {
    if (state.drawerSort === 'revenue') return (b.currentRevenue || 0) - (a.currentRevenue || 0);
    if (state.drawerSort === 'lastOrder') return String(b.lastOrderDate || '').localeCompare(String(a.lastOrderDate || ''));
    if (state.drawerSort === 'name') return String(a.customerName || '').localeCompare(String(b.customerName || ''), 'ko');

    if ((b.currentParticipationDays || 0) !== (a.currentParticipationDays || 0)) {
      return (b.currentParticipationDays || 0) - (a.currentParticipationDays || 0);
    }

    return (b.currentRevenue || 0) - (a.currentRevenue || 0);
  });
}

function exportDrawerCustomers() {
  const customers = getVisibleDrawerCustomers();
  const headers = [
    '고객명',
    '뒤4',
    '최초주문일',
    '최근주문일',
    '현재기간참여일수',
    '직전기간참여일수',
    '현재기간주문라인수',
    '현재기간구매수량',
    '현재기간주문금액',
    '직전기간주문금액',
    '누적참여일수',
    '누적주문금액',
    '최근구매상품',
    '고객상태'
  ];
  const rows = customers.map(customer => [
    customer.customerName,
    customer.customerDigits4,
    customer.firstOrderDate,
    customer.lastOrderDate,
    customer.currentParticipationDays,
    customer.previousParticipationDays,
    customer.currentOrderLines,
    customer.currentQuantity,
    customer.currentRevenue,
    customer.previousRevenue,
    customer.cumulativeParticipationDays,
    customer.cumulativeRevenue,
    (customer.recentProducts || []).join(' / '),
    customer.status
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(value => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `manman-customers-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
    `${data.sheetName} · ${MODE_LABELS[state.mode] || data.mode} · 기준 ${getBasisLabel(data.basis)} · 그래프 ${formatNumber(pointCount)}구간 · 오늘 제외 ${formatNumber(data.meta.excludedTodayRowCount)}행 · 아군 제외 ${formatNumber(data.meta.excludedAllyRowCount)}행 · 유효 ${formatNumber(data.meta.validRowCount)}행 · 성장분석 ${formatNumber(data.meta.growthAnalyzedRowCount)}행 · 확인 필요 ${formatNumber(data.meta.warningCount)}건`
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

function setKakaoUploadStatus(message, isError = false, isSuccess = false) {
  if (!els.kakaoUploadStatus) return;
  els.kakaoUploadStatus.textContent = message;
  els.kakaoUploadStatus.classList.toggle('is-error', isError);
  els.kakaoUploadStatus.classList.toggle('is-success', isSuccess);
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

function formatLocalDateTime(date) {
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${toInputDate(date)} ${hour}:${minute}`;
}

function inferDateFromKakaoFileName(fileName) {
  const match = String(fileName || '').match(/(20\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function nextInputDate(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return toInputDate(addDays(new Date(year, month - 1, day), 1));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('파일을 읽지 못했습니다.'));
    reader.readAsText(file, 'utf-8');
  });
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

function compactDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const date = raw.slice(0, 10);
  const time = raw.slice(11, 16);
  return time ? `${formatDateShort(date)} ${time}` : formatDateShort(date);
}

function isoDateOnly(value) {
  return String(value || '').slice(0, 10);
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

function formatDecimal(value) {
  const n = Number(value || 0);
  if (Number.isInteger(n)) return formatNumber(n);
  return n.toLocaleString('ko-KR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  });
}

function formatRate(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toLocaleString('ko-KR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })}%`;
}

function formatSignedRate(value) {
  if (value == null || Number.isNaN(Number(value))) return '비교 불가';
  const sign = Number(value) > 0 ? '+' : '';
  return `${sign}${formatRate(value)}`;
}

function percentLike(value, total) {
  return total ? Math.round((Number(value || 0) / total) * 1000) / 10 : 0;
}

function formatPeriod(period) {
  if (!period) return '-';
  const from = compactDate(period.from);
  const to = compactDate(period.to);
  return from === to ? from : `${from} ~ ${to}`;
}

function getBasisLabel(basis) {
  if (basis === 'pickupDate') return '픽업일자';
  if (basis === 'orderDate') return '주문일자';
  return '공구일자';
}

function normalizeAllyName(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeSearch(value) {
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
