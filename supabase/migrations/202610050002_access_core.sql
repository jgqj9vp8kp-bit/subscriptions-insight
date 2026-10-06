-- Access control core: workspace, roles, members, funnel data scope, audit.
--
-- Plan §8-§12, §24-§27 (sharded-painting-axolotl). Data is tenanted per Supabase
-- user today; this introduces ONE workspace whose data_key is the existing data
-- owner's uuid. Edge binds every ClickHouse {auth_user_id:String} to that key
-- (ctx.tenantKey), never to the caller. Membership + role + funnel scope are
-- resolved per request from these tables (resolve_access / my_access), never
-- from JWT claims, so a revocation applies on the next request.
--
-- Old functions ignore these tables, so applying this migration is inert until
-- `select public.bootstrap_workspace('<owner uuid>', 'SubEngine');` runs. The
-- workspace row is the latch: new Edge code answers 503 workspace_not_bootstrapped
-- without it, never "allow".
--
-- Security model of this file:
--   * Every new table: RLS enabled + REVOKE ALL from anon/authenticated (and
--     writes from service_role), then minimal SELECT grants. No client write
--     policy exists anywhere. All writes go through the SECURITY DEFINER RPCs
--     below (called by the Edge `access` function with the service-role client),
--     which lock the workspace row FOR UPDATE, re-resolve the actor's ACTIVE
--     membership inside the transaction, enforce permission + anti-escalation,
--     and write an access_audit_log row in the same transaction.
--   * The permission catalog lives in code (supabase/functions/_shared/access/
--     permissions.ts). Roles store text[] keys already validated by Edge; SQL
--     only checks shape, privileged-key rules and grantor ⊇ grantee.
--   * Privileged keys = 'admin.%', 'funnels.manage', 'api_export.use' (the
--     catalog's requiresFullScope set). Only the Owner may add/assign them, and a
--     role holding them may only be assigned to members with funnel scope 'all'.
--   * Invariants are ALSO enforced by triggers (defense in depth for direct SQL):
--     immutable identity columns, data-owner membership (Owner, active, scope
--     all), last active Owner, append-only audit, access_version bumps.
--
-- Error contract (SQLSTATE P0001, message "<code>: <detail>"), mapped by Edge:
--   permission_denied  actor is not an active member / lacks the permission  (403)
--   escalation_denied  privileged grant, grant beyond own access, self-edit (403)
--   not_found          unknown member / role / funnel / user                 (404)
--   conflict           duplicate member or role key, role still assigned,
--                      workspace already bootstrapped                        (409)
--   invalid            malformed input; Owner / data-owner / last-owner rule (400)
--
-- Only core Postgres is used (gen_random_uuid(), sha256()); no pgcrypto.

create schema if not exists app;
-- `app` is never exposed through PostgREST (plan §12.9: confirm it is not in
-- the API's exposed schemas). No role gets USAGE on it: RLS policies reference
-- the helpers by OID, which needs EXECUTE on the function (granted per helper
-- below) but not schema USAGE -- so even if `app` were exposed by mistake, no
-- client could call anything in it directly.
revoke all on schema app from public;


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Singleton workspace. data_key = the legacy data owner's auth uuid (U). No FK
-- to auth.users on purpose: the tenant key must survive auth-side changes.
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  data_key uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_name_check check (btrim(name) <> '' and char_length(name) <= 120)
);

-- At most one row, ever (expression index on a constant).
create unique index workspaces_singleton_idx on public.workspaces ((true));

create table public.access_roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  key text not null,
  name text not null,
  description text not null default '',
  -- The Owner role implicitly holds every enforced permission; it stores none.
  is_owner boolean not null default false,
  is_system boolean not null default false,
  template_key text,
  permissions text[] not null default '{}'::text[],
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, key),
  -- Target of workspace_members' composite FK (role must be in the same workspace).
  unique (id, workspace_id),
  constraint access_roles_key_check check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint access_roles_name_check check (btrim(name) <> '' and char_length(name) <= 80),
  constraint access_roles_description_check check (char_length(description) <= 500),
  constraint access_roles_owner_shape_check check (
    not is_owner or (is_system and key = 'owner' and cardinality(permissions) = 0)
  ),
  -- Shape only (dotted lower-case keys, no blanks/nulls); catalog membership is
  -- validated by Edge against permissions.ts before any write.
  constraint access_roles_permissions_shape_check check (
    cardinality(permissions) <= 200
    and array_position(permissions, null) is null
    and array_to_string(permissions, ',')
      ~ '^([a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+(,[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+)*)?$'
  )
);

create unique index access_roles_one_owner_idx on public.access_roles (workspace_id) where is_owner;

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  -- Offboarding = status 'disabled' (plus a GoTrue ban), never a delete.
  user_id uuid not null unique references auth.users(id) on delete restrict,
  role_id uuid not null,
  status text not null default 'active',
  -- True exactly for the member whose user_id = workspaces.data_key.
  is_data_owner boolean not null default false,
  email_snapshot text not null default '',
  display_name text not null default '',
  -- Bumped by triggers on role/status/scope/role-permission/funnel-path changes;
  -- feeds the client cache partition (plan §25).
  access_version bigint not null default 1,
  added_by uuid,
  added_at timestamptz not null default now(),
  disabled_by uuid,
  disabled_at timestamptz,
  last_seen_at timestamptz,
  updated_at timestamptz not null default now(),

  foreign key (role_id, workspace_id) references public.access_roles (id, workspace_id) on delete restrict,
  constraint workspace_members_status_check check (status in ('active', 'disabled')),
  constraint workspace_members_display_name_check check (char_length(display_name) <= 120),
  constraint workspace_members_access_version_check check (access_version >= 1)
);

create unique index workspace_members_one_data_owner_idx
  on public.workspace_members (workspace_id) where is_data_owner;
create index workspace_members_role_idx on public.workspace_members (role_id);

-- Data scope (plan §9). No rule => no data ("none"); 'selected' with no values
-- => zero rows, never "all"; 'all' is dynamic (future + unattributed funnels).
create table public.member_scope_rules (
  member_id uuid not null references public.workspace_members(id) on delete cascade,
  -- v1 has exactly one dimension; a future one relaxes this check + adds code.
  dimension text not null,
  mode text not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),

  primary key (member_id, dimension),
  constraint member_scope_rules_dimension_check check (dimension = 'funnel'),
  constraint member_scope_rules_mode_check check (mode in ('all', 'selected'))
);

-- Grant identity is funnels.id (immutable); paths are derived at resolve time.
create table public.member_scope_values (
  id bigint generated always as identity primary key,
  member_id uuid not null,
  dimension text not null,
  funnel_id uuid references public.funnels(id) on delete restrict,
  value text,
  created_at timestamptz not null default now(),

  foreign key (member_id, dimension)
    references public.member_scope_rules (member_id, dimension) on delete cascade,
  constraint member_scope_values_shape_check
    check ((dimension = 'funnel') = (funnel_id is not null and value is null))
);

create unique index member_scope_values_funnel_unique_idx
  on public.member_scope_values (member_id, dimension, funnel_id) where funnel_id is not null;
create unique index member_scope_values_value_unique_idx
  on public.member_scope_values (member_id, dimension, value) where value is not null;
create index member_scope_values_funnel_idx on public.member_scope_values (funnel_id);

-- Append-only (triggers below block UPDATE/DELETE/TRUNCATE for every role).
-- ids and hashes only: no secrets, tokens or raw emails.
create table public.access_audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  request_id text,
  actor_kind text not null,
  actor_user_id uuid,
  actor_member_id uuid,
  event text not null,
  target_type text,
  target_id text,
  outcome text not null,
  reason_code text,
  before jsonb,
  after jsonb,
  context jsonb not null default '{}'::jsonb,

  constraint access_audit_log_actor_kind_check check (actor_kind in ('user', 'cron', 'api_key', 'system')),
  constraint access_audit_log_event_check check (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint access_audit_log_outcome_check check (outcome in ('success', 'denied', 'error'))
);

create index access_audit_log_occurred_idx on public.access_audit_log (workspace_id, occurred_at desc);
create index access_audit_log_actor_idx on public.access_audit_log (actor_user_id, occurred_at desc);
create index access_audit_log_target_idx on public.access_audit_log (target_type, target_id, occurred_at desc);

-- Denials deduplicated per (day, actor, fn, action, code) so a client stuck in a
-- 403 loop cannot flood the audit log (written by access_record_denial()).
create table public.access_denial_counters (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  day date not null,
  actor_key text not null,
  fn text not null,
  action text not null,
  error_code text not null,
  denials bigint not null default 0,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  last_request_id text,

  primary key (workspace_id, day, actor_key, fn, action, error_code)
);


-- Export API log: who ran an authorized export. From the access-aware Edge
-- deploy on, export-campaign-performance writes the log row of an authorized
-- export under the workspace data key (user_id — tenant data, readable by the
-- data owner; 202610050003 adds the data-key RLS) and the key's creator here.
-- Without it an employee's export would be logged under the employee's id,
-- which the lockdown hides from everyone. Nullable: rows written before this
-- column, and denied requests (logged under the key creator), leave it empty.
-- Added here (step 4), not in 202610050003, because the Edge deploy (step 6)
-- writes it.
alter table public.api_export_logs add column if not exists actor_user_id uuid;
comment on column public.api_export_logs.actor_user_id is
  'API key creator who ran the export (the actor); user_id is the workspace data key for authorized exports.';


-- ---------------------------------------------------------------------------
-- Pure helpers (immutable; no table access)
-- ---------------------------------------------------------------------------

