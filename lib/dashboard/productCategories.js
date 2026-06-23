import { getSheetsClient, getSpreadsheetId } from '../googleSheetsClient.js';
import { supabaseAdmin } from '../supabaseAdmin.js';

const PRODUCT_CATEGORY_TABLE = process.env.PRODUCT_CATEGORY_TABLE || 'product_category_cache';
const ORDER_FORM_SHEET_NAMES = [
  process.env.ORDER_FORM_SHEET_NAME,
  '발주요청(Index)',
  '발주양식'
].filter(Boolean);
const CATEGORY_CACHE_TTL_MS = Number(process.env.PRODUCT_CATEGORY_CACHE_TTL_MS || 30 * 60 * 1000);
const CATALOG_CACHE_TTL_MS = Number(process.env.PRODUCT_CATALOG_CACHE_TTL_MS || 10 * 60 * 1000);
const ORDER_FORM_READ_RANGE = process.env.PRODUCT_CATEGORY_READ_RANGE || 'A:AB';

let storedCategoryCache = null;
let storedCategoryCacheUntil = 0;
let catalogCache = null;
let catalogCacheUntil = 0;

export async function getProductCategoryLookup(productNames = []) {
  const [storedLookup, sheetCategoryLookup] = await Promise.all([
    readStoredProductCategories().catch(error => {
      console.warn('stored product category fallback:', error.message);
      return emptyStoredLookup({ unavailable: true });
    }),
    readSheetProductCategories().catch(error => {
      console.warn('sheet product category fallback:', error.message);
      return {
        sheetName: ORDER_FORM_SHEET_NAMES[0] || '',
        categoriesByKey: new Map(),
        recordsByKey: new Map()
      };
    })
  ]);
  const categories = {};
  let storedHitCount = 0;
  let sheetHitCount = 0;
  let ruleFallbackCount = 0;

  productNames.forEach(productName => {
    const storedCategory = findCategory(productName, storedLookup);
    if (storedCategory) {
      categories[productName] = storedCategory;
      storedHitCount += 1;
      return;
    }

    const sheetCategory = findCategory(productName, sheetCategoryLookup);
    if (sheetCategory) {
      categories[productName] = sheetCategory;
      sheetHitCount += 1;
      return;
    }

    categories[productName] = inferProductCategory(productName);
    ruleFallbackCount += 1;
  });

  return {
    categories,
    sheetName: sheetCategoryLookup.sheetName || ORDER_FORM_SHEET_NAMES[0] || '',
    source: buildCategorySource({ storedHitCount, sheetHitCount, ruleFallbackCount }),
    storedHitCount,
    sheetHitCount,
    ruleFallbackCount,
    totalStoredCategoryCount: storedLookup.categoriesByKey.size,
    totalSheetCategoryCount: sheetCategoryLookup.categoriesByKey.size,
    tableUnavailable: storedLookup.unavailable || false
  };
}

export async function syncProductCategoryCache() {
  const catalog = await readOrderFormCatalog({ forceRefresh: true });
  if (!catalog.products.length) {
    return {
      ok: false,
      message: '발주요청 시트에서 상품명을 찾지 못했습니다.',
      sheetName: catalog.sheetName,
      productCount: 0
    };
  }

  const storedLookup = await readStoredProductCategories({
    forceRefresh: true,
    suppressMissingTable: false
  });
  const now = new Date().toISOString();
  let keptCount = 0;
  let ruleAssignedCount = 0;

  const records = catalog.products.map(product => {
    const stored = storedLookup.recordsByKey.get(product.key);
    const storedCategory = normalizeCategory(stored?.category);
    const category = storedCategory || inferProductCategory(product.productName);
    const categorySource = storedCategory
      ? stored.category_source || 'manual'
      : 'rules';

    if (storedCategory) keptCount += 1;
    else ruleAssignedCount += 1;

    return {
      product_key: product.key,
      product_name: product.productName,
      normalized_product_name: product.key,
      product_code: product.productCode || null,
      category,
      category_source: categorySource,
      sheet_name: catalog.sheetName,
      last_seen_at: now,
      updated_at: now
    };
  });

  await upsertProductCategories(records);
  clearProductCategoryCaches();

  return {
    ok: true,
    tableName: PRODUCT_CATEGORY_TABLE,
    sheetName: catalog.sheetName,
    productCount: catalog.products.length,
    upsertedCount: records.length,
    keptCount,
    ruleAssignedCount
  };
}

