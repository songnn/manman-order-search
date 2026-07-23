import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_PRODUCT_PAGES,
  STORAGE_TYPES,
  buildAdaptiveProductPlan,
  chooseUniformPageLayout,
  chunkItemsIntoRows
} from '../public/tv-pickup-layout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layoutMetrics = Object.freeze({
  zoneGap: 4,
  gridGap: 4,
  zoneInlineChrome: 10,
  zoneBlockChrome: 75,
  emptyZoneContentHeight: 24,
  productNameHeight: 42
});

async function pickupFiles() {
  return Promise.all([
    readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8'),
    readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8'),
    readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8'),
    readFile(path.join(root, 'public', 'tv-pickup-layout.js'), 'utf8')
  ]);
}

function counts(ambient, chilled, frozen) {
  return { '상온': ambient, '냉장': chilled, '냉동': frozen };
}

function makeItems(ambient, chilled, frozen) {
  return [
    ...Array.from({ length: ambient }, (_, index) => ({ id: `a-${index}`, storageType: '상온' })),
    ...Array.from({ length: chilled }, (_, index) => ({ id: `c-${index}`, storageType: '냉장' })),
    ...Array.from({ length: frozen }, (_, index) => ({ id: `f-${index}`, storageType: '냉동' }))
  ];
}

function flattenPlanItems(plan) {
  return plan.pages.flatMap(page =>
    STORAGE_TYPES.flatMap(storageType => page[storageType] || [])
  );
}

function pageTotal(pageCounts) {
  return STORAGE_TYPES.reduce((sum, storageType) => sum + pageCounts[storageType], 0);
}

