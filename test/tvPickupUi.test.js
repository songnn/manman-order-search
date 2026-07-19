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
  assert.match(css, /grid-template-columns:\s*31fr 69fr;/);
  assert.match(css, /html,[\s\S]*?body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.product-grid--ambient\s*\{[\s\S]*?repeat\(5,/);

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
  assert.match(html, /→ TV를 보고 맨 오른쪽/);
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