export function clearProductCategoryCaches() {
  storedCategoryCache = null;
  storedCategoryCacheUntil = 0;
  catalogCache = null;
  catalogCacheUntil = 0;
}

async function readStoredProductCategories(options = {}) {
  const now = Date.now();
  if (!options.forceRefresh && storedCategoryCache && storedCategoryCacheUntil > now) {
    return storedCategoryCache;
  }

  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from(PRODUCT_CATEGORY_TABLE)
      .select('product_key,product_name,normalized_product_name,category,category_source,sheet_name,last_seen_at')
      .range(from, from + pageSize - 1);

    if (error) {
      if (options.suppressMissingTable !== false && isMissingTableError(error)) {
        const empty = emptyStoredLookup({ unavailable: true });
        storedCategoryCache = empty;
        storedCategoryCacheUntil = now + Math.min(CATEGORY_CACHE_TTL_MS, 5 * 60 * 1000);
        return empty;
      }

      throw new Error(
        isMissingTableError(error)
          ? `Supabase ${PRODUCT_CATEGORY_TABLE} 테이블이 없습니다. docs/supabase-product-category-cache.sql을 먼저 실행해주세요.`
          : error.message
      );
    }

    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  const lookup = emptyStoredLookup();
  rows.forEach(row => {
    const category = normalizeCategory(row.category);
    const key = normalizeProductKey(row.product_key || row.normalized_product_name || row.product_name);
    if (!key || !category) return;

    lookup.categoriesByKey.set(key, category);
    lookup.recordsByKey.set(key, row);
  });

  storedCategoryCache = lookup;
  storedCategoryCacheUntil = now + CATEGORY_CACHE_TTL_MS;
  return lookup;
}

async function readSheetProductCategories() {
  const catalog = await readOrderFormCatalog();
  const categoriesByKey = new Map();
  const recordsByKey = new Map();

  catalog.products.forEach(product => {
    if (!product.category) return;
    categoriesByKey.set(product.key, product.category);
    recordsByKey.set(product.key, product);
  });

  return {
    sheetName: catalog.sheetName,
    categoriesByKey,
    recordsByKey
  };
}

async function readOrderFormCatalog(options = {}) {
  const now = Date.now();
  if (!options.forceRefresh && catalogCache && catalogCacheUntil > now) return catalogCache;

  let lastError = null;
  for (const sheetName of ORDER_FORM_SHEET_NAMES) {
    try {
      const values = await readSheetValues(sheetName);
      const catalog = parseOrderFormCatalog(sheetName, values);
      if (catalog.products.length) {
        catalogCache = catalog;
        catalogCacheUntil = now + CATALOG_CACHE_TTL_MS;
        return catalog;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    console.warn('order form product catalog fallback:', lastError.message);
  }

  catalogCache = {
    sheetName: ORDER_FORM_SHEET_NAMES[0] || '',
    products: []
  };
  catalogCacheUntil = now + Math.min(CATALOG_CACHE_TTL_MS, 5 * 60 * 1000);
  return catalogCache;
}

async function readSheetValues(sheetName) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `'${escapeSheetName(sheetName)}'!${ORDER_FORM_READ_RANGE}`,
    valueRenderOption: 'FORMULA',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });

  return response.data.values || [];
}

