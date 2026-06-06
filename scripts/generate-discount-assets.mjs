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

    if (existing?.themeColor && existing?.themeIconUrl && !force) {
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
    const iconPrompt = metadata.iconPrompt || createIconPrompt(product, themeColor);
    const iconFileName = `${assetKey}.png`;
    const iconPath = path.join(ICON_DIR, iconFileName);
    const themeIconUrl = `/discount-assets/icons/${iconFileName}`;

    if (!dryRun) {
      const iconBuffer = await generateIconImage(iconPrompt);
      await fs.writeFile(iconPath, iconBuffer);
    }

    nextItems[assetKey] = {
      productName: product.productName,
      description: product.description || '',
      themeColor,
      themeIconUrl,
      iconPrompt,
      generatedAt: new Date().toISOString(),
      source: dryRun ? 'fallback-dry-run' : 'openai'
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
    'Return only JSON with this shape: {"themeColor":"#RRGGBB","iconPrompt":"..."}',
    'themeColor must be a premium line color that harmonizes with the product name and remains visible on a dark photo overlay.',
    'iconPrompt must describe one centered 3D product icon, no text, no badge, no background clutter, suitable inside a 40px square UI ornament.',
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
    iconPrompt: createIconPrompt(product, themeColor)
  };
}

function createIconPrompt(product, themeColor) {
  return [
    'A single premium 3D commerce icon for a Korean market discount product.',
    'No letters, no numbers, no labels, no price tags, no background scene.',
    'Centered product-object icon, glossy but clean, transparent or plain background, soft studio lighting.',
    'Keep the object readable when rendered at 40px.',
    `Theme accent color: ${themeColor}.`,
    `Product: ${product.productName}.`,
    `Product detail: ${product.description || ''}.`
  ].join(' ');
}

async function generateIconImage(prompt) {
  const baseRequest = {
    model: IMAGE_MODEL,
    prompt,
    size: '1024x1024',
    quality: 'low',
    output_format: 'png',
    n: 1
  };

  let result;

  try {
    result = await openaiJson('/v1/images/generations', {
      ...baseRequest,
      background: 'transparent'
    });
  } catch (error) {
    if (!/transparent background is not supported/i.test(error.message)) {
      throw error;
    }

    console.warn(`${IMAGE_MODEL} does not support transparent background; retrying with model default background.`);
    result = await openaiJson('/v1/images/generations', baseRequest);
  }

  const image = result?.data?.[0];
  if (image?.b64_json) {
    return Buffer.from(image.b64_json, 'base64');
  }

  if (image?.url) {
    const response = await fetch(image.url);
    if (!response.ok) {
      throw new Error(`generated image download failed (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error('OpenAI image response did not include b64_json or url.');
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
