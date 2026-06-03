const TOKEN_KEY = 'mm_admin_dashboard_token';
const ALLY_CUSTOMERS_KEY = 'mm_admin_dashboard_ally_customers';
const DEFAULT_ALLY_CUSTOMERS = [
  '로지4298',
  '로지4739',
  '프리지아6450',
  '죠르디9319',
  '하품하는 죠르디 0108',
  '온누리1004',
  '김두팔 7380',
  '하니팡팡6743'
];
const PERIOD_LABELS = {
  daily: '일간',
  weekly: '주간',
  monthly: '월간'
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
  period: 'daily',
  orderMetric: 'quantity',
  orderChart: null,
  revenueChart: null,
  loading: false,
  allyCustomers: []
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  setDefaultDates();
  state.allyCustomers = loadAllyCustomers();
  bindEvents();
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
  els.from = document.querySelector('[data-from]');
  els.to = document.querySelector('[data-to]');
  els.basis = document.querySelector('[data-basis]');
  els.refresh = document.querySelector('[data-refresh]');
  els.logout = document.querySelector('[data-logout]');
  els.status = document.querySelector('[data-status]');
  els.periodButtons = Array.from(document.querySelectorAll('[data-period]'));
  els.orderMetric = document.querySelector('[data-order-metric]');
  els.orderCanvas = document.querySelector('[data-order-chart]');
  els.revenueCanvas = document.querySelector('[data-revenue-chart]');
  els.customerQuantity = document.querySelector('[data-customer-quantity]');
  els.customerRevenue = document.querySelector('[data-customer-revenue]');
  els.productQuantity = document.querySelector('[data-product-quantity]');
  els.productRevenue = document.querySelector('[data-product-revenue]');
  els.warningCount = document.querySelector('[data-warning-count]');
  els.warnings = document.querySelector('[data-warnings]');
  els.allyForm = document.querySelector('[data-ally-form]');
  els.allyInput = document.querySelector('[data-ally-input]');
  els.allyList = document.querySelector('[data-ally-list]');
  els.allyReset = document.querySelector('[data-ally-reset]');
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

  [els.from, els.to, els.basis].forEach(input => {
    input.addEventListener('change', () => fetchDashboardData());
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

  els.periodButtons.forEach(button => {
    button.addEventListener('click', () => {
      state.period = button.dataset.period;
      els.periodButtons.forEach(item => item.classList.toggle('is-active', item === button));
      renderRankings();
    });
  });

  els.orderMetric.addEventListener('change', () => {
    state.orderMetric = els.orderMetric.value;
    renderCharts();
  });
}

async function fetchDashboardData() {
  if (state.loading) return;

  state.loading = true;
  setStatus('데이터를 불러오는 중입니다...');

  try {
    const params = new URLSearchParams({
      from: els.from.value,
      to: els.to.value,
      basis: els.basis.value,
      excludedCustomers: JSON.stringify(state.allyCustomers)
    });
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
    renderDashboard();
    setStatus(
      `${data.sheetName} · 랭킹 기준 ${data.meta.rankingAnchor || '-'} · 아군 제외 ${formatNumber(data.meta.excludedAllyRowCount)}행 · 유효 ${formatNumber(data.meta.validRowCount)}행 · 확인 필요 ${formatNumber(data.meta.warningCount)}건`
    );
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

function renderDashboard() {
  renderKpis();
  renderCharts();
  renderRankings();
  renderWarnings();
}

function renderKpis() {
  const today = state.data.summary.today;
  const week = state.data.summary.week;

  setText('[data-kpi="todayQuantity"]', `${formatNumber(today.quantity)}개`);
  setText('[data-kpi="todayOrderCount"]', `주문건수 ${formatNumber(today.orderCount)}건`);
  setText('[data-kpi="weekQuantity"]', `${formatNumber(week.quantity)}개`);
  setText('[data-kpi="weekOrderCount"]', `주문건수 ${formatNumber(week.orderCount)}건`);
  setText('[data-kpi="todayRevenue"]', formatWon(today.revenue));
  setText('[data-kpi="weekRevenue"]', formatWon(week.revenue));
  setChange('[data-kpi="todayQuantityChange"]', today.quantityChangeRate, '전일');
  setChange('[data-kpi="weekQuantityChange"]', week.quantityChangeRate, '전주');
  setChange('[data-kpi="todayRevenueChange"]', today.revenueChangeRate, '전일');
  setChange('[data-kpi="weekRevenueChange"]', week.revenueChangeRate, '전주');

  renderSparkline('[data-sparkline="quantity"]', state.data.series.daily.map(item => item.quantity));
  renderSparkline('[data-sparkline="orderCount"]', state.data.series.daily.map(item => item.orderCount));
  renderSparkline('[data-sparkline="revenue"]', state.data.series.daily.map(item => item.revenue));
  renderSparkline('[data-sparkline="weekRevenue"]', state.data.series.weekly.map(item => item.revenue));
}

function renderCharts() {
  if (!state.data || typeof Chart === 'undefined') return;

  const daily = state.data.series.daily;
  const labels = daily.map(item => compactDate(item.date));
  const orderLabel = state.orderMetric === 'quantity' ? '주문수량' : '주문건수';
  const orderData = daily.map(item => item[state.orderMetric]);
  const revenueData = daily.map(item => item.revenue);

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
    label: '매출',
    data: revenueData,
    borderColor: '#0F9F6E',
    backgroundColor: 'rgba(15, 159, 110, 0.12)',
    yFormatter: value => compactWon(value)
  });
}

function renderRankings() {
  if (!state.data) return;

  const keyPrefix = state.period;
  const customerRankings = state.data.rankings.customers;
  const productRankings = state.data.rankings.products;

  renderCustomerRanking(
    els.customerQuantity,
    customerRankings[`${keyPrefix}ByQuantity`] || [],
    'quantity'
  );
  renderCustomerRanking(
    els.customerRevenue,
    customerRankings[`${keyPrefix}ByRevenue`] || [],
    'revenue'
  );
  renderProductRanking(
    els.productQuantity,
    productRankings[`${keyPrefix}ByQuantity`] || [],
    'quantity'
  );
  renderProductRanking(
    els.productRevenue,
    productRankings[`${keyPrefix}ByRevenue`] || [],
    'revenue'
  );
}

function renderCustomerRanking(container, items, metric) {
  if (!items.length) {
    container.innerHTML = emptyRankingMessage();
    return;
  }

  container.innerHTML = items
    .map(item => {
      const value = metric === 'revenue' ? formatWon(item.revenue) : `${formatNumber(item.quantity)}개`;
      return `
        <article class="ranking-item">
          <span class="rank-badge">${item.rank}</span>
          <div class="ranking-main">
            <p class="ranking-title">${escapeHtml(item.customerName)}</p>
            <div class="ranking-meta">
              <span>수량 ${formatNumber(item.quantity)}개</span>
              <span>건수 ${formatNumber(item.orderCount)}건</span>
              <span>평균 ${formatWon(item.averageOrderValue)}</span>
            </div>
          </div>
          <strong class="ranking-value">${value}</strong>
        </article>
      `;
    })
    .join('');
}

function renderProductRanking(container, items, metric) {
  if (!items.length) {
    container.innerHTML = emptyRankingMessage();
    return;
  }

  container.innerHTML = items
    .map(item => {
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
              <span>판매가 ${formatWon(item.price)}</span>
              <span>고객 ${formatNumber(item.customerCount)}명</span>
            </div>
          </div>
          <strong class="ranking-value">${value}</strong>
        </article>
      `;
    })
    .join('');
}

function renderWarnings() {
  const warnings = state.data.warnings || [];
  els.warningCount.textContent = `${formatNumber(warnings.length)}건`;

  if (!warnings.length) {
    els.warnings.innerHTML = '<div class="ranking-empty">확인 필요 데이터가 없습니다.</div>';
    return;
  }

  els.warnings.innerHTML = warnings
    .slice(0, 100)
    .map(
      warning => `
        <article class="warning-item">
          <strong>${formatNumber(warning.rowNumber)}행</strong>
          <span>${escapeHtml(warning.reason)}</span>
          <span>${escapeHtml(warning.customerName || '-')} · ${escapeHtml(warning.productName || '-')}</span>
        </article>
      `
    )
    .join('');
}

function renderAllyCustomers() {
  if (!els.allyList) return;

  if (!state.allyCustomers.length) {
    els.allyList.innerHTML = '<div class="ranking-empty">아군 제외 목록이 비어 있습니다.</div>';
    return;
  }

  els.allyList.innerHTML = state.allyCustomers
    .map(
      (name, index) => `
        <span class="ally-chip">
          <span>${escapeHtml(name)}</span>
          <span class="ally-chip-actions">
            <button type="button" data-ally-edit="${index}">수정</button>
            <button type="button" data-ally-delete="${index}">삭제</button>
          </span>
        </span>
      `
    )
    .join('');

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

  const exists = state.allyCustomers.some(
    (item, itemIndex) => itemIndex !== index && normalizeAllyName(item) === normalizeAllyName(name)
  );
  if (exists) return;

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
    datasets: [
      {
        label: config.label,
        data: config.data,
        borderColor: config.borderColor,
        backgroundColor: config.backgroundColor,
        borderWidth: 3,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.34
      }
    ]
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
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: context => `${config.label}: ${config.yFormatter(context.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: '#6B7280',
            maxTicksLimit: 9
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: '#EEF2F7'
          },
          ticks: {
            color: '#6B7280',
            callback: config.yFormatter
          }
        }
      }
    }
  });
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

function setDefaultDates() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 30);

  els.from.value = toInputDate(from);
  els.to.value = toInputDate(today);
}

