export const STORAGE_TYPES = Object.freeze(['상온', '냉장', '냉동']);

export const MAX_VISIBLE_PRODUCTS = 40;

function makeStorageRecord(initialValue = 0) {
  return Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, initialValue]));
}

export function limitLayoutItemCounts(itemCounts, maxTotal = MAX_VISIBLE_PRODUCTS) {
  const counts = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [
      storageType,
      Math.max(0, Math.floor(Number(itemCounts[storageType] || 0)))
    ])
  );
  const safeMaxTotal = Math.max(1, Math.floor(Number(maxTotal || 0)));
  const total = STORAGE_TYPES.reduce((sum, storageType) => sum + counts[storageType], 0);
  if (total <= safeMaxTotal) return counts;

  const positiveTypes = STORAGE_TYPES
    .filter(storageType => counts[storageType] > 0)
    .sort((a, b) => counts[b] - counts[a] || STORAGE_TYPES.indexOf(a) - STORAGE_TYPES.indexOf(b));
  const limited = makeStorageRecord();

  if (positiveTypes.length >= safeMaxTotal) {
    positiveTypes.slice(0, safeMaxTotal).forEach(storageType => {
      limited[storageType] = 1;
    });
    return limited;
  }

  positiveTypes.forEach(storageType => {
    limited[storageType] = 1;
  });

  const remainingSlots = safeMaxTotal - positiveTypes.length;
  const remainingItems = positiveTypes.reduce(
    (sum, storageType) => sum + counts[storageType] - 1,
    0
  );
  const shares = positiveTypes.map((storageType, index) => {
    const exact = remainingItems > 0
      ? (counts[storageType] - 1) / remainingItems * remainingSlots
      : 0;
    const base = Math.min(counts[storageType] - 1, Math.floor(exact));
    limited[storageType] += base;
    return { storageType, index, remainder: exact - base };
  }).sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  let unallocated = safeMaxTotal - STORAGE_TYPES.reduce(
    (sum, storageType) => sum + limited[storageType],
    0
  );
  while (unallocated > 0) {
    const next = shares.find(({ storageType }) => limited[storageType] < counts[storageType]);
    if (!next) break;
    limited[next.storageType] += 1;
    unallocated -= 1;
    shares.push(shares.shift());
  }

  return limited;
}

export function splitItemsIntoRows(items, rowCount) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const rows = Math.max(1, Math.min(source.length, Math.floor(Number(rowCount || 0)) || 1));
  const baseSize = Math.floor(source.length / rows);
  const largerRows = source.length % rows;
  const result = [];
  let offset = 0;

  for (let index = 0; index < rows; index += 1) {
    const size = baseSize + (index < largerRows ? 1 : 0);
    result.push(source.slice(offset, offset + size));
    offset += size;
  }

  return result;
}

export function buildProductPages(items, maxVisibleProducts = MAX_VISIBLE_PRODUCTS) {
  const pageSize = Math.max(1, Math.floor(Number(maxVisibleProducts || 0)));
  const visibleItems = (Array.isArray(items) ? items : [])
    .filter(item => STORAGE_TYPES.includes(item?.storageType));
  const pages = [];

  for (let offset = 0; offset < visibleItems.length; offset += pageSize) {
    const page = Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, []]));
    visibleItems.slice(offset, offset + pageSize).forEach(item => {
      page[item.storageType].push(item);
    });
    pages.push(page);
  }

  return pages.length
    ? pages
    : [Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, []]))];
}

function allocatePhotoHeights(rowCounts, widthLimits, availableHeight) {
  const activeTypes = STORAGE_TYPES.filter(storageType => rowCounts[storageType] > 0);
  const heights = makeStorageRecord();
  if (!activeTypes.length || availableHeight <= 0) return heights;

  const squareHeightCost = activeTypes.reduce(
    (sum, storageType) => sum + rowCounts[storageType] * widthLimits[storageType],
    0
  );
  if (squareHeightCost <= availableHeight) {
    activeTypes.forEach(storageType => {
      heights[storageType] = widthLimits[storageType];
    });
    return heights;
  }

  let low = 0;
  let high = Math.max(...activeTypes.map(storageType => widthLimits[storageType]));
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const cost = activeTypes.reduce(
      (sum, storageType) =>
        sum + rowCounts[storageType] * Math.min(widthLimits[storageType], middle),
      0
    );
    if (cost <= availableHeight) low = middle;
    else high = middle;
  }

  activeTypes.forEach(storageType => {
    heights[storageType] = Math.min(widthLimits[storageType], low);
  });
  return heights;
}

