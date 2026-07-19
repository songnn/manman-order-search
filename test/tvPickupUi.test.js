import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('TV 픽업 페이지는 1920×1152와 31:69 고정 레이아웃을 사용한다', async () => {
  const css = await readFile(path.join(root, 'public', 'tv-pickup.css'), 'utf8');

  assert.match(css, /\.tv-canvas\s*\{[\s\S]*?width:\s*1920px;[\s\S]*?height:\s*1152px;/);
  assert.match(css, /grid-template-columns:\s*31fr 69fr;/);
  assert.match(css, /html,[\s\S]*?body\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.product-grid--ambient\s*\{[\s\S]*?repeat\(5,/);
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
