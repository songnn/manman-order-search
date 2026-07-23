export const STORAGE_TYPES = Object.freeze(['상온', '냉장', '냉동']);

export const MAX_PRODUCT_PAGES = 2;

const COMFORTABLE_CARD_RATIO = 0.85;
const DEFAULT_ZONE_GRID_TRACKS = 12;
const DEFAULT_MIN_ZONE_TRACK_SPAN = 3;

const ZONE_LAYOUT_TEMPLATES = Object.freeze([
  {
    key: 'columns',
    rows: [STORAGE_TYPES]
  },
  {
    key: 'stacked',
    rows: STORAGE_TYPES.map(storageType => [storageType])
  },
  ...STORAGE_TYPES.flatMap(primaryType => {
    const secondaryTypes = STORAGE_TYPES.filter(storageType => storageType !== primaryType);
    return [
      {
        key: `${primaryType}-wide-first`,
        rows: [[primaryType], secondaryTypes]
      },
      {
        key: `${primaryType}-wide-last`,
        rows: [secondaryTypes, [primaryType]]
      }
    ];
  })
]);

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
  const zoneBlockChrome = Math.max(0, Number(metrics.zoneBlockChrome || 0));
  return {
    zoneGap: Math.max(0, Number(metrics.zoneGap || 0)),
    gridGap: Math.max(0, Number(metrics.gridGap || 0)),
    zoneInlineChrome: Math.max(0, Number(metrics.zoneInlineChrome || 0)),
    zoneBlockChrome,
    compactZoneBlockChrome: Math.max(
      zoneBlockChrome,
      Number(metrics.compactZoneBlockChrome || zoneBlockChrome)
    ),
    emptyZoneContentHeight: Math.max(0, Number(metrics.emptyZoneContentHeight || 0)),
    productNameHeight: Math.max(0, Number(metrics.productNameHeight || 0)),
    zoneGridTracks: Math.max(
      STORAGE_TYPES.length,
      Math.floor(Number(metrics.zoneGridTracks || DEFAULT_ZONE_GRID_TRACKS))
    ),
    minZoneTrackSpan: Math.max(
      1,
      Math.floor(Number(metrics.minZoneTrackSpan || DEFAULT_MIN_ZONE_TRACK_SPAN))
    )
  };
}

export function chunkItemsIntoRows(items, columnCount) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];

  const columns = Math.max(1, Math.floor(Number(columnCount || 0)) || 1);
  const rowCount = Math.ceil(source.length / columns);
  const baseRowLength = Math.floor(source.length / rowCount);
  let longerRowCount = source.length % rowCount;
  let offset = 0;

  return Array.from({ length: rowCount }, () => {
    const rowLength = baseRowLength + (longerRowCount > 0 ? 1 : 0);
    const row = source.slice(offset, offset + rowLength);
    offset += rowLength;
    longerRowCount = Math.max(0, longerRowCount - 1);
    return row;
  });
}

function buildZoneGridOptions(count) {
  if (!count) {
    return [{
      columns: 0,
      rows: 0,
      emptySlots: 0
    }];
  }

  const options = [];
  const seenRowCounts = new Set();
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    if (seenRowCounts.has(rows)) continue;
    seenRowCounts.add(rows);
    options.push({
      columns,
      rows,
      emptySlots: rows * columns - count
    });
  }
  return options;
}

function buildSpanOptions(storageTypes, trackCount, rawMinimumSpan) {
  if (storageTypes.length === 1) {
    return [{ [storageTypes[0]]: trackCount }];
  }

  const minimumSpan = Math.min(
    rawMinimumSpan,
    Math.max(1, Math.floor(trackCount / storageTypes.length))
  );
  const results = [];

  function visit(index, remainingTracks, spans) {
    const remainingTypes = storageTypes.length - index;
    if (remainingTypes === 1) {
      if (remainingTracks >= minimumSpan) {
        results.push({
          ...spans,
          [storageTypes[index]]: remainingTracks
        });
      }
      return;
    }

    const maximumSpan = remainingTracks - minimumSpan * (remainingTypes - 1);
    for (let span = minimumSpan; span <= maximumSpan; span += 1) {
      visit(index + 1, remainingTracks - span, {
        ...spans,
        [storageTypes[index]]: span
      });
    }
  }

  visit(0, trackCount, {});
  return results;
}