function distributeZoneHeights(desiredHeights, rowCounts, availableZoneHeight) {
  const zoneHeights = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, Math.floor(desiredHeights[storageType])])
  );
  let remaining = Math.max(
    0,
    Math.floor(availableZoneHeight) - STORAGE_TYPES.reduce(
      (sum, storageType) => sum + zoneHeights[storageType],
      0
    )
  );
  const activeTypes = STORAGE_TYPES.filter(storageType => rowCounts[storageType] > 0);
  const recipients = activeTypes.length ? activeTypes : STORAGE_TYPES;
  const desiredFractions = recipients.map((storageType, index) => ({
    storageType,
    index,
    fraction: desiredHeights[storageType] - Math.floor(desiredHeights[storageType])
  })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (const recipient of desiredFractions) {
    if (remaining <= 0) break;
    zoneHeights[recipient.storageType] += 1;
    remaining -= 1;
  }

  const weightedRecipients = recipients.flatMap(storageType =>
    Array.from(
      { length: Math.max(1, rowCounts[storageType] || 0) },
      () => storageType
    )
  );
  for (let index = 0; remaining > 0; index += 1) {
    zoneHeights[weightedRecipients[index % weightedRecipients.length]] += 1;
    remaining -= 1;
  }

  let overflow = STORAGE_TYPES.reduce(
    (sum, storageType) => sum + zoneHeights[storageType],
    0
  ) - Math.floor(availableZoneHeight);
  if (overflow > 0) {
    while (overflow > 0) {
      const storageType = STORAGE_TYPES
        .filter(type => zoneHeights[type] > 1)
        .sort((a, b) => zoneHeights[b] - zoneHeights[a])[0];
      if (!storageType) break;
      const reduction = Math.min(overflow, zoneHeights[storageType] - 1);
      zoneHeights[storageType] -= reduction;
      overflow -= reduction;
    }
  }

  return zoneHeights;
}

