create table if not exists public.product_category_cache (
  product_key text primary key,
  product_name text not null,
  normalized_product_name text not null,
  product_code text,
  category text not null,
  category_source text not null default 'rules',
  sheet_name text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_category_cache_category_idx
  on public.product_category_cache(category);

create index if not exists product_category_cache_name_idx
  on public.product_category_cache(normalized_product_name);