function calculateZoneWidth(layoutWidth, trackCount, zoneGap, columnSpan) {
  const availableTrackWidth = Math.max(
    1,
    layoutWidth - zoneGap * Math.max(0, trackCount - 1)
  );
  const trackWidth = availableTrackWidth / trackCount;
  return trackWidth * columnSpan + zoneGap * Math.max(0, columnSpan - 1);
}

function buildTemplatePlacements(template, layoutWidth, metrics) {
  const rowSpanOptions = template.rows.map(row =>
    buildSpanOptions(row, metrics.zoneGridTracks, metrics.minZoneTrackSpan)
  );
  const spanCombinations = rowSpanOptions.reduce(
    (combinations, options) =>
      combinations.flatMap(combination =>
        options.map(option => [...combination, option])
      ),
    [[]]
  );

  return spanCombinations.map(rowSpans => {
    const zones = {};
    template.rows.forEach((row, rowIndex) => {
      let columnStart = 1;
      row.forEach(storageType => {
        const columnSpan = rowSpans[rowIndex][storageType];
        zones[storageType] = {
          row: rowIndex + 1,
          columnStart,
          columnSpan,
          width: calculateZoneWidth(
            layoutWidth,
            metrics.zoneGridTracks,
            metrics.zoneGap,
            columnSpan
          ),
          compactHeader: row.length > 1
        };
        columnStart += columnSpan;
      });
    });

    return {
      templateKey: template.key,
      templateRows: template.rows.map(row => [...row]),
      zones
    };
  });
}

function zoneBlockChrome(zone, metrics) {
  return zone.compactHeader
    ? metrics.compactZoneBlockChrome
    : metrics.zoneBlockChrome;
}

function requiredZoneHeight(zone, cardSize, metrics) {
  const blockChrome = zoneBlockChrome(zone, metrics);
  if (!zone.count) return blockChrome + metrics.emptyZoneContentHeight;

  return blockChrome
    + zone.rows * (cardSize + metrics.productNameHeight)
    + Math.max(0, zone.rows - 1) * metrics.gridGap;
}

function requiredPageHeight(templateRows, zones, cardSize, metrics) {
  const rowHeight = row => Math.max(
    ...row.map(storageType => requiredZoneHeight(zones[storageType], cardSize, metrics))
  );
  return templateRows.reduce((sum, row) => sum + rowHeight(row), 0)
    + metrics.zoneGap * Math.max(0, templateRows.length - 1);
}

function calculateEmptyZoneArea(templateRows, zones, cardSize, metrics) {
  const rowHeights = templateRows.map(row => Math.max(
    ...row.map(storageType => requiredZoneHeight(zones[storageType], cardSize, metrics))
  ));
  return STORAGE_TYPES.reduce((sum, storageType) => {
    const zone = zones[storageType];
    if (zone.count > 0) return sum;
    return sum + zone.width * rowHeights[zone.row - 1];
  }, 0);
}