function loadAllyCustomers() {
  const raw = localStorage.getItem(ALLY_CUSTOMERS_KEY);
  if (!raw) {
    localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(DEFAULT_ALLY_CUSTOMERS));
    return [...DEFAULT_ALLY_CUSTOMERS];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return uniqueAllyCustomers(parsed);
  } catch {
    // Restore defaults below.
  }

  localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(DEFAULT_ALLY_CUSTOMERS));
  return [...DEFAULT_ALLY_CUSTOMERS];
}

function saveAllyCustomers() {
  state.allyCustomers = uniqueAllyCustomers(state.allyCustomers);
  localStorage.setItem(ALLY_CUSTOMERS_KEY, JSON.stringify(state.allyCustomers));
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

function normalizeAllyName(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
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

function setChange(selector, value, label) {
  const el = document.querySelector(selector);
  if (!el) return;

  const sign = value > 0 ? '+' : '';
  el.textContent = `${label} ${sign}${Number(value || 0).toFixed(1)}%`;
  el.classList.toggle('is-negative', value < 0);
}

function emptyRankingMessage() {
  return `<div class="ranking-empty">${PERIOD_LABELS[state.period]} 랭킹 데이터가 없습니다.</div>`;
}

function compactDate(dateKey) {
  const [, month, day] = String(dateKey).split('-');
  return `${Number(month)}/${Number(day)}`;
}

function toInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
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
