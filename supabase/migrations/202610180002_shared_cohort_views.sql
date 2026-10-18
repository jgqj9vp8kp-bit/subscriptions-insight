-- Shared Cohorts views (2026-10-18).
--
-- A saved Cohorts view (column order, visibility and widths) lives in the
-- author's own data_snapshots row (cohorts_ui_settings), which RLS keeps to that
-- account. The owner wants to hand a layout (e.g. "Buyer") to the media buyers
-- and other members: this table holds workspace-wide views.
--   * read:  every active member who may open Cohorts (cohorts.view);
--   * write: the workspace Owner only (insert / update / delete), via
--     app.is_workspace_owner() — no catalog permission exists for it yet.
-- A view is a column layout, never data or filters, so it is safe for a
-- funnel-restricted member: the numbers they see stay scoped by the gate.
-- Single workspace (as everywhere else in this schema), so no workspace column.

create or replace function app.is_workspace_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.access_roles r on r.id = m.role_id
    where m.user_id = (select auth.uid()) and m.status = 'active' and r.is_owner
  )
$$;

revoke all on function app.is_workspace_owner() from public, anon;
grant execute on function app.is_workspace_owner() to authenticated;

create table public.shared_cohort_views (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  column_order text[] not null default '{}',
  column_visibility jsonb not null default '{}'::jsonb,
  column_widths jsonb,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shared_cohort_views_name_check check (name = btrim(name) and char_length(name) between 1 and 80),
  constraint shared_cohort_views_order_check check (cardinality(column_order) <= 500),
  constraint shared_cohort_views_visibility_check check (jsonb_typeof(column_visibility) = 'object'),
  constraint shared_cohort_views_widths_check check (column_widths is null or jsonb_typeof(column_widths) = 'object')
);

create unique index shared_cohort_views_name_idx on public.shared_cohort_views (lower(name));

create trigger shared_cohort_views_touch_updated_at before update on public.shared_cohort_views
for each row execute function app.touch_updated_at();

alter table public.shared_cohort_views enable row level security;

revoke all on table public.shared_cohort_views from anon;
grant select, insert, update, delete on table public.shared_cohort_views to authenticated;

create policy shared_cohort_views_read on public.shared_cohort_views
for select to authenticated
using ((select app.has_permission('cohorts.view')));

create policy shared_cohort_views_owner_insert on public.shared_cohort_views
for insert to authenticated
with check ((select app.is_workspace_owner()));

create policy shared_cohort_views_owner_update on public.shared_cohort_views
for update to authenticated
using ((select app.is_workspace_owner()))
with check ((select app.is_workspace_owner()));

create policy shared_cohort_views_owner_delete on public.shared_cohort_views
for delete to authenticated
using ((select app.is_workspace_owner()));

-- Same RESTRICTIVE floor as every other table (202610050003): no active
-- membership, no rows — whatever a permissive policy above says.
create policy lockdown_active_member on public.shared_cohort_views
as restrictive for all to authenticated
using ((select app.is_active_member()))
with check ((select app.is_active_member()));
