create table if not exists public.kakao_csv_uploads (
  upload_id text primary key,
  file_hash text not null,
  store_name text not null,
  order_date text not null,
  start_at text,
  end_at text,
  uploaded_at text,
  source text,
  file_name text,
  file_size bigint,
  mime_type text,
  message_count integer default 0,
  window_message_count integer default 0,
  join_count integer default 0,
  leave_count integer default 0,
  order_candidate_message_count integer default 0,
  raw_order_count integer default 0,
  matched_order_count integer default 0,
  unmatched_csv_order_count integer default 0,
  unmatched_raw_order_count integer default 0,
  avg_ordered_at text,
  first_ordered_at text,
  first_order_after_minutes integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kakao_csv_messages (
  upload_id text not null references public.kakao_csv_uploads(upload_id) on delete cascade,
  message_id text primary key,
  file_hash text not null,
  store_name text not null,
  order_date text not null,
  message_at text,
  date_raw text,
  csv_row_number integer,
  message_index integer,
  user_name text,
  normalized_user text,
  message text,
  message_type text default 'message',
  member_subject text,
  source text,
  created_at timestamptz not null default now()
);

create table if not exists public.kakao_member_events (
  upload_id text not null references public.kakao_csv_uploads(upload_id) on delete cascade,
  message_id text primary key references public.kakao_csv_messages(message_id) on delete cascade,
  event_type text not null check (event_type in ('join', 'leave')),
  member_subject text,
  message_at text,
  date_raw text,
  user_name text,
  normalized_user text,
  message text,
  created_at timestamptz not null default now()
);

create table if not exists public.order_message_matches (
  csv_upload_id text not null references public.kakao_csv_uploads(upload_id) on delete cascade,
  csv_message_id text not null references public.kakao_csv_messages(message_id) on delete cascade,
  raw_order_stable_id text not null,
  store_name text not null,
  order_date text,
  customer_name text,
  normalized_customer text,
  product_name text,
  normalized_product_name text,
  quantity numeric,
  occurrence_index integer,
  actual_ordered_at text,
  message_raw text,
  match_confidence numeric,
  match_method text,
  matched_at text,
  current_source_row_number integer,
  source_sheet_name text,
  created_at timestamptz not null default now(),
  primary key (csv_upload_id, raw_order_stable_id)
);

create index if not exists kakao_csv_uploads_store_order_idx
  on public.kakao_csv_uploads(store_name, order_date);

create index if not exists kakao_csv_messages_upload_idx
  on public.kakao_csv_messages(upload_id, message_index);

create index if not exists kakao_csv_messages_user_idx
  on public.kakao_csv_messages(upload_id, normalized_user);

create index if not exists kakao_member_events_upload_idx
  on public.kakao_member_events(upload_id, event_type, message_at);

create index if not exists order_message_matches_upload_idx
  on public.order_message_matches(csv_upload_id, actual_ordered_at);

