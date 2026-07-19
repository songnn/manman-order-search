const DEFAULTS = {
  minRows: 100,
  minSourceCountRatio: 0.97,
  maxSourceCountRatio: 1.2,
  changedRowFloor: 10,
  maxChangedRowRatio: 0.001,
  missingFieldFloor: 5,
  maxMissingFieldRatioIncrease: 0.002
};

const COMPARED_FIELDS = [
  'customer_label',
  'product_name',
  'quantity',
  'price',
  'image_url',
  'order_date_text',
  'pickup_date_text'
];

const TEXT_FIELDS = [
  'customer_label',
  'product_name',
  'image_url',
  'order_date_text',
  'pickup_date_text'
];

const SPREADSHEET_ERROR_PATTERN = /(?:^|\s)#(?:REF!|N\/A|VALUE!|ERROR!|DIV\/0!|NAME\?|NUM!|NULL!|SPILL!|CALC!|LOADING)/i;

export function evaluateOrderCacheSnapshot({
  nextRecords = [],
  cachedRecords = [],
  options = {}
} = {}) {
  const config = normalizeOptions_(options);
  const reasons = [];
  const nextByKey = new Map();
  const cachedByKey = new Map();
  const duplicateKeys = [];
  const errorValueCounts = {};

  nextRecords.forEach(record => {
    const key = sourceKey_(record);

    if (!key) {
      duplicateKeys.push('(invalid source key)');
      return;
    }

    if (nextByKey.has(key)) {
      duplicateKeys.push(key);
      return;
    }

    nextByKey.set(key, record);

    TEXT_FIELDS.forEach(field => {
      if (SPREADSHEET_ERROR_PATTERN.test(clean_(record[field]))) {
        errorValueCounts[field] = (errorValueCounts[field] || 0) + 1;
      }
    });
  });

  cachedRecords.forEach(record => {
    const key = sourceKey_(record);
    if (key) cachedByKey.set(key, record);
  });

  if (nextRecords.length < config.minRows && cachedRecords.length >= config.minRows) {
    reasons.push({
      code: 'too_few_rows',
      message: `새 주문 데이터가 ${nextRecords.length}건으로 기존 정상 캐시보다 비정상적으로 적습니다.`
    });
  }

  if (duplicateKeys.length) {
    reasons.push({
      code: 'duplicate_source_rows',
      message: `동일한 시트 행이 ${duplicateKeys.length}건 중복되어 있습니다.`
    });
  }

  const spreadsheetErrorCount = Object.values(errorValueCounts)
    .reduce((sum, count) => sum + count, 0);

  if (spreadsheetErrorCount) {
    reasons.push({
      code: 'spreadsheet_errors',
      message: `구글시트 오류값이 ${spreadsheetErrorCount}건 감지되었습니다.`
    });
  }

  const nextSourceCounts = countBySource_(nextRecords);
  const cachedSourceCounts = countBySource_(cachedRecords);

  Object.entries(nextSourceCounts).forEach(([source, nextCount]) => {
    const cachedCount = cachedSourceCounts[source] || 0;
    if (cachedCount < config.minRows) return;

    const ratio = nextCount / cachedCount;

    if (ratio < config.minSourceCountRatio) {
      reasons.push({
        code: 'source_row_count_dropped',
        source,
        message: `${source} 데이터가 ${cachedCount}건에서 ${nextCount}건으로 급감했습니다.`
      });
    }

    if (ratio > config.maxSourceCountRatio) {
      reasons.push({
        code: 'source_row_count_spiked',
        source,
        message: `${source} 데이터가 ${cachedCount}건에서 ${nextCount}건으로 급증했습니다.`
      });
    }
  });

  let overlapCount = 0;

  nextByKey.forEach((record, key) => {
    if (cachedByKey.has(key)) overlapCount += 1;
  });

  // source_row_number는 시트 행 삽입·삭제 때 함께 이동하므로 영구 ID가 아니다.
  // 실제 주문 내용의 multiset을 source별로 비교해 단순 행 이동은 변경에서 제외한다.
  const contentComparison = compareContentBySource_(nextRecords, cachedRecords);
  const changedExistingRows = contentComparison.changedExistingRows;

  const changedRowLimit = Math.max(
    config.changedRowFloor,
    Math.ceil(contentComparison.comparableRows * config.maxChangedRowRatio)
  );

  if (changedExistingRows > changedRowLimit) {
    reasons.push({
      code: 'too_many_existing_rows_changed',
      message: `기존 주문 ${changedExistingRows}건이 한 번에 바뀌어 안전 기준 ${changedRowLimit}건을 넘었습니다.`
    });
  }

  if (contentComparison.removedRows > changedRowLimit) {
    reasons.push({
      code: 'too_many_rows_removed',
      message: `기존 주문 내용 ${contentComparison.removedRows}건이 사라져 안전 기준 ${changedRowLimit}건을 넘었습니다.`
    });
  }

  const missingFieldChanges = compareMissingFields_(nextRecords, cachedRecords);

  Object.entries(missingFieldChanges).forEach(([field, counts]) => {
    if (!cachedRecords.length) return;

    const increase = counts.next - counts.cached;
    const ratioIncrease = (counts.next / Math.max(nextRecords.length, 1)) -
      (counts.cached / cachedRecords.length);

    if (
      increase > config.missingFieldFloor &&
      ratioIncrease > config.maxMissingFieldRatioIncrease
    ) {
      reasons.push({
        code: 'missing_field_spike',
        field,
        message: `${field} 누락이 ${counts.cached}건에서 ${counts.next}건으로 급증했습니다.`
      });
    }
  });

  return {
    ok: reasons.length === 0,
    frozen: reasons.length > 0,
    reasons,
    metrics: {
      nextCount: nextRecords.length,
      cachedCount: cachedRecords.length,
      overlapCount,
      addedRows: contentComparison.addedRows,
      removedRows: contentComparison.removedRows,
      contentMatchedRows: contentComparison.matchedRows,
      comparableRows: contentComparison.comparableRows,
      changedExistingRows,
      changedRowLimit,
      removedRowLimit: changedRowLimit,
      duplicateSourceRows: duplicateKeys.length,
      spreadsheetErrorCount,
      errorValueCounts,
      nextSourceCounts,
      cachedSourceCounts,
      missingFieldChanges
    }
  };
}

