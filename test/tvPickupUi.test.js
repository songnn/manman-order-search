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
  assert.match(css, /\.zones-layout\s*\{[\s\S]*?display:\s*flex;/);

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
    'tv-guide-step1.jpeg',
    'tv-guide-step2.jpeg',
    'tv-guide-step3.jpeg',
    'tv-guide-step4.png'
  ]) {
    const data = await readFile(path.join(root, 'public', file));
    assert.ok(data.length > 100000);
    assert.match(html, new RegExp(file.replace('.', '\\.')));
  }

  assert.match(html, /010-9394-9071/);
  assert.match(html, /나의 주문, 휴대폰으로 지금 확인해보세요!/);
  assert.match(html, /무인픽업에 어려움이 있으신가요\?/);
  assert.match(html, /언제든지 아래 번호로 연락해 주세요\./);
  assert.doesNotMatch(html, /점장 연락처/);
  assert.doesNotMatch(html, /QR|qr-code|qrcode/i);
  assert.match(html, /내 주문 확인[\s\S]*?픽업존 수령[\s\S]*?키오스크 결제/);
  assert.match(html, /카톡방에서 상단[\s\S]*?🎈 필독[\s\S]*?눌러주세요\./);
  assert.match(html, /공구상품 주문조회[\s\S]*?눌러주세요\./);
  assert.match(html, /휴대폰 번호[\s\S]*?뒤 4자리[\s\S]*?입력해주세요\./);
  assert.match(html, /오늘의 픽업 상품 목록을 확인하실 수 있습니다\./);
  assert.match(html, /TV 오른쪽 끝/);
});

test('연락처는 구분선과 라벨 없이 전용 굵은 글꼴의 큰 번호로 표시된다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const contactPhone = css.match(/\.contact-phone\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(css, /\.contact-copy strong\s*\{[\s\S]*?font-size:\s*17px;/);
  assert.match(css, /\.contact-copy small\s*\{[\s\S]*?font-size:\s*11px;/);
  assert.match(contactPhone, /font-family:\s*'JalnanGothic'/);
  assert.match(contactPhone, /font-size:\s*36px;/);
  assert.doesNotMatch(contactPhone, /border-top|padding-top/);
});

