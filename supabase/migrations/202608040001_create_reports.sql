-- Weekly management reports (Reports page, phase R1).
--
-- A report is a FROZEN FACT PACK with prose attached, not a document with
-- numbers in it. `snapshot` holds the deterministic result of collecting every
-- metric for the period (plus its evidence paths and its data gaps); `blocks`
-- holds the editor content. The page is fully useful with `blocks` empty and
-- with no AI configured at all -- that is the whole point of the split.
--
-- Scalar columns exist so the LIST view never parses jsonb, and so an
-- incomplete report (known FB spend gap in the window, missing sources) is
-- visible in the list before it is opened. Shape follows project_forecasts
-- (202608030001) deliberately: same lineage/frozen/scalars split, same
-- schema_version + engine_version gate, same trigger and RLS discipline.
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- ---- list-view scalars ----
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'collected', 'ready', 'published', 'archived')),
  period_kind text not null default 'week'
    check (period_kind in ('week', 'month', 'custom')),
  period_from date not null,
  period_to date not null,
  compare_from date,
  compare_to date,
  language text not null default 'ru',
  template_key text not null default 'weekly_management_v1',

  -- Headline numbers, denormalised from snapshot.kpi ONLY to render the list
  -- and the report-vs-report grid. Nullable on purpose: a metric with no
  -- source stays NULL and is rendered as an em dash, never as 0.
  spend numeric,
  gross_revenue numeric,
  net_revenue numeric,
  refund_amount numeric,
  trials integer,
  blended_cpa numeric,
  funnel_count integer not null default 0,

  -- Honesty flags, scalar so they are visible without opening the report.
  data_incomplete boolean not null default false,
  provisional_reasons text[] not null default '{}',
  ai_status text not null default 'none'
    check (ai_status in ('none', 'generated', 'edited', 'failed')),
  validation_status text not null default 'not_run'
    check (validation_status in ('not_run', 'passed', 'warned', 'failed')),

  -- ---- versioning ----
  schema_version integer not null,
  engine_version text not null,
  -- A report depends on FIVE upstream engines, so one engine_version string is
  -- not enough to explain why a re-collect moved a number. Records the cohort
  -- classification version, the forecast engine version, the support
  -- classification version and FX_RATES_AS_OF (fxRates.ts is a static map --
  -- when it is refreshed, a historical report must keep the rates it used).
  engine_versions jsonb not null default '{}'::jsonb,
  published_version_no integer,
  published_at timestamptz,

  -- ---- payloads ----
  -- bindings: the parameters the operator edits (window, filters, thresholds,
  -- which sections are enabled). manual_inputs: numbers the operator typed for
  -- sources that do not exist yet (email sends, TikTok spend) -- they enter the
  -- allowed-numbers set for the AI validator carrying source:'manual'.
  bindings jsonb not null,
  manual_inputs jsonb not null default '{}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  blocks jsonb not null default '[]'::jsonb,

  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reports_auth_user_id_idx on public.reports (auth_user_id);
create index if not exists reports_updated_idx on public.reports (auth_user_id, updated_at desc);
create index if not exists reports_period_idx on public.reports (auth_user_id, period_from, period_to);

create or replace function public.set_reports_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists reports_set_updated_at on public.reports;
create trigger reports_set_updated_at
before update on public.reports
for each row
execute function public.set_reports_updated_at();

alter table public.reports enable row level security;

drop policy if exists "Users can read own reports" on public.reports;
create policy "Users can read own reports"
on public.reports for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own reports" on public.reports;
create policy "Users can insert own reports"
on public.reports for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own reports" on public.reports;
create policy "Users can update own reports"
on public.reports for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

-- Deliberately NO delete policy (same call as public.funnels, 202607240001).
-- status = 'archived' is the retirement mechanism. This is not squeamishness:
-- report_versions below is append-only and carries no foreign key, so a hard
-- delete of a report would leave its published history orphaned with no way to
-- reach or remove it. Not offering the delete keeps the two tables consistent.


-- Published, immutable snapshots of a report.
--
-- The contract the operator cares about: a report published last week must not
-- change when the warehouse is re-synced. Copying the payload here achieves
-- that; the append-only trigger below hardens it against an accidental UPDATE
-- from any role, service_role included.
--
-- LOAD-BEARING: there is intentionally NO foreign key on report_id or
-- auth_user_id. facebook_sync_runs (202607190001) made the same call for the
-- same reason -- a DELETE cascading into an append-only child hits the guard
-- trigger and aborts the whole transaction, which would make deleting an
-- account impossible. Referential integrity is kept by the application; rows
-- orphaned by an account deletion are inert.
create table if not exists public.report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  auth_user_id uuid not null,
  version_no integer not null,
  title text not null,
  period_from date not null,
  period_to date not null,
  schema_version integer not null,
  engine_version text not null,
  engine_versions jsonb not null default '{}'::jsonb,
  bindings jsonb not null,
  manual_inputs jsonb not null default '{}'::jsonb,
  snapshot jsonb not null,
  blocks jsonb not null,
  published_at timestamptz not null default now(),

  unique (report_id, version_no)
);