export function orderCacheGuardOptionsFromEnv(env = process.env) {
  return {
    minRows: numberFromEnv_(env.ORDER_CACHE_GUARD_MIN_ROWS, DEFAULTS.minRows),
    minSourceCountRatio: numberFromEnv_(
      env.ORDER_CACHE_GUARD_MIN_COUNT_RATIO,
      DEFAULTS.minSourceCountRatio
    ),
    maxSourceCountRatio: numberFromEnv_(
      env.ORDER_CACHE_GUARD_MAX_COUNT_RATIO,
      DEFAULTS.maxSourceCountRatio
    ),
    changedRowFloor: numberFromEnv_(
      env.ORDER_CACHE_GUARD_CHANGED_ROW_FLOOR,
      DEFAULTS.changedRowFloor
    ),
    maxChangedRowRatio: numberFromEnv_(
      env.ORDER_CACHE_GUARD_MAX_CHANGED_RATIO,
      DEFAULTS.maxChangedRowRatio
    ),
    missingFieldFloor: numberFromEnv_(
      env.ORDER_CACHE_GUARD_MISSING_FIELD_FLOOR,
      DEFAULTS.missingFieldFloor
    ),
    maxMissingFieldRatioIncrease: numberFromEnv_(
      env.ORDER_CACHE_GUARD_MAX_MISSING_RATIO_INCREASE,
      DEFAULTS.maxMissingFieldRatioIncrease
    )
  };
}

function normalizeOptions_(options) {
  return {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => Number.isFinite(Number(value)))
    )
  };
}

function countBySource_(records) {
  const counts = {};

  records.forEach(record => {
    const source = clean_(record?.source_sheet_name);
    if (!source) return;
    counts[source] = (counts[source] || 0) + 1;
  });

  return counts;
}

function sourceKey_(record) {
  const source = clean_(record?.source_sheet_name);
  const rowNumber = Number(record?.source_row_number);

  if (!source || !Number.isInteger(rowNumber) || rowNumber < 1) return '';
  return `${source}::${rowNumber}`;
}

function normalizedField_(field, value) {
  if (field === 'quantity' || field === 'price') {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  return clean_(value);
}

function compareContentBySource_(nextRecords, cachedRecords) {
  const nextSources = buildContentCountsBySource_(nextRecords);
  const cachedSources = buildContentCountsBySource_(cachedRecords);
  const sources = new Set([...nextSources.keys(), ...cachedSources.keys()]);
  let matchedRows = 0;
  let addedRows = 0;
  let removedRows = 0;
  let changedExistingRows = 0;
  let comparableRows = 0;

  sources.forEach(source => {
    const next = nextSources.get(source) || emptyContentCounts_();
    const cached = cachedSources.get(source) || emptyContentCounts_();
    let sourceMatchedRows = 0;

    next.fingerprints.forEach((nextCount, fingerprint) => {
      sourceMatchedRows += Math.min(nextCount, cached.fingerprints.get(fingerprint) || 0);
    });

    const sourceAddedRows = Math.max(0, next.total - sourceMatchedRows);
    const sourceRemovedRows = Math.max(0, cached.total - sourceMatchedRows);

    matchedRows += sourceMatchedRows;
    addedRows += sourceAddedRows;
    removedRows += sourceRemovedRows;
    changedExistingRows += Math.min(sourceAddedRows, sourceRemovedRows);
    comparableRows += Math.min(next.total, cached.total);
  });

  return {
    matchedRows,
    addedRows,
    removedRows,
    changedExistingRows,
    comparableRows
  };
}

function buildContentCountsBySource_(records) {
  const sources = new Map();

  records.forEach(record => {
    const source = clean_(record?.source_sheet_name);
    if (!source) return;

    const entry = sources.get(source) || emptyContentCounts_();
    const fingerprint = contentFingerprint_(record);

    entry.total += 1;
    entry.fingerprints.set(fingerprint, (entry.fingerprints.get(fingerprint) || 0) + 1);
    sources.set(source, entry);
  });

  return sources;
}

function contentFingerprint_(record) {
  return JSON.stringify(COMPARED_FIELDS.map(field => normalizedField_(field, record?.[field])));
}

function emptyContentCounts_() {
  return {
    total: 0,
    fingerprints: new Map()
  };
}

function compareMissingFields_(nextRecords, cachedRecords) {
  return Object.fromEntries(COMPARED_FIELDS.map(field => [
    field,
    {
      next: nextRecords.filter(record => isMissing_(field, record[field])).length,
      cached: cachedRecords.filter(record => isMissing_(field, record[field])).length
    }
  ]));
}

function isMissing_(field, value) {
  if (field === 'quantity') return !(Number(value) > 0);
  if (field === 'price') return !(Number(value) > 0);
  return !clean_(value);
}

function numberFromEnv_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}
