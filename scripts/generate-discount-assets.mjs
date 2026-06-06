#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAllDiscountProductsForAssets,
  getDiscountAssetKey,
  getFallbackDiscountThemeColor,
  updateDiscountProductAssetCells
} from '../lib/discountProducts.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ASSET_DIR = path.join(PUBLIC_DIR, 'discount-assets');
const ICON_DIR = path.join(ASSET_DIR, 'icons');
const MANIFEST_PATH = path.join(ASSET_DIR, 'manifest.json');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const writeSheet = !args.has('--no-write-sheet');
const sourceUrl = getArgValue('--source-url');

await loadLocalEnv(path.join(ROOT_DIR, '.env.local'));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.4-mini';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';

async function main() {
  const products = await loadDiscountProducts();
  const manifest = await readManifest();
  const nextItems = { ...(manifest.items || {}) };
  const changed = [];
  const sheetUpdates = [];

  await fs.mkdir(ICON_DIR, { recursive: true });

  for (const product of products) {
    const assetKey = product.assetKey || getDiscountAssetKey(product.productName);
    if (!assetKey) continue;

    const existing = nextItems[assetKey];
    const sheetHasColor = Boolean(normalizeHexColor(product._sheetThemeColor));
    const sheetHasIcon = Boolean(normalizeIconUrl(product._sheetThemeIconUrl));

    if (isReusableLineIconAsset(existing) && !force) {
      queueSheetUpdate(sheetUpdates, product, existing, {
        sheetHasColor,
        sheetHasIcon
      });
      continue;
    }

    if (!dryRun && !OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY 환경변수가 필요합니다. 테스트만 하려면 --dry-run을 사용하세요.');
    }

    const metadata = dryRun
      ? createFallbackMetadata(product)
      : await generateThemeMetadata(product);
    const themeColor = normalizeHexColor(metadata.themeColor) ||
      normalizeHexColor(existing?.themeColor) ||
      getFallbackDiscountThemeColor(product.productName);
    const iconType = normalizeIconType(metadata.iconType) || normalizeIconType(existing?.iconType) || inferIconType(product);
    const iconPrompt = metadata.iconPrompt || createIconPrompt(product, themeColor, iconType);
    const iconFileName = `${assetKey}.svg`;
    const iconPath = path.join(ICON_DIR, iconFileName);
    const themeIconUrl = `/discount-assets/icons/${iconFileName}`;

    if (!dryRun) {
      await fs.writeFile(iconPath, createLineIconSvg({
        iconType,
        themeColor,
        title: product.productName
      }));
    }

    nextItems[assetKey] = {
      productName: product.productName,
      description: product.description || '',
      themeColor,
      themeIconUrl,
      iconPrompt,
      iconType,
      iconStyle: 'line-svg',
      generatedAt: new Date().toISOString(),
      source: dryRun ? 'line-svg-dry-run' : 'openai-metadata'
    };

    queueSheetUpdate(sheetUpdates, product, nextItems[assetKey], {
      sheetHasColor,
      sheetHasIcon,
      force
    });
    changed.push(nextItems[assetKey]);
  }

  const nextManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: nextItems
  };

  if (!dryRun) {
    await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`);
    if (writeSheet && sheetUpdates.length) {
      await updateDiscountProductAssetCells(sheetUpdates);
    }
  }

  console.log(JSON.stringify({
    dryRun,
    force,
    writeSheet,
    productCount: products.length,
    generatedCount: changed.length,
    sheetUpdateCount: sheetUpdates.length,
    generated: changed.map(item => ({
      productName: item.productName,
      themeColor: item.themeColor,
      themeIconUrl: item.themeIconUrl
    })),
    sheetUpdates: sheetUpdates.map(item => ({
      sheetRow: item.sheetRow,
      themeColor: item.themeColor,
      themeIconUrl: item.themeIconUrl
    }))
  }, null, 2));
}

async function loadDiscountProducts() {
  if (sourceUrl) {
    const response = await fetch(sourceUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`source-url 요청 실패 (${response.status})`);
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];

    return items.map(item => ({
      ...item,
      assetKey: item.assetKey || getDiscountAssetKey(item.productName)
    }));
  }

  return getAllDiscountProductsForAssets({ includeSheetAssetFields: true });
}

async function readManifest() {
  try {
    const text = await fs.readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(text);
  } catch {
    return {
      version: 1,
      generatedAt: null,
      items: {}
    };
  }
}

async function generateThemeMetadata(product) {
  const prompt = [
    'You are designing commerce UI assets for a Korean grocery discount card.',
    'Return only JSON with this shape: {"themeColor":"#RRGGBB","iconType":"octopus|squid|tofu|chicken-leg|seafood|meat|produce|beauty|default","iconPrompt":"..."}',
    'themeColor must be a premium line color that harmonizes with the product name and remains visible on a dark photo overlay.',
    'iconType must choose the closest simple line-icon category for the product.',
    'iconPrompt must describe a transparent-background single-color outline icon, no text, no fill-heavy 3D rendering, suitable inside a 40px square UI ornament.',
    `Product name: ${product.productName}`,
    `Description: ${product.description || ''}`
  ].join('\n');

  try {
    const result = await openaiJson('/v1/responses', {
      model: TEXT_MODEL,
      input: prompt
    });
    const text = extractOpenAIText(result);
    const parsed = parseJsonObject(text);

    return {
      themeColor: normalizeHexColor(parsed.themeColor),
      iconType: normalizeIconType(parsed.iconType),
      iconPrompt: String(parsed.iconPrompt || '').trim()
    };
  } catch (error) {
    console.warn(`theme metadata fallback: ${product.productName}`, error.message);
    return createFallbackMetadata(product);
  }
}

function createFallbackMetadata(product) {
  const themeColor = getFallbackDiscountThemeColor(product.productName);

  return {
    themeColor,
    iconType: inferIconType(product),
    iconPrompt: createIconPrompt(product, themeColor, inferIconType(product))
  };
}

function createIconPrompt(product, themeColor, iconType = inferIconType(product)) {
  return [
    'A single premium transparent-background line icon for a Korean market discount product.',
    'No letters, no numbers, no labels, no price tags, no background scene, no 3D rendering.',
    'Centered outline icon, single stroke color, clean rounded stroke caps and joins.',
    'Keep the object readable when rendered at 40px.',
    `Theme accent color: ${themeColor}.`,
    `Icon type: ${iconType}.`,
    `Product: ${product.productName}.`,
    `Product detail: ${product.description || ''}.`
  ].join(' ');
}

async function openaiJson(endpoint, body) {
  const response = await fetch(`https://api.openai.com${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = json?.error?.message || text || `OpenAI request failed (${response.status})`;
    throw new Error(message);
  }

  return json;
}

