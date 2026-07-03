-- Resumable, staged FunnelFox Leads sync.
--
-- Adds the bookkeeping the chunked sync needs: a per-row "we already tried to enrich this email"
-- marker (so detail enrichment can resume without re-fetching and so "profiles without email" can be
-- counted honestly), and per-resource stage/completion + cursor tracking on the sync-state row.
--
-- Backwards compatible: all columns are nullable / defaulted, so existing rows keep working and the
-- existing lead definition (is_lead) is untouched.

-- Per-profile enrichment marker. NULL/false = email enrichment not yet attempted for this row.
alter table public.funnelfox_leads
  add column if not exists detail_checked boolean not null default false;

create index if not exists funnelfox_leads_detail_checked_idx
  on public.funnelfox_leads (auth_user_id, detail_checked)
  where detail_checked = false;

-- Stage / completion bookkeeping for resumable sync.
alter table public.funnelfox_leads_sync_state
  add column if not exists current_stage text,
  add column if not exists profiles_completed boolean not null default false,
  add column if not exists details_completed boolean not null default false,
  add column if not exists sessions_completed boolean not null default false,
  add column if not exists reconcile_completed boolean not null default false,
  add column if not exists profiles_total_reported_by_api integer,
  add column if not exists profiles_scanned_total integer not null default 0,
  add column if not exists sessions_scanned_total integer not null default 0;
