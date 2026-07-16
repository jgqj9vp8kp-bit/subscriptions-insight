create extension if not exists pgcrypto;

create table if not exists public.support_import_batches (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  filename text not null,
  checksum text not null,
  imported_at timestamptz not null default now(),
  import_year integer not null,
  total_rows integer not null default 0,
  inserted_rows integer not null default 0,
  updated_rows integer not null default 0,
  skipped_rows integer not null default 0,
  invalid_rows integer not null default 0,
  status text not null default 'completed',
  diagnostics jsonb not null default '{}'::jsonb,
  constraint support_import_batches_status_check check (status in ('pending', 'completed', 'completed_with_warnings', 'failed'))
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  import_batch_id uuid references public.support_import_batches(id) on delete set null,
  source_row_number integer not null,
  sender_name text,
  subject text,
  message_body text,
  received_at timestamptz,
  received_date_raw text,
  customer_email text,
  normalized_email text,
  matched_contact_name text,
  category text not null default 'Other/unclear',
  subcategory text not null default 'other_unclear',
  language text not null default 'unknown',
  sentiment text not null default 'neutral',
  urgency text not null default 'low',
  requires_refund boolean not null default false,
  requires_cancellation boolean not null default false,
  payment_related boolean not null default false,
  delivery_related boolean not null default false,
  possible_unauthorized_charge boolean not null default false,
  duplicate_charge boolean not null default false,
  urgent boolean not null default false,
  matched_customer boolean not null default false,
  classification_source text not null default 'rule',
  classification_version text not null default 'support_rules_v1',
  classification_confidence numeric(5,4) not null default 0,
  classification_reason text,
  manual_category text,
  manual_subcategory text,
  manual_urgency text,
  manual_changed_at timestamptz,
  manual_changed_by uuid references auth.users(id) on delete set null,
  source_hash text not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_requests_unique_source_hash unique (auth_user_id, source_hash),
  constraint support_requests_urgency_check check (urgency in ('low', 'medium', 'high')),
  constraint support_requests_manual_urgency_check check (manual_urgency is null or manual_urgency in ('low', 'medium', 'high')),
  constraint support_requests_sentiment_check check (sentiment in ('negative', 'neutral', 'positive'))
);

create index if not exists support_import_batches_auth_imported_idx
on public.support_import_batches (auth_user_id, imported_at desc);

create index if not exists support_import_batches_auth_checksum_idx
on public.support_import_batches (auth_user_id, checksum);

create index if not exists support_requests_auth_received_idx
on public.support_requests (auth_user_id, received_at desc);

create index if not exists support_requests_auth_category_idx
on public.support_requests (auth_user_id, category);

create index if not exists support_requests_auth_subcategory_idx
on public.support_requests (auth_user_id, subcategory);

create index if not exists support_requests_auth_language_idx
on public.support_requests (auth_user_id, language);

create index if not exists support_requests_auth_normalized_email_idx
on public.support_requests (auth_user_id, normalized_email);

create index if not exists support_requests_auth_source_hash_idx
on public.support_requests (auth_user_id, source_hash);

create index if not exists support_requests_auth_urgency_idx
on public.support_requests (auth_user_id, urgency);

create index if not exists support_requests_auth_matched_idx
on public.support_requests (auth_user_id, matched_customer);

create index if not exists support_requests_auth_flags_idx
on public.support_requests (auth_user_id, requires_cancellation, requires_refund, payment_related, delivery_related);

create or replace function public.set_support_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists support_requests_set_updated_at on public.support_requests;
create trigger support_requests_set_updated_at
before update on public.support_requests
for each row
execute function public.set_support_requests_updated_at();

alter table public.support_import_batches enable row level security;
alter table public.support_requests enable row level security;

drop policy if exists "Users can read own support import batches" on public.support_import_batches;
create policy "Users can read own support import batches"
on public.support_import_batches for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own support import batches" on public.support_import_batches;
create policy "Users can insert own support import batches"
on public.support_import_batches for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own support import batches" on public.support_import_batches;
create policy "Users can update own support import batches"
on public.support_import_batches for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own support import batches" on public.support_import_batches;
create policy "Users can delete own support import batches"
on public.support_import_batches for delete
using (auth.uid() = auth_user_id);

drop policy if exists "Users can read own support requests" on public.support_requests;
create policy "Users can read own support requests"
on public.support_requests for select
using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own support requests" on public.support_requests;
create policy "Users can insert own support requests"
on public.support_requests for insert
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own support requests" on public.support_requests;
create policy "Users can update own support requests"
on public.support_requests for update
using (auth.uid() = auth_user_id)
with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own support requests" on public.support_requests;
create policy "Users can delete own support requests"
on public.support_requests for delete
using (auth.uid() = auth_user_id);
