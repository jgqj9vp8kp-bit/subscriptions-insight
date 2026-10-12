-- Payment System Health, phase P2 (plan section X "Доступ и безопасность"):
-- the SQL side of the two privileged payment_health.* keys.
--
-- permissions.ts (the catalog, shared by Edge, SQL validation and the browser)
-- adds five keys for the module:
--   payment_health.view, payment_health.export, payment_health.risk_events.view
--     ordinary keys (no action of the module is scopeReady in the MVP, so a
--     funnel-restricted member holding them still gets 403 scope_not_supported);
--   payment_health.psp_global.view, payment_health.manage_alerts
--     PRIVILEGED (requiresFullScope, sensitive 'admin'): PSP x MID and
--     descriptor breakdowns are whole-tenant account figures and alert
--     management is a write, so both follow the admin.* rules -- full funnel
--     scope only, granted by the Owner only, and a role holding them cannot be
--     assigned to a narrowed member (plan D10).
--
-- The catalog is code, but the anti-escalation rules run in SQL
-- (app.is_privileged_permission, 202610050002) and that predicate hard-codes
-- its list: this migration extends it to the two new keys. Everything that
-- reads it (app.permissions_privileged, app.has_permission, the role / member
-- mutation RPCs, the commit-time scope invariant) picks the change up through
-- the function; nothing else changes. accessCoreMigration.test.ts keeps the
-- TS catalog (PRIVILEGED_PERMISSION_KEYS) and this predicate in parity.
--
-- New keys are NOT added to stored roles (roles.ts: a template reflects the
-- catalog only at seeding time). The Owner role holds every enforced key
-- implicitly; the owner adds the payment_health.* keys to the Admin role by
-- hand (owner decision 3 / 10, README "Payment health P2").
--
-- APPLY ORDER: after 202610110002 (guarded below: public.network_program_thresholds
-- is the marker that the P1 registries have landed) and BEFORE deploying the P2
-- functions: with the new catalog live and the old predicate, an Admin could
-- grant payment_health.psp_global.view like an ordinary key (the Edge would still
-- drop it for a narrowed member, but the SQL invariant would not hold). Apply this
-- file on its own, as ONE transaction (supabase db push does): the guards abort
-- the whole file. Re-applying is safe (create or replace, idempotent revoke).

do $$
begin
  if to_regclass('public.network_program_thresholds') is null
    or to_regprocedure('app.is_privileged_permission(text)') is null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_permissions: 202610110002_payment_health_registries.sql has not been applied',
      hint = 'Apply 202610110002 (the P1 registries) first; this migration is applied after the payment health series (README "Payment health P2").';
  end if;
end
$$;

-- Fail closed before the predicate changes meaning: a role that already holds
-- one of the keys (possible only if the P2 functions were deployed before this
-- file) must not be assigned to a member outside funnel scope all -- the
-- commit-time invariant of 202610050002 would otherwise be violated by rows
-- that already exist. Nothing is rewritten: the owner narrows or re-scopes the
-- member first (access -> members), then re-applies.
do $$
declare
  v_violations text;
begin
  select string_agg(m.id::text || ' (' || r.key || ')', ', ' order by m.id) into v_violations
  from public.workspace_members m
  join public.access_roles r on r.id = m.role_id
  left join public.member_scope_rules sr on sr.member_id = m.id and sr.dimension = 'funnel'
  where r.permissions && array['payment_health.psp_global.view', 'payment_health.manage_alerts']::text[]
    and coalesce(sr.mode, 'none') <> 'all';
  if v_violations is not null then
    raise exception using
      errcode = 'P0001',
      message = 'payment_health_permissions: members outside funnel scope all hold a role with a payment_health privileged key: ' || v_violations,
      hint = 'Re-scope those members to all funnels or remove the key from the role, then re-apply.';
  end if;
end
$$;

-- Mirrors PRIVILEGED_PERMISSION_KEYS (requiresFullScope) in permissions.ts:
-- admin.*, funnels.manage, api_export.use (202610050002) plus the two payment
-- health keys. CREATE OR REPLACE keeps the OID, ownership and the privileges
-- 202610050002 revoked; the revoke below is restated so a re-run on a database
-- where the function was recreated by hand is still closed.
create or replace function app.is_privileged_permission(p_permission text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    p_permission like 'admin.%'
    or p_permission in ('funnels.manage', 'api_export.use', 'payment_health.psp_global.view', 'payment_health.manage_alerts'),
    false)
$$;

revoke all on function app.is_privileged_permission(text) from public, anon, authenticated, service_role;

-- Fail closed: the predicate answers exactly what the catalog says for the
-- module's keys (and still for the 202610050002 ones).
do $$
begin
  if not app.is_privileged_permission('payment_health.psp_global.view')
    or not app.is_privileged_permission('payment_health.manage_alerts')
    or not app.is_privileged_permission('admin.users.view')
    or not app.is_privileged_permission('funnels.manage')
    or not app.is_privileged_permission('api_export.use')
    or app.is_privileged_permission('payment_health.view')
    or app.is_privileged_permission('payment_health.export')
    or app.is_privileged_permission('payment_health.risk_events.view')
    or app.is_privileged_permission('payment_pass.view')
    or app.is_privileged_permission(null) then
    raise exception 'payment_health_permissions: app.is_privileged_permission does not match the catalog';
  end if;
  if has_function_privilege('anon', 'app.is_privileged_permission(text)', 'execute')
    or has_function_privilege('authenticated', 'app.is_privileged_permission(text)', 'execute')
    or has_function_privilege('service_role', 'app.is_privileged_permission(text)', 'execute') then
    raise exception 'payment_health_permissions: app.is_privileged_permission is executable by an API role';
  end if;
end
$$;
