import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('TV 픽업 페이지는 1920×1152를 기준 비율로만 사용하고 실제 화면을 빈틈없이 채운다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.match(css, /\.tv-canvas\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;[\s\S]*?left:\s*0;/);
  assert.match(css, /width:\s*var\(--tv-canvas-width,\s*100vw\);/);
  assert.match(css, /height:\s*var\(--tv-canvas-height,\s*100vh\);/);
  assert.match(css, /transform:\s*scale\(var\(--tv-canvas-scale,\s*1\)\);/);
  assert.doesNotMatch(css, /\.tv-canvas\s*\{[\s\S]*?width:\s*1920px;/);
  assert.doesNotMatch(css, /\.tv-canvas\s*\{[\s\S]*?height:\s*1152px;/);
  assert.match(css, /grid-template-columns:\s*25fr 75fr;/);
  assert.match(css, /html,[\s\S]*?body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.zones-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);

  assert.match(js, /const DESIGN_WIDTH\s*=\s*1920;/);
  assert.match(js, /const DESIGN_HEIGHT\s*=\s*1152;/);
  assert.match(js, /function fillViewport\(\)/);
  assert.match(js, /logicalWidth\s*=\s*Math\.ceil\(viewportWidth\s*\/\s*scale\)/);
  assert.match(js, /logicalHeight\s*=\s*Math\.ceil\(viewportHeight\s*\/\s*scale\)/);
  assert.match(js, /setProperty\('--tv-canvas-width'/);
  assert.match(js, /setProperty\('--tv-canvas-height'/);
  assert.match(js, /setProperty\('--tv-canvas-scale'/);
  assert.doesNotMatch(js, /translate\(-50%,\s*-50%\)/);
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
    const renderedWidth = logicalWidth * scale;
    const renderedHeight = logicalHeight * scale;

    assert.ok(renderedWidth >= viewportWidth);
    assert.ok(renderedHeight >= viewportHeight);
    assert.ok(renderedWidth - viewportWidth < scale + Number.EPSILON);
    assert.ok(renderedHeight - viewportHeight < scale + Number.EPSILON);
  }
});

test('주문조회 네 단계 캡처와 점장 전화번호가 QR 없이 표시된다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');

  for (const file of [
    'tv-guide-step1-v2.png',
    'tv-guide-step2-v2.png',
    'tv-guide-step3-v2.png',
    'tv-guide-step4-v2.png'
  ]) {
    const data = await readFile(path.join(root, 'public', file));
    assert.ok(data.length > 100000);
    assert.match(html, new RegExp(file.replace('.', '\\.')));
  }

  assert.match(html, /010-9394-9071/);
  assert.match(html, /나의 주문, 휴대폰으로 지금 확인해보세요!/);
  assert.match(html, /무인픽업에 어려움이 있으신가요\?/);
  assert.match(html, /언제든지 아래 번호로 연락해 주세요\./);
  assert.match(html, /주문조회를 위해 카톡에서 아래 순서대로 진행해주시기 바랍니다\./);
  assert.doesNotMatch(html, /점장 연락처/);
  assert.doesNotMatch(html, /QR|qr-code|qrcode/i);
  assert.match(html, /📱[\s\S]*?내 주문 확인[\s\S]*?🛍️[\s\S]*?픽업존 수량[\s\S]*?💳[\s\S]*?키오스크 결제/);
  assert.match(html, /카톡방에서 상단[\s\S]*?🎈 필독[\s\S]*?눌러주세요\./);
  assert.match(html, /공구상품 주문조회[\s\S]*?눌러주세요\./);
  assert.match(html, /휴대폰 번호[\s\S]*?뒤 4자리[\s\S]*?입력해주세요\./);
  assert.match(html, /오늘의 픽업 상품 목록을 확인하실 수 있습니다\./);
  assert.doesNotMatch(html, /guide-focus|guide-arrow/);
  assert.match(html, /TV 우측 선반대 픽업존/);
  assert.match(html, /TV 오른쪽 끝 냉장1 픽업존/);
  assert.match(html, /TV 뒤쪽 4시 방향 냉동1 픽업존/);
});

test('연락처는 구분선과 라벨 없이 강조용 잠실체의 큰 번호로 표시된다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const contactPhone = css.match(/\.contact-phone\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(css, /\.contact-copy strong\s*\{[\s\S]*?font-size:\s*20px;/);
  assert.match(css, /\.contact-copy small\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(contactPhone, /font-family:\s*var\(--font-highlight\);/);
  assert.match(contactPhone, /font-size:\s*44px;/);
  assert.doesNotMatch(contactPhone, /border-top|padding-top/);
});

test('TV 픽업 화면은 Pretendard를 기본으로 하고 핵심 강조에만 잠실체를 사용한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(html, /preload[^>]+TheJamsil-Regular\.ttf/);
  assert.match(html, /orioncactus\/pretendard\/dist\/web\/static\/pretendard\.css/);
  assert.match(css, /--font-base:\s*'Pretendard'/);
  assert.match(css, /--font-highlight:\s*'The Jamsil',\s*'Pretendard'/);
  assert.match(css, /body\s*\{[\s\S]*?font-family:\s*var\(--font-base\);/);
  assert.doesNotMatch(css, /JalnanGothic/);

  for (const selector of [
    '.brand-copy strong',
    '.guide-heading h1',
    '.guide-step > p b',
    '.contact-phone',
    '.date-block strong',
    '.summary-card strong',
    '.zone-title strong',
    '.zone-direction'
  ]) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?font-family:\\s*var\\(--font-highlight\\);`));
  }

  for (const selector of [
    '.brand-copy small',
    '.guide-heading p',
    '.guide-step > p',
    '.contact-copy',
    '.date-meta > span',
    '.zone-title em',
    '.product-card__name',
    '.product-empty',
    '.board-footer'
  ]) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?font-family:\\s*var\\(--font-base\\);`));
  }

  for (const file of [
    'TheJamsil-Regular.ttf',
    'TheJamsil-Medium.ttf',
    'TheJamsil-Bold.ttf',
    'TheJamsil-ExtraBold.ttf'
  ]) {
    const data = await readFile(path.join(root, 'public', 'fonts', file));
    assert.ok(data.length > 900000);
  }
});