-- Raise the error contract above: SQLSTATE P0001, "<code>: <detail>".
create or replace function app.deny(p_code text, p_detail text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code || ': ' || p_detail;
end;
$$;

-- Mirrors PRIVILEGED_PERMISSION_KEYS (requiresFullScope) in permissions.ts.
create or replace function app.is_privileged_permission(p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_permission like 'admin.%' or p_permission in ('funnels.manage', 'api_export.use'), false)
$$;

create or replace function app.permissions_privileged(p_permissions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from unnest(coalesce(p_permissions, '{}'::text[])) k
    where app.is_privileged_permission(k)
  )
$$;

-- Sorted, de-duplicated, null-free. Stored arrays are always in this form so
-- before/after comparisons and audit diffs are stable.
create or replace function app.normalize_permissions(p_permissions text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct k order by k), '{}'::text[])
  from unnest(coalesce(p_permissions, '{}'::text[])) k
  where k is not null
$$;

create or replace function app.permissions_well_formed(p_permissions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(coalesce(p_permissions, '{}'::text[])) <= 200
    and not exists (
      select 1 from unnest(coalesce(p_permissions, '{}'::text[])) k
      where k is null or k !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    )
$$;

create or replace function app.normalize_funnel_ids(p_funnel_ids uuid[])
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct f order by f), '{}'::uuid[])
  from unnest(coalesce(p_funnel_ids, '{}'::uuid[])) f
  where f is not null
$$;

-- Canonical scope path = lower(btrim(funnel_path without leading slashes)),
-- the same normalization ClickHouse campaign_path filters use. '' => null.
create or replace function app.canonical_funnel_path(p_path text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(btrim(ltrim(btrim(coalesce(p_path, '')), '/'))), '')
$$;

-- Elements of p_a that are not in p_b (both treated as sets; sorted result).
create or replace function app.text_array_minus(p_a text[], p_b text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct x order by x), '{}'::text[])
  from unnest(coalesce(p_a, '{}'::text[])) x
  where not (x = any (coalesce(p_b, '{}'::text[])))
$$;

create or replace function app.uuid_array_minus(p_a uuid[], p_b uuid[])
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
  from unnest(coalesce(p_a, '{}'::uuid[])) x
  where not (x = any (coalesce(p_b, '{}'::uuid[])))
$$;

-- Best-effort correlation id: PostgREST exposes request headers as a GUC, so an
-- Edge client that sends `x-request-id` gets it stamped on audit rows.
create or replace function app.request_id()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers text := current_setting('request.headers', true);
begin
  if v_headers is null or v_headers = '' then
    return null;
  end if;
  return left(nullif(v_headers::jsonb ->> 'x-request-id', ''), 100);
exception when others then
  return null;
end;
$$;


-- ---------------------------------------------------------------------------
-- Lookup helpers (definer; internal, no grants)
-- ---------------------------------------------------------------------------

create or replace function app.role_is_owner(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select r.is_owner from public.access_roles r where r.id = p_role_id), false)
$$;

create or replace function app.role_is_privileged(p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select r.is_owner or app.permissions_privileged(r.permissions)
    from public.access_roles r where r.id = p_role_id
  ), false)
$$;

-- 'all' | 'selected' | 'none' (no rule).
create or replace function app.member_scope_mode(p_member_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select r.mode from public.member_scope_rules r
    where r.member_id = p_member_id and r.dimension = 'funnel'
  ), 'none')
$$;

create or replace function app.member_funnel_ids(p_member_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct v.funnel_id order by v.funnel_id), '{}'::uuid[])
  from public.member_scope_values v
  join public.member_scope_rules r
    on r.member_id = v.member_id and r.dimension = v.dimension and r.mode = 'selected'
  where v.member_id = p_member_id and v.dimension = 'funnel' and v.funnel_id is not null
$$;

create or replace function app.member_scope_json(p_member_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mode', app.member_scope_mode(p_member_id),
    'funnel_ids', to_jsonb(app.member_funnel_ids(p_member_id))
  )
$$;

-- Audit snapshot of a membership: ids only (no email).
create or replace function app.member_snapshot(p_member_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'member_id', m.id,
    'user_id', m.user_id,
    'role_id', m.role_id,
    'role_key', r.key,
    'status', m.status,
    'is_data_owner', m.is_data_owner,
    'display_name', m.display_name,
    'funnel_scope', app.member_scope_json(m.id)
  )
  from public.workspace_members m
  join public.access_roles r on r.id = m.role_id
  where m.id = p_member_id
$$;

create or replace function app.role_snapshot(p_role_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'role_id', r.id,
    'key', r.key,
    'name', r.name,
    'description', r.description,
    'is_owner', r.is_owner,
    'is_system', r.is_system,
    'template_key', r.template_key,
    'permissions', to_jsonb(r.permissions)
  )
  from public.access_roles r
  where r.id = p_role_id
$$;

create or replace function app.assert_other_active_owner(p_workspace_id uuid, p_except_member_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.workspace_members m
    join public.access_roles r on r.id = m.role_id
    where m.workspace_id = p_workspace_id
      and m.id <> p_except_member_id
      and m.status = 'active'
      and r.is_owner
  ) then
    perform app.deny('invalid', 'the last active Owner cannot be disabled, demoted or removed');
  end if;
end;
$$;

