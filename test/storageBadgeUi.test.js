import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(repoRoot, 'public', 'index.html');
const storageAssets = [
  'storage-refrigerated-a2ca1185.webp',
  'storage-refrigerated-78e338ae.webp',
  'storage-ambient.webp',
  'storage-frozen.webp'
];

test('노출되는 보관방법 아이콘은 실제 WebP 파일이다', async () => {
  for (const assetName of storageAssets) {
    const data = await readFile(path.join(repoRoot, 'public', assetName));
    assert.equal(data.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(data.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(data.length > 1000);
  }
});

test('주문 이미지의 세 렌더 경로에 좌측 보관방법 배지가 연결된다', async () => {
  const html = await readFile(indexPath, 'utf8');
  const renderCalls = html.match(/\$\{renderStorageMethodBadge\(item(?:, 'compact')?\)\}/g) || [];
  const compactRenderCalls = html.match(/\$\{renderStorageMethodBadge\(item, 'compact'\)\}/g) || [];

  assert.equal(renderCalls.length, 3);
  assert.equal(compactRenderCalls.length, 2);
  assert.match(html, /\.storage-method-badge\s*\{[\s\S]*?left:\s*12px;/);
  assert.match(html, /'냉장':[\s\S]*?iconUrl:\s*'\/storage-refrigerated-a2ca1185\.webp'[\s\S]*?compactIconUrl:\s*'\/storage-refrigerated-78e338ae\.webp'/);
  assert.match(html, /'상온':[\s\S]*?storage-ambient\.webp/);
  assert.match(html, /'냉동':[\s\S]*?storage-frozen\.webp/);
  assert.match(html, /storageStatus && storageStatus !== 'confirmed'/);
  assert.match(html, /const iconUrl = context === 'compact'[\s\S]*?config\.compactIconUrl \|\| config\.iconUrl/);
  assert.match(html, /src="\$\{iconUrl\}"/);
  assert.match(html, /function renderScheduleProductCard[\s\S]*?renderStorageMethodBadge\(item, 'compact'\)/);
  assert.match(html, /if \(isShowAll\)[\s\S]*?renderStorageMethodBadge\(item, 'compact'\)/);
  assert.match(html, /<div class="swiper orders-swiper"[\s\S]*?renderStorageMethodBadge\(item\)/);
});

test('모바일 배지만 정수 크기로 축소하고 아이콘 크기는 유지한다', async () => {
  const html = await readFile(indexPath, 'utf8');

  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.storage-method-badge\s*\{[\s\S]*?height:\s*26px;[\s\S]*?font-size:\s*13px;/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.storage-method-badge__icon\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
  assert.match(html, /\.orders-section\.show-all \.storage-method-badge\s*\{[\s\S]*?height:\s*20px;[\s\S]*?font-size:\s*9px;/);
  assert.match(html, /\.orders-section\.show-all \.storage-method-badge__icon\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
  assert.match(html, /@media \(max-width: 640px\)\s*\{\s*\.schedule-product-thumb-wrap \.storage-method-badge\s*\{[\s\S]*?height:\s*18px;[\s\S]*?font-size:\s*8px;/);
  assert.match(html, /\.schedule-product-thumb-wrap \.storage-method-badge__icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;/);
});
