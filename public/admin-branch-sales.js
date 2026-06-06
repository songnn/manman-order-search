const TOKEN_KEY = 'mm_admin_dashboard_token';

const PERIOD_PRESETS = [
  { key: 'all', label: '전체기간' },
  { key: '3', label: '최근 3일', days: 3 },
  { key: '7', label: '최근 7일', days: 7 },
  { key: '14', label: '최근 14일', days: 14 },
  { key: '30', label: '최근 1개월', days: 30 },
  { key: '60', label: '최근 2개월', days: 60 }
];

const BRANCH_COLORS = [
  '#0051A0',
  '#0F9F6E',
  '#C2410C',
  '#7C3AED',
  '#DC2626',
  '#0891B2',
  '#CA8A04',
  '#BE185D',
  '#4F46E5',
  '#059669',
  '#EA580C',
  '#9333EA',
  '#2563EB',
  '#65A30D',
  '#B45309',
  '#0E7490'
];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  data: null,
  period: 'all',
  selectedBranches: new Set(),
  selectionHydrated: false,
  chart: null,
  chartDates: [],
  loading: false
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  bindEvents();
  renderPeriodButtons();

  if (state.token) {
    showApp();
    fetchSalesData();
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
  els.refresh = document.querySelector('[data-refresh]');
  els.logout = document.querySelector('[data-logout]');
  els.periodButtons = document.querySelector('[data-period-buttons]');
  els.currentPeriod = document.querySelector('[data-current-period]');
  els.status = document.querySelector('[data-status]');
  els.branchAll = document.querySelector('[data-branch-all]');
  els.branchToggles = document.querySelector('[data-branch-toggles]');
  els.chartMeta = document.querySelector('[data-chart-meta]');
  els.chartCanvas = document.querySelector('[data-branch-sales-chart]');
  els.chartEmpty = document.querySelector('[data-chart-empty]');
  els.branchSummary = document.querySelector('[data-branch-summary]');
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
    fetchSalesData();
  });

  els.refresh.addEventListener('click', () => fetchSalesData());

  els.logout.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    state.data = null;
    state.selectionHydrated = false;
    state.selectedBranches = new Set();
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    showAuth();
  });

  els.periodButtons.addEventListener('click', event => {
    const button = event.target.closest('[data-period]');
    if (!button) return;

    state.period = button.dataset.period;
    renderPage();
  });

  els.branchAll.addEventListener('change', () => {
    if (!state.data) return;

    state.selectedBranches = els.branchAll.checked
      ? new Set(state.data.branches.map(branch => branch.name))
      : new Set();
    renderPage();
  });
}