function maximumCardSizeForCandidate(templateRows, zones, layoutHeight, metrics) {
  const activeZones = STORAGE_TYPES
    .map(storageType => zones[storageType])
    .filter(zone => zone.count > 0);
  if (!activeZones.length) return 0;

  const maximumByWidth = Math.min(...activeZones.map(zone => zone.maximumCardSize));
  if (maximumByWidth < 1) return 0;

  let low = 0;
  let high = maximumByWidth;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (requiredPageHeight(templateRows, zones, middle, metrics) <= layoutHeight + 0.5) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function readingOrderPenalty(templateRows) {
  const flattened = templateRows.flat();
  let inversions = 0;
  for (let left = 0; left < flattened.length; left += 1) {
    for (let right = left + 1; right < flattened.length; right += 1) {
      if (
        STORAGE_TYPES.indexOf(flattened[left])
        > STORAGE_TYPES.indexOf(flattened[right])
      ) {
        inversions += 1;
      }
    }
  }
  return inversions;
}

function isBetterPageLayout(candidate, current) {
  if (!current) return true;
  if (candidate.fits !== current.fits) return candidate.fits;
  if (candidate.cardSize !== current.cardSize) return candidate.cardSize > current.cardSize;
  if (candidate.emptySlots !== current.emptySlots) {
    return candidate.emptySlots < current.emptySlots;
  }
  if (candidate.emptyZoneArea !== current.emptyZoneArea) {
    return candidate.emptyZoneArea < current.emptyZoneArea;
  }
  if (candidate.readingOrderPenalty !== current.readingOrderPenalty) {
    return candidate.readingOrderPenalty < current.readingOrderPenalty;
  }
  if (candidate.compactZoneCount !== current.compactZoneCount) {
    return candidate.compactZoneCount < current.compactZoneCount;
  }
  if (candidate.templateRows.length !== current.templateRows.length) {
    return candidate.templateRows.length < current.templateRows.length;
  }
  return candidate.layoutKey < current.layoutKey;
}

function distributeRowHeights(minimumHeights, layoutHeight, zoneGap, rowWeights) {
  const rowHeights = minimumHeights.map(height => Math.floor(height));
  const totalGap = zoneGap * Math.max(0, rowHeights.length - 1);
  let remaining = Math.max(
    0,
    Math.floor(layoutHeight - totalGap - rowHeights.reduce((sum, height) => sum + height, 0))
  );
  const recipients = rowWeights.flatMap((weight, rowIndex) =>
    Array.from({ length: Math.max(1, weight) }, () => rowIndex)
  );

  for (let index = 0; remaining > 0; index += 1) {
    rowHeights[recipients[index % recipients.length]] += 1;
    remaining -= 1;
  }
  return rowHeights;
}

function finalizePageLayout(candidate, layoutHeight, metrics, commonCardSize = candidate.cardSize) {
  const cardSize = Math.max(
    0,
    Math.min(candidate.cardSize, Math.floor(Number(commonCardSize || 0)))
  );
  const minimumRowHeights = candidate.templateRows.map(row => Math.max(
    ...row.map(storageType =>
      requiredZoneHeight(candidate.zones[storageType], cardSize, metrics)
    )
  ));
  const rowWeights = candidate.templateRows.map(row => Math.max(
    1,
    ...row.map(storageType => candidate.zones[storageType].rows || 0)
  ));
  const rowHeights = distributeRowHeights(
    minimumRowHeights,
    layoutHeight,
    metrics.zoneGap,
    rowWeights
  );
  const zones = Object.fromEntries(STORAGE_TYPES.map(storageType => {
    const source = candidate.zones[storageType];
    return [storageType, {
      ...source,
      cardSize,
      cardWidth: cardSize,
      cardHeight: cardSize + metrics.productNameHeight,
      height: rowHeights[source.row - 1]
    }];
  }));
  const zoneHeights = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [storageType, zones[storageType].height])
  );

  return {
    ...candidate,
    cardSize,
    imageSize: cardSize,
    cardWidth: cardSize,
    cardHeight: cardSize + metrics.productNameHeight,
    columnsByStorage: Object.fromEntries(
      STORAGE_TYPES.map(storageType => [storageType, zones[storageType].columns])
    ),
    rowsByStorage: Object.fromEntries(
      STORAGE_TYPES.map(storageType => [storageType, zones[storageType].rows])
    ),
    rowHeights,
    zoneHeights,
    zones,
    totalRequiredHeight: rowHeights.reduce((sum, height) => sum + height, 0)
      + metrics.zoneGap * Math.max(0, rowHeights.length - 1)
  };
}

