export const STORAGE_TYPES = Object.freeze(['상온', '냉장', '냉동']);

export const MAX_PRODUCT_PAGES = 2;

const COMFORTABLE_CARD_RATIO = 0.85;

function makeStorageRecord(initialValue = 0) {
  return Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, initialValue]));
}

function normalizeItemCounts(itemCounts = {}) {
  return Object.fromEntries(
    STORAGE_TYPES.map(storageType => [
      storageType,
      Math.max(0, Math.floor(Number(itemCounts[storageType] || 0)))
    ])
  );
}

function totalItems(itemCounts) {
  return STORAGE_TYPES.reduce(
    (sum, storageType) => sum + Number(itemCounts[storageType] || 0),
    0
  );
}

function normalizeMetrics(metrics = {}) {
  return {
    zoneGap: Math.max(0, Number(metrics.zoneGap || 0)),
    gridGap: Math.max(0, Number(metrics.gridGap || 0)),
    zoneInlineChrome: Math.max(0, Number(metrics.zoneInlineChrome || 0)),
    zoneBlockChrome: Math.max(0, Number(metrics.zoneBlockChrome || 0)),
    emptyZoneContentHeight: Math.max(0, Number(metrics.emptyZoneContentHeight || 0)),
    productNameHeight: Math.max(0, Number(metrics.productNameHeight || 0))
  };
}

export function chunkItemsIntoRows(items, columnCount) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const columns = Math.max(1, Math.floor(Number(columnCount || 0)) || 1);
  const rows = [];
  for (let offset = 0; offset < source.length; offset += columns) {
    rows.push(source.slice(offset, offset + columns));
  }
  return rows;
}

function calculateRows(itemCounts, columns) {
  return Object.fromEntries(STORAGE_TYPES.map(storageType => {
    const count = itemCounts[storageType];
    return [storageType, count > 0 ? Math.ceil(count / columns) : 0];
  }));
}

function calculateFixedHeight(itemCounts, rows, metrics) {
  return STORAGE_TYPES.reduce((sum, storageType) => {
    if (!itemCounts[storageType]) {
      return sum + metrics.zoneBlockChrome + metrics.emptyZoneContentHeight;
    }

    const rowCount = rows[storageType];
    return sum
      + metrics.zoneBlockChrome
      + rowCount * metrics.productNameHeight
      + Math.max(0, rowCount - 1) * metrics.gridGap;
  }, 0);
}

function distributeZoneHeights(itemCounts, rows, cardSize, layoutHeight, metrics) {
  const totalZoneGap = metrics.zoneGap * Math.max(0, STORAGE_TYPES.length - 1);
  const availableZoneHeight = Math.max(1, Math.floor(Number(layoutHeight || 0) - totalZoneGap));
  const minimumHeights = Object.fromEntries(STORAGE_TYPES.map(storageType => {
    if (!itemCounts[storageType]) {
      return [
        storageType,
        metrics.zoneBlockChrome + metrics.emptyZoneContentHeight
      ];
    }

    const rowCount = rows[storageType];
    return [
      storageType,
      metrics.zoneBlockChrome
        + rowCount * (cardSize + metrics.productNameHeight)
        + Math.max(0, rowCount - 1) * metrics.gridGap
    ];
  }));
  const zoneHeights = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, Math.floor(minimumHeights[storageType])])
  );
  let remaining = Math.max(
    0,
    availableZoneHeight - totalItems(zoneHeights)
  );
  const activeTypes = STORAGE_TYPES.filter(storageType => itemCounts[storageType] > 0);
  const recipients = activeTypes.length ? activeTypes : STORAGE_TYPES;
  const weightedRecipients = recipients.flatMap(storageType =>
    Array.from({ length: Math.max(1, rows[storageType] || 0) }, () => storageType)
  );

  for (let index = 0; remaining > 0; index += 1) {
    zoneHeights[weightedRecipients[index % weightedRecipients.length]] += 1;
    remaining -= 1;
  }

  return zoneHeights;
}

function finalizePageLayout(candidate, layoutHeight, metrics, commonCardSize = candidate.cardSize) {
  const cardSize = Math.max(0, Math.floor(Number(commonCardSize || 0)));
  const zoneHeights = distributeZoneHeights(
    candidate.itemCounts,
    candidate.rows,
    cardSize,
    layoutHeight,
    metrics
  );
  const totalZoneGap = metrics.zoneGap * Math.max(0, STORAGE_TYPES.length - 1);

  return {
    ...candidate,
    cardSize,
    imageSize: cardSize,
    cardWidth: cardSize,
    cardHeight: cardSize + metrics.productNameHeight,
    zoneHeights,
    totalRequiredHeight: totalItems(zoneHeights) + totalZoneGap
  };
}

