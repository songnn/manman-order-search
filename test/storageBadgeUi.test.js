import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(repoRoot, 'public', 'index.html');
const storageAssets = [
  'storage-refrigerated.webp',
  'storage-ambient.webp',
  'storage-frozen.webp'
];

test('보관방법 아이콘 세 개는 실제 WebP 파일이다', async () => {
  for (const assetName of storageAssets) {
    const data = await readFile(path.join(repoRoot, 'public', assetName));
    assert.equal(data.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(data.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(data.length > 1000);
  }
});

test('주문 이미지의 세 렌더 경로에 좌측 보관방법 배지가 연결된다', async () => {
  const html = await readFile(indexPath, 'utf8');
  const renderCalls = html.match(/\$\{renderStorageMethodBadge\(item\)\}/g) || [];

  assert.equal(renderCalls.length, 3);
  assert.match(html, /\.storage-method-badge\s*\{[\s\S]*?left:\s*12px;/);
  assert.match(html, /'냉장':[\s\S]*?storage-refrigerated\.webp/);
  assert.match(html, /'상온':[\s\S]*?storage-ambient\.webp/);
  assert.match(html, /'냉동':[\s\S]*?storage-frozen\.webp/);
  assert.match(html, /storageStatus && storageStatus !== 'confirmed'/);
});