export function chooseAdaptivePageLayout(
  itemCounts,
  layoutWidth,
  layoutHeight,
  rawMetrics = {},
  layoutOptions = {}
) {
  const counts = normalizeItemCounts(itemCounts);
  const metrics = normalizeMetrics(rawMetrics);
  const safeLayoutWidth = Math.max(1, Number(layoutWidth || 0));
  const safeLayoutHeight = Math.max(1, Number(layoutHeight || 0));
  const gridOptions = Object.fromEntries(
    STORAGE_TYPES.map(storageType => [
      storageType,
      buildZoneGridOptions(counts[storageType])
    ])
  );
  let best = null;

  const templates = layoutOptions.templateKey
    ? ZONE_LAYOUT_TEMPLATES.filter(template => template.key === layoutOptions.templateKey)
    : ZONE_LAYOUT_TEMPLATES;

  for (const template of templates) {
    const placements = buildTemplatePlacements(template, safeLayoutWidth, metrics);
    for (const placement of placements) {
      const selectedOptions = {};

      function visit(storageIndex) {
        if (storageIndex < STORAGE_TYPES.length) {
          const storageType = STORAGE_TYPES[storageIndex];
          for (const option of gridOptions[storageType]) {
            selectedOptions[storageType] = option;
            visit(storageIndex + 1);
          }
          return;
        }

        const zones = Object.fromEntries(STORAGE_TYPES.map(storageType => {
          const option = selectedOptions[storageType];
          const zonePlacement = placement.zones[storageType];
          const usableWidth = Math.max(
            1,
            zonePlacement.width - metrics.zoneInlineChrome
          );
          const maximumCardSize = option.columns > 0
            ? Math.max(0, Math.floor((
              usableWidth
                - metrics.gridGap * Math.max(0, option.columns - 1)
            ) / option.columns))
            : 0;

          return [storageType, {
            ...zonePlacement,
            ...option,
            count: counts[storageType],
            maximumCardSize
          }];
        }));
        const cardSize = maximumCardSizeForCandidate(
          placement.templateRows,
          zones,
          safeLayoutHeight,
          metrics
        );
        const minimumRequiredHeight = requiredPageHeight(
          placement.templateRows,
          zones,
          cardSize,
          metrics
        );
        const activeTypes = STORAGE_TYPES.filter(storageType => counts[storageType] > 0);
        const candidate = {
          itemCounts: counts,
          templateKey: placement.templateKey,
          templateRows: placement.templateRows,
          trackCount: metrics.zoneGridTracks,
          zones,
          cardSize,
          emptySlots: STORAGE_TYPES.reduce(
            (sum, storageType) => sum + zones[storageType].emptySlots,
            0
          ),
          emptyZoneArea: activeTypes.length
            ? calculateEmptyZoneArea(
              placement.templateRows,
              zones,
              cardSize,
              metrics
            )
            : 0,
          totalRows: STORAGE_TYPES.reduce(
            (sum, storageType) => sum + zones[storageType].rows,
            0
          ),
          minimumRequiredHeight,
          fits: activeTypes.length
            ? cardSize >= 1 && minimumRequiredHeight <= safeLayoutHeight + 0.5
            : minimumRequiredHeight <= safeLayoutHeight + 0.5,
          readingOrderPenalty: readingOrderPenalty(placement.templateRows),
          compactZoneCount: STORAGE_TYPES.filter(
            storageType => zones[storageType].compactHeader
          ).length,
          layoutKey: `${placement.templateKey}:${STORAGE_TYPES.map(storageType => {
            const zone = zones[storageType];
            return `${zone.columnSpan}-${zone.columns}-${zone.rows}`;
          }).join(':')}`
        };

        if (isBetterPageLayout(candidate, best)) best = candidate;
      }

      visit(0);
    }
  }

  return finalizePageLayout(best, safeLayoutHeight, metrics);
}