function isBetterPageLayout(candidate, current) {
  if (!current) return true;
  if (candidate.fits !== current.fits) return candidate.fits;
  if (candidate.cardSize !== current.cardSize) return candidate.cardSize > current.cardSize;
  if (candidate.emptySlots !== current.emptySlots) return candidate.emptySlots < current.emptySlots;
  if (candidate.totalRows !== current.totalRows) return candidate.totalRows < current.totalRows;
  return candidate.columns < current.columns;
}

export function chooseUniformPageLayout(
  itemCounts,
  layoutWidth,
  layoutHeight,
  rawMetrics = {}
) {
  const counts = normalizeItemCounts(itemCounts);
  const metrics = normalizeMetrics(rawMetrics);
  const safeLayoutWidth = Math.max(1, Number(layoutWidth || 0));
  const safeLayoutHeight = Math.max(1, Number(layoutHeight || 0));
  const gridWidth = Math.max(1, safeLayoutWidth - metrics.zoneInlineChrome);
  const totalZoneGap = metrics.zoneGap * Math.max(0, STORAGE_TYPES.length - 1);
  const availableZoneHeight = Math.max(1, safeLayoutHeight - totalZoneGap);
  const maximumColumns = Math.max(...STORAGE_TYPES.map(storageType => counts[storageType]));

  if (!maximumColumns) {
    const emptyCandidate = {
      itemCounts: counts,
      columns: 0,
      rows: makeStorageRecord(),
      cardSize: 0,
      emptySlots: 0,
      totalRows: 0,
      minimumRequiredHeight: STORAGE_TYPES.length
        * (metrics.zoneBlockChrome + metrics.emptyZoneContentHeight)
        + totalZoneGap,
      fits: true
    };
    return finalizePageLayout(emptyCandidate, safeLayoutHeight, metrics);
  }

  let best = null;
  for (let columns = 1; columns <= maximumColumns; columns += 1) {
    const rows = calculateRows(counts, columns);
    const rowTotal = totalItems(rows);
    const fixedHeight = calculateFixedHeight(counts, rows, metrics);
    const availablePhotoHeight = availableZoneHeight - fixedHeight;
    const photoSizeByHeight = rowTotal > 0 ? availablePhotoHeight / rowTotal : 0;
    const photoSizeByWidth = (
      gridWidth - metrics.gridGap * Math.max(0, columns - 1)
    ) / columns;
    const rawCardSize = Math.min(photoSizeByWidth, photoSizeByHeight);
    const cardSize = Math.max(0, Math.floor(rawCardSize));
    const emptySlots = STORAGE_TYPES.reduce((sum, storageType) => {
      if (!counts[storageType]) return sum;
      return sum + rows[storageType] * columns - counts[storageType];
    }, 0);
    const minimumRequiredHeight = fixedHeight
      + rowTotal * Math.max(0, cardSize)
      + totalZoneGap;
    const candidate = {
      itemCounts: counts,
      columns,
      rows,
      cardSize,
      emptySlots,
      totalRows: rowTotal,
      minimumRequiredHeight,
      fits: rawCardSize >= 1 && minimumRequiredHeight <= safeLayoutHeight + 0.5
    };

    if (isBetterPageLayout(candidate, best)) best = candidate;
  }

  return finalizePageLayout(best, safeLayoutHeight, metrics);
}

function buildBalancedFirstPageCounts(itemCounts) {
  return STORAGE_TYPES.reduce((candidates, storageType) => {
    const lower = Math.floor(itemCounts[storageType] / 2);
    const upper = Math.ceil(itemCounts[storageType] / 2);
    const choices = lower === upper ? [lower] : [lower, upper];

    return candidates.flatMap(candidate =>
      choices.map(choice => ({ ...candidate, [storageType]: choice }))
    );
  }, [{}]);
}

function isBetterTwoPagePlan(candidate, current) {
  if (!current) return true;
  if (candidate.pageBalance !== current.pageBalance) {
    return candidate.pageBalance < current.pageBalance;
  }
  if (candidate.cardSize !== current.cardSize) return candidate.cardSize > current.cardSize;
  if (candidate.missingSplitTypes !== current.missingSplitTypes) {
    return candidate.missingSplitTypes < current.missingSplitTypes;
  }
  if (candidate.activeZoneBalance !== current.activeZoneBalance) {
    return candidate.activeZoneBalance < current.activeZoneBalance;
  }
  if (candidate.storageBalance !== current.storageBalance) {
    return candidate.storageBalance < current.storageBalance;
  }
  if (candidate.combinedCardSize !== current.combinedCardSize) {
    return candidate.combinedCardSize > current.combinedCardSize;
  }
  if (candidate.emptySlots !== current.emptySlots) {
    return candidate.emptySlots < current.emptySlots;
  }
  return candidate.pageCounts[0]['상온'] < current.pageCounts[0]['상온'];
}