test('픽업존 헤더는 기존 수량·위치 2단 구성을 WebP 아이콘과 함께 유지한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.doesNotMatch(html, /summaryCards|zone-location/);
  assert.match(html, /상온[\s\S]*?ambientCount[\s\S]*?↓ TV 바로 아래/);
  assert.match(html, /냉장[\s\S]*?chilledCount[\s\S]*?→ TV 오른쪽 끝/);
  assert.match(html, /냉동[\s\S]*?frozenCount[\s\S]*?↘ 뒤쪽 5시 방향/);
  assert.match(css, /\.board-column\s*\{[\s\S]*?grid-template-rows:\s*50px minmax\(0,\s*1fr\) 34px;/);
  assert.match(css, /\.zone\s*\{[\s\S]*?grid-template-rows:\s*62px minmax\(0,\s*1fr\);/);
  assert.match(css, /\.zone-header\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*29px 18px;/);
  assert.match(js, /readyByStorage/);
  assert.doesNotMatch(js, /renderSummary|입고 대기|입고 확인 중/);
});

test('상온·냉장·냉동 픽업존은 한 상품판에서 상품 수에 따라 유동적으로 넓어진다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.match(
    html,
    /id="zonesLayout"[\s\S]*?id="ambientZone"[\s\S]*?id="chilledZone"[\s\S]*?id="frozenZone"[\s\S]*?<\/div>/
  );
  assert.doesNotMatch(html, /lower-zones/);
  assert.match(css, /\.zone\s*\{[\s\S]*?padding:\s*3px;[\s\S]*?flex-grow:\s*var\(--zone-columns\);/);
  assert.match(
    js,
    /zone\.style\.setProperty\('--zone-columns',\s*String\(columns\)\)/
  );
  assert.match(js, /function refreshZoneCapacities\(\)/);
  assert.match(js, /function chooseZoneLayout\(/);
  assert.match(js, /elements\.zonesLayout\.clientWidth/);
  assert.doesNotMatch(js, /capacity:\s*(?:15|2|5),/);
  assert.doesNotMatch(css, /grid-template-columns:\s*29fr 71fr/);

  const columnSource = js.match(/function getZoneColumnCount\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(columnSource);
  const getZoneColumnCount = Function(`${columnSource}; return getZoneColumnCount;`)();
  assert.equal(getZoneColumnCount(22, 4), 6);
  assert.equal(getZoneColumnCount(5, 4), 2);
  assert.equal(getZoneColumnCount(4, 4), 1);
  assert.equal(getZoneColumnCount(0, 4), 1);
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
  assert.match(css, /\.product-card__name-text\s*\{[\s\S]*?max-height:\s*32px;[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*500;[\s\S]*?text-align:\s*center;[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.doesNotMatch(css, /-webkit-line-clamp:\s*3/);
  assert.match(js, /class="product-card__image"[\s\S]*?class="product-card__name"[\s\S]*?class="product-card__name-text"/);
  assert.match(js, /function clampProductNames\(/);
  assert.match(js, /scrollHeight[\s\S]*?clientHeight[\s\S]*?…/);
});

test('폭 채움 그리드는 모든 40종 보관방법 분포에서 4행 후보로 한 화면에 수용된다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const columnSource = js.match(/function getZoneColumnCount\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(columnSource);
  const getZoneColumnCount = Function(`${columnSource}; return getZoneColumnCount;`)();

  const visibleRows = 4;
  const layoutWidth = 1404;
  const gridHeight = 900;
  const zoneGap = 4;
  const zoneInlineChrome = 10;
  const gridGap = 4;
  const productNameHeight = 42;
  for (let ambient = 0; ambient <= 40; ambient += 1) {
    for (let chilled = 0; chilled <= 40 - ambient; chilled += 1) {
      const frozen = 40 - ambient - chilled;
      const itemCounts = [ambient, chilled, frozen];
      const columns = itemCounts.map(count => getZoneColumnCount(count, visibleRows));
      const totalColumns = columns.reduce((sum, count) => sum + count, 0);
      const usableWidth = layoutWidth - zoneGap * 2;

      assert.ok(
        totalColumns <= 12,
        `40종 분포 ${itemCounts.join('/')}가 가로 12열을 초과함`
      );
      itemCounts.forEach((count, index) => {
        const zoneWidth = usableWidth * columns[index] / totalColumns;
        const cardWidth = (
          zoneWidth - zoneInlineChrome - gridGap * Math.max(0, columns[index] - 1)
        ) / columns[index];
        const rows = count > 0 ? Math.ceil(count / columns[index]) : 0;
        const neededHeight = rows > 0
          ? rows * (cardWidth + productNameHeight) + (rows - 1) * gridGap
          : 0;
        assert.ok(
          count <= columns[index] * visibleRows,
          `${itemCounts.join('/')} 중 ${count}종 영역의 카드 수용량이 부족함`
        );
        assert.ok(
          neededHeight <= gridHeight,
          `${itemCounts.join('/')} 중 ${count}종 영역의 세로 공간이 부족함`
        );
      });
    }
  }
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

test('픽업존 헤더는 SVG 대표색·WebP 아이콘·600 굵기의 보관방법명을 사용한다', async () => {
  const html = await readFile(path.join(root, 'public', 'tv-pickup.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(html, /zone--ambient[\s\S]*?<img src="\/storage-ambient\.webp"/);
  assert.match(html, /zone--chilled[\s\S]*?<img src="\/storage-refrigerated-a2ca1185\.webp"/);
  assert.match(html, /zone--frozen[\s\S]*?<img src="\/storage-frozen\.webp"/);
  assert.match(css, /--ambient:\s*#FFB13B;/);
  assert.match(css, /--chilled:\s*#21D4E8;/);
  assert.match(css, /--frozen:\s*#38B6FF;/);
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
