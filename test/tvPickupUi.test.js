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
  assert.doesNotMatch(html, /QR|qr-code|qrcode/i);
  assert.match(html, /내 주문 확인[\s\S]*?카운터 결제[\s\S]*?픽업존 수령/);
  assert.match(html, /→ TV 오른쪽 끝/);
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
  assert.match(css, /\.zone\s*\{[\s\S]*?flex-grow:\s*var\(--zone-weight\);/);
  assert.match(
    js,
    /zone\.style\.setProperty\('--zone-weight',\s*String\(getZoneWeight\(items\.length,\s*state\.zoneRows\)\)\)/
  );
  assert.match(js, /function refreshZoneCapacities\(\)/);
  assert.match(js, /grid\.clientWidth[\s\S]*?grid\.clientHeight/);
  assert.doesNotMatch(js, /capacity:\s*(?:15|2|5),/);
  assert.doesNotMatch(css, /grid-template-columns:\s*29fr 71fr/);

  const weightSource = js.match(/function getZoneWeight\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(weightSource);
  const getZoneWeight = Function(`${weightSource}; return getZoneWeight;`)();
  assert.equal(getZoneWeight(22, 5), 5);
  assert.equal(getZoneWeight(6, 5), 2);
  assert.equal(getZoneWeight(5, 5), 1);
  assert.equal(getZoneWeight(3, 5), 1);
  assert.equal(getZoneWeight(0, 5), 1);
});

test('모든 보관방법 카드는 같은 크기·정사각 상단 이미지·가운데 두 줄 말줄임을 사용한다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');

  assert.match(css, /--product-card-width:\s*120px;/);
  assert.match(css, /--product-card-height:\s*164px;/);
  assert.match(css, /\.product-card\s*\{[\s\S]*?width:\s*var\(--product-card-width\);[\s\S]*?height:\s*var\(--product-card-height\);/);
  assert.doesNotMatch(css, /\.product-grid--ambient \.product-card|\.lower-zones \.product-card|\.zone--(?:ambient|chilled|frozen) \.product-card/);
  assert.match(css, /\.product-card__image\s*\{[\s\S]*?width:\s*100%;[\s\S]*?aspect-ratio:\s*1 \/ 1;[\s\S]*?object-fit:\s*cover;/);
  assert.match(css, /\.product-card__name\s*\{[\s\S]*?text-align:\s*center;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?-webkit-line-clamp:\s*2;/);
  assert.doesNotMatch(css, /-webkit-line-clamp:\s*3/);
  assert.match(js, /class="product-card__image"[\s\S]*?class="product-card__name"/);
});

test('동일 카드 그리드는 모든 40종 보관방법 분포를 한 화면에 수용한다', async () => {
  const js = await readFile(path.join(root, 'public', 'tv-pickup.js'), 'utf8');
  const shapeSource = js.match(/function calculateGridShape\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  const weightSource = js.match(/function getZoneWeight\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(shapeSource);
  assert.ok(weightSource);
  const calculateGridShape = Function(`${shapeSource}; return calculateGridShape;`)();
  const getZoneWeight = Function(`${weightSource}; return getZoneWeight;`)();

  assert.equal(calculateGridShape(446, 920, 120, 164, 8).capacity, 15);
  assert.equal(calculateGridShape(1072, 920, 120, 164, 8).capacity, 40);

  const visibleRows = 5;
  const availableColumnTracks = 10;
  for (let ambient = 0; ambient <= 40; ambient += 1) {
    for (let chilled = 0; chilled <= 40 - ambient; chilled += 1) {
      const frozen = 40 - ambient - chilled;
      const itemCounts = [ambient, chilled, frozen];
      const columnWeights = itemCounts.map(count => getZoneWeight(count, visibleRows));

      assert.ok(
        columnWeights.reduce((sum, weight) => sum + weight, 0) <= availableColumnTracks,
        `40종 분포 ${itemCounts.join('/')}가 가로 10열을 초과함`
      );
      itemCounts.forEach((count, index) => {
        assert.ok(
          count <= columnWeights[index] * visibleRows,
          `${itemCounts.join('/')} 중 ${count}종 영역의 카드 수용량이 부족함`
        );
      });
    }
  }
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
