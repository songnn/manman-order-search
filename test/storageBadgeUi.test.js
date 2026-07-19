import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(repoRoot, 'public', 'index.html');
const whiteStorageAssets = [
  'storage-refrigerated-a2ca1185.webp',
  'storage-refrigerated-78e338ae.webp',
  'storage-ambient.webp',
  'storage-frozen.webp'
];
const darkStorageAssets = [
  'storage-dark-refrigerated.svg',
  'storage-dark-ambient.svg',
  'storage-dark-frozen-v3-electric.svg'
];

test('화이트 보관방법 아이콘은 실제 WebP 파일로 보존된다', async () => {
  for (const assetName of whiteStorageAssets) {
    const data = await readFile(path.join(repoRoot, 'public', assetName));
    assert.equal(data.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(data.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(data.length > 1000);
  }
});

test('다크 보관방법 아이콘은 외부 실행 요소가 없는 SVG 파일이다', async () => {
  for (const assetName of darkStorageAssets) {
    const svg = await readFile(path.join(repoRoot, 'public', assetName), 'utf8');
    const hrefs = [...svg.matchAll(/\b(?:href|xlink:href)="([^"]+)"/g)].map(match => match[1]);

    assert.match(svg, /^<svg\b/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image)\b/i);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i);
    assert.ok(hrefs.every(href => href.startsWith('#')));
  }
});

