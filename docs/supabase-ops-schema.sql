create extension if not exists pgcrypto;

create table if not exists public.operations_settlement_files (
  drive_file_id text primary key,
  store_name text not null,
  file_name text not null,
  mime_type text,
  modified_time timestamptz,
  md5_checksum text,
  size_bytes bigint,
  parsed_at timestamptz not null default now(),
  sheet_count integer not null default 0,
  row_count integer not null default 0,
  sync_run_id uuid
);

create table if not exists public.operations_settlement_items (
  stable_id text primary key,
  store_name text not null,
  drive_file_id text not null references public.operations_settlement_files(drive_file_id) on delete cascade,
  file_name text not null,
  sheet_name text not null,
  row_number integer not null,
  settlement_date date,
  settlement_date_text text,
  product_name text not null,
  product_key text not null,
  tax_status text,
  settlement_count numeric not null default 0,
  supply_price_ex_vat numeric not null default 0,
  supply_price_vat_included numeric not null default 0,
  sale_price numeric not null default 0,
  hq_buffer_quantity numeric not null default 0,
  is_fresh_produce boolean not null default false,
  raw_json jsonb not null default '{}'::jsonb,
  parsed_at timestamptz not null default now(),
  sync_run_id uuid
);

create index if not exists operations_settlement_items_product_idx
  on public.operations_settlement_items(store_name, product_key, settlement_date);

create table if not exists public.operations_inventory_items (
  stable_id text primary key,
  store_name text not null,
  source_spreadsheet_id text not null,
  source_sheet_name text not null,
  source_row_number integer not null,
  product_name text not null,
  product_key text not null,
  storage_method text,
  sales_type text,
  inbound_date date,
  inbound_date_text text,
  inbound_quantity numeric not null default 0,
  package_unit text,
  supply_price numeric not null default 0,
  sale_price numeric not null default 0,
  image_url text,
  our_buffer_quantity numeric not null default 0,
  hq_buffer_quantity numeric not null default 0,
  d_day_offset integer,
  raw_json jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  sync_run_id uuid
);

create unique index if not exists operations_inventory_items_source_idx
  on public.operations_inventory_items(store_name, source_spreadsheet_id, source_sheet_name, source_row_number);

create index if not exists operations_inventory_items_date_idx
  on public.operations_inventory_items(store_name, inbound_date, product_key);

create table if not exists public.operations_inventory_raw_rows (
  stable_id text primary key,
  store_name text not null,
  source_spreadsheet_id text not null,
  source_sheet_name text not null,
  source_row_number integer not null,
  product_name text,
  product_key text,
  storage_method text,
  sales_type text,
  outbound_date date,
  outbound_date_text text,
  quantity numeric not null default 0,
  package_unit text,
  raw_json jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  sync_run_id uuid
);

create table if not exists public.operations_buffer_notes (
  stable_id text primary key,
  store_name text not null,
  source_spreadsheet_id text not null,
  source_sheet_name text not null,
  source_row_number integer not null,
  product_name text not null,
  product_key text not null,
  pickup_date date,
  pickup_date_text text,
  note_text text not null,
  parsed_buffer_quantity numeric not null default 0,
  raw_json jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  sync_run_id uuid
);

create index if not exists operations_buffer_notes_product_idx
  on public.operations_buffer_notes(store_name, product_key, pickup_date);

create table if not exists public.operations_buffer_events (
  event_id uuid primary key default gen_random_uuid(),
  store_name text not null,
  inventory_stable_id text references public.operations_inventory_items(stable_id) on delete set null,
  product_key text not null,
  product_name text not null,
  delta_quantity numeric not null,
  actor_memo text,
  event_source text not null default 'staff',
  created_at timestamptz not null default now()
);

create index if not exists operations_buffer_events_item_idx
  on public.operations_buffer_events(store_name, inventory_stable_id, created_at);

create table if not exists public.operations_receiving_events (
  event_id uuid primary key default gen_random_uuid(),
  store_name text not null,
  inventory_stable_id text not null references public.operations_inventory_items(stable_id) on delete cascade,
  counted_quantity numeric not null,
  actor_memo text,
  created_at timestamptz not null default now()
);

create index if not exists operations_receiving_events_item_idx
  on public.operations_receiving_events(store_name, inventory_stable_id, created_at);

create table if not exists public.operations_receiving_checks (
  inventory_stable_id text primary key references public.operations_inventory_items(stable_id) on delete cascade,
  store_name text not null,
  is_complete boolean not null default false,
  completed_at timestamptz,
  completed_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.pickup_completions (
  stable_id text primary key,
  store_name text not null,
  source_sheet_name text not null,
  source_row_number integer not null,
  customer_label text,
  customer_digits4 text,
  product_name text,
  pickup_date_text text,
  completed boolean not null default false,
  completed_at timestamptz,
  completed_by text,
  last_action_at timestamptz not null default now(),
  needs_sheet_sync boolean not null default true,
  sheet_synced_at timestamptz,
  sheet_synced_value text
);

create unique index if not exists pickup_completions_source_idx
  on public.pickup_completions(store_name, source_sheet_name, source_row_number);

create index if not exists pickup_completions_sync_idx
  on public.pickup_completions(store_name, needs_sheet_sync, source_sheet_name);