export function calculateZoneLayoutCandidate(
  itemCounts,
  rowCounts,
  layoutWidth,
  layoutHeight,
  metrics = {}
) {
  const zoneGap = Math.max(0, Number(metrics.zoneGap || 0));
  const gridGap = Math.max(0, Number(metrics.gridGap || 0));
  const zoneInlineChrome = Math.max(0, Number(metrics.zoneInlineChrome || 0));
  const zoneBlockChrome = Math.max(0, Number(metrics.zoneBlockChrome || 0));
  const emptyZoneContentHeight = Math.max(0, Number(metrics.emptyZoneContentHeight || 0));
  const productNameHeight = Math.max(0, Number(metrics.productNameHeight || 0));
  const gridWidth = Math.max(1, Number(layoutWidth || 0) - zoneInlineChrome);
  const safeLayoutHeight = Math.max(1, Number(layoutHeight || 0));
  const totalGapHeight = zoneGap * Math.max(0, STORAGE_TYPES.length - 1);
  const columns = makeStorageRecord(1);
  const capacities = makeStorageRecord(1);
  const pageQuotas = makeStorageRecord();
  const normalizedRows = makeStorageRecord();
  const widthLimits = makeStorageRecord();
  const minimumZoneHeights = makeStorageRecord();
  let fixedZoneHeight = 0;
  let totalRows = 0;
  let emptySlots = 0;

  STORAGE_TYPES.forEach(storageType => {
    const itemCount = Math.max(0, Math.floor(Number(itemCounts[storageType] || 0)));
    pageQuotas[storageType] = itemCount;
    const rows = itemCount > 0
      ? Math.max(1, Math.min(itemCount, Math.floor(Number(rowCounts[storageType] || 0)) || 1))
      : 0;
    normalizedRows[storageType] = rows;

    if (!rows) {
      const emptyHeight = zoneBlockChrome + emptyZoneContentHeight;
      minimumZoneHeights[storageType] = emptyHeight;
      fixedZoneHeight += emptyHeight;
      return;
    }

    const maximumColumns = Math.ceil(itemCount / rows);
    const widthLimit = Math.max(
      1,
      (gridWidth - gridGap * Math.max(0, maximumColumns - 1)) / maximumColumns
    );
    const fixedHeight = zoneBlockChrome
      + rows * productNameHeight
      + gridGap * Math.max(0, rows - 1);

    columns[storageType] = maximumColumns;
    capacities[storageType] = itemCount;
    widthLimits[storageType] = widthLimit;
    minimumZoneHeights[storageType] = fixedHeight;
    fixedZoneHeight += fixedHeight;
    totalRows += rows;
    emptySlots += maximumColumns * rows - itemCount;
  });

  const availableZoneHeight = Math.max(1, Math.floor(safeLayoutHeight - totalGapHeight));
  const availablePhotoHeight = Math.max(0, availableZoneHeight - fixedZoneHeight);
  const photoHeights = allocatePhotoHeights(normalizedRows, widthLimits, availablePhotoHeight);
  const desiredZoneHeights = makeStorageRecord();

  STORAGE_TYPES.forEach(storageType => {
    desiredZoneHeights[storageType] = minimumZoneHeights[storageType]
      + normalizedRows[storageType] * photoHeights[storageType];
  });

  const usedDesiredHeight = STORAGE_TYPES.reduce(
    (sum, storageType) => sum + desiredZoneHeights[storageType],
    0
  );
  const unusedHeight = Math.max(0, availableZoneHeight - usedDesiredHeight);
  const activeRows = Math.max(1, totalRows);
  STORAGE_TYPES.forEach(storageType => {
    const share = totalRows > 0
      ? normalizedRows[storageType] / activeRows
      : 1 / STORAGE_TYPES.length;
    desiredZoneHeights[storageType] += unusedHeight * share;
  });

  const zoneWeights = distributeZoneHeights(
    desiredZoneHeights,
    normalizedRows,
    availableZoneHeight
  );
  const activeTypes = STORAGE_TYPES.filter(storageType => normalizedRows[storageType] > 0);
  const minimumPhotoSize = activeTypes.length
    ? Math.min(...activeTypes.map(storageType => photoHeights[storageType]))
    : 0;
  const photoAreaScore = activeTypes.reduce(
    (sum, storageType) =>
      sum + Number(itemCounts[storageType] || 0) * photoHeights[storageType] ** 2,
    0
  );
  const minimumRequiredHeight = fixedZoneHeight + totalGapHeight;

  return {
    rows: normalizedRows,
    columns,
    capacities,
    pageQuotas,
    photoHeights,
    widthLimits,
    zoneWeights,
    minimumRequiredHeight,
    totalRequiredHeight: STORAGE_TYPES.reduce(
      (sum, storageType) => sum + zoneWeights[storageType],
      totalGapHeight
    ),
    minimumPhotoSize,
    photoAreaScore,
    emptySlots,
    totalRows,
    overflow: minimumRequiredHeight - safeLayoutHeight,
    fits: minimumRequiredHeight <= safeLayoutHeight + 0.5
  };
}

function isBetterLayout(candidate, current) {
  if (!current) return true;
  if (candidate.fits !== current.fits) return candidate.fits;
  if (Math.abs(candidate.minimumPhotoSize - current.minimumPhotoSize) > 0.25) {
    return candidate.minimumPhotoSize > current.minimumPhotoSize;
  }
  if (Math.abs(candidate.photoAreaScore - current.photoAreaScore) > 1) {
    return candidate.photoAreaScore > current.photoAreaScore;
  }
  if (candidate.emptySlots !== current.emptySlots) {
    return candidate.emptySlots < current.emptySlots;
  }
  if (candidate.totalRows !== current.totalRows) {
    return candidate.totalRows < current.totalRows;
  }
  return candidate.overflow < current.overflow;
}

export function chooseZoneLayout(
  itemCounts,
  layoutWidth,
  layoutHeight,
  metrics = {},
  maxVisibleProducts = MAX_VISIBLE_PRODUCTS
) {
  const limitedCounts = limitLayoutItemCounts(itemCounts, maxVisibleProducts);
  const rowChoices = Object.fromEntries(STORAGE_TYPES.map(storageType => {
    const count = limitedCounts[storageType];
    return [
      storageType,
      count > 0 ? Array.from({ length: count }, (_, index) => index + 1) : [0]
    ];
  }));
  let best = null;

  for (const ambientRows of rowChoices['상온']) {
    for (const chilledRows of rowChoices['냉장']) {
      for (const frozenRows of rowChoices['냉동']) {
        const candidate = calculateZoneLayoutCandidate(
          limitedCounts,
          { '상온': ambientRows, '냉장': chilledRows, '냉동': frozenRows },
          layoutWidth,
          layoutHeight,
          metrics
        );
        if (isBetterLayout(candidate, best)) best = candidate;
      }
    }
  }

  return best;
}