-- Invariants checked at COMMIT (deferred constraint triggers), because a
-- membership row and its scope rule are written by separate statements:
--   * the data-owner member is always Owner + active + funnel scope 'all';
--   * a member whose role holds privileged permissions (or is Owner) has funnel
--     scope 'all' (plan D10: no "duplicate Admin role, assign to a Viewer").
create or replace function app.assert_member_invariants(p_member_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_is_data_owner boolean;
  v_status text;
  v_role_owner boolean;
  v_role_privileged boolean;
  v_mode text;
begin
  select m.is_data_owner, m.status, r.is_owner, r.is_owner or app.permissions_privileged(r.permissions)
    into v_is_data_owner, v_status, v_role_owner, v_role_privileged
  from public.workspace_members m
  join public.access_roles r on r.id = m.role_id
  where m.id = p_member_id;

  if not found then
    return; -- deleted in this transaction
  end if;

  v_mode := app.member_scope_mode(p_member_id);

  if v_is_data_owner and (not v_role_owner or v_status <> 'active' or v_mode <> 'all') then
    perform app.deny('invalid', 'the data owner membership is immutable (Owner role, active, funnel scope all)');
  end if;

  if v_role_privileged and v_mode <> 'all' then
    perform app.deny('escalation_denied', 'a member holding privileged permissions requires funnel scope all');
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Trigger functions
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Clone of public.facebook_history_block_mutation (202607190001): applies to
-- EVERY role, service_role and the table owner included. Used for row-level
-- UPDATE/DELETE and statement-level TRUNCATE.
create or replace function app.block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001',
    message = format('invalid: %s is append-only: %s is not allowed', tg_table_name, tg_op);
end;
$$;

-- TRUNCATE skips row triggers, so the guarded tables block it outright.
create or replace function app.block_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001',
    message = format('invalid: TRUNCATE is not allowed on %s', tg_table_name);
end;
$$;

create or replace function app.workspaces_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform app.deny('invalid', 'the workspace cannot be deleted');
  end if;
  if new.id is distinct from old.id
    or new.data_key is distinct from old.data_key
    or new.created_at is distinct from old.created_at then
    perform app.deny('invalid', 'workspaces.id and workspaces.data_key are immutable');
  end if;
  return new;
end;
$$;

create or replace function app.access_roles_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner or old.is_system then
      perform app.deny('invalid', 'system roles cannot be deleted');
    end if;
    return old;
  end if;

  new.permissions := app.normalize_permissions(new.permissions);

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.workspace_id is distinct from old.workspace_id
      or new.key is distinct from old.key
      or new.is_owner is distinct from old.is_owner
      or new.is_system is distinct from old.is_system
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by then
      perform app.deny('invalid', 'access_roles identity columns are immutable');
    end if;
    if old.is_owner and (new.name, new.description, new.permissions, new.template_key)
      is distinct from (old.name, old.description, old.permissions, old.template_key) then
      perform app.deny('invalid', 'the Owner role is immutable');
    end if;
  end if;
  return new;
end;
$$;

-- Identity + data-owner rules (immediate).
create or replace function app.workspace_members_data_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data_key uuid;
begin
  if tg_op = 'INSERT' then
    select w.data_key into v_data_key from public.workspaces w where w.id = new.workspace_id;
    if (new.user_id = v_data_key) is distinct from new.is_data_owner then
      perform app.deny('invalid', 'is_data_owner must be set exactly for the workspace data key');
    end if;
    if new.is_data_owner and (new.status <> 'active' or not app.role_is_owner(new.role_id)) then
      perform app.deny('invalid', 'the data owner membership must be an active Owner');
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.is_data_owner then
      perform app.deny('invalid', 'the data owner membership cannot be deleted');
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.user_id is distinct from old.user_id
    or new.is_data_owner is distinct from old.is_data_owner
    or new.added_at is distinct from old.added_at
    or new.added_by is distinct from old.added_by then
    perform app.deny('invalid', 'workspace_members identity columns (user_id, is_data_owner) are immutable');
  end if;
  if new.access_version < old.access_version then
    perform app.deny('invalid', 'access_version cannot decrease');
  end if;
  if old.is_data_owner and (new.status <> 'active' or not app.role_is_owner(new.role_id)) then
    perform app.deny('invalid', 'the data owner membership is immutable (Owner role, active, funnel scope all)');
  end if;
  return new;
end;
$$;

-- At least one active Owner must always remain (immediate).
create or replace function app.workspace_members_last_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'active' and app.role_is_owner(old.role_id) then
    if tg_op = 'DELETE' then
      perform app.assert_other_active_owner(old.workspace_id, old.id);
      return old;
    end if;
    if not (new.status = 'active' and app.role_is_owner(new.role_id)) then
      perform app.assert_other_active_owner(old.workspace_id, old.id);
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function app.workspace_members_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.access_version := greatest(new.access_version, old.access_version + 1);
  return new;
end;
$$;

create or replace function app.bump_member_access_version(p_member_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.workspace_members
  set access_version = access_version + 1
  where id = p_member_id
$$;

create or replace function app.scope_bump_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.bump_member_access_version(new.member_id);
    return new;
  end if;
  perform app.bump_member_access_version(old.member_id);
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.member_id is distinct from old.member_id then
    perform app.bump_member_access_version(new.member_id);
  end if;
  return new;
end;
$$;

-- Role permission change fans out to every member holding the role.
create or replace function app.role_bump_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_members
  set access_version = access_version + 1
  where role_id = new.id;
  return new;
end;
$$;

-- Re-pathing a granted funnel changes the member's effective paths.
-- security definer: public.funnels is written by authenticated clients today.
create or replace function app.funnel_path_bump_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workspace_members m
  set access_version = m.access_version + 1
  where m.id in (
    select v.member_id from public.member_scope_values v
    where v.dimension = 'funnel' and v.funnel_id = new.id
  );
  return new;
end;
$$;

create or replace function app.member_invariants_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'workspace_members' then
    perform app.assert_member_invariants(new.id);
  elsif tg_op = 'DELETE' then
    perform app.assert_member_invariants(old.member_id);
  else
    perform app.assert_member_invariants(new.member_id);
    if tg_op = 'UPDATE' and new.member_id is distinct from old.member_id then
      perform app.assert_member_invariants(old.member_id);
    end if;
  end if;
  return null;
end;
$$;

create or replace function app.role_invariants_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  for v_member_id in select m.id from public.workspace_members m where m.role_id = new.id loop
    perform app.assert_member_invariants(v_member_id);
  end loop;
  return null;
end;
$$;

-- updated_at
create trigger workspaces_touch_updated_at before update on public.workspaces
for each row execute function app.touch_updated_at();
create trigger access_roles_touch_updated_at before update on public.access_roles
for each row execute function app.touch_updated_at();
create trigger workspace_members_touch_updated_at before update on public.workspace_members
for each row execute function app.touch_updated_at();
create trigger member_scope_rules_touch_updated_at before update on public.member_scope_rules
for each row execute function app.touch_updated_at();

-- immutability / guards
create trigger workspaces_guard before update or delete on public.workspaces
for each row execute function app.workspaces_guard();
create trigger access_roles_guard before insert or update or delete on public.access_roles
for each row execute function app.access_roles_guard();
create trigger workspace_members_data_owner_guard before insert or update or delete on public.workspace_members
for each row execute function app.workspace_members_data_owner_guard();
create trigger workspace_members_last_owner_guard before update or delete on public.workspace_members
for each row execute function app.workspace_members_last_owner_guard();

-- access_version bumps (last_seen_at / display_name / email changes do not bump)
create trigger workspace_members_bump_version
before update of role_id, status on public.workspace_members
for each row
when (old.role_id is distinct from new.role_id or old.status is distinct from new.status)
execute function app.workspace_members_bump_version();

create trigger member_scope_rules_bump_version
after insert or update or delete on public.member_scope_rules
for each row execute function app.scope_bump_version();

create trigger member_scope_values_bump_version
after insert or update or delete on public.member_scope_values
for each row execute function app.scope_bump_version();

create trigger access_roles_bump_members
after update of permissions on public.access_roles
for each row
when (old.permissions is distinct from new.permissions)
execute function app.role_bump_members();

create trigger funnels_bump_member_access_version
after update of funnel_path on public.funnels
for each row
when (old.funnel_path is distinct from new.funnel_path)
execute function app.funnel_path_bump_members();

-- commit-time invariants
create constraint trigger workspace_members_invariants
after insert or update on public.workspace_members
deferrable initially deferred
for each row execute function app.member_invariants_trigger();

create constraint trigger member_scope_rules_invariants
after insert or update or delete on public.member_scope_rules
deferrable initially deferred
for each row execute function app.member_invariants_trigger();

create constraint trigger access_roles_invariants
after update on public.access_roles
deferrable initially deferred
for each row execute function app.role_invariants_trigger();

-- append-only audit
create trigger access_audit_log_append_only
before update or delete on public.access_audit_log
for each row execute function app.block_mutation();

-- TRUNCATE bypasses every row trigger above.
create trigger access_audit_log_block_truncate before truncate on public.access_audit_log
for each statement execute function app.block_truncate();
create trigger workspaces_block_truncate before truncate on public.workspaces
for each statement execute function app.block_truncate();
create trigger access_roles_block_truncate before truncate on public.access_roles
for each statement execute function app.block_truncate();
create trigger workspace_members_block_truncate before truncate on public.workspace_members
for each statement execute function app.block_truncate();
create trigger member_scope_rules_block_truncate before truncate on public.member_scope_rules
for each statement execute function app.block_truncate();
create trigger member_scope_values_block_truncate before truncate on public.member_scope_values
for each statement execute function app.block_truncate();


-- ---------------------------------------------------------------------------
-- RLS helpers (schema app; STABLE SECURITY DEFINER; use as `(select app.x())`)
-- All are keyed on auth.uid() and fail closed: no active membership => false /
-- null / empty.
-- ---------------------------------------------------------------------------

create or replace function app.data_key()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.data_key from public.workspaces w limit 1
$$;

-- The caller's ACTIVE membership id (null when absent or disabled).
create or replace function app.current_member()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.workspace_members m
  where m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create or replace function app.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.user_id = (select auth.uid()) and m.status = 'active'
  )
$$;

create or replace function app.funnel_scope_all()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    join public.member_scope_rules r on r.member_id = m.id and r.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active' and r.mode = 'all'
  )
$$;

-- SQL mirror of effectivePermissions() for RLS: Owner => true; otherwise the
-- key must be in the role AND (privileged key => funnel scope 'all'). The
-- catalog's `requires` closure and "planned" status are guaranteed at write
-- time by Edge validation (validateRolePermissions), so they are not re-derived
-- here. Unknown / null keys => false.
create or replace function app.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case
      when p_permission is null then false
      when r.is_owner then true
      when not (p_permission = any (r.permissions)) then false
      when app.is_privileged_permission(p_permission) then coalesce(sr.mode = 'all', false)
      else true
    end
    from public.workspace_members m
    join public.access_roles r on r.id = m.role_id
    left join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), false)
$$;

-- Canonical paths the caller may see: '{*}' for scope 'all' (the same sentinel
-- the saved-object scope stamp uses, plan §22), the selected funnels' paths for
-- 'selected', '{}' for none / no active membership. Policies comparing stamps
-- must OR with app.funnel_scope_all().
create or replace function app.allowed_paths()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case sr.mode
      when 'all' then array['*']::text[]
      when 'selected' then (
        select coalesce(array_agg(distinct p order by p), '{}'::text[])
        from (
          select app.canonical_funnel_path(f.funnel_path) as p
          from public.member_scope_values v
          join public.funnels f on f.id = v.funnel_id
          where v.member_id = m.id and v.dimension = 'funnel'
        ) paths
        where p is not null
      )
      else '{}'::text[]
    end
    from public.workspace_members m
    left join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), '{}'::text[])
$$;

create or replace function app.can_see_funnel(p_funnel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select sr.mode = 'all'
      or (sr.mode = 'selected' and exists (
        select 1 from public.member_scope_values v
        where v.member_id = m.id and v.dimension = 'funnel' and v.funnel_id = p_funnel_id
      ))
    from public.workspace_members m
    join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
    where m.user_id = (select auth.uid()) and m.status = 'active'
  ), false)
$$;


-- ---------------------------------------------------------------------------
-- Resolver: resolve_access (service_role) / my_access (authenticated)
-- ---------------------------------------------------------------------------