function parseOrderFormCatalog(sheetName, values) {
  const columns = detectOrderFormColumns(values);
  const byKey = new Map();

  if (!columns) return { sheetName, products: [] };

  values.slice(columns.headerRowIndex + 1).forEach(row => {
    const productName = clean(row[columns.productIndex]);
    if (!productName || looksLikeHeaderText(productName)) return;

    const key = normalizeProductKey(productName);
    if (!key || byKey.has(key)) return;

    byKey.set(key, {
      key,
      productName,
      productCode: columns.productCodeIndex >= 0 ? clean(row[columns.productCodeIndex]) : '',
      category: columns.categoryIndex >= 0 ? normalizeCategory(row[columns.categoryIndex]) : ''
    });
  });

  return {
    sheetName,
    products: Array.from(byKey.values())
  };
}

function detectOrderFormColumns(values) {
  const headerRowIndex = values.findIndex(row => row.map(cell => clean(cell)).some(isProductHeader));
  if (headerRowIndex >= 0) {
    const header = values[headerRowIndex].map(cell => clean(cell));
    const productIndex = header.findIndex(isProductHeader);
    const productCodeIndex = header.findIndex(isProductCodeHeader);
    const categoryIndex = header.findIndex(isCategoryHeader);

    if (productIndex >= 0) {
      return { headerRowIndex, productIndex, productCodeIndex, categoryIndex };
    }
  }

  return inferProductOnlyColumns(values);
}

function inferProductOnlyColumns(values) {
  const sampleRows = values.slice(0, 80);
  const width = Math.max(...sampleRows.map(row => row.length), 0);
  let bestProduct = { index: -1, score: 0 };

  for (let index = 0; index < width; index += 1) {
    const cells = sampleRows.map(row => clean(row[index])).filter(Boolean);
    const productScore = cells.filter(looksLikeProductName).length;
    if (productScore > bestProduct.score) bestProduct = { index, score: productScore };
  }

  if (bestProduct.index >= 0 && bestProduct.score >= 3) {
    return {
      headerRowIndex: 0,
      productIndex: bestProduct.index,
      productCodeIndex: -1,
      categoryIndex: -1
    };
  }

  return null;
}

function findCategory(productName, lookup) {
  const key = normalizeProductKey(productName);
  if (!key) return '';

  const exact = lookup.categoriesByKey.get(key);
  if (exact) return exact;

  let best = null;
  for (const [candidateKey, category] of lookup.categoriesByKey.entries()) {
    if (candidateKey.length < 6) continue;
    const contains = key.includes(candidateKey) || candidateKey.includes(key);
    if (!contains) continue;
    if (!best || candidateKey.length > best.key.length) {
      best = { key: candidateKey, category };
    }
  }

  return best?.category || '';
}

function buildCategorySource({ storedHitCount, sheetHitCount, ruleFallbackCount }) {
  const parts = [];
  if (storedHitCount) parts.push('저장 카테고리');
  if (sheetHitCount) parts.push('시트 카테고리');
  if (ruleFallbackCount) parts.push('규칙 보정');
  return parts.join(' + ') || '규칙 보정';
}

async function upsertProductCategories(records) {
  const chunkSize = 500;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const { error } = await supabaseAdmin
      .from(PRODUCT_CATEGORY_TABLE)
      .upsert(chunk, { onConflict: 'product_key' });

    if (error) {
      throw new Error(
        isMissingTableError(error)
          ? `Supabase ${PRODUCT_CATEGORY_TABLE} 테이블이 없습니다. docs/supabase-product-category-cache.sql을 먼저 실행해주세요.`
          : error.message
      );
    }
  }
}

function emptyStoredLookup(extra = {}) {
  return {
    categoriesByKey: new Map(),
    recordsByKey: new Map(),
    ...extra
  };
}

function normalizeCategory(value) {
  const text = clean(value)
    .replace(/^[-–—•·\s]+/, '')
    .replace(/\s+/g, ' ');

  if (!text) return '';
  if (/^(기타|미분류|없음|확인|분류\s*필요)$/i.test(text)) return '';
  if (looksLikeHeaderText(text)) return '';

  return text;
}