// 이전 모듈 사용처가 깨지지 않도록 이름은 남기되, 실제 계산은 새 적응형 배치를 사용한다.
export function chooseUniformPageLayout(
  itemCounts,
  layoutWidth,
  layoutHeight,
  rawMetrics = {}
) {
  return chooseAdaptivePageLayout(itemCounts, layoutWidth, layoutHeight, rawMetrics);
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

function layoutShiftPenalty(firstLayout, secondLayout) {
  let penalty = firstLayout.templateKey === secondLayout.templateKey ? 0 : 100;
  STORAGE_TYPES.forEach(storageType => {
    const first = firstLayout.zones[storageType];
    const second = secondLayout.zones[storageType];
    penalty += Math.abs(first.row - second.row) * 10;
    penalty += Math.abs(first.columnStart - second.columnStart);
    penalty += Math.abs(first.columnSpan - second.columnSpan);
    penalty += Math.abs(first.columns - second.columns) * 2;
    penalty += Math.abs(first.rows - second.rows);
  });
  return penalty;
}

function isBetterLayoutPair(candidate, current) {
  if (!current) return true;
  const largerCardSize = Math.max(candidate.cardSize, current.cardSize);
  const stabilityTolerance = Math.max(16, Math.floor(largerCardSize * 0.08));
  if (Math.abs(candidate.cardSize - current.cardSize) > stabilityTolerance) {
    return candidate.cardSize > current.cardSize;
  }
  if (candidate.layoutShiftPenalty !== current.layoutShiftPenalty) {
    return candidate.layoutShiftPenalty < current.layoutShiftPenalty;
  }
  if (candidate.cardSize !== current.cardSize) return candidate.cardSize > current.cardSize;
  return candidate.emptySlots < current.emptySlots;
}

function chooseStableLayoutPair(
  firstCounts,
  secondCounts,
  layoutWidth,
  layoutHeight,
  metrics
) {
  const layoutPairs = [[
    chooseAdaptivePageLayout(firstCounts, layoutWidth, layoutHeight, metrics),
    chooseAdaptivePageLayout(secondCounts, layoutWidth, layoutHeight, metrics)
  ]];

  ZONE_LAYOUT_TEMPLATES.forEach(template => {
    layoutPairs.push([
      chooseAdaptivePageLayout(
        firstCounts,
        layoutWidth,
        layoutHeight,
        metrics,
        { templateKey: template.key }
      ),
      chooseAdaptivePageLayout(
        secondCounts,
        layoutWidth,
        layoutHeight,
        metrics,
        { templateKey: template.key }
      )
    ]);
  });

  let best = null;
  layoutPairs.forEach(pageLayouts => {
    const candidate = {
      pageLayouts,
      cardSize: Math.min(...pageLayouts.map(layout => layout.cardSize)),
      layoutShiftPenalty: layoutShiftPenalty(...pageLayouts),
      emptySlots: pageLayouts.reduce((sum, layout) => sum + layout.emptySlots, 0)
    };
    if (isBetterLayoutPair(candidate, best)) best = candidate;
  });
  return best;
}

function isBetterTwoPagePlan(candidate, current) {
  if (!current) return true;
  if (candidate.pageBalance !== current.pageBalance) {
    return candidate.pageBalance < current.pageBalance;
  }
  if (candidate.cardSize !== current.cardSize) return candidate.cardSize > current.cardSize;
  if (candidate.layoutShiftPenalty !== current.layoutShiftPenalty) {
    return candidate.layoutShiftPenalty < current.layoutShiftPenalty;
  }
  if (candidate.missingSplitTypes !== current.missingSplitTypes) {
    return candidate.missingSplitTypes < current.missingSplitTypes;
  }
  if (candidate.storageBalance !== current.storageBalance) {
    return candidate.storageBalance < current.storageBalance;
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

    const layoutPair = chooseStableLayoutPair(
      firstCounts,
      secondCounts,
      layoutWidth,
      layoutHeight,
      metrics
    );
    const [firstLayout, secondLayout] = layoutPair.pageLayouts;
    const cardSize = layoutPair.cardSize;
    const candidate = {
      pageCounts: [firstCounts, secondCounts],
      pageLayouts: [firstLayout, secondLayout],
      cardSize,
      pageBalance: Math.abs(firstTotal - secondTotal),
      missingSplitTypes: STORAGE_TYPES.filter(type =>
        itemCounts[type] >= 2 && (!firstCounts[type] || !secondCounts[type])
      ).length,
      storageBalance: STORAGE_TYPES.reduce(
        (sum, type) => sum + Math.abs(firstCounts[type] - secondCounts[type]),
        0
      ),
      layoutShiftPenalty: layoutPair.layoutShiftPenalty,
      emptySlots: layoutPair.emptySlots
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

function calculateComfortableCardSize(layoutHeight, metrics) {
  const totalZoneGap = metrics.zoneGap * Math.max(0, STORAGE_TYPES.length - 1);
  const fixedHeight = STORAGE_TYPES.length
    * (metrics.zoneBlockChrome + metrics.productNameHeight);
  const idealStackedCardSize = Math.max(
    0,
    Math.floor((
      Math.max(1, layoutHeight) - totalZoneGap - fixedHeight
    ) / STORAGE_TYPES.length)
  );
  return Math.floor(idealStackedCardSize * COMFORTABLE_CARD_RATIO);
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
  const singlePageLayout = chooseAdaptivePageLayout(
    itemCounts,
    layoutWidth,
    layoutHeight,
    metrics
  );
  const comfortableCardSize = calculateComfortableCardSize(layoutHeight, metrics);
  // 한 화면에서도 충분히 크게 보이면 전환 대기 없이 전체 상품을 한 번에 보여준다.
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