test('TV 픽업 페이지는 실제 화면 전체를 단일 상품판으로 채운다', async () => {
  const [html, css, js] = await pickupFiles();

  assert.match(css, /\.tv-canvas\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;[\s\S]*?left:\s*0;/);
  assert.match(css, /width:\s*var\(--tv-canvas-width,\s*100vw\);/);
  assert.match(css, /height:\s*var\(--tv-canvas-height,\s*100vh\);/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(css, /grid-template-columns:\s*25fr 75fr;/);
  assert.match(css, /transform:\s*scale\(var\(--tv-canvas-scale,\s*1\)\);/);
  assert.match(css, /\.board-column\s*\{[\s\S]*?grid-template-rows:\s*var\(--top-header-height\) minmax\(0,\s*1fr\) var\(--help-ticker-height\);/);
  assert.doesNotMatch(html, /class="guide-column"|class="board-footer"/);

  assert.match(js, /const DESIGN_WIDTH\s*=\s*1920;/);
  assert.match(js, /const DESIGN_HEIGHT\s*=\s*1152;/);
  assert.match(js, /logicalWidth\s*=\s*Math\.ceil\(viewportWidth\s*\/\s*scale\)/);
  assert.match(js, /logicalHeight\s*=\s*Math\.ceil\(viewportHeight\s*\/\s*scale\)/);
  assert.match(js, /setProperty\('--tv-canvas-width'/);
  assert.match(js, /setProperty\('--tv-canvas-height'/);
  assert.match(js, /setProperty\('--tv-canvas-scale'/);
});

test('여러 TV 화면비에서도 캔버스가 레터박스 없이 뷰포트를 덮는다', () => {
  for (const [viewportWidth, viewportHeight] of [
    [1920, 1152],
    [1920, 1080],
    [1920, 1200],
    [1600, 900],
    [2560, 1080],
    [1280, 1024]
  ]) {
    const scale = Math.min(viewportWidth / 1920, viewportHeight / 1152);
    const logicalWidth = Math.ceil(viewportWidth / scale);
    const logicalHeight = Math.ceil(viewportHeight / scale);

    assert.ok(logicalWidth * scale >= viewportWidth);
    assert.ok(logicalHeight * scale >= viewportHeight);
    assert.ok(logicalWidth * scale - viewportWidth < scale + Number.EPSILON);
    assert.ok(logicalHeight * scale - viewportHeight < scale + Number.EPSILON);
  }
});

test('삭제한 주문조회 안내 패널은 화면 밖 보관본에서 그대로 복구할 수 있다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const archive = await readFile(
    path.join(root, 'docs', 'tv-pickup-guide-column.archive.html'),
    'utf8'
  );

  assert.doesNotMatch(html, /휴대폰 주문조회 안내|tv-guide-step1-v2/);
  assert.match(archive, /복구 방법/);
  assert.match(archive, /#tvCanvas 첫 번째 자식/);
  assert.match(archive, /grid-template-columns:\s*25fr 75fr/);
  assert.match(archive, /padding:\s*18px/);
  assert.match(archive, /gap:\s*12px/);
  assert.match(archive, /class="guide-column"/);
  assert.match(archive, /010-9394-9071/);
  assert.match(archive, /나의 주문, 휴대폰으로 지금 확인해보세요!/);
  assert.match(archive, /📱[\s\S]*?내 주문 확인[\s\S]*?🛍️[\s\S]*?픽업존 수량[\s\S]*?💳[\s\S]*?키오스크 결제/);
  assert.match(css, /\.guide-column\s*\{/);
  assert.match(css, /\.contact-phone\s*\{/);

  for (const file of [
    'tv-guide-step1-v2.png',
    'tv-guide-step2-v2.png',
    'tv-guide-step3-v2.png',
    'tv-guide-step4-v2.png'
  ]) {
    const data = await readFile(path.join(root, 'public', file));
    assert.ok(data.length > 100000);
    assert.match(archive, new RegExp(file.replace('.', '\\.')));
  }
});

test('요청한 이전 상품 보관 문구와 하단 안내판은 완전히 제거된다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');

  assert.doesNotMatch(html, /▤/);
  assert.doesNotMatch(html, /이전 픽업 예정 상품도 오늘까지 보관합니다/);
  assert.doesNotMatch(html, /내 상품과 보관 위치는 휴대폰 주문조회에서 확인해 주세요/);
  assert.doesNotMatch(html, /board-footer/);
});

test('픽업 도움 전화번호를 최하단 무한 뉴스티커로 크게 안내한다', async () => {
  const [html, css] = await pickupFiles();

  assert.match(html, /class="pickup-help-ticker"[\s\S]*?role="note"[\s\S]*?010\.9394\.9071/);
  assert.ok((html.match(/010\.9394\.9071/g) || []).length >= 5);
  assert.match(html, /픽업에 어려움이 있으시면[\s\S]*?로 바로 연락주세요/);
  assert.match(html, /pickup-help-ticker__group pickup-help-ticker__group--clone/);
  assert.match(css, /--help-ticker-height:\s*64px;/);
  assert.match(css, /\.pickup-help-ticker\s*\{[\s\S]*?grid-template-columns:\s*230px minmax\(0,\s*1fr\);[\s\S]*?border:\s*2px solid #ffc928;/);
  assert.match(css, /\.pickup-help-ticker__message strong\s*\{[\s\S]*?font-size:\s*44px;/);
  assert.match(css, /\.pickup-help-ticker__track\s*\{[\s\S]*?animation:\s*pickup-help-marquee 24s linear infinite;/);
  assert.match(css, /@keyframes\s+pickup-help-marquee[\s\S]*?translate3d\(-50%,\s*0,\s*0\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.pickup-help-ticker__track[\s\S]*?animation:\s*none;/);
});

test('세 보관존 위치를 고대비 안내판으로 크고 명확하게 표시한다', async () => {
  const [html, css] = await pickupFiles();

  assert.match(html, /픽업 위치[\s\S]*?TV 오른쪽[\s\S]*?선반대 픽업존/);
  assert.match(html, /TV 오른쪽 끝[\s\S]*?냉장[\s\S]*?zone-direction__number">1<[\s\S]*?번 픽업존/);
  assert.match(
    html,
    /TV 뒤쪽[\s\S]*?4시 방향[\s\S]*?냉동[\s\S]*?zone-direction__number">1<[\s\S]*?번 픽업존[\s\S]*?zone-direction__divider"[^>]*>\+<[\s\S]*?냉동[\s\S]*?zone-direction__number">2<[\s\S]*?번 상단 3칸/
  );
  assert.equal((html.match(/class="zone-direction" role="note"/g) || []).length, 3);
  assert.match(css, /\.zone-direction\s*\{[\s\S]*?justify-self:\s*stretch;[\s\S]*?background:\s*linear-gradient\(90deg,\s*#fff/);
  assert.match(css, /\.zone-direction__label\s*\{[\s\S]*?font-size:\s*17px;/);
  assert.match(css, /\.zone-direction__lead\s*\{[\s\S]*?font-size:\s*32px;/);
  assert.match(css, /\.zone-direction__spot\s*\{[\s\S]*?font-size:\s*28px;/);
  assert.match(css, /\.zone-direction__number\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
  assert.match(css, /@keyframes\s+pickup-location-pulse/);
});

test('페이지 표시는 삭제된 푸터 대신 상품판 헤더에 보존된다', async () => {
  const [html, css, js] = await pickupFiles();

  assert.match(html, /<header class="board-header">[\s\S]*?id="summaryCards"[\s\S]*?id="pageIndicator"[\s\S]*?<\/header>/);
  assert.match(css, /\.page-indicator\s*\{[\s\S]*?height:\s*52px;[\s\S]*?font-family:\s*var\(--font-highlight\);/);
  assert.match(css, /\.page-indicator\[hidden\]\s*\{[\s\S]*?display:\s*none;/);
  assert.match(js, /elements\.pageIndicator\.hidden\s*=\s*state\.pageCount\s*<=\s*1/);
  assert.match(js, /`\$\{state\.pageIndex \+ 1\}\/\$\{state\.pageCount\}`/);
});

test('상품판은 Pretendard를 기본으로 하고 핵심 숫자와 제목만 잠실체로 강조한다', async () => {
  const [html, css] = await pickupFiles();

  assert.match(html, /preload[^>]+TheJamsil-Regular\.ttf/);
  assert.match(html, /orioncactus\/pretendard\/dist\/web\/static\/pretendard\.css/);
  assert.match(css, /--font-base:\s*'Pretendard'/);
  assert.match(css, /--font-highlight:\s*'The Jamsil',\s*'Pretendard'/);
  assert.match(css, /body\s*\{[\s\S]*?font-family:\s*var\(--font-base\);/);
  assert.doesNotMatch(css, /JalnanGothic/);

  for (const selector of [
    '.date-block strong',
    '.summary-card strong',
    '.zone-title strong',
    '.zone-direction',
    '.page-indicator'
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escaped}\\s*\\{[\\s\\S]*?font-family:\\s*var\\(--font-highlight\\);`));
  }

  for (const selector of ['.date-meta > span', '.zone-title em', '.product-card__name', '.product-empty']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escaped}\\s*\\{[\\s\\S]*?font-family:\\s*var\\(--font-base\\);`));
  }
});

test('모든 행은 공통 고정 카드 폭을 쓰고 마지막 행은 늘어나지 않은 채 가운데 정렬된다', async () => {
  const [html, css, js, layoutSource] = await pickupFiles();
  const productRow = css.match(/\.product-row\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(html, /id="zonesLayout"[\s\S]*?id="ambientZone"[\s\S]*?id="chilledZone"[\s\S]*?id="frozenZone"/);
  assert.match(css, /\.zones-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(productRow, /grid-template-columns:\s*repeat\(var\(--row-columns\),\s*var\(--product-card-size\)\);/);
  assert.match(productRow, /justify-content:\s*center;/);
  assert.doesNotMatch(productRow, /minmax\(0,\s*1fr\)/);
  assert.match(js, /chunkItemsIntoRows\(/);
  assert.match(js, /--product-card-size/);
  assert.match(js, /pageLayouts\[state\.pageIndex\]/);
  assert.match(js, /zoneHeights\[storageType\]/);
  assert.doesNotMatch(js, /splitItemsIntoRows|wideClass/);
  assert.match(layoutSource, /function chooseUniformPageLayout\(/);

  assert.deepEqual(chunkItemsIntoRows(Array.from({ length: 25 }), 13).map(row => row.length), [13, 12]);
  assert.deepEqual(chunkItemsIntoRows(Array.from({ length: 14 }), 7).map(row => row.length), [7, 7]);
  assert.deepEqual(chunkItemsIntoRows(Array.from({ length: 5 }), 2).map(row => row.length), [2, 2, 1]);
});

test('모든 상품 카드는 같은 정사각 사진 위에 고정 높이 상품명을 항상 하단에 둔다', async () => {
  const [, css, js] = await pickupFiles();
  const card = css.match(/\.product-card\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const baseImage = css.match(/\.product-card__image\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const productName = css.match(/\.product-card__name\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(card, /width:\s*100%;/);
  assert.match(card, /height:\s*100%;/);
  assert.match(card, /flex-direction:\s*column;/);
  assert.match(baseImage, /width:\s*100%;/);
  assert.match(baseImage, /height:\s*var\(--product-card-size\);/);
  assert.match(baseImage, /aspect-ratio:\s*1\s*\/\s*1;/);
  assert.match(baseImage, /flex:\s*0 0 var\(--product-card-size\);/);
  assert.match(baseImage, /object-fit:\s*contain;/);
  assert.doesNotMatch(baseImage, /object-fit:\s*cover/);
  assert.match(productName, /height:\s*var\(--product-name-height\);/);
  assert.match(productName, /flex:\s*0 0 var\(--product-name-height\);/);
  assert.match(css, /\.product-card__name-text\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.doesNotMatch(css, /\.product-row--wide\b/);
  assert.doesNotMatch(js, /product-row--wide|wideClass|cardWidth\s*>=\s*rowHeight/);
  assert.match(js, /class="product-card__image"[\s\S]*?class="product-card__name"[\s\S]*?class="product-card__name-text"/);
  assert.match(js, /function clampProductNames\(/);
});

test('한 페이지 안에서는 모든 보관존이 하나의 공통 카드 크기로 자동 배치된다', () => {
  const layoutWidth = 1886;
  const layoutHeight = 976;
  const cases = [
    counts(1, 1, 1),
    counts(8, 8, 8),
    counts(10, 10, 10),
    counts(21, 4, 11),
    counts(14, 13, 13),
    counts(38, 1, 1)
  ];

  for (const input of cases) {
    const layout = chooseUniformPageLayout(input, layoutWidth, layoutHeight, layoutMetrics);

    assert.ok(layout, `${JSON.stringify(input)} 배치를 계산하지 못함`);
    assert.equal(layout.fits, true);
    assert.ok(Number.isFinite(layout.cardSize) && layout.cardSize > 0);
    assert.equal(layout.cardHeight, layout.cardSize + layoutMetrics.productNameHeight);
    assert.ok(Number.isInteger(layout.columns) && layout.columns > 0);
    assert.equal(
      layout.totalRows,
      STORAGE_TYPES.reduce((sum, storageType) => sum + layout.rows[storageType], 0)
    );
    assert.equal(
      layout.emptySlots,
      STORAGE_TYPES.reduce(
        (sum, storageType) =>
          sum + Math.max(0, layout.columns * layout.rows[storageType] - input[storageType]),
        0
      )
    );
    assert.equal(
      layout.totalRequiredHeight,
      STORAGE_TYPES.reduce((sum, storageType) => sum + layout.zoneHeights[storageType], 0)
        + layoutMetrics.zoneGap * (STORAGE_TYPES.length - 1)
    );
    assert.ok(layout.totalRequiredHeight <= layoutHeight);
    STORAGE_TYPES.forEach(storageType => {
      const rows = Number(layout.rows[storageType] || 0);
      assert.ok(layout.zoneHeights[storageType] > 0);
      if (input[storageType] > 0) {
        assert.ok(rows > 0);
        assert.equal(rows, Math.ceil(input[storageType] / layout.columns));
        assert.ok(layout.columns * rows >= input[storageType]);
      }
    });
  }

  const first = chooseUniformPageLayout(counts(21, 4, 11), layoutWidth, layoutHeight, layoutMetrics);
  const rotated = chooseUniformPageLayout(counts(4, 11, 21), layoutWidth, layoutHeight, layoutMetrics);
  assert.equal(first.cardSize, rotated.cardSize);
});

test('상품이 없는 날에도 세 보관존과 빈 상태를 한 화면 안에 유지한다', () => {
  const plan = buildAdaptiveProductPlan([], 1886, 976, layoutMetrics);
  const layout = plan.pageLayouts[0];

  assert.equal(plan.pageCount, 1);
  assert.equal(plan.pages.length, 1);
  assert.equal(plan.cardSize, 0);
  assert.equal(layout.columns, 0);
  assert.deepEqual(layout.rows, counts(0, 0, 0));
  assert.equal(layout.totalRequiredHeight, 976);
  STORAGE_TYPES.forEach(storageType => {
    assert.ok(layout.zoneHeights[storageType] > 0);
    assert.deepEqual(plan.pages[0][storageType], []);
  });
});

test('상품 수에 따라 한 화면 또는 두 화면을 선택하고 두 화면 모두 같은 카드 크기를 쓴다', async () => {
  const [, , js] = await pickupFiles();
  const cases = [
    { distribution: [8, 8, 8], pageCount: 1 },
    { distribution: [10, 10, 10], pageCount: 1 },
    { distribution: [14, 13, 13], pageCount: 2 },
    { distribution: [21, 4, 11], pageCount: 2 },
    { distribution: [38, 1, 1], pageCount: 2 }
  ];

  assert.equal(MAX_PRODUCT_PAGES, 2);
  for (const { distribution, pageCount } of cases) {
    const items = makeItems(...distribution);
    const plan = buildAdaptiveProductPlan(items, 1886, 976, layoutMetrics);
    const renderedIds = flattenPlanItems(plan).map(item => item.id).sort();

    assert.equal(plan.pages.length, pageCount, distribution.join('/'));
    assert.equal(plan.pageCount, pageCount);
    assert.equal(plan.pageLayouts.length, pageCount);
    assert.ok(Number.isFinite(plan.cardSize) && plan.cardSize > 100);
    if (pageCount === 2) {
      assert.ok(
        Math.abs(pageTotal(plan.pageCounts[0]) - pageTotal(plan.pageCounts[1])) <= 1,
        `${distribution.join('/')} 두 화면의 상품 수가 균등하지 않음`
      );
      STORAGE_TYPES.forEach(storageType => {
        assert.ok(
          Math.abs(
            plan.pageCounts[0][storageType] - plan.pageCounts[1][storageType]
          ) <= 1,
          `${distribution.join('/')} ${storageType} 상품이 한 화면에 치우침`
        );
      });
    }
    plan.pageLayouts.forEach(layout => {
      assert.equal(layout.fits, true);
      assert.equal(layout.cardSize, plan.cardSize);
      assert.equal(layout.cardHeight, plan.cardSize + layoutMetrics.productNameHeight);
      assert.ok(Number.isInteger(layout.columns) && layout.columns > 0);
      STORAGE_TYPES.forEach(storageType => {
        assert.ok(layout.zoneHeights[storageType] > 0);
      });
    });
    assert.deepEqual(renderedIds, items.map(item => item.id).sort());
    assert.equal(new Set(renderedIds).size, items.length);
  }

  const crowdedItems = makeItems(80, 20, 10);
  const crowdedPlan = buildAdaptiveProductPlan(crowdedItems, 1886, 976, layoutMetrics);
  const crowdedIds = flattenPlanItems(crowdedPlan).map(item => item.id);
  assert.ok(crowdedPlan.pages.length <= MAX_PRODUCT_PAGES);
  assert.equal(crowdedPlan.pageCount, crowdedPlan.pages.length);
  assert.equal(crowdedPlan.pageLayouts.length, crowdedPlan.pages.length);
  assert.equal(crowdedIds.length, crowdedItems.length);
  assert.equal(new Set(crowdedIds).size, crowdedItems.length);
  assert.deepEqual([...crowdedIds].sort(), crowdedItems.map(item => item.id).sort());

  const liveCountPlan = buildAdaptiveProductPlan(
    makeItems(21, 10, 10),
    1886,
    976,
    layoutMetrics
  );
  assert.deepEqual(liveCountPlan.pageCounts.map(pageTotal).sort((a, b) => a - b), [20, 21]);
  STORAGE_TYPES.forEach(storageType => {
    assert.ok(
      Math.abs(
        liveCountPlan.pageCounts[0][storageType]
          - liveCountPlan.pageCounts[1][storageType]
      ) <= 1
    );
  });

  const skewedPlan = buildAdaptiveProductPlan(
    makeItems(60, 1, 1),
    1886,
    976,
    layoutMetrics
  );
  assert.deepEqual(skewedPlan.pageCounts.map(pageTotal), [31, 31]);

  assert.match(js, /buildAdaptiveProductPlan\(/);
  assert.match(js, /state\.pageCount\s*=\s*state\.productPages\.length/);
  assert.match(js, /state\.productPages\[state\.pageIndex\]/);
  assert.match(js, /state\.pageIndex\s*=\s*\(state\.pageIndex \+ 1\) % state\.pageCount/);
  assert.doesNotMatch(js, /MAX_VISIBLE_PRODUCTS/);
});

test('보관존 색상·아이콘·요약 카드의 기존 시각 언어를 유지한다', async () => {
  const [html, css, js] = await pickupFiles();
  const combined = `${html}\n${js}`;

  for (const asset of [
    'storage-dark-ambient.svg',
    'storage-dark-refrigerated.svg',
    'storage-dark-frozen-v3-electric.svg',
    'storage-ambient.webp',
    'storage-refrigerated-a2ca1185.webp',
    'storage-refrigerated-78e338ae.webp',
    'storage-frozen.webp'
  ]) {
    assert.match(combined, new RegExp(asset.replaceAll('.', '\\.')));
  }

  assert.match(html, /zone--ambient[\s\S]*?<img src="\/storage-ambient\.webp"/);
  assert.match(html, /zone--chilled[\s\S]*?<img src="\/storage-refrigerated-a2ca1185\.webp"/);
  assert.match(html, /zone--frozen[\s\S]*?<img src="\/storage-frozen\.webp"/);
  assert.match(css, /--ambient:\s*#d85a06;/);
  assert.match(css, /--chilled:\s*#0797ad;/);
  assert.match(css, /--frozen:\s*#4c4edb;/);
  assert.match(css, /\.zone--ambient\s*\{[\s\S]*?border-color:\s*#ff9d4d;/);
  assert.match(css, /\.zone--chilled\s*\{[\s\S]*?border-color:\s*#55d5e4;/);
  assert.match(css, /\.zone--frozen\s*\{[\s\S]*?border-color:\s*#9296ff;/);
  assert.match(js, /function renderSummary\(summary\)/);
  assert.match(js, /summary\.totalProducts/);
  assert.match(js, /summary\.byStorage/);
  assert.match(js, /총 픽업상품/);
});

test('데이터 자동 갱신·페이지 전환·오전 10시 갱신 정책을 유지한다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const dataSource = await readFile(path.join(root, 'lib', 'tvPickupData.js'), 'utf8');

  assert.match(js, /PAGE_INTERVAL_MS\s*=\s*18\s*\*\s*1000/);
  assert.match(js, /REFRESH_INTERVAL_MS\s*=\s*30\s*\*\s*1000/);
  assert.match(js, /function scheduleTenOClockRefresh\(\)/);
  assert.match(js, /Date\.UTC\(parts\.year, parts\.month - 1, parts\.day, 10, 0, 0\)/);
  assert.match(js, /localStorage\.setItem\(CACHE_KEY/);
  assert.doesNotMatch(js, /직전 영업일 유지/);
  assert.doesNotMatch(dataSource, /직전 영업일 유지/);
  assert.match(dataSource, /refreshPolicy:\s*'매일 오전 10시 자동 갱신'/);
});

test('공개 경로와 서울 리전 API가 Vercel 설정에 연결된다', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));

  assert.deepEqual(
    config.rewrites.find(rule => rule.source === '/tv/pickup'),
    { source: '/tv/pickup', destination: '/tv-pickup.html' }
  );
  assert.deepEqual(config.functions['api/tv-pickup.js'], { regions: ['icn1'] });
});