create index if not exists report_versions_report_idx
  on public.report_versions (auth_user_id, report_id, version_no desc);

create or replace function public.reject_report_version_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end;
$$;

drop trigger if exists report_versions_append_only on public.report_versions;
create trigger report_versions_append_only
before update or delete on public.report_versions
for each row
execute function public.reject_report_version_mutation();

alter table public.report_versions enable row level security;

-- Select and insert only. There is no update policy and no delete policy: the
-- trigger would reject them anyway, and not offering them keeps PostgREST from
-- advertising a path that always fails.
drop policy if exists "Users can read own report versions" on public.report_versions;
create policy "Users can read own report versions"
on public.report_versions for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report versions" on public.report_versions;
create policy "Users can insert own report versions"
on public.report_versions for insert with check (auth.uid() = auth_user_id);


-- Publishing, as one atomic step.
--
-- Reading the report and inserting the version from the browser in two calls
-- races two open tabs into either a duplicate version_no or a version whose
-- snapshot is half-updated. security invoker keeps RLS in force, so the
-- auth.uid() check below is belt-and-braces rather than the only guard.
create or replace function public.publish_report(p_report_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_report public.reports%rowtype;
  v_next integer;
begin
  select * into v_report from public.reports where id = p_report_id;
  if not found then
    raise exception 'Report % not found', p_report_id;
  end if;
  if v_report.auth_user_id <> auth.uid() then
    raise exception 'Not allowed to publish report %', p_report_id;
  end if;
  if v_report.snapshot = '{}'::jsonb then
    raise exception 'Report % has no collected data to publish', p_report_id;
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next
  from public.report_versions
  where report_id = p_report_id;

  insert into public.report_versions (
    report_id, auth_user_id, version_no, title, period_from, period_to,
    schema_version, engine_version, engine_versions,
    bindings, manual_inputs, snapshot, blocks
  ) values (
    v_report.id, v_report.auth_user_id, v_next, v_report.title,
    v_report.period_from, v_report.period_to,
    v_report.schema_version, v_report.engine_version, v_report.engine_versions,
    v_report.bindings, v_report.manual_inputs, v_report.snapshot, v_report.blocks
  );

  update public.reports
  set status = 'published',
      published_version_no = v_next,
      published_at = now()
  where id = p_report_id;

  return v_next;
end;
$$;

revoke all on function public.publish_report(uuid) from public, anon;
grant execute on function public.publish_report(uuid) to authenticated;


-- Plan/Fact tasks. These live BETWEEN reports, not inside one: an unfinished
-- task carries into next week's report, and the reason it moved is part of the
-- record ("перенесли задачу на эту неделю" appears in every weekly report).
create table if not exists public.report_tasks (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  direction text,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'done', 'paused', 'blocked', 'moved', 'cancelled')),
  priority text not null default 'medium'
    check (priority in ('high', 'medium', 'low')),
  owner text,
  planned_date date,
  actual_date date,
  comment text,
  link text,
  moved_reason text,
  result text,
  -- Which report first listed this task, and which one closed it. Plain uuids:
  -- a task must survive its report being archived.
  first_report_id uuid,
  closed_report_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_tasks_user_status_idx
  on public.report_tasks (auth_user_id, status, planned_date);

drop trigger if exists report_tasks_set_updated_at on public.report_tasks;
create trigger report_tasks_set_updated_at
before update on public.report_tasks
for each row
execute function public.set_reports_updated_at();

alter table public.report_tasks enable row level security;

drop policy if exists "Users can read own report tasks" on public.report_tasks;
create policy "Users can read own report tasks"
on public.report_tasks for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report tasks" on public.report_tasks;
create policy "Users can insert own report tasks"
on public.report_tasks for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own report tasks" on public.report_tasks;
create policy "Users can update own report tasks"
on public.report_tasks for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own report tasks" on public.report_tasks;
create policy "Users can delete own report tasks"
on public.report_tasks for delete using (auth.uid() = auth_user_id);


