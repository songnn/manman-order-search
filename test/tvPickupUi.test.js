import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_VISIBLE_PRODUCTS,
  STORAGE_TYPES,
  buildProductPages,
  chooseZoneLayout,
  splitItemsIntoRows
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

test('TV 픽업 페이지는 실제 화면 전체를 단일 상품판으로 채운다', async () => {
  const [html, css, js] = await pickupFiles();

  assert.match(css, /\.tv-canvas\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;[\s\S]*?left:\s*0;/);
  assert.match(css, /width:\s*var\(--tv-canvas-width,\s*100vw\);/);
  assert.match(css, /height:\s*var\(--tv-canvas-height,\s*100vh\);/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(css, /grid-template-columns:\s*25fr 75fr;/);
  assert.match(css, /transform:\s*scale\(var\(--tv-canvas-scale,\s*1\)\);/);
  assert.match(css, /\.board-column\s*\{[\s\S]*?grid-template-rows:\s*var\(--top-header-height\) minmax\(0,\s*1fr\);/);
  assert.doesNotMatch(css, /\.board-column\s*\{[\s\S]*?minmax\(0,\s*1fr\) 34px;/);
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

  assert.doesNotMatch(html, /휴대폰 주문조회 안내|010-9394-9071|tv-guide-step1-v2/);
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

test('냉동 픽업 위치는 냉동1과 냉동2 상단 3칸을 함께 명확히 안내한다', async () => {
  const [html, css] = await pickupFiles();

  assert.match(html, /TV 우측[\s\S]*?선반대 픽업존/);
  assert.match(html, /TV 오른쪽 끝[\s\S]*?냉장[\s\S]*?zone-direction__number">1<[\s\S]*?픽업존/);
  assert.match(
    html,
    /TV 뒤쪽 4시 방향[\s\S]*?냉동[\s\S]*?zone-direction__number">1<[\s\S]*?냉동[\s\S]*?zone-direction__number">2<[\s\S]*?상단 3칸 픽업존/
  );
  assert.match(css, /\.zone-direction__spot\s*\{[\s\S]*?font-size:\s*28px;/);
  assert.match(css, /\.zone-direction__number\s*\{[\s\S]*?width:\s*29px;[\s\S]*?height:\s*29px;/);
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

test('각 보관존의 행은 상품 수에 맞게 따로 계산되고 마지막 행도 빈칸 없이 채운다', async () => {
  const [html, css, js, layoutSource] = await pickupFiles();

  assert.match(html, /id="zonesLayout"[\s\S]*?id="ambientZone"[\s\S]*?id="chilledZone"[\s\S]*?id="frozenZone"/);
  assert.match(css, /\.zones-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.zone\s*\{[\s\S]*?--zone-rows:\s*1;[\s\S]*?flex-grow:\s*var\(--zone-weight\);/);
  assert.match(css, /\.product-grid\s*\{[\s\S]*?grid-template-rows:\s*repeat\(var\(--zone-rows\),\s*minmax\(0,\s*1fr\)\);[\s\S]*?align-content:\s*stretch;/);
  assert.match(css, /\.product-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(var\(--row-columns\),\s*minmax\(0,\s*1fr\)\);/);
  assert.match(js, /splitItemsIntoRows\(visibleItems,\s*visibleRows\)/);
  assert.match(js, /class="product-row\$\{wideClass\}"[\s\S]*?--row-columns:/);
  assert.match(layoutSource, /function chooseZoneLayout\(/);

  assert.deepEqual(splitItemsIntoRows(Array.from({ length: 25 }), 2).map(row => row.length), [13, 12]);
  assert.deepEqual(splitItemsIntoRows(Array.from({ length: 14 }), 2).map(row => row.length), [7, 7]);
  assert.deepEqual(splitItemsIntoRows(Array.from({ length: 5 }), 3).map(row => row.length), [2, 2, 1]);
});

test('카드와 사진은 배정된 행의 가로·세로 공간을 모두 쓰고 사진을 자르지 않는다', async () => {
  const [, css, js] = await pickupFiles();
  const baseImage = css.match(/\.product-card__image\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(css, /\.product-card\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/);
  assert.match(baseImage, /width:\s*100%;[\s\S]*?height:\s*0;[\s\S]*?flex:\s*1 1 0;[\s\S]*?object-fit:\s*contain;/);
  assert.doesNotMatch(baseImage, /object-fit:\s*cover|aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(css, /\.product-row--wide \.product-card\s*\{[\s\S]*?flex-direction:\s*row;/);
  assert.match(css, /\.product-row--wide \.product-card__image\s*\{[\s\S]*?height:\s*100%;[\s\S]*?aspect-ratio:\s*1 \/ 1;/);
  assert.match(js, /cardWidth\s*>=\s*rowHeight \* 1\.45/);
  assert.match(css, /\.product-card__name\s*\{[\s\S]*?height:\s*var\(--product-name-height\);[\s\S]*?flex:\s*0 0 var\(--product-name-height\);/);
  assert.match(css, /\.product-card__name-text\s*\{[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.match(js, /class="product-card__image"[\s\S]*?class="product-card__name"[\s\S]*?class="product-card__name-text"/);
  assert.match(js, /function clampProductNames\(/);
});

test('대표적인 일별 상품 분포마다 사진 크기와 존 높이를 자동 최적화한다', () => {
  const layoutWidth = 1886;
  const layoutHeight = 1048;
  const cases = [
    { input: counts(0, 0, 0), rows: [0, 0, 0] },
    { input: counts(1, 1, 1), rows: [1, 1, 1] },
    { input: counts(21, 4, 11), rows: [2, 1, 1] },
    { input: counts(25, 5, 10), rows: [2, 1, 1] },
    { input: counts(14, 13, 13), rows: [2, 1, 1] },
    { input: counts(38, 1, 1), rows: [3, 1, 1] },
    { input: counts(40, 0, 0), rows: [4, 0, 0] }
  ];

  for (const { input, rows } of cases) {
    const layout = chooseZoneLayout(
      input,
      layoutWidth,
      layoutHeight,
      layoutMetrics,
      MAX_VISIBLE_PRODUCTS
    );
    const total = STORAGE_TYPES.reduce((sum, storageType) => sum + input[storageType], 0);

    assert.ok(layout?.fits, `${JSON.stringify(input)} 배치가 화면을 벗어남`);
    assert.equal(layout.totalRequiredHeight, layoutHeight);
    assert.deepEqual(STORAGE_TYPES.map(storageType => layout.rows[storageType]), rows);
    assert.equal(
      STORAGE_TYPES.reduce((sum, storageType) => sum + layout.pageQuotas[storageType], 0),
      Math.min(total, MAX_VISIBLE_PRODUCTS)
    );
    STORAGE_TYPES.forEach(storageType => {
      assert.ok(layout.columns[storageType] * Math.max(1, layout.rows[storageType]) >= layout.pageQuotas[storageType]);
    });
    if (total > 0) assert.ok(layout.minimumPhotoSize > 110);
  }

  const mix = chooseZoneLayout(counts(21, 4, 11), layoutWidth, layoutHeight, layoutMetrics);
  assert.ok(mix.zoneWeights['상온'] > mix.zoneWeights['냉장']);
  assert.ok(mix.columns['상온'] > mix.columns['냉장']);
});

test('같은 수량 분포의 보관방법 순서를 바꿔도 같은 배치가 함께 이동한다', () => {
  const first = chooseZoneLayout(counts(25, 5, 10), 1886, 1048, layoutMetrics);
  const rotated = chooseZoneLayout(counts(5, 10, 25), 1886, 1048, layoutMetrics);

  assert.deepEqual(
    [first.rows['상온'], first.rows['냉장'], first.rows['냉동']],
    [rotated.rows['냉동'], rotated.rows['상온'], rotated.rows['냉장']]
  );
  assert.equal(first.minimumPhotoSize, rotated.minimumPhotoSize);
});

test('40종 초과 시 최소 페이지에 최대 40종씩 담고 페이지마다 다시 배치한다', async () => {
  const [, , js] = await pickupFiles();
  const makeItems = (ambient, chilled, frozen) => [
    ...Array.from({ length: ambient }, (_, index) => ({ id: `a-${index}`, storageType: '상온' })),
    ...Array.from({ length: chilled }, (_, index) => ({ id: `c-${index}`, storageType: '냉장' })),
    ...Array.from({ length: frozen }, (_, index) => ({ id: `f-${index}`, storageType: '냉동' }))
  ];
  const items = makeItems(80, 20, 10);
  const pages = buildProductPages(items, MAX_VISIBLE_PRODUCTS);
  const sparsePages = buildProductPages(makeItems(0, 1, 79), MAX_VISIBLE_PRODUCTS);

  assert.equal(pages.length, Math.ceil(items.length / MAX_VISIBLE_PRODUCTS));
  assert.deepEqual(
    pages.map(page => STORAGE_TYPES.reduce((sum, storageType) => sum + page[storageType].length, 0)),
    [40, 40, 30]
  );
  assert.deepEqual(
    sparsePages.map(page => STORAGE_TYPES.reduce((sum, storageType) => sum + page[storageType].length, 0)),
    [40, 40]
  );
  const renderedIds = pages
    .flatMap(page => STORAGE_TYPES.flatMap(storageType => page[storageType]))
    .map(item => item.id)
    .sort();
  assert.deepEqual(renderedIds, items.map(item => item.id).sort());

  assert.match(js, /state\.productPages\s*=\s*buildProductPages/);
  assert.match(js, /state\.pageCount\s*=\s*state\.productPages\.length/);
  assert.match(js, /state\.productPages\[state\.pageIndex\]/);
  assert.match(js, /function refreshZoneLayout\(\)/);
  assert.match(js, /state\.pageIndex\s*=\s*\(state\.pageIndex \+ 1\) % state\.pageCount/);
  assert.match(js, /if \(!refreshZoneLayout\(\)\) renderBoard\(\)/);
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