function chooseTwoPageLayout(itemCounts, layoutWidth, layoutHeight, rawMetrics) {
  if (totalItems(itemCounts) < 2) return null;

  const metrics = normalizeMetrics(rawMetrics);
  let best = null;

  for (const firstCounts of buildBalancedFirstPageCounts(itemCounts)) {
    const secondCounts = Object.fromEntries(STORAGE_TYPES.map(storageType => [
      storageType,
      itemCounts[storageType] - firstCounts[storageType]
    ]));
    const firstTotal = totalItems(firstCounts);
    const secondTotal = totalItems(secondCounts);
    if (!firstTotal || !secondTotal) continue;

    const firstLayout = chooseUniformPageLayout(
      firstCounts,
      layoutWidth,
      layoutHeight,
      metrics
    );
    const secondLayout = chooseUniformPageLayout(
      secondCounts,
      layoutWidth,
      layoutHeight,
      metrics
    );
    const cardSize = Math.min(firstLayout.cardSize, secondLayout.cardSize);
    const firstActiveZones = STORAGE_TYPES.filter(type => firstCounts[type] > 0).length;
    const secondActiveZones = STORAGE_TYPES.filter(type => secondCounts[type] > 0).length;
    const candidate = {
      pageCounts: [firstCounts, secondCounts],
      pageLayouts: [firstLayout, secondLayout],
      cardSize,
      combinedCardSize: firstLayout.cardSize + secondLayout.cardSize,
      pageBalance: Math.abs(firstTotal - secondTotal),
      missingSplitTypes: STORAGE_TYPES.filter(type =>
        itemCounts[type] >= 2 && (!firstCounts[type] || !secondCounts[type])
      ).length,
      activeZoneBalance: Math.abs(firstActiveZones - secondActiveZones),
      storageBalance: STORAGE_TYPES.reduce(
        (sum, type) => sum + Math.abs(firstCounts[type] - secondCounts[type]),
        0
      ),
      emptySlots: firstLayout.emptySlots + secondLayout.emptySlots
    };

    if (isBetterTwoPagePlan(candidate, best)) best = candidate;
  }

  if (!best) return null;
  return {
    ...best,
    pageLayouts: best.pageLayouts.map(layout =>
      finalizePageLayout(layout, layoutHeight, metrics, best.cardSize)
    )
  };
}

function groupItems(items) {
  const grouped = Object.fromEntries(STORAGE_TYPES.map(storageType => [storageType, []]));
  (Array.isArray(items) ? items : []).forEach(item => {
    if (grouped[item?.storageType]) grouped[item.storageType].push(item);
  });
  return grouped;
}

function buildProductPages(groupedItems, pageCounts) {
  const offsets = makeStorageRecord();
  return pageCounts.map(counts => Object.fromEntries(STORAGE_TYPES.map(storageType => {
    const start = offsets[storageType];
    const end = start + counts[storageType];
    offsets[storageType] = end;
    return [storageType, groupedItems[storageType].slice(start, end)];
  })));
}

export function buildAdaptiveProductPlan(
  items,
  layoutWidth,
  layoutHeight,
  rawMetrics = {}
) {
  const metrics = normalizeMetrics(rawMetrics);
  const groupedItems = groupItems(items);
  const itemCounts = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, groupedItems[storageType].length])
  );
  const singlePageLayout = chooseUniformPageLayout(
    itemCounts,
    layoutWidth,
    layoutHeight,
    metrics
  );
  const idealLayout = chooseUniformPageLayout(
    { '상온': 1, '냉장': 1, '냉동': 1 },
    layoutWidth,
    layoutHeight,
    metrics
  );
  const comfortableCardSize = Math.floor(idealLayout.cardSize * COMFORTABLE_CARD_RATIO);
  const twoPagePlan = singlePageLayout.cardSize < comfortableCardSize
    ? chooseTwoPageLayout(itemCounts, layoutWidth, layoutHeight, metrics)
    : null;
  const useTwoPages = Boolean(
    twoPagePlan
      && singlePageLayout.cardSize < comfortableCardSize
      && twoPagePlan.cardSize > singlePageLayout.cardSize
  );
  const selectedPageCounts = useTwoPages
    ? twoPagePlan.pageCounts
    : [itemCounts];
  const selectedPageLayouts = useTwoPages
    ? twoPagePlan.pageLayouts
    : [singlePageLayout];
  const cardSize = useTwoPages ? twoPagePlan.cardSize : singlePageLayout.cardSize;
  const pages = buildProductPages(groupedItems, selectedPageCounts);

  return {
    pages,
    pageCount: Math.min(MAX_PRODUCT_PAGES, pages.length),
    pageLayouts: selectedPageLayouts,
    pageCounts: selectedPageCounts,
    cardSize,
    singlePageCardSize: singlePageLayout.cardSize,
    comfortableCardSize
  };
}