function inferProductCategory(productName) {
  const text = normalizeProductKey(productName);

  if (/한우|소고기|쇠고기|돼지|삼겹|목살|갈비|닭|오리|스테이크|불고기|제육|육회|고기|정육/.test(text)) return '축산/정육';
  if (/고등어|갈치|새우|오징어|낙지|문어|전복|가리비|조개|생선|연어|대구|명태|수산|해물|멸치|황태/.test(text)) return '수산/해산';
  if (/사과|배|귤|오렌지|망고|바나나|딸기|포도|수박|참외|복숭아|블루베리|키위|자두|과일/.test(text)) return '과일';
  if (/상추|양파|대파|쪽파|마늘|감자|고구마|버섯|토마토|채소|야채|나물|오이|호박|양배추|브로콜리|깻잎|시금치/.test(text)) return '채소';
  if (/쌀|현미|잡곡|보리|귀리|콩|두부|묵|누룽지/.test(text)) return '쌀/곡물/두부';
  if (/치즈|우유|요거트|요구르트|버터|크림|유청|계란|달걀|난각/.test(text)) return '유제품/계란';
  if (/빵|브레드|케이크|쿠키|약과|떡|도넛|베이커리|디저트|파이|마카롱|초코/.test(text)) return '베이커리/디저트';
  if (/막걸리|와인|맥주|소주|주류|술/.test(text)) return '주류/전통주';
  if (/커피|음료|주스|쥬스|차|콜라|사이다|물|탄산|에이드|티백/.test(text)) return '음료/커피';
  if (/과자|스낵|칩|초콜릿|젤리|사탕|간식|견과|아몬드|호두/.test(text)) return '간식/스낵';
  if (/만두|돈까스|핫도그|튀김|피자|냉동|아이스|떡갈비/.test(text)) return '냉동식품';
  if (/냉장|햄|소시지|소세지|어묵|맛살|유부|면|칼국수|우동|냉면/.test(text)) return '냉장식품';
  if (/국|탕|찌개|반찬|김치|볶음|도시락|밀키트|간편|조림|구이|카레|짜장|덮밥|죽|수프|스프/.test(text)) return '반찬/간편식';
  if (/간장|고추장|된장|소스|양념|드레싱|식초|오일|참기름|들기름|꿀|잼|시럽|설탕|소금/.test(text)) return '소스/양념';
  if (/세제|청소|주방|휴지|티슈|수세미|살림|생활|봉투|장갑|키친타월|랩|호일/.test(text)) return '생활/주방';
  if (/비타민|영양|건강|샴푸|크림|화장|뷰티|마스크|치약|칫솔|밴드|패치/.test(text)) return '건강/뷰티';

  return '분류확인';
}

function isMissingTableError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'PGRST205' || code === '42P01' || /Could not find the table|relation .* does not exist/i.test(message);
}

function isProductHeader(value) {
  return /상품명|제품명|품명|상품\s*이름|발주\s*상품|상품$/i.test(clean(value));
}

function isProductCodeHeader(value) {
  return /상품\s*코드|제품\s*코드|품목\s*코드|코드/i.test(clean(value));
}

function isCategoryHeader(value) {
  return /카테고리|대분류|중분류|소분류|분류|품목|category/i.test(clean(value));
}

function looksLikeHeaderText(value) {
  return isProductHeader(value) || isProductCodeHeader(value) || isCategoryHeader(value);
}

function looksLikeProductName(value) {
  const text = clean(value);
  if (text.length < 4) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^\d+([.,]\d+)?$/.test(text.replace(/원|개|입|g|kg|ml|l/gi, ''))) return false;
  if (looksLikeHeaderText(text)) return false;
  return /[가-힣A-Za-z]/.test(text);
}

function normalizeProductKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[{}"'“”‘’]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function escapeSheetName(sheetName) {
  return String(sheetName).replace(/'/g, "''");
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}