test('픽업존 헤더는 보관방법·수량을 붙이고 위치 안내를 오른쪽에 크게 표시한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.doesNotMatch(html, /zone-location/);
  assert.match(html, /상온[\s\S]*?ambientCount[\s\S]*?→ TV 우측 선반대 픽업존/);
  assert.match(html, /냉장[\s\S]*?chilledCount[\s\S]*?→ TV 오른쪽 끝 냉장1 픽업존/);
  assert.match(html, /냉동[\s\S]*?frozenCount[\s\S]*?↘ TV 뒤쪽 4시 방향 냉동1 픽업존/);
  assert.match(css, /\.board-column\s*\{[\s\S]*?grid-template-rows:\s*var\(--top-header-height\) minmax\(0,\s*1fr\) 34px;/);
  assert.match(css, /\.zone\s*\{[\s\S]*?grid-template-rows:\s*var\(--zone-header-height\) minmax\(0,\s*1fr\);/);
  assert.match(css, /\.zone-header\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*max-content minmax\(0,\s*1fr\);[\s\S]*?grid-template-rows:\s*1fr;/);
  assert.match(css, /\.zone-title em\s*\{[\s\S]*?margin-left:\s*0;/);
  assert.match(css, /\.zone-header\s*\{[\s\S]*?padding:\s*2px 5px;/);
  assert.match(css, /\.zone-title img\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
  assert.match(css, /\.zone-title strong\s*\{[\s\S]*?font-size:\s*24px;/);
  assert.match(css, /\.zone-direction\s*\{[\s\S]*?justify-self:\s*end;[\s\S]*?font-size:\s*22px;[\s\S]*?text-align:\s*right;/);
  assert.match(js, /readyByStorage/);
  assert.doesNotMatch(js, /입고 대기|입고 확인 중/);
});

test('좌우 상단과 안내·보관 헤더는 같은 높이와 시작선을 공유한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(css, /--top-header-height:\s*72px;/);
  assert.match(css, /--zone-header-height:\s*62px;/);
  assert.match(css, /\.guide-column\s*\{[\s\S]*?grid-template-rows:\s*var\(--top-header-height\) minmax\(0,\s*1fr\);[\s\S]*?gap:\s*8px;/);
  assert.match(css, /\.board-column\s*\{[\s\S]*?grid-template-rows:\s*var\(--top-header-height\) minmax\(0,\s*1fr\) 34px;[\s\S]*?gap:\s*8px;/);
  assert.match(css, /\.guide-panel\s*\{[\s\S]*?padding:\s*4px 10px 10px;[\s\S]*?grid-template-rows:\s*var\(--zone-header-height\)/);
  assert.match(html, /id="pickupDate"[\s\S]*?TODAY'S PICK UP[\s\S]*?id="updateTime"[\s\S]*?id="summaryCards"/);
  assert.match(css, /\.brand-copy strong\s*\{[\s\S]*?font-size:\s*28px;/);
  assert.match(css, /\.date-block strong\s*\{[\s\S]*?font-size:\s*30px;/);
  assert.match(css, /\.date-meta small\s*\{[\s\S]*?font-size:\s*12px;/);
  assert.match(css, /\.summary-card strong\s*\{[\s\S]*?font-size:\s*18px;/);
});

test('실제 만만 로고와 작은 총·보관방법별 상품 요약을 표시한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const logo = await readFile(path.join(root, 'public', 'manman-logo-white.svg'), 'utf8');

  assert.match(html, /class="brand-logo" src="\/manman-logo-white\.svg"/);
  assert.doesNotMatch(html, /class="brand-mark"/);
  assert.match(html, /오늘의 픽업 안내[\s\S]*?만만마켓 전농래미안크레시티점/);
  assert.match(logo, /viewBox="0 0 156 137"/);
  assert.equal((logo.match(/<path\b/g) || []).length, 6);
  assert.equal((logo.match(/fill="#FFFFFF"/g) || []).length, 6);
  assert.doesNotMatch(logo, /<script|foreignObject|<image\b|(?:xlink:)?href=|on\w+=|@import/i);
  assert.match(css, /\.summary-card\s*\{[\s\S]*?height:\s*44px;/);
  assert.match(js, /function renderSummary\(summary\)/);
  assert.match(js, /summary\.totalProducts/);
  assert.match(js, /summary\.byStorage/);
  assert.match(js, /총 픽업상품/);
  assert.doesNotMatch(js, /입고 대기/);
});

test('안내 단계·수령 흐름·문의 영역은 현대적인 카드와 균일한 패딩을 사용한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(css, /\.guide-step\s*\{[\s\S]*?border-radius:\s*16px;[\s\S]*?box-shadow:/);
  assert.match(css, /\.guide-step > p b\s*\{[\s\S]*?border-radius:\s*10px;[\s\S]*?linear-gradient/);
  assert.match(css, /\.guide-step > p b::before\s*\{[\s\S]*?content:\s*'STEP';/);
  assert.match(css, /\.guide-heading h1\s*\{[\s\S]*?font-size:\s*22px;/);
  assert.match(css, /\.guide-step > p\s*\{[\s\S]*?font-size:\s*15px;/);
  assert.match(css, /\.pickup-flow\s*\{[\s\S]*?grid-template-columns:/);
  assert.match(html, /pickup-flow__icon/);
  assert.match(css, /\.manager-contact\s*\{[\s\S]*?padding:\s*6px 8px 5px;/);
});

test('상온·냉장·냉동 픽업존은 세로로 쌓이고 상품 행 수에 따라 높이가 유동적으로 바뀐다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.match(
    html,
    /id="zonesLayout"[\s\S]*?id="ambientZone"[\s\S]*?id="chilledZone"[\s\S]*?id="frozenZone"[\s\S]*?<\/div>/
  );
  assert.doesNotMatch(html, /lower-zones/);
  assert.match(css, /\.zones-layout\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.zone\s*\{[\s\S]*?width:\s*100%;[\s\S]*?padding:\s*3px;[\s\S]*?flex-grow:\s*var\(--zone-weight\);/);
  assert.match(
    js,
    /zone\.style\.setProperty\('--zone-columns',\s*String\(columns\)\)/
  );
  assert.match(
    js,
    /zone\.style\.setProperty\('--zone-weight',\s*String\(weight\)\)/
  );
  assert.match(js, /function refreshZoneCapacities\(\)/);
  assert.match(js, /function chooseZoneLayout\(/);
  assert.match(js, /elements\.zonesLayout\.clientWidth/);
  assert.match(js, /elements\.zonesLayout\.clientHeight/);
  assert.match(js, /zoneWeights\[storageType\]\s*=\s*Math\.ceil\(requiredHeight\)/);
  assert.match(js, /ratio\s*=\s*totalItems\s*>\s*0[\s\S]*?itemCounts\[storageType\][\s\S]*?remainingHeight/);
  assert.match(js, /totalRequiredHeight\s*-\s*layoutHeight/);
  assert.doesNotMatch(js, /capacity:\s*(?:15|2|5),/);
  assert.doesNotMatch(css, /grid-template-columns:\s*29fr 71fr/);

  const rowSource = js.match(/function getZoneRowCount\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(rowSource);
  const getZoneRowCount = Function(`${rowSource}; return getZoneRowCount;`)();
  assert.equal(getZoneRowCount(22, 11), 2);
  assert.equal(getZoneRowCount(5, 11), 1);
  assert.equal(getZoneRowCount(0, 11), 0);
});

test('상품카드는 각 보관존 폭을 채우고 정사각 상단 이미지·강제 두 줄 말줄임을 사용한다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.doesNotMatch(css, /--product-card-width|--product-card-height/);
  assert.match(css, /\.product-grid\s*\{[\s\S]*?repeat\(var\(--zone-columns\),\s*minmax\(0,\s*1fr\)\);[\s\S]*?justify-content:\s*stretch;/);
  assert.match(css, /\.product-card\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*auto;/);
  assert.doesNotMatch(css, /\.product-grid--ambient \.product-card|\.lower-zones \.product-card|\.zone--(?:ambient|chilled|frozen) \.product-card/);
  assert.match(css, /\.product-card__image\s*\{[\s\S]*?width:\s*100%;[\s\S]*?aspect-ratio:\s*1 \/ 1;[\s\S]*?object-fit:\s*cover;/);
  assert.match(css, /\.product-card__name\s*\{[\s\S]*?height:\s*var\(--product-name-height\);[\s\S]*?flex:\s*0 0 var\(--product-name-height\);/);
  assert.match(css, /\.product-card__name-text\s*\{[\s\S]*?max-height:\s*32px;[\s\S]*?font-size:\s*13px;[\s\S]*?font-weight:\s*500;[\s\S]*?text-align:\s*center;[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.doesNotMatch(css, /-webkit-line-clamp:\s*3/);
  assert.match(js, /class="product-card__image"[\s\S]*?class="product-card__name"[\s\S]*?class="product-card__name-text"/);
  assert.match(js, /function clampProductNames\(/);
  assert.match(js, /scrollHeight[\s\S]*?clientHeight[\s\S]*?…/);
});

test('세로형 보관존은 모든 40종 분포를 수용하며 상품이 많은 영역에 더 큰 높이를 준다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const layoutWidth = 1404;
  const layoutHeight = 994;
  const zoneGap = 4;
  const zoneInlineChrome = 10;
  const zoneBlockChrome = 75;
  const emptyZoneContentHeight = 24;
  const gridGap = 4;
  const productNameHeight = 42;

  const calculateCandidate = (itemCounts, columns) => {
    const gridWidth = layoutWidth - zoneInlineChrome;
    const cardWidth = (
      gridWidth - gridGap * Math.max(0, columns - 1)
    ) / columns;
    const cardHeight = cardWidth + productNameHeight;
    const rows = itemCounts.map(count => count > 0 ? Math.ceil(count / columns) : 0);
    const requiredHeights = rows.map(rowCount => zoneBlockChrome + (
      rowCount > 0
        ? rowCount * cardHeight + (rowCount - 1) * gridGap
        : emptyZoneContentHeight
    ));
    const zoneWeights = requiredHeights.map(Math.ceil);
    const totalGapHeight = zoneGap * 2;
    const totalRequiredHeight = zoneWeights.reduce((sum, height) => sum + height, 0) + totalGapHeight;
    const availableZoneHeight = Math.floor(layoutHeight - totalGapHeight);
    const remainingHeight = Math.max(
      0,
      availableZoneHeight - zoneWeights.reduce((sum, height) => sum + height, 0)
    );
    const totalItems = itemCounts.reduce((sum, count) => sum + count, 0);
    const shares = itemCounts.map((count, index) => {
      const exact = (totalItems > 0 ? count / totalItems : 1 / itemCounts.length) * remainingHeight;
      const base = Math.floor(exact);
      zoneWeights[index] += base;
      return { index, remainder: exact - base };
    }).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    const undistributed = Math.max(
      0,
      availableZoneHeight - zoneWeights.reduce((sum, height) => sum + height, 0)
    );
    for (let index = 0; index < undistributed; index += 1) {
      zoneWeights[shares[index % shares.length].index] += 1;
    }
    return { columns, rows, requiredHeights, zoneWeights, totalRequiredHeight, cardWidth };
  };

  const chooseCandidate = itemCounts => {
    const fitting = [];
    for (let columns = 1; columns <= 40; columns += 1) {
      const candidate = calculateCandidate(itemCounts, columns);
      if (candidate.totalRequiredHeight <= layoutHeight + 0.5) fitting.push(candidate);
    }
    return fitting.sort((a, b) => b.cardWidth - a.cardWidth)[0];
  };

  for (let ambient = 0; ambient <= 40; ambient += 1) {
    for (let chilled = 0; chilled <= 40 - ambient; chilled += 1) {
      const frozen = 40 - ambient - chilled;
      const itemCounts = [ambient, chilled, frozen];
      const layout = chooseCandidate(itemCounts);
      assert.ok(layout, `40종 분포 ${itemCounts.join('/')}에 맞는 세로 배치가 없음`);
      itemCounts.forEach((count, index) => {
        assert.ok(
          count <= layout.columns * Math.max(1, layout.rows[index]),
          `${itemCounts.join('/')} 중 ${count}종 영역의 카드 수용량이 부족함`
        );
      });
    }
  }

  const ambientHeavy = chooseCandidate([25, 5, 10]);
  const frozenHeavy = chooseCandidate([5, 7, 28]);
  const currentMix = chooseCandidate([21, 4, 11]);
  assert.ok(ambientHeavy.requiredHeights[0] > ambientHeavy.requiredHeights[1]);
  assert.ok(frozenHeavy.requiredHeights[2] > frozenHeavy.requiredHeights[0]);
  assert.ok(currentMix.zoneWeights[0] > currentMix.zoneWeights[2]);
  assert.ok(currentMix.zoneWeights[2] > currentMix.zoneWeights[1]);
  assert.match(js, /const MAX_LAYOUT_COLUMNS\s*=\s*MAX_VISIBLE_PRODUCTS;/);
  assert.match(js, /for \(let columns = 1; columns <= MAX_LAYOUT_COLUMNS; columns \+= 1\)/);
});

test('직전 영업일 유지 문구는 화면과 공개 정책 문구에서 제거된다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const dataSource = await readFile(path.join(root, 'lib', 'tvPickupData.js'), 'utf8');

  assert.doesNotMatch(js, /직전 영업일 유지/);
  assert.doesNotMatch(dataSource, /직전 영업일 유지/);
  assert.match(dataSource, /refreshPolicy:\s*'매일 오전 10시 자동 갱신'/);
});

test('고객 주문조회와 같은 다크 SVG·화이트 WebP 보관 아이콘을 공유한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
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
});

test('픽업존 헤더는 기존 대표색·연한 배경·WebP 아이콘·600 굵기의 보관방법명을 사용한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(html, /zone--ambient[\s\S]*?<img src="\/storage-ambient\.webp"/);
  assert.match(html, /zone--chilled[\s\S]*?<img src="\/storage-refrigerated-a2ca1185\.webp"/);
  assert.match(html, /zone--frozen[\s\S]*?<img src="\/storage-frozen\.webp"/);
  assert.match(css, /--ambient:\s*#d85a06;/);
  assert.match(css, /--ambient-dark:\s*#b84704;/);
  assert.match(css, /--ambient-soft:\s*#fff7ed;/);
  assert.match(css, /--chilled:\s*#0797ad;/);
  assert.match(css, /--chilled-dark:\s*#077f93;/);
  assert.match(css, /--chilled-soft:\s*#ecfeff;/);
  assert.match(css, /--frozen:\s*#4c4edb;/);
  assert.match(css, /--frozen-dark:\s*#3d3bbd;/);
  assert.match(css, /--frozen-soft:\s*#eef2ff;/);
  assert.match(css, /\.zone--ambient\s*\{[\s\S]*?border-color:\s*#ff9d4d;/);
  assert.match(css, /\.zone--chilled\s*\{[\s\S]*?border-color:\s*#55d5e4;/);
  assert.match(css, /\.zone--frozen\s*\{[\s\S]*?border-color:\s*#9296ff;/);
  assert.match(css, /\.zone-header\s*\{[\s\S]*?color:\s*#fff;/);
  assert.match(css, /\.zone-title em\s*\{[\s\S]*?background:\s*#ffffff2c;/);
  assert.match(css, /\.zone-title strong\s*\{[\s\S]*?font-weight:\s*600;/);
});

test('오른쪽 상품판만 18초 전환하고 데이터는 30초마다 갱신한다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.match(js, /PAGE_INTERVAL_MS\s*=\s*18\s*\*\s*1000/);
  assert.match(js, /REFRESH_INTERVAL_MS\s*=\s*30\s*\*\s*1000/);
  assert.match(js, /function scheduleTenOClockRefresh\(\)/);
  assert.match(js, /Date\.UTC\(parts\.year, parts\.month - 1, parts\.day, 10, 0, 0\)/);
  assert.match(js, /localStorage\.setItem\(CACHE_KEY/);
  assert.match(js, /state\.pageIndex\s*=\s*\(state\.pageIndex \+ 1\) % state\.pageCount/);
});

test('공개 경로와 서울 리전 API가 Vercel 설정에 연결된다', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));

  assert.deepEqual(
    config.rewrites.find(rule => rule.source === '/tv/pickup'),
    { source: '/tv/pickup', destination: '/tv-pickup.html' }
  );
  assert.deepEqual(config.functions['api/tv-pickup.js'], { regions: ['icn1'] });
});