async function fetchSalesData() {
  if (state.loading) return;

  state.loading = true;
  setStatus('지점별 매출 데이터를 불러오는 중입니다...');

  try {
    const response = await fetch('/api/branch-sales-data', {
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
      throw new Error(data.detail || data.error || '지점별 매출 데이터를 불러오지 못했습니다.');
    }

    state.data = normalizeSalesData(data);
    hydrateBranchSelection();
    renderPage();
  } catch (error) {
    console.error(error);
    setStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

function normalizeSalesData(data) {
  const branches = [...(data.branches || [])]
    .sort((a, b) => Number(b.sales || 0) - Number(a.sales || 0))
    .map((branch, index) => ({
      ...branch,
      color: BRANCH_COLORS[index % BRANCH_COLORS.length]
    }));
  const branchOrder = new Map(branches.map((branch, index) => [branch.name, index]));
  const records = [...(data.records || [])].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (branchOrder.get(a.store) ?? 999) - (branchOrder.get(b.store) ?? 999);
  });
  const recordsByKey = new Map(
    records.map(record => [`${record.date}::${record.store}`, record])
  );

  return {
    ...data,
    branches,
    records,
    recordsByKey,
    dates: [...(data.dates || [])].sort()
  };
}

function hydrateBranchSelection() {
  if (!state.data) return;

  const branchNames = state.data.branches.map(branch => branch.name);

  if (!state.selectionHydrated) {
    state.selectedBranches = new Set(branchNames);
    state.selectionHydrated = true;
    return;
  }

  state.selectedBranches = new Set(
    branchNames.filter(name => state.selectedBranches.has(name))
  );
}

function renderPage() {
  if (!state.data) return;

  renderPeriodButtons();
  renderBranchToggles();
  renderBranchAllToggle();
  renderKpis();
  renderChart();
  renderSummaryTable();
  updateStatusLine();
}

function renderPeriodButtons() {
  els.periodButtons.innerHTML = PERIOD_PRESETS.map(preset => `
    <button class="branch-period-button ${state.period === preset.key ? 'is-active' : ''}" type="button" data-period="${preset.key}">
      ${preset.label}
    </button>
  `).join('');
}

function renderBranchToggles() {
  const periodDates = getCurrentPeriodDates();
  const summaries = getBranchSummaries(periodDates);
  const summaryByBranch = new Map(summaries.map(summary => [summary.name, summary]));

  els.branchToggles.innerHTML = state.data.branches.map(branch => {
    const isSelected = state.selectedBranches.has(branch.name);
    const summary = summaryByBranch.get(branch.name);

    return `
      <label class="branch-toggle ${isSelected ? '' : 'is-off'}" style="--branch-color: ${branch.color}">
        <input type="checkbox" ${isSelected ? 'checked' : ''} data-branch="${escapeAttribute(branch.name)}" />
        <span class="branch-swatch" aria-hidden="true"></span>
        <span class="branch-name">${escapeHtml(branch.shortName || branch.name)}</span>
        <span class="branch-total">${formatWon(summary?.sales || 0)}</span>
      </label>
    `;
  }).join('');

  els.branchToggles.querySelectorAll('[data-branch]').forEach(input => {
    input.addEventListener('change', () => {
      const branchName = input.dataset.branch;

      if (input.checked) {
        state.selectedBranches.add(branchName);
      } else {
        state.selectedBranches.delete(branchName);
      }

      renderPage();
    });
  });
}

function renderBranchAllToggle() {
  const total = state.data.branches.length;
  const selected = getSelectedBranches().length;

  els.branchAll.checked = total > 0 && selected === total;
  els.branchAll.indeterminate = selected > 0 && selected < total;
}

function renderKpis() {
  const periodDates = getCurrentPeriodDates();
  const summaries = getBranchSummaries(periodDates);
  const selectedCount = getSelectedBranches().length;
  const totalSales = summaries.reduce((sum, item) => sum + item.sales, 0);
  const topBranch = summaries.find(item => item.sales > 0);

  setText('[data-kpi="selectedBranches"]', `${formatNumber(selectedCount)}개`);
  setText('[data-kpi="totalSales"]', formatWon(totalSales));
  setText('[data-kpi="averageSales"]', formatWon(periodDates.length ? totalSales / periodDates.length : 0));
  setText('[data-kpi="topBranch"]', topBranch ? topBranch.shortName : '-');
  setText('[data-kpi="topBranchSales"]', topBranch ? formatWon(topBranch.sales) : '0원');

  els.currentPeriod.textContent = getPeriodLabel(periodDates);
}

function renderChart() {
  if (typeof Chart === 'undefined') {
    setStatus('차트 라이브러리를 불러오지 못했습니다.', true);
    return;
  }

  const periodDates = getCurrentPeriodDates();
  const selectedBranches = getSelectedBranches();
  const labels = periodDates.map(formatDateShort);

  state.chartDates = periodDates;
  els.chartEmpty.classList.toggle('is-hidden', selectedBranches.length > 0);
  els.chartMeta.textContent = `${formatNumber(selectedBranches.length)}개 지점 · ${formatNumber(periodDates.length)}일`;

  const datasets = selectedBranches.map(branch => ({
    label: branch.shortName || branch.name,
    data: periodDates.map(date => {
      const record = state.data.recordsByKey.get(`${date}::${branch.name}`);
      return record ? Number(record.sales || 0) : null;
    }),
    borderColor: branch.color,
    backgroundColor: toRgba(branch.color, 0.12),
    borderWidth: 2.5,
    pointRadius: periodDates.length <= 14 ? 3 : 0,
    pointHoverRadius: 5,
    fill: false,
    tension: 0.28,
    spanGaps: false
  }));

  const chartData = {
    labels,
    datasets
  };

  if (state.chart) {
    state.chart.data = chartData;
    state.chart.options.scales.x.ticks.maxTicksLimit = getMaxTickCount(periodDates.length);
    state.chart.update();
    return;
  }

  state.chart = new Chart(els.chartCanvas, {
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
            title: contexts => {
              const index = contexts[0]?.dataIndex ?? 0;
              return formatDateFull(state.chartDates[index]);
            },
            label: context => `${context.dataset.label}: ${formatWon(context.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#6B7280',
            maxTicksLimit: getMaxTickCount(periodDates.length)
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#EEF2F7' },
          ticks: {
            color: '#6B7280',
            callback: value => compactWon(value)
          }
        }
      }
    }
  });
}

function renderSummaryTable() {
  const periodDates = getCurrentPeriodDates();
  const summaries = getBranchSummaries(periodDates);

  if (!summaries.length) {
    els.branchSummary.innerHTML = `
      <tr>
        <td class="branch-empty-row" colspan="5">선택된 지점이 없습니다.</td>
      </tr>
    `;
    return;
  }

  els.branchSummary.innerHTML = summaries.map(summary => `
    <tr>
      <td>
        <span class="branch-summary-store" style="--branch-color: ${summary.color}">
          <span class="summary-swatch" aria-hidden="true"></span>
          <span>${escapeHtml(summary.shortName)}</span>
        </span>
      </td>
      <td>${formatWon(summary.sales)}</td>
      <td>${formatNumber(summary.quantity)}개</td>
      <td>${formatWon(summary.averageSales)}</td>
      <td>${summary.bestDate ? `${formatDateFull(summary.bestDate)} · ${formatWon(summary.bestSales)}` : '-'}</td>
    </tr>
  `).join('');
}

function updateStatusLine() {
  const periodDates = getCurrentPeriodDates();
  const selectedCount = getSelectedBranches().length;
  const totalCount = state.data.branches.length;
  const range = state.data.dateRange || {};

  setStatus(
    `${state.data.sourceFile} · 데이터 ${formatDateFull(range.from)} ~ ${formatDateFull(range.to)} · 선택 ${formatNumber(periodDates.length)}일 · 지점 ${formatNumber(selectedCount)}/${formatNumber(totalCount)}개 · 원본 ${formatNumber(state.data.recordCount)}행`
  );
}

function getCurrentPeriodDates() {
  if (!state.data) return [];

  const dates = state.data.dates || [];
  const preset = PERIOD_PRESETS.find(item => item.key === state.period) || PERIOD_PRESETS[0];
  if (!preset.days) return dates;

  const endKey = state.data.dateRange?.to || dates[dates.length - 1];
  const fromKey = toDateKey(addDays(parseLocalDate(endKey), -(preset.days - 1)));

  return dates.filter(date => date >= fromKey && date <= endKey);
}

function getSelectedBranches() {
  if (!state.data) return [];
  return state.data.branches.filter(branch => state.selectedBranches.has(branch.name));
}

function getBranchSummaries(periodDates) {
  if (!state.data) return [];

  const dateSet = new Set(periodDates);

  return getSelectedBranches()
    .map(branch => {
      const records = state.data.records.filter(record =>
        record.store === branch.name && dateSet.has(record.date)
      );
      const sales = records.reduce((sum, record) => sum + Number(record.sales || 0), 0);
      const quantity = records.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
      const bestRecord = records.reduce((best, record) => {
        if (!best || Number(record.sales || 0) > Number(best.sales || 0)) return record;
        return best;
      }, null);

      return {
        ...branch,
        sales,
        quantity,
        averageSales: periodDates.length ? sales / periodDates.length : 0,
        bestDate: bestRecord?.date || '',
        bestSales: bestRecord ? Number(bestRecord.sales || 0) : 0
      };
    })
    .sort((a, b) => b.sales - a.sales || a.shortName.localeCompare(b.shortName, 'ko-KR'));
}

function getPeriodLabel(periodDates) {
  const preset = PERIOD_PRESETS.find(item => item.key === state.period) || PERIOD_PRESETS[0];
  if (!periodDates.length) return preset.label;

  return `${preset.label} · ${formatDateFull(periodDates[0])} ~ ${formatDateFull(periodDates[periodDates.length - 1])}`;
}

function getMaxTickCount(length) {
  if (length <= 7) return length;
  if (length <= 31) return 10;
  if (length <= 70) return 12;
  return 14;
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

function parseLocalDate(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateShort(dateKey) {
  const [, month, day] = String(dateKey || '').split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : String(dateKey || '');
}

function formatDateFull(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-');
  if (!year || !month || !day) return String(dateKey || '-');
  return `${year}.${Number(month)}.${Number(day)}`;
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

function toRgba(hex, alpha) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return `rgba(0, 81, 160, ${alpha})`;

  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
