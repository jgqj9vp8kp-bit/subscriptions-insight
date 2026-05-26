create extension if not exists pgcrypto;

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null default 'primer_csv',
  filename text,
  checksum text,
  rows_total integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated integer not null default 0,
  rows_skipped integer not null default 0,
  imported_at timestamptz not null default now(),
  status text not null default 'processing',
  notes text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  user_id text,
  transaction_id text not null,
  external_transaction_id text,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  source text not null default 'primer_csv',
  event_time timestamptz not null,
  status text,
  transaction_type text,
  amount_gross numeric(18,2),
  amount_net numeric(18,2),
  amount_refunded numeric(18,2),
  currency text,
  email text,
  country_code text,
  campaign_path text,
  funnel text,
  source_name text,
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.import_batch_files (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  filename text not null,
  file_size bigint,
  uploaded_at timestamptz not null default now(),
  storage_path text
);

create unique index if not exists transactions_transaction_id_key
on public.transactions (transaction_id);

create index if not exists transactions_event_time_idx on public.transactions (event_time);
create index if not exists transactions_email_idx on public.transactions (email);
create index if not exists transactions_campaign_path_idx on public.transactions (campaign_path);
create index if not exists transactions_status_idx on public.transactions (status);
create index if not exists transactions_transaction_type_idx on public.transactions (transaction_type);
create index if not exists transactions_import_batch_id_idx on public.transactions (import_batch_id);
create index if not exists transactions_auth_user_id_event_time_idx on public.transactions (auth_user_id, event_time);
create index if not exists transactions_active_idx on public.transactions (auth_user_id, deleted_at);

create index if not exists import_batches_imported_at_idx on public.import_batches (imported_at);
create index if not exists import_batches_checksum_idx on public.import_batches (checksum);
create index if not exists import_batches_user_imported_at_idx on public.import_batches (user_id, imported_at desc);
create index if not exists import_batch_files_import_batch_id_idx on public.import_batch_files (import_batch_id);

create or replace function public.set_transactions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at
before update on public.transactions
for each row
execute function public.set_transactions_updated_at();

alter table public.import_batches enable row level security;
alter table public.transactions enable row level security;
alter table public.import_batch_files enable row level security;

drop policy if exists "Users can read own import batches" on public.import_batches;
create policy "Users can read own import batches"
on public.import_batches
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own import batches" on public.import_batches;
create policy "Users can insert own import batches"
on public.import_batches
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own import batches" on public.import_batches;
create policy "Users can update own import batches"
on public.import_batches
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own import batches" on public.import_batches;
create policy "Users can delete own import batches"
on public.import_batches
for delete
using (auth.uid() = user_id);

drop policy if exists "Users can read own transactions" on public.transactions;
create policy "Users can read own transactions"
on public.transactions
for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own transactions" on public.transactions;
create policy "Users can insert own transactions"
on public.transactions
for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own transactions" on public.transactions;
create policy "Users can update own transactions"
on public.transactions
for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own transactions" on public.transactions;
create policy "Users can delete own transactions"
on public.transactions
for delete
using (auth.uid() = auth_user_id);

drop policy if exists "Users can read own import batch files" on public.import_batch_files;
create policy "Users can read own import batch files"
on public.import_batch_files
for select
using (
  exists (
    select 1
    from public.import_batches
    where import_batches.id = import_batch_files.import_batch_id
      and import_batches.user_id = auth.uid()
  )
);

drop policy if exists "Users can insert own import batch files" on public.import_batch_files;
create policy "Users can insert own import batch files"
on public.import_batch_files
for insert
with check (
  exists (
    select 1
    from public.import_batches
    where import_batches.id = import_batch_files.import_batch_id
      and import_batches.user_id = auth.uid()
  )
);

drop policy if exists "Users can update own import batch files" on public.import_batch_files;
create policy "Users can update own import batch files"
on public.import_batch_files
for update
using (
  exists (
    select 1
    from public.import_batches
    where import_batches.id = import_batch_files.import_batch_id
      and import_batches.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.import_batches
    where import_batches.id = import_batch_files.import_batch_id
      and import_batches.user_id = auth.uid()
  )
);

drop policy if exists "Users can delete own import batch files" on public.import_batch_files;
create policy "Users can delete own import batch files"
on public.import_batch_files
for delete
using (
  exists (
    select 1
    from public.import_batches
    where import_batches.id = import_batch_files.import_batch_id
      and import_batches.user_id = auth.uid()
  )
);
