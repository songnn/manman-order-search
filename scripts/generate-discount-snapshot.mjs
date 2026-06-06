#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISCOUNT_TIMEZONE,
  getAllDiscountProductsForAssets
} from '../lib/discountProducts.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT_DIR, 'lib', 'discount-products-data.json');

await loadLocalEnv(path.join(ROOT_DIR, '.env.local'));

const products = await getAllDiscountProductsForAssets();
const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  timezone: DISCOUNT_TIMEZONE,
  items: products
};

await fs.writeFile(SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  path: path.relative(ROOT_DIR, SNAPSHOT_PATH),
  generatedAt: payload.generatedAt,
  productCount: payload.items.length
}, null, 2));

async function loadLocalEnv(envPath) {
  let content = '';

  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch {
    return;
  }

  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;

    const [, key, rawValue] = match;
    if (process.env[key]) return;

    process.env[key] = unquoteEnvValue(rawValue);
  });
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