function extractOpenAIText(result) {
  if (typeof result?.output_text === 'string') return result.output_text;

  const chunks = [];
  const output = Array.isArray(result?.output) ? result.output : [];

  output.forEach(item => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach(part => {
      if (typeof part?.text === 'string') chunks.push(part.text);
      if (typeof part?.output_text === 'string') chunks.push(part.output_text);
    });
  });

  return chunks.join('\n').trim();
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function normalizeHexColor(value) {
  const text = String(value || '').trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return '';

  if (text.length === 4) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toUpperCase();
  }

  return text.toUpperCase();
}

function normalizeIconUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/')) return text;

  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    // Invalid URL.
  }

  return '';
}

const ICON_TYPES = new Set([
  'octopus',
  'squid',
  'tofu',
  'chicken-leg',
  'seafood',
  'meat',
  'produce',
  'beauty',
  'default'
]);

function normalizeIconType(value) {
  const text = String(value || '').trim().toLowerCase();
  return ICON_TYPES.has(text) ? text : '';
}

function inferIconType(product) {
  const text = `${product?.productName || ''} ${product?.description || ''}`.toLowerCase();
  if (/낙지|octopus/.test(text)) return 'octopus';
  if (/오징어|squid/.test(text)) return 'squid';
  if (/두부|tofu/.test(text)) return 'tofu';
  if (/통다리|닭|치킨|chicken|drumstick/.test(text)) return 'chicken-leg';
  if (/생선|해산|seafood|fish|새우|shrimp/.test(text)) return 'seafood';
  if (/고기|육|meat|beef|pork/.test(text)) return 'meat';
  if (/사과|과일|채소|야채|fruit|produce/.test(text)) return 'produce';
  if (/패드|화장|시카|뷰티|beauty|cosmetic/.test(text)) return 'beauty';
  return 'default';
}

function isReusableLineIconAsset(asset) {
  return Boolean(
    asset?.themeColor &&
    asset?.themeIconUrl &&
    normalizeIconUrl(asset.themeIconUrl).endsWith('.svg') &&
    asset.iconStyle === 'line-svg'
  );
}