-- Shape (status 'ok'):
--   { status, workspace_id, data_key (resolve_access only), member_id, user_id,
--     email, display_name, is_data_owner, raw_access,
--     role: {id, key, name, is_owner, permissions[]},
--     funnel_scope: {mode: all|selected|none, funnel_ids[], paths[]},
--     access_version, partition }
-- Other statuses ('no_workspace' | 'no_membership' | 'disabled') carry only
-- status, user_id and workspace_id (when known).
-- partition = hex sha256(workspace_id|user_id|access_version|mode|sorted funnel ids).
create or replace function app.resolve_access_core(p_user_id uuid, p_include_data_key boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_member public.workspace_members%rowtype;
  v_role public.access_roles%rowtype;
  v_mode text;
  v_funnel_ids uuid[] := '{}'::uuid[];
  v_paths text[] := '{}'::text[];
  v_email text;
  v_partition text;
  v_result jsonb;
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'no_membership', 'user_id', null);
  end if;

  select * into v_ws from public.workspaces limit 1;
  if not found then
    return jsonb_build_object('status', 'no_workspace', 'user_id', p_user_id, 'workspace_id', null);
  end if;

  select * into v_member
  from public.workspace_members m
  where m.user_id = p_user_id and m.workspace_id = v_ws.id;
  if not found then
    return jsonb_build_object('status', 'no_membership', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  if v_member.status <> 'active' then
    return jsonb_build_object('status', 'disabled', 'user_id', p_user_id, 'workspace_id', v_ws.id);
  end if;

  select * into v_role from public.access_roles r where r.id = v_member.role_id;
  if not found then
    -- Impossible under the FK; fail closed (Edge maps an RPC error to 503).
    raise exception 'access role % missing for member %', v_member.role_id, v_member.id;
  end if;

  v_mode := app.member_scope_mode(v_member.id);
  if v_mode = 'selected' then
    v_funnel_ids := app.member_funnel_ids(v_member.id);
    select coalesce(array_agg(distinct p order by p), '{}'::text[]) into v_paths
    from (
      select app.canonical_funnel_path(f.funnel_path) as p
      from public.funnels f
      where f.id = any (v_funnel_ids)
    ) paths
    where p is not null;
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  v_partition := encode(sha256(convert_to(concat_ws('|',
    v_ws.id::text,
    p_user_id::text,
    v_member.access_version::text,
    v_mode,
    array_to_string(v_funnel_ids, ',')
  ), 'UTF8')), 'hex');

  v_result := jsonb_build_object(
    'status', 'ok',
    'workspace_id', v_ws.id,
    'member_id', v_member.id,
    'user_id', p_user_id,
    'email', coalesce(v_email, nullif(v_member.email_snapshot, '')),
    'display_name', nullif(v_member.display_name, ''),
    'is_data_owner', v_member.is_data_owner,
    'raw_access', p_user_id = v_ws.data_key,
    'role', jsonb_build_object(
      'id', v_role.id,
      'key', v_role.key,
      'name', v_role.name,
      'is_owner', v_role.is_owner,
      'permissions', to_jsonb(v_role.permissions)
    ),
    'funnel_scope', jsonb_build_object(
      'mode', v_mode,
      'funnel_ids', to_jsonb(v_funnel_ids),
      'paths', to_jsonb(v_paths)
    ),
    'access_version', v_member.access_version::text,
    'partition', v_partition
  );

  if p_include_data_key then
    v_result := v_result || jsonb_build_object('data_key', v_ws.data_key);
  end if;

  return v_result;
end;
$$;

create or replace function public.resolve_access(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app.resolve_access_core(p_user_id, true)
$$;

-- Frontend `me` call through PostgREST (no Edge cold start). Never returns
-- data_key.
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app.resolve_access_core((select auth.uid()), false)
$$;

-- Tenant key for cron contexts (they never take it from the request body).
create or replace function public.workspace_data_key()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.data_key from public.workspaces w limit 1
$$;


-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create or replace function app.write_audit(
  p_workspace_id uuid,
  p_event text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_member_id uuid,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_reason_code text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.access_audit_log (
    workspace_id, request_id, actor_kind, actor_user_id, actor_member_id, event,
    target_type, target_id, outcome, reason_code, before, after, context
  ) values (
    p_workspace_id,
    left(coalesce(nullif(p_context ->> 'request_id', ''), app.request_id()), 100),
    p_actor_kind,
    p_actor_user_id,
    p_actor_member_id,
    p_event,
    left(p_target_type, 100),
    left(p_target_id, 200),
    p_outcome,
    left(p_reason_code, 100),
    p_before,
    p_after,
    coalesce(p_context, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Edge's single audit() entry point (denials, exports, sync triggers, ...).
create or replace function public.access_write_audit(
  p_event text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_reason_code text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_member_id uuid;
begin
  select w.id into v_workspace_id from public.workspaces w limit 1;
  if v_workspace_id is null then
    perform app.deny('invalid', 'workspace is not bootstrapped');
  end if;
  if p_event is null or p_event !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then
    perform app.deny('invalid', 'event must be a dotted lower-case name');
  end if;
  if p_actor_kind is null or p_actor_kind not in ('user', 'cron', 'api_key', 'system') then
    perform app.deny('invalid', 'actor_kind must be user, cron, api_key or system');
  end if;
  if p_outcome is null or p_outcome not in ('success', 'denied', 'error') then
    perform app.deny('invalid', 'outcome must be success, denied or error');
  end if;

  if p_actor_user_id is not null then
    select m.id into v_member_id
    from public.workspace_members m
    where m.workspace_id = v_workspace_id and m.user_id = p_actor_user_id;
  end if;

  return app.write_audit(
    v_workspace_id, p_event, p_actor_kind, p_actor_user_id, v_member_id,
    p_target_type, p_target_id, p_outcome, p_reason_code, p_before, p_after, p_context
  );
end;
$$;

-- Deduplicated denial counter (one row per UTC day/actor/fn/action/code).
-- Returns the running count, or 0 before bootstrap.
create or replace function public.access_record_denial(
  p_actor_user_id uuid,
  p_fn text,
  p_action text,
  p_error_code text,
  p_request_id text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_count bigint;
begin
  select w.id into v_workspace_id from public.workspaces w limit 1;
  if v_workspace_id is null then
    return 0;
  end if;

  insert into public.access_denial_counters as c (
    workspace_id, day, actor_key, fn, action, error_code, denials, first_at, last_at, last_request_id
  ) values (
    v_workspace_id,
    (now() at time zone 'utc')::date,
    coalesce(p_actor_user_id::text, 'anonymous'),
    left(coalesce(nullif(btrim(p_fn), ''), 'unknown'), 100),
    left(coalesce(nullif(btrim(p_action), ''), 'unknown'), 100),
    left(coalesce(nullif(btrim(p_error_code), ''), 'unknown'), 100),
    1, now(), now(),
    left(p_request_id, 100)
  )
  on conflict (workspace_id, day, actor_key, fn, action, error_code) do update set
    denials = c.denials + 1,
    last_at = now(),
    last_request_id = coalesce(excluded.last_request_id, c.last_request_id)
  returning c.denials into v_count;

  return v_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- Mutation internals
-- ---------------------------------------------------------------------------

-- The actor as re-resolved INSIDE the mutation transaction (after the
-- workspace lock). permissions = effective set: privileged keys only when the
-- actor's funnel scope is 'all'. An Owner holds everything (is_owner).
create type app.access_actor as (
  member_id uuid,
  user_id uuid,
  role_id uuid,
  is_owner boolean,
  permissions text[],
  scope_mode text,
  funnel_ids uuid[]
);

-- Serializes every access mutation (plan §8 rule 5: no concurrent-edit TOCTOU).
create or replace function app.lock_workspace()
returns public.workspaces
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
begin
  select * into v_ws from public.workspaces limit 1 for update;
  if not found then
    perform app.deny('invalid', 'workspace is not bootstrapped');
  end if;
  return v_ws;
end;
$$;

create or replace function app.load_actor(p_workspace_id uuid, p_actor uuid)
returns app.access_actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor app.access_actor;
  v_role_permissions text[];
begin
  if p_actor is null then
    perform app.deny('permission_denied', 'an actor is required');
  end if;

  select m.id, m.user_id, m.role_id, r.is_owner, r.permissions
    into v_actor.member_id, v_actor.user_id, v_actor.role_id, v_actor.is_owner, v_role_permissions
  from public.workspace_members m
  join public.access_roles r on r.id = m.role_id
  where m.workspace_id = p_workspace_id and m.user_id = p_actor and m.status = 'active';

  if not found then
    perform app.deny('permission_denied', 'the actor is not an active member');
  end if;

  v_actor.scope_mode := app.member_scope_mode(v_actor.member_id);
  v_actor.funnel_ids := case
    when v_actor.scope_mode = 'selected' then app.member_funnel_ids(v_actor.member_id)
    else '{}'::uuid[]
  end;
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_actor.permissions
  from unnest(v_role_permissions) k
  where not app.is_privileged_permission(k) or v_actor.scope_mode = 'all';

  return v_actor;
end;
$$;

create or replace function app.actor_holds(p_actor app.access_actor, p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_actor.is_owner, false) or coalesce(p_permission = any (p_actor.permissions), false)
$$;

create or replace function app.actor_holds_all(p_actor app.access_actor, p_permissions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_actor.is_owner, false)
    or coalesce(p_permissions, '{}'::text[]) <@ coalesce(p_actor.permissions, '{}'::text[])
$$;

create or replace function app.require_permission(p_actor app.access_actor, p_permission text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if not app.actor_holds(p_actor, p_permission) then
    perform app.deny('permission_denied', p_permission || ' is required');
  end if;
end;
$$;

-- Normalizes and validates a requested scope. Returns (mode, funnel_ids).
create or replace function app.prepare_scope(
  p_mode text,
  p_funnel_ids uuid[],
  out scope_mode text,
  out scope_funnel_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing uuid[];
begin
  scope_mode := lower(btrim(coalesce(p_mode, '')));
  if scope_mode not in ('all', 'selected', 'none') then
    perform app.deny('invalid', 'scope mode must be all, selected or none');
  end if;
  scope_funnel_ids := app.normalize_funnel_ids(p_funnel_ids);
  if scope_mode <> 'selected' and cardinality(scope_funnel_ids) > 0 then
    perform app.deny('invalid', 'funnel ids are only accepted with scope mode selected');
  end if;
  if cardinality(scope_funnel_ids) > 1000 then
    perform app.deny('invalid', 'too many funnel ids');
  end if;
  select coalesce(array_agg(x order by x), '{}'::uuid[]) into v_missing
  from unnest(scope_funnel_ids) x
  where not exists (select 1 from public.funnels f where f.id = x);
  if cardinality(v_missing) > 0 then
    perform app.deny('not_found', 'unknown funnel id(s): ' || array_to_string(v_missing, ','));
  end if;
end;
$$;

-- Grantor's scope must contain the granted scope (plan §8 rule 1).
create or replace function app.assert_scope_within_actor(p_actor app.access_actor, p_mode text, p_funnel_ids uuid[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_actor.is_owner or p_actor.scope_mode = 'all' or p_mode = 'none' then
    return;
  end if;
  if p_mode = 'all' then
    perform app.deny('escalation_denied', 'cannot grant funnel scope all without holding it');
  end if;
  if not (coalesce(p_funnel_ids, '{}'::uuid[]) <@ coalesce(p_actor.funnel_ids, '{}'::uuid[])) then
    perform app.deny('escalation_denied', 'cannot grant funnels outside your own scope');
  end if;
end;
$$;

-- May the actor give this role to a member whose scope is p_target_mode?
create or replace function app.assert_can_assign_role(p_actor app.access_actor, p_role public.access_roles, p_target_mode text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_role.is_owner or app.permissions_privileged(p_role.permissions) then
    if not p_actor.is_owner then
      perform app.deny('escalation_denied', 'only the Owner may assign a role with privileged permissions');
    end if;
    if p_target_mode <> 'all' then
      perform app.deny('escalation_denied', 'a role with privileged permissions requires funnel scope all');
    end if;
  end if;
  if not app.actor_holds_all(p_actor, p_role.permissions) then
    perform app.deny('escalation_denied', 'cannot grant permissions you do not hold');
  end if;
end;
$$;

-- May the actor modify this existing member at all? Never self; a member
-- holding privileged permissions only by the Owner; otherwise the actor's
-- permissions and scope must contain the target's (plan §8 rules 1-3).
create or replace function app.assert_can_manage_member(p_actor app.access_actor, p_target public.workspace_members)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.access_roles%rowtype;
begin
  if p_target.user_id = p_actor.user_id then
    perform app.deny('escalation_denied', 'you cannot modify your own membership');
  end if;
  select * into v_role from public.access_roles r where r.id = p_target.role_id;
  if (v_role.is_owner or app.permissions_privileged(v_role.permissions)) and not p_actor.is_owner then
    perform app.deny('escalation_denied', 'only the Owner may modify a member holding privileged permissions');
  end if;
  if not app.actor_holds_all(p_actor, v_role.permissions) then
    perform app.deny('escalation_denied', 'cannot modify a member holding permissions you do not hold');
  end if;
  perform app.assert_scope_within_actor(
    p_actor, app.member_scope_mode(p_target.id), app.member_funnel_ids(p_target.id)
  );
end;
$$;

-- Writes the funnel scope rule/values. 'none' removes the rule (values cascade).
create or replace function app.apply_member_scope(p_member_id uuid, p_mode text, p_funnel_ids uuid[], p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_mode = 'none' then
    delete from public.member_scope_rules where member_id = p_member_id and dimension = 'funnel';
    return;
  end if;

  insert into public.member_scope_rules as r (member_id, dimension, mode, updated_by)
  values (p_member_id, 'funnel', p_mode, p_actor)
  on conflict (member_id, dimension) do update
    set mode = excluded.mode, updated_by = excluded.updated_by
    where r.mode is distinct from excluded.mode;

  delete from public.member_scope_values v
  where v.member_id = p_member_id
    and v.dimension = 'funnel'
    and (p_mode <> 'selected' or not (v.funnel_id = any (coalesce(p_funnel_ids, '{}'::uuid[]))));

  if p_mode = 'selected' then
    insert into public.member_scope_values (member_id, dimension, funnel_id)
    select p_member_id, 'funnel', f
    from unnest(coalesce(p_funnel_ids, '{}'::uuid[])) f
    where not exists (
      select 1 from public.member_scope_values v
      where v.member_id = p_member_id and v.dimension = 'funnel' and v.funnel_id = f
    );
  end if;
end;
$$;

-- admin_access.granted / admin_access.revoked when a member's effective
-- privileged access flips (plan §24).
create or replace function app.audit_admin_access_change(
  p_workspace_id uuid,
  p_actor app.access_actor,
  p_member_id uuid,
  p_was_privileged boolean,
  p_is_privileged boolean,
  p_before jsonb,
  p_after jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_was_privileged is distinct from p_is_privileged then
    perform app.write_audit(
      p_workspace_id,
      case when p_is_privileged then 'admin_access.granted' else 'admin_access.revoked' end,
      'user', p_actor.user_id, p_actor.member_id,
      'member', p_member_id::text, 'success', null, p_before, p_after, '{}'::jsonb
    );
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Mutation RPCs (service_role only; called by the Edge `access` function)
-- ---------------------------------------------------------------------------

create or replace function public.access_add_member(
  p_actor uuid,
  p_email text,
  p_role_id uuid,
  p_scope_mode text,
  p_funnel_ids uuid[],
  p_display_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_user_count integer;
  v_user_id uuid;
  v_user_email text;
  v_confirmed_at timestamptz;
  v_role public.access_roles%rowtype;
  v_mode text;
  v_funnel_ids uuid[];
  v_member_id uuid;
  v_after jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.users.manage');

  if v_email = '' then
    perform app.deny('invalid', 'email is required');
  end if;
  if char_length(v_display_name) > 120 then
    perform app.deny('invalid', 'display name is too long');
  end if;

  select count(*) into v_user_count from auth.users u where lower(u.email) = v_email;
  if v_user_count = 0 then
    perform app.deny('not_found', 'no user with that email');
  elsif v_user_count > 1 then
    perform app.deny('conflict', 'more than one user has that email');
  end if;
  select u.id, u.email, u.email_confirmed_at into v_user_id, v_user_email, v_confirmed_at
  from auth.users u where lower(u.email) = v_email;
  if v_confirmed_at is null then
    perform app.deny('invalid', 'the user has not confirmed their email');
  end if;

  if exists (select 1 from public.workspace_members m where m.user_id = v_user_id) then
    perform app.deny('conflict', 'the user is already a member');
  end if;

  select * into v_role from public.access_roles r where r.id = p_role_id and r.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'role not found');
  end if;

  select s.scope_mode, s.scope_funnel_ids into v_mode, v_funnel_ids
  from app.prepare_scope(p_scope_mode, p_funnel_ids) s;
  perform app.assert_can_assign_role(v_actor, v_role, v_mode);
  perform app.assert_scope_within_actor(v_actor, v_mode, v_funnel_ids);

  insert into public.workspace_members (
    workspace_id, user_id, role_id, status, is_data_owner, email_snapshot, display_name, added_by
  ) values (
    v_ws.id, v_user_id, v_role.id, 'active', false, coalesce(v_user_email, ''), v_display_name, p_actor
  )
  returning id into v_member_id;

  perform app.apply_member_scope(v_member_id, v_mode, v_funnel_ids, p_actor);

  v_after := app.member_snapshot(v_member_id);
  perform app.write_audit(
    v_ws.id, 'member.added', 'user', v_actor.user_id, v_actor.member_id,
    'member', v_member_id::text, 'success', null, null, v_after, '{}'::jsonb
  );
  perform app.audit_admin_access_change(
    v_ws.id, v_actor, v_member_id, false,
    v_role.is_owner or app.permissions_privileged(v_role.permissions), null, v_after
  );

  return jsonb_build_object('ok', true, 'member_id', v_member_id, 'member', v_after);
end;
$$;

-- null argument = unchanged.
create or replace function public.access_update_member(
  p_actor uuid,
  p_member_id uuid,
  p_role_id uuid,
  p_status text,
  p_display_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_target public.workspace_members%rowtype;
  v_old_role public.access_roles%rowtype;
  v_new_role public.access_roles%rowtype;
  v_status text;
  v_display_name text;
  v_mode text;
  v_before jsonb;
  v_after jsonb;
  v_event text;
  v_was_privileged boolean;
  v_is_privileged boolean;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.users.manage');

  select * into v_target from public.workspace_members m
  where m.id = p_member_id and m.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'member not found');
  end if;

  perform app.assert_can_manage_member(v_actor, v_target);

  select * into v_old_role from public.access_roles r where r.id = v_target.role_id;
  v_new_role := v_old_role;
  v_mode := app.member_scope_mode(v_target.id);

  if p_role_id is not null and p_role_id is distinct from v_target.role_id then
    select * into v_new_role from public.access_roles r where r.id = p_role_id and r.workspace_id = v_ws.id;
    if not found then
      perform app.deny('not_found', 'role not found');
    end if;
    if v_target.is_data_owner then
      perform app.deny('invalid', 'the data owner membership is immutable (Owner role, active, funnel scope all)');
    end if;
    perform app.assert_can_assign_role(v_actor, v_new_role, v_mode);
  end if;

  v_status := coalesce(lower(btrim(p_status)), v_target.status);
  if v_status not in ('active', 'disabled') then
    perform app.deny('invalid', 'status must be active or disabled');
  end if;
  if v_target.is_data_owner and v_status <> 'active' then
    perform app.deny('invalid', 'the data owner membership is immutable (Owner role, active, funnel scope all)');
  end if;

  v_display_name := coalesce(btrim(p_display_name), v_target.display_name);
  if char_length(v_display_name) > 120 then
    perform app.deny('invalid', 'display name is too long');
  end if;

  if v_target.status = 'active' and v_old_role.is_owner
    and not (v_status = 'active' and v_new_role.is_owner) then
    perform app.assert_other_active_owner(v_ws.id, v_target.id);
  end if;

  if v_new_role.id = v_target.role_id
    and v_status = v_target.status
    and v_display_name = v_target.display_name then
    return jsonb_build_object('ok', true, 'changed', false, 'member_id', v_target.id,
      'member', app.member_snapshot(v_target.id));
  end if;

  v_before := app.member_snapshot(v_target.id);

  update public.workspace_members m set
    role_id = v_new_role.id,
    status = v_status,
    display_name = v_display_name,
    disabled_by = case
      when v_status = 'disabled' and v_target.status <> 'disabled' then p_actor
      when v_status = 'active' then null
      else m.disabled_by end,
    disabled_at = case
      when v_status = 'disabled' and v_target.status <> 'disabled' then now()
      when v_status = 'active' then null
      else m.disabled_at end
  where m.id = v_target.id;

  v_after := app.member_snapshot(v_target.id);
  v_event := case
    when v_status = 'disabled' and v_target.status = 'active' then 'member.disabled'
    when v_status = 'active' and v_target.status = 'disabled' then 'member.enabled'
    else 'member.updated'
  end;
  perform app.write_audit(
    v_ws.id, v_event, 'user', v_actor.user_id, v_actor.member_id,
    'member', v_target.id::text, 'success', null, v_before, v_after, '{}'::jsonb
  );

  v_was_privileged := v_target.status = 'active'
    and (v_old_role.is_owner or app.permissions_privileged(v_old_role.permissions));
  v_is_privileged := v_status = 'active'
    and (v_new_role.is_owner or app.permissions_privileged(v_new_role.permissions));
  perform app.audit_admin_access_change(
    v_ws.id, v_actor, v_target.id, v_was_privileged, v_is_privileged, v_before, v_after
  );

  return jsonb_build_object('ok', true, 'changed', true, 'member_id', v_target.id, 'member', v_after);
end;
$$;

create or replace function public.access_set_member_scope(
  p_actor uuid,
  p_member_id uuid,
  p_mode text,
  p_funnel_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_target public.workspace_members%rowtype;
  v_mode text;
  v_funnel_ids uuid[];
  v_old_mode text;
  v_old_funnel_ids uuid[];
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.users.manage');

  select * into v_target from public.workspace_members m
  where m.id = p_member_id and m.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'member not found');
  end if;

  perform app.assert_can_manage_member(v_actor, v_target);

  select s.scope_mode, s.scope_funnel_ids into v_mode, v_funnel_ids
  from app.prepare_scope(p_mode, p_funnel_ids) s;

  if v_target.is_data_owner and v_mode <> 'all' then
    perform app.deny('invalid', 'the data owner membership is immutable (Owner role, active, funnel scope all)');
  end if;
  if app.role_is_privileged(v_target.role_id) and v_mode <> 'all' then
    perform app.deny('escalation_denied', 'a member holding privileged permissions requires funnel scope all');
  end if;
  perform app.assert_scope_within_actor(v_actor, v_mode, v_funnel_ids);

  v_old_mode := app.member_scope_mode(v_target.id);
  v_old_funnel_ids := app.member_funnel_ids(v_target.id);
  if v_old_mode = v_mode and v_old_funnel_ids = v_funnel_ids then
    return jsonb_build_object('ok', true, 'changed', false, 'member_id', v_target.id,
      'funnel_scope', app.member_scope_json(v_target.id));
  end if;

  v_before := app.member_scope_json(v_target.id);
  perform app.apply_member_scope(v_target.id, v_mode, v_funnel_ids, p_actor);
  v_after := app.member_scope_json(v_target.id);

  perform app.write_audit(
    v_ws.id, 'scope.updated', 'user', v_actor.user_id, v_actor.member_id,
    'member', v_target.id::text, 'success', null, v_before, v_after,
    jsonb_build_object(
      'added_funnel_ids', to_jsonb(app.uuid_array_minus(v_funnel_ids, v_old_funnel_ids)),
      'removed_funnel_ids', to_jsonb(app.uuid_array_minus(v_old_funnel_ids, v_funnel_ids))
    )
  );

  return jsonb_build_object('ok', true, 'changed', true, 'member_id', v_target.id, 'funnel_scope', v_after);
end;
$$;

create or replace function public.access_create_role(
  p_actor uuid,
  p_key text,
  p_name text,
  p_description text,
  p_permissions text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_permissions text[] := app.normalize_permissions(p_permissions);
  v_role_id uuid;
  v_after jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.roles.manage');

  if v_key !~ '^[a-z][a-z0-9_]{1,40}$' then
    perform app.deny('invalid', 'role key must match ^[a-z][a-z0-9_]{1,40}$');
  end if;
  if v_key = 'owner' then
    perform app.deny('invalid', 'the role key owner is reserved');
  end if;
  if v_name = '' or char_length(v_name) > 80 then
    perform app.deny('invalid', 'role name must be 1-80 characters');
  end if;
  if char_length(v_description) > 500 then
    perform app.deny('invalid', 'role description is too long');
  end if;
  if not app.permissions_well_formed(v_permissions) then
    perform app.deny('invalid', 'malformed permission key');
  end if;
  if app.permissions_privileged(v_permissions) and not v_actor.is_owner then
    perform app.deny('escalation_denied', 'only the Owner may grant privileged permissions');
  end if;
  if not app.actor_holds_all(v_actor, v_permissions) then
    perform app.deny('escalation_denied', 'cannot grant permissions you do not hold');
  end if;
  if exists (select 1 from public.access_roles r where r.workspace_id = v_ws.id and r.key = v_key) then
    perform app.deny('conflict', 'a role with that key already exists');
  end if;

  insert into public.access_roles (workspace_id, key, name, description, permissions, created_by, updated_by)
  values (v_ws.id, v_key, v_name, v_description, v_permissions, p_actor, p_actor)
  returning id into v_role_id;

  v_after := app.role_snapshot(v_role_id);
  perform app.write_audit(
    v_ws.id, 'role.created', 'user', v_actor.user_id, v_actor.member_id,
    'role', v_role_id::text, 'success', null, null, v_after, '{}'::jsonb
  );

  return jsonb_build_object('ok', true, 'role_id', v_role_id, 'role', v_after);
end;
$$;

-- null argument = unchanged.
create or replace function public.access_update_role(
  p_actor uuid,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_permissions text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_role public.access_roles%rowtype;
  v_name text;
  v_description text;
  v_permissions text[];
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.roles.manage');

  select * into v_role from public.access_roles r where r.id = p_role_id and r.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'role not found');
  end if;
  if v_role.is_owner then
    perform app.deny('invalid', 'the Owner role is immutable');
  end if;
  if v_role.id = v_actor.role_id then
    perform app.deny('escalation_denied', 'you cannot edit the role assigned to yourself');
  end if;

  v_name := coalesce(btrim(p_name), v_role.name);
  v_description := coalesce(btrim(p_description), v_role.description);
  v_permissions := case when p_permissions is null then v_role.permissions
    else app.normalize_permissions(p_permissions) end;

  if v_name = '' or char_length(v_name) > 80 then
    perform app.deny('invalid', 'role name must be 1-80 characters');
  end if;
  if char_length(v_description) > 500 then
    perform app.deny('invalid', 'role description is too long');
  end if;
  if not app.permissions_well_formed(v_permissions) then
    perform app.deny('invalid', 'malformed permission key');
  end if;
  if (app.permissions_privileged(v_role.permissions) or app.permissions_privileged(v_permissions))
    and not v_actor.is_owner then
    perform app.deny('escalation_denied', 'only the Owner may edit a role with privileged permissions');
  end if;
  if not app.actor_holds_all(v_actor, v_role.permissions || v_permissions) then
    perform app.deny('escalation_denied', 'cannot edit a role beyond the permissions you hold');
  end if;
  if app.permissions_privileged(v_permissions) and exists (
    select 1 from public.workspace_members m
    where m.role_id = v_role.id and app.member_scope_mode(m.id) <> 'all'
  ) then
    perform app.deny('escalation_denied',
      'the role is assigned to members without funnel scope all and cannot hold privileged permissions');
  end if;

  if v_name = v_role.name and v_description = v_role.description and v_permissions = v_role.permissions then
    return jsonb_build_object('ok', true, 'changed', false, 'role_id', v_role.id, 'role', app.role_snapshot(v_role.id));
  end if;

  v_before := app.role_snapshot(v_role.id);
  update public.access_roles r set
    name = v_name,
    description = v_description,
    permissions = v_permissions,
    updated_by = p_actor
  where r.id = v_role.id;
  v_after := app.role_snapshot(v_role.id);

  perform app.write_audit(
    v_ws.id, 'role.updated', 'user', v_actor.user_id, v_actor.member_id,
    'role', v_role.id::text, 'success', null, v_before, v_after,
    jsonb_build_object(
      'added_permissions', to_jsonb(app.text_array_minus(v_permissions, v_role.permissions)),
      'removed_permissions', to_jsonb(app.text_array_minus(v_role.permissions, v_permissions))
    )
  );

  return jsonb_build_object('ok', true, 'changed', true, 'role_id', v_role.id, 'role', v_after);
end;
$$;

create or replace function public.access_delete_role(p_actor uuid, p_role_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_role public.access_roles%rowtype;
  v_members integer;
  v_before jsonb;
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  perform app.require_permission(v_actor, 'admin.roles.manage');

  select * into v_role from public.access_roles r where r.id = p_role_id and r.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'role not found');
  end if;
  if v_role.is_owner or v_role.is_system then
    perform app.deny('invalid', 'system roles cannot be deleted');
  end if;
  if app.permissions_privileged(v_role.permissions) and not v_actor.is_owner then
    perform app.deny('escalation_denied', 'only the Owner may delete a role with privileged permissions');
  end if;
  if not app.actor_holds_all(v_actor, v_role.permissions) then
    perform app.deny('escalation_denied', 'cannot delete a role beyond the permissions you hold');
  end if;
  select count(*) into v_members from public.workspace_members m where m.role_id = v_role.id;
  if v_members > 0 then
    perform app.deny('conflict', format('the role is assigned to %s member(s)', v_members));
  end if;

  v_before := app.role_snapshot(v_role.id);
  delete from public.access_roles r where r.id = v_role.id;

  perform app.write_audit(
    v_ws.id, 'role.deleted', 'user', v_actor.user_id, v_actor.member_id,
    'role', v_role.id::text, 'success', null, v_before, null, '{}'::jsonb
  );

  return jsonb_build_object('ok', true, 'role_id', v_role.id);
end;
$$;

-- p_templates: [{key, name, description, permissions: [...]}] (ROLE_TEMPLATES
-- from supabase/functions/_shared/access/roles.ts, validated by Edge).
-- Owner only; idempotent by key (an existing key is skipped, never updated, so
-- new catalog permissions are never auto-added to existing roles).
create or replace function public.access_seed_role_templates(p_actor uuid, p_templates jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_actor app.access_actor;
  v_item jsonb;
  v_key text;
  v_name text;
  v_description text;
  v_permissions text[];
  v_role_id uuid;
  v_created text[] := '{}'::text[];
  v_skipped text[] := '{}'::text[];
begin
  select * into v_ws from app.lock_workspace();
  select * into v_actor from app.load_actor(v_ws.id, p_actor);
  if not v_actor.is_owner then
    perform app.deny('permission_denied', 'only the Owner may seed role templates');
  end if;
  if p_templates is null or jsonb_typeof(p_templates) <> 'array' then
    perform app.deny('invalid', 'templates must be a JSON array');
  end if;

  for v_item in select value from jsonb_array_elements(p_templates) loop
    if jsonb_typeof(v_item) <> 'object' then
      perform app.deny('invalid', 'each template must be an object');
    end if;
    v_key := lower(btrim(coalesce(v_item ->> 'key', '')));
    v_name := btrim(coalesce(v_item ->> 'name', ''));
    v_description := btrim(coalesce(v_item ->> 'description', ''));
    if v_key !~ '^[a-z][a-z0-9_]{1,40}$' or v_key = 'owner' then
      perform app.deny('invalid', format('invalid template key %s', v_key));
    end if;
    if v_name = '' or char_length(v_name) > 80 or char_length(v_description) > 500 then
      perform app.deny('invalid', format('invalid name or description for template %s', v_key));
    end if;
    if jsonb_typeof(coalesce(v_item -> 'permissions', '[]'::jsonb)) <> 'array' then
      perform app.deny('invalid', format('permissions of template %s must be an array', v_key));
    end if;
    select app.normalize_permissions(coalesce(array_agg(p), '{}'::text[])) into v_permissions
    from jsonb_array_elements_text(coalesce(v_item -> 'permissions', '[]'::jsonb)) p;
    if not app.permissions_well_formed(v_permissions) then
      perform app.deny('invalid', format('malformed permission key in template %s', v_key));
    end if;

    if exists (select 1 from public.access_roles r where r.workspace_id = v_ws.id and r.key = v_key) then
      v_skipped := v_skipped || v_key;
      continue;
    end if;

    insert into public.access_roles (
      workspace_id, key, name, description, template_key, permissions, created_by, updated_by
    ) values (
      v_ws.id, v_key, v_name, v_description, v_key, v_permissions, p_actor, p_actor
    )
    returning id into v_role_id;

    perform app.write_audit(
      v_ws.id, 'role.created', 'user', v_actor.user_id, v_actor.member_id,
      'role', v_role_id::text, 'success', null, null, app.role_snapshot(v_role_id),
      jsonb_build_object('source', 'template')
    );
    v_created := v_created || v_key;
  end loop;

  return jsonb_build_object('ok', true, 'created', to_jsonb(v_created), 'skipped', to_jsonb(v_skipped));
end;
$$;


-- ---------------------------------------------------------------------------
-- Bootstrap / recovery (service_role + postgres only; run from the SQL editor)
-- ---------------------------------------------------------------------------

-- Bootstrap pre-flight (plan §26.1). Tables are looked up by name: they come
-- from earlier migrations that a test database may not have applied.
--   * fb_cron_config.auth_user_id: the FB and FunnelFox crons post it until
--     202610050003 replaces the senders, and the gate refuses any value but
--     data_key (400 tenant_mismatch) from the Edge deploy on;
--   * support_mail_sync_state (INBOX), funnelfox_subscriptions_sync_state,
--     funnelfox_leads_sync_state: the syncs resume from data_key's row only. If
--     the table has rows but none of them is the data owner's, the support tick
--     would answer 409 HISTORY_IMPORT_REQUIRED every hour and the FunnelFox
--     syncs would silently start over under another account.
-- Fix: bootstrap with the account that owns them, or merge / re-key the state
-- to the data owner first (or delete the foreign rows: they are cursors only).
create or replace function app.assert_bootstrap_preflight(p_data_owner uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cron_owner uuid;
  v_found boolean;
  v_check record;
begin
  if to_regclass('public.fb_cron_config') is not null then
    execute 'select c.auth_user_id from public.fb_cron_config c where c.id limit 1' into v_cron_owner;
    if v_cron_owner is not null and v_cron_owner <> p_data_owner then
      perform app.deny('invalid', 'preflight: fb_cron_config.auth_user_id is not the data owner (plan §26.1); '
        || 'set it to the data owner or bootstrap with the account the crons run for');
    end if;
  end if;

  for v_check in
    select t.table_name, t.row_filter
    from (values
      ('support_mail_sync_state', 'folder = ''INBOX'''),
      ('funnelfox_subscriptions_sync_state', 'true'),
      ('funnelfox_leads_sync_state', 'true')
    ) as t(table_name, row_filter)
  loop
    if to_regclass('public.' || v_check.table_name) is null then
      continue;
    end if;
    execute format(
      'select exists (select 1 from public.%I where %s) and not exists (select 1 from public.%I where %s and auth_user_id = $1)',
      v_check.table_name, v_check.row_filter, v_check.table_name, v_check.row_filter
    ) into v_found using p_data_owner;
    if v_found then
      perform app.deny('invalid', format(
        'preflight: %s has rows, but none belongs to the data owner (plan §26.1-2); '
          || 'merge or re-key that state to the data owner first, or bootstrap with the account that owns it',
        v_check.table_name
      ));
    end if;
  end loop;
end;
$$;

-- One-time latch (plan §26 step 4): creates the workspace (data_key =
-- p_data_owner), the immutable Owner role, the data owner's membership (Owner,
-- active, scope all), revokes every API key not owned by the data owner, and
-- writes bootstrap.completed. Role templates are seeded afterwards by Edge
-- (access_seed_role_templates) from the code catalog.
create or replace function public.bootstrap_workspace(p_data_owner uuid, p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := coalesce(nullif(btrim(p_name), ''), 'SubEngine');
  v_email text;
  v_workspace_id uuid;
  v_role_id uuid;
  v_member_id uuid;
  v_revoked integer;
  v_revoked_ids uuid[];
begin
  -- Serialize concurrent bootstrap attempts (the singleton index is the backstop).
  perform pg_advisory_xact_lock(hashtext('public.bootstrap_workspace'));

  if exists (select 1 from public.workspaces) then
    perform app.deny('conflict', 'the workspace is already bootstrapped');
  end if;
  if p_data_owner is null then
    perform app.deny('invalid', 'a data owner is required');
  end if;
  select u.email into v_email from auth.users u where u.id = p_data_owner;
  if not found then
    perform app.deny('not_found', 'the data owner user does not exist');
  end if;

  -- Tenant pre-flight (plan §26.1), enforced HERE because data_key is immutable
  -- and this latch cannot be re-run: from the access-aware Edge deploy on, the
  -- crons and syncs run for data_key only. A sync state or cron config that
  -- belongs to another account means the wrong owner was chosen or that data
  -- was not merged first (§26.2); both must be fixed before the latch closes.
  perform app.assert_bootstrap_preflight(p_data_owner);

  insert into public.workspaces (name, data_key) values (v_name, p_data_owner)
  returning id into v_workspace_id;

  insert into public.access_roles (workspace_id, key, name, description, is_owner, is_system, permissions)
  values (v_workspace_id, 'owner', 'Owner', 'Holds every permission. Cannot be edited or deleted.', true, true, '{}'::text[])
  returning id into v_role_id;

  insert into public.workspace_members (
    workspace_id, user_id, role_id, status, is_data_owner, email_snapshot, display_name, added_by
  ) values (
    v_workspace_id, p_data_owner, v_role_id, 'active', true, coalesce(v_email, ''), '', null
  )
  returning id into v_member_id;

  insert into public.member_scope_rules (member_id, dimension, mode) values (v_member_id, 'funnel', 'all');

  -- Export API keys of any other account would keep serving that account's
  -- private data copy (plan §21): revoke them in the same transaction.
  -- The ids are kept in the audit row so supabase/runbooks/rebootstrap_workspace.sql
  -- can restore exactly these keys if this bootstrap named the wrong owner.
  with revoked as (
    update public.api_keys k
    set is_active = false, revoked_at = coalesce(k.revoked_at, now())
    where k.user_id <> p_data_owner
      and (k.is_active or k.revoked_at is null)
    returning k.id
  )
  select count(*)::integer, coalesce(array_agg(revoked.id order by revoked.id), '{}'::uuid[])
  into v_revoked, v_revoked_ids
  from revoked;

  perform app.write_audit(
    v_workspace_id, 'bootstrap.completed', 'system', null, null,
    'workspace', v_workspace_id::text, 'success', null, null,
    jsonb_build_object(
      'workspace_id', v_workspace_id,
      'owner_role_id', v_role_id,
      'member', app.member_snapshot(v_member_id),
      'api_keys_revoked', v_revoked,
      'api_keys_revoked_ids', to_jsonb(v_revoked_ids)
    ),
    '{}'::jsonb
  );

  return jsonb_build_object(
    'ok', true,
    'workspace_id', v_workspace_id,
    'owner_role_id', v_role_id,
    'member_id', v_member_id,
    'api_keys_revoked', v_revoked
  );
end;
$$;

-- Lock-out recovery: re-activates an EXISTING member and assigns the Owner role
-- with funnel scope all. Audited as owner.recovered.
create or replace function public.recover_owner(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws public.workspaces%rowtype;
  v_member public.workspace_members%rowtype;
  v_owner_role_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_ws from app.lock_workspace();

  select * into v_member from public.workspace_members m
  where m.user_id = p_user_id and m.workspace_id = v_ws.id;
  if not found then
    perform app.deny('not_found', 'the user is not a member');
  end if;

  select r.id into v_owner_role_id from public.access_roles r
  where r.workspace_id = v_ws.id and r.is_owner;

  v_before := app.member_snapshot(v_member.id);

  update public.workspace_members m set
    role_id = v_owner_role_id,
    status = 'active',
    disabled_by = null,
    disabled_at = null
  where m.id = v_member.id;
  perform app.apply_member_scope(v_member.id, 'all', '{}'::uuid[], null);

  v_after := app.member_snapshot(v_member.id);
  perform app.write_audit(
    v_ws.id, 'owner.recovered', 'system', null, null,
    'member', v_member.id::text, 'success', null, v_before, v_after, '{}'::jsonb
  );

  return jsonb_build_object('ok', true, 'member_id', v_member.id, 'member', v_after);
end;
$$;


-- ---------------------------------------------------------------------------
-- RLS + grants on the new tables
-- ---------------------------------------------------------------------------

alter table public.workspaces enable row level security;
alter table public.access_roles enable row level security;
alter table public.workspace_members enable row level security;
alter table public.member_scope_rules enable row level security;
alter table public.member_scope_values enable row level security;
alter table public.access_audit_log enable row level security;
alter table public.access_denial_counters enable row level security;

-- Supabase's default privileges grant ALL on new public tables to anon,
-- authenticated and service_role. Strip all of it; writes go through the RPCs
-- above only (service_role keeps SELECT for Edge reads such as the admin list).
revoke all on table
  public.workspaces,
  public.access_roles,
  public.workspace_members,
  public.member_scope_rules,
  public.member_scope_values,
  public.access_audit_log,
  public.access_denial_counters
from public, anon, authenticated, service_role;

revoke all on sequence
  public.member_scope_values_id_seq,
  public.access_audit_log_id_seq
from public, anon, authenticated, service_role;

grant select on table
  public.workspaces,
  public.access_roles,
  public.workspace_members,
  public.member_scope_rules,
  public.member_scope_values,
  public.access_audit_log,
  public.access_denial_counters
to service_role;

-- workspaces: no authenticated grant at all (data_key is never client-visible;
-- my_access carries workspace_id).
grant select on table
  public.access_roles,
  public.workspace_members,
  public.member_scope_rules,
  public.member_scope_values,
  public.access_audit_log,
  public.access_denial_counters
to authenticated;

create policy "Members read own membership; member admins read all"
on public.workspace_members
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select app.has_permission('admin.users.view'))
);

create policy "Role admins and member admins read roles; members read own role"
on public.access_roles
for select
to authenticated
using (
  (select app.has_permission('admin.roles.view'))
  or (select app.has_permission('admin.users.view'))
  or exists (
    select 1 from public.workspace_members m
    where m.role_id = access_roles.id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  )
);

create policy "Members read own scope rule; member admins read all"
on public.member_scope_rules
for select
to authenticated
using (
  member_id = (select app.current_member())
  or (select app.has_permission('admin.users.view'))
);

create policy "Members read own scope values; member admins read all"
on public.member_scope_values
for select
to authenticated
using (
  member_id = (select app.current_member())
  or (select app.has_permission('admin.users.view'))
);

create policy "Audit viewers read the audit log"
on public.access_audit_log
for select
to authenticated
using ((select app.has_permission('admin.audit.view')));

create policy "Audit viewers read denial counters"
on public.access_denial_counters
for select
to authenticated
using ((select app.has_permission('admin.audit.view')));


-- ---------------------------------------------------------------------------
-- Function grants. Postgres grants EXECUTE to PUBLIC on every new function and
-- Supabase adds anon/authenticated/service_role in `public`, so every function
-- created here is revoked first, then granted only where needed.
-- ---------------------------------------------------------------------------

do $$
declare
  v_fn regprocedure;
begin
  for v_fn in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', v_fn);
  end loop;
end
$$;

revoke all on function public.resolve_access(uuid) from public, anon, authenticated;
revoke all on function public.my_access() from public, anon, authenticated, service_role;
revoke all on function public.workspace_data_key() from public, anon, authenticated;
revoke all on function public.access_write_audit(text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.access_record_denial(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.access_add_member(uuid, text, uuid, text, uuid[], text) from public, anon, authenticated;
revoke all on function public.access_update_member(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.access_set_member_scope(uuid, uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.access_create_role(uuid, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.access_update_role(uuid, uuid, text, text, text[]) from public, anon, authenticated;
revoke all on function public.access_delete_role(uuid, uuid) from public, anon, authenticated;
revoke all on function public.access_seed_role_templates(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.bootstrap_workspace(uuid, text) from public, anon, authenticated;
revoke all on function public.recover_owner(uuid) from public, anon, authenticated;

-- RLS helpers: EXECUTE for authenticated only, because policies evaluated as
-- authenticated call them (here and in the upcoming RESTRICTIVE lockdown
-- migration). service_role bypasses RLS and Edge uses the public RPCs, so it
-- needs none of them.
grant execute on function app.data_key() to authenticated;
grant execute on function app.current_member() to authenticated;
grant execute on function app.is_active_member() to authenticated;
grant execute on function app.has_permission(text) to authenticated;
grant execute on function app.funnel_scope_all() to authenticated;
grant execute on function app.allowed_paths() to authenticated;
grant execute on function app.can_see_funnel(uuid) to authenticated;

grant execute on function public.my_access() to authenticated;

grant execute on function public.resolve_access(uuid) to service_role;
grant execute on function public.workspace_data_key() to service_role;
grant execute on function public.access_write_audit(text, text, uuid, text, text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.access_record_denial(uuid, text, text, text, text) to service_role;
grant execute on function public.access_add_member(uuid, text, uuid, text, uuid[], text) to service_role;
grant execute on function public.access_update_member(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.access_set_member_scope(uuid, uuid, text, uuid[]) to service_role;
grant execute on function public.access_create_role(uuid, text, text, text, text[]) to service_role;
grant execute on function public.access_update_role(uuid, uuid, text, text, text[]) to service_role;
grant execute on function public.access_delete_role(uuid, uuid) to service_role;
grant execute on function public.access_seed_role_templates(uuid, jsonb) to service_role;
grant execute on function public.bootstrap_workspace(uuid, text) to service_role;
grant execute on function public.recover_owner(uuid) to service_role;


-- ---------------------------------------------------------------------------
-- Fail closed: every table in `public` must have RLS enabled (red-team F1).
-- Tables checked when this migration was written (all from supabase/migrations):
--   ai_assistant_runs, ai_feedback, ai_recommendations, api_export_logs,
--   api_keys, capsuled_facebook_stats, capsuled_facebook_syncs,
--   clickhouse_cohort_snapshot_state, clickhouse_transaction_sync_state,
--   clickhouse_validation_state, data_snapshots, facebook_batch_dq,
--   facebook_buyer_mapping, facebook_campaign_funnel_map,
--   facebook_campaign_mapping, facebook_import_batches, facebook_known_gaps,
--   facebook_raw_payloads, facebook_sync_run_requests, facebook_sync_runs,
--   fb_cron_config, forecast_scenarios, funnel_tags, funnelfox_leads,
--   funnelfox_leads_sync_state, funnelfox_subscriptions,
--   funnelfox_subscriptions_sync_state, funnels, import_batch_files,
--   import_batches, project_forecasts, report_ai_runs, report_notes,
--   report_settings, report_targets, report_tasks, report_versions, reports,
--   support_classification_state, support_import_batches,
--   support_mail_cron_config, support_mail_sync_state, support_messages,
--   support_replies, support_requests, tags, transactions,
--   + this migration: workspaces, access_roles, workspace_members,
--   member_scope_rules, member_scope_values, access_audit_log,
--   access_denial_counters.
-- A table created outside migrations (dashboard) without RLS aborts this
-- migration on purpose: enable RLS on it first.
-- ---------------------------------------------------------------------------

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'access_core: row level security is disabled on public table(s): %', v_missing;
  end if;

  -- Views, materialized views and foreign tables have no RLS of their own: a
  -- view runs with its OWNER's rights (security_invoker is off by default), so
  -- a view over a tenant table would bypass every policy above. None exists in
  -- the repo; one created in the dashboard and readable by the browser roles
  -- aborts this migration. A view with security_invoker=true checks the
  -- caller's RLS and is allowed.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm', 'f')
    and (
      has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('authenticated', c.oid, 'SELECT')
    )
    and not (
      c.relkind = 'v'
      and exists (
        select 1 from unnest(coalesce(c.reloptions, '{}'::text[])) as o(opt)
        where lower(o.opt) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes')
      )
    );

  if v_missing is not null then
    raise exception using
      message = 'access_core: public view(s) / materialized view(s) / foreign table(s) readable by the browser roles bypass RLS: '
        || v_missing,
      hint = 'Recreate a view WITH (security_invoker = true), or revoke SELECT on it from anon and authenticated.';
  end if;
end
$$;