-- Manual context no database has and no metric implies: "слетел зацеп",
-- "шторм ФБ", "почта была затоплена". Half the conclusions in the weekly
-- reports lean on these, so they are first-class rows, not free text in a
-- block. use_in_ai lets the operator keep a note out of the prompt.
create table if not exists public.report_notes (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_date date not null,
  direction text,
  funnel_path text,
  channel text,
  body text not null,
  importance text not null default 'normal'
    check (importance in ('high', 'normal', 'low')),
  use_in_ai boolean not null default true,
  report_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists report_notes_user_date_idx
  on public.report_notes (auth_user_id, note_date desc);

drop trigger if exists report_notes_set_updated_at on public.report_notes;
create trigger report_notes_set_updated_at
before update on public.report_notes
for each row
execute function public.set_reports_updated_at();

alter table public.report_notes enable row level security;

drop policy if exists "Users can read own report notes" on public.report_notes;
create policy "Users can read own report notes"
on public.report_notes for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report notes" on public.report_notes;
create policy "Users can insert own report notes"
on public.report_notes for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own report notes" on public.report_notes;
create policy "Users can update own report notes"
on public.report_notes for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own report notes" on public.report_notes;
create policy "Users can delete own report notes"
on public.report_notes for delete using (auth.uid() = auth_user_id);


-- Targets with effective dating. A July report must be judged against July's
-- ceilings, so a target is never overwritten -- it is closed with an
-- effective_to and a new row opens. The report snapshot stores the RESOLVED
-- values, so re-opening an old report never re-scores it against today's goals.
create table if not exists public.report_targets (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  metric_key text not null,
  scope_kind text not null default 'global'
    check (scope_kind in ('global', 'funnel', 'geo', 'channel')),
  scope_value text,
  target_value numeric not null,
  comparator text not null default 'gte'
    check (comparator in ('gte', 'lte')),
  effective_from date not null,
  effective_to date,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists report_targets_lookup_idx
  on public.report_targets (auth_user_id, metric_key, scope_kind, effective_from desc);

alter table public.report_targets enable row level security;

drop policy if exists "Users can read own report targets" on public.report_targets;
create policy "Users can read own report targets"
on public.report_targets for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report targets" on public.report_targets;
create policy "Users can insert own report targets"
on public.report_targets for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own report targets" on public.report_targets;
create policy "Users can update own report targets"
on public.report_targets for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);

drop policy if exists "Users can delete own report targets" on public.report_targets;
create policy "Users can delete own report targets"
on public.report_targets for delete using (auth.uid() = auth_user_id);


-- One row per user: saved templates, style presets, defaults. The built-in
-- weekly template stays a code constant -- only user-made ones live here.
create table if not exists public.report_settings (
  auth_user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  templates jsonb not null default '[]'::jsonb,
  style_presets jsonb not null default '[]'::jsonb,
  defaults jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists report_settings_set_updated_at on public.report_settings;
create trigger report_settings_set_updated_at
before update on public.report_settings
for each row
execute function public.set_reports_updated_at();

alter table public.report_settings enable row level security;

drop policy if exists "Users can read own report settings" on public.report_settings;
create policy "Users can read own report settings"
on public.report_settings for select using (auth.uid() = auth_user_id);

drop policy if exists "Users can insert own report settings" on public.report_settings;
create policy "Users can insert own report settings"
on public.report_settings for insert with check (auth.uid() = auth_user_id);

drop policy if exists "Users can update own report settings" on public.report_settings;
create policy "Users can update own report settings"
on public.report_settings for update using (auth.uid() = auth_user_id) with check (auth.uid() = auth_user_id);


-- Funnel passport.
--
-- Every weekly report opens each funnel block with the same header: trial price
-- and duration, subscription price and period, the upsells with their prices,
-- the localisation list, the default language and currency, and where the
-- funnel leads. None of it exists anywhere today -- cohorts' price_plan is a
-- rounded USD string with NO interval, so it cannot tell a monthly $29.99 from
-- a weekly one. Without these fields the report's funnel block is a table with
-- no header and the operator keeps writing it by hand.
--
-- Additive, in the style of 202607240002. The registry stays deployment-shared
-- (its RLS grants every authenticated user read/write), so no policy changes.
alter table public.funnels
  add column if not exists trial_price numeric,
  add column if not exists trial_currency text,
  add column if not exists trial_duration_days integer,
  add column if not exists subscription_price numeric,
  add column if not exists subscription_currency text,
  add column if not exists billing_period text,
  add column if not exists upsells jsonb not null default '[]'::jsonb,
  add column if not exists default_language text,
  add column if not exists default_currency text,
  add column if not exists geo_localization text[] not null default '{}',
  add column if not exists destination text,
  add column if not exists product text,
  add column if not exists traffic_sources text[] not null default '{}',
  add column if not exists passport_notes text;

-- Constraints are added separately so re-running the migration on a table that
-- already has the columns does not fail on a duplicate constraint name.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'funnels_billing_period_check') then
    alter table public.funnels
      add constraint funnels_billing_period_check
      check (billing_period is null or billing_period in
        ('weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'funnels_destination_check') then
    alter table public.funnels
      add constraint funnels_destination_check
      check (destination is null or destination in
        ('web_app', 'ios', 'android', 'content'));
  end if;
end $$;