function createLineIconSvg({ iconType, themeColor, title }) {
  const stroke = normalizeHexColor(themeColor) || '#F2DE95';
  const escapedTitle = escapeXml(title || 'discount product icon');
  const body = getLineIconBody(normalizeIconType(iconType) || 'default');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" role="img" aria-label="${escapedTitle}">
  <title>${escapedTitle}</title>
  <g stroke="${stroke}" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round">
${body}
  </g>
</svg>
`;
}

function getLineIconBody(iconType) {
  switch (iconType) {
    case 'octopus':
      return [
        '    <path d="M20 27c0-9 5.5-15 12-15s12 6 12 15c0 8-5 12-12 12s-12-4-12-12Z"/>',
        '    <path d="M24 41c-3 3-5 6-8 6"/>',
        '    <path d="M29 42c-1 5-3 8-6 10"/>',
        '    <path d="M35 42c1 5 3 8 6 10"/>',
        '    <path d="M40 41c3 3 5 6 8 6"/>',
        '    <path d="M28 25h.1M36 25h.1"/>'
      ].join('\n');
    case 'squid':
      return [
        '    <path d="M32 10 20 27l12 9 12-9-12-17Z"/>',
        '    <path d="M24 38c-2 4-5 7-9 9"/>',
        '    <path d="M29 39c-1 5-3 9-6 12"/>',
        '    <path d="M35 39c1 5 3 9 6 12"/>',
        '    <path d="M40 38c2 4 5 7 9 9"/>',
        '    <path d="M27 26h.1M37 26h.1"/>'
      ].join('\n');
    case 'tofu':
      return [
        '    <path d="M15 24 32 14l17 10v20L32 54 15 44V24Z"/>',
        '    <path d="M15 24 32 34l17-10"/>',
        '    <path d="M32 34v20"/>',
        '    <path d="M24 24c2-3 6-4 9-2"/>',
        '    <path d="M38 39h.1"/>'
      ].join('\n');
    case 'chicken-leg':
      return [
        '    <path d="M24 37c-6-6-5-16 2-21 8-5 19 0 21 8 2 9-4 16-12 17"/>',
        '    <path d="M25 36 14 47"/>',
        '    <path d="M12 46c-4-1-7 2-6 6 4 1 7-2 6-6Z"/>',
        '    <path d="M15 49c2 2 2 5 0 7 5 1 8-4 5-8"/>'
      ].join('\n');
    case 'seafood':
      return [
        '    <path d="M11 32c9-11 23-14 37-2-14 12-28 9-37 2Z"/>',
        '    <path d="M48 30 57 22v20l-9-8"/>',
        '    <path d="M24 31h.1"/>',
        '    <path d="M32 24c3 4 3 12 0 16"/>'
      ].join('\n');
    case 'meat':
      return [
        '    <path d="M16 38c-4-9 2-20 12-23 12-4 25 6 22 18-2 11-15 18-26 13"/>',
        '    <path d="M24 44 13 55"/>',
        '    <path d="M14 54c-4 0-7-3-6-7 4-1 7 2 6 7Z"/>',
        '    <path d="M32 25c4-2 9 0 11 4"/>'
      ].join('\n');
    case 'produce':
      return [
        '    <path d="M32 22c-10-8-22 1-19 15 2 11 11 18 19 13 8 5 17-2 19-13 3-14-9-23-19-15Z"/>',
        '    <path d="M32 22c0-7 4-11 10-12"/>',
        '    <path d="M28 14c3 0 6 2 7 5"/>'
      ].join('\n');
    case 'beauty':
      return [
        '    <path d="M20 12h24v40H20z"/>',
        '    <path d="M24 20h16"/>',
        '    <path d="M28 31c6-5 13 1 7 7-2 2-5 4-7 7"/>',
        '    <path d="M23 48c8 1 14-1 18-7"/>'
      ].join('\n');
    default:
      return [
        '    <path d="M32 10 47 18v18c0 10-6 16-15 20-9-4-15-10-15-20V18l15-8Z"/>',
        '    <path d="M24 33 30 39 42 25"/>'
      ].join('\n');
  }
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function queueSheetUpdate(updates, product, asset, options = {}) {
  if (!writeSheet || !product?.sheetRow || !asset?.themeColor || !asset?.themeIconUrl) return;
  if (!options.force && options.sheetHasColor && options.sheetHasIcon) return;

  updates.push({
    sheetRow: product.sheetRow,
    themeColor: asset.themeColor,
    themeIconUrl: asset.themeIconUrl
  });
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));

  return found ? found.slice(prefix.length) : '';
}

async function loadLocalEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const index = trimmed.indexOf('=');
      if (index < 0) return;

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] == null) {
        process.env[key] = value;
      }
    });
  } catch {
    // Local env is optional in deployment/CI.
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