test('주문 이미지의 세 렌더 경로에 선택된 보관방법 배지가 연결된다', async () => {
  const html = await readFile(indexPath, 'utf8');
  const renderCalls = html.match(/\$\{renderStorageMethodBadge\(item(?:, 'compact')?\)\}/g) || [];
  const compactRenderCalls = html.match(/\$\{renderStorageMethodBadge\(item, 'compact'\)\}/g) || [];

  assert.equal(renderCalls.length, 3);
  assert.equal(compactRenderCalls.length, 2);
  assert.match(html, /\.storage-method-badge\s*\{[\s\S]*?left:\s*12px;/);
  assert.match(html, /const STORAGE_METHOD_BADGE_THEME = 'dark';/);
  assert.match(html, /'냉장':[\s\S]*?white:[\s\S]*?storage-refrigerated-a2ca1185\.webp[\s\S]*?storage-refrigerated-78e338ae\.webp[\s\S]*?dark:[\s\S]*?storage-dark-refrigerated\.svg/);
  assert.match(html, /'상온':[\s\S]*?white:[\s\S]*?storage-ambient\.webp[\s\S]*?dark:[\s\S]*?storage-dark-ambient\.svg/);
  assert.match(html, /'냉동':[\s\S]*?white:[\s\S]*?storage-frozen\.webp[\s\S]*?dark:[\s\S]*?storage-dark-frozen-v3-electric\.svg/);
  assert.match(html, /storageStatus && storageStatus !== 'confirmed'/);
  assert.match(html, /const activeTheme = config\.themes\[STORAGE_METHOD_BADGE_THEME\][\s\S]*?: 'white';/);
  assert.match(html, /const iconUrl = context === 'compact'[\s\S]*?themeConfig\.compactIconUrl \|\| themeConfig\.iconUrl/);
  assert.match(html, /storage-method-badge--theme-\$\{activeTheme\}/);
  assert.match(html, /src="\$\{iconUrl\}"/);
  assert.match(html, /function renderScheduleProductCard[\s\S]*?renderStorageMethodBadge\(item, 'compact'\)/);
  assert.match(html, /if \(isShowAll\)[\s\S]*?renderStorageMethodBadge\(item, 'compact'\)/);
  assert.match(html, /<div class="swiper orders-swiper"[\s\S]*?renderStorageMethodBadge\(item\)/);
});

test('화이트 모바일 배지 크기와 아이콘 구성이 그대로 보존된다', async () => {
  const html = await readFile(indexPath, 'utf8');

  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.storage-method-badge\s*\{[\s\S]*?height:\s*26px;[\s\S]*?font-size:\s*13px;/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.storage-method-badge__icon\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
  assert.match(html, /\.orders-section\.show-all \.storage-method-badge\s*\{[\s\S]*?height:\s*20px;[\s\S]*?font-size:\s*9px;/);
  assert.match(html, /\.orders-section\.show-all \.storage-method-badge__icon\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
  assert.match(html, /@media \(max-width: 640px\)\s*\{\s*\.schedule-product-thumb-wrap \.storage-method-badge\s*\{[\s\S]*?height:\s*18px;[\s\S]*?font-size:\s*8px;/);
  assert.match(html, /\.schedule-product-thumb-wrap \.storage-method-badge__icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
});

test('다크 배지는 세 카드 경로에서 우측 반투명 사각 태그로 표시된다', async () => {
  const html = await readFile(indexPath, 'utf8');
  const darkBadgeBlocks = [...html.matchAll(/(?:^|\n)\s*[^\n{]*\.storage-method-badge\.storage-method-badge--theme-dark\s*\{([^}]*)\}/g)];

  assert.match(html, /\.storage-method-badge\.storage-method-badge--theme-dark\s*\{[\s\S]*?left:\s*auto;[\s\S]*?right:\s*12px;[\s\S]*?max-width:\s*none;[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*0 9px 0 5px;[\s\S]*?border-radius:\s*9px;[\s\S]*?background:\s*#0f1216c2;[\s\S]*?color:\s*#fff;[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*600;/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.storage-method-badge\.storage-method-badge--theme-dark\s*\{[\s\S]*?right:\s*8px;[\s\S]*?height:\s*26px;[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*0 9px 0 5px;[\s\S]*?border-radius:\s*9px;[\s\S]*?font-size:\s*12px;/);
  assert.match(html, /\.orders-section\.show-all \.storage-method-badge\.storage-method-badge--theme-dark\s*\{[\s\S]*?right:\s*5px;[\s\S]*?height:\s*20px;[\s\S]*?max-width:\s*none;[\s\S]*?gap:\s*1px;[\s\S]*?padding:\s*0 8px 0 4px;[\s\S]*?border-radius:\s*7px;[\s\S]*?font-size:\s*9px;/);
  assert.match(html, /\.schedule-product-thumb-wrap \.storage-method-badge\.storage-method-badge--theme-dark\s*\{[\s\S]*?right:\s*4px;[\s\S]*?min-height:\s*22px;[\s\S]*?max-width:\s*none;[\s\S]*?gap:\s*1px;[\s\S]*?padding:\s*0 8px 0 4px;[\s\S]*?border-radius:\s*7px;[\s\S]*?font-size:\s*9px;/);
  assert.match(html, /@media \(max-width: 640px\)\s*\{\s*\.schedule-product-thumb-wrap \.storage-method-badge\.storage-method-badge--theme-dark\s*\{[\s\S]*?height:\s*18px;[\s\S]*?gap:\s*1px;[\s\S]*?padding:\s*0 8px 0 4px;[\s\S]*?border-radius:\s*7px;[\s\S]*?font-size:\s*9px;/);
  assert.match(html, /\.storage-method-badge\.storage-method-badge--theme-dark \.storage-method-badge__icon\s*\{[\s\S]*?width:\s*24px;/);
  assert.match(html, /\.storage-method-badge\.storage-method-badge--theme-dark \.storage-method-badge__label\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow:\s*visible;[\s\S]*?text-overflow:\s*clip;/);
  assert.doesNotMatch(html, /storage-method-badge--theme-dark[^{]*\{[^}]*border-radius:\s*999px;/);
  assert.ok(darkBadgeBlocks.length >= 4);
  for (const [, declarations] of darkBadgeBlocks) {
    assert.doesNotMatch(declarations, /(?:^|[;\n])\s*width\s*:/);
  }
});
