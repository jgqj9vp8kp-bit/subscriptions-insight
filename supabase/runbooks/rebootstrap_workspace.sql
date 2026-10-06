-- Runbook: re-key a workspace that was bootstrapped with the WRONG data owner.
--
-- NOT a migration (supabase db push never runs it). bootstrap_workspace() is a
-- one-time latch and workspaces.data_key is immutable, so a wrong p_data_owner
-- cannot be fixed through the normal RPCs. This script moves the workspace and
-- its data-owner membership to the correct account IN PLACE: roles, seeded
-- templates and the audit trail are kept, and the change is itself audited
-- (bootstrap.rekeyed).
--
-- Supported only while the wrong owner is still the ONLY member (no employee
-- was added yet): it refuses otherwise. With other members, disable them and
-- contact whoever owns the access-control design before touching data_key.
--
-- Usage (Supabase SQL editor or psql, as postgres, ONE transaction):
--   1. Replace both placeholders below with real auth user ids.
--   2. Run the whole file. It aborts (and changes nothing) unless every check
--      passes, including the bootstrap pre-flight for the new owner
--      (fb_cron_config and sync-state ownership, plan §26.1).
--   3. Ask the new owner to sign out and in again (their cache partition moves).
--
-- What it does:
--   * re-runs app.assert_bootstrap_preflight(<data owner>);
--   * workspaces.data_key and the data-owner membership's user_id / email are
--     rewritten with exactly the two guard triggers that forbid it disabled for
--     these two statements (the member-invariant constraint triggers stay ON
--     and check the result before the guards are re-enabled);
--   * API keys: the keys the wrong bootstrap revoked that belong to the new
--     owner are restored (their ids are in the bootstrap.completed audit row);
--     the wrong owner's active keys are revoked, like bootstrap does.

begin;

select set_config('rebootstrap.wrong_owner', '__WRONG_OWNER_UUID__', true);
select set_config('rebootstrap.data_owner', '__DATA_OWNER_UUID__', true);

do $rebootstrap$
declare
  v_wrong uuid := current_setting('rebootstrap.wrong_owner')::uuid;
  v_owner uuid := current_setting('rebootstrap.data_owner')::uuid;
  v_ws public.workspaces%rowtype;
  v_member public.workspace_members%rowtype;
  v_email text;
  v_bootstrap jsonb;
  v_restored uuid[];
  v_revoked uuid[];
  v_before jsonb;
begin
  if v_wrong = v_owner then
    raise exception 'rebootstrap: the wrong owner and the data owner are the same account';
  end if;

  select * into v_ws from public.workspaces for update;
  if not found then
    raise exception 'rebootstrap: no workspace exists; run select public.bootstrap_workspace(...) instead';
  end if;
  if v_ws.data_key <> v_wrong then
    raise exception 'rebootstrap: the workspace data key is not the given wrong owner';
  end if;
  if exists (select 1 from public.workspace_members m where m.user_id <> v_wrong) then
    raise exception 'rebootstrap: other members exist; this runbook only supports a workspace whose only member is the wrong owner';
  end if;
  select u.email into v_email from auth.users u where u.id = v_owner;
  if not found then
    raise exception 'rebootstrap: the data owner user does not exist';
  end if;

  -- Same tenant pre-flight bootstrap_workspace() runs (raises on a mismatch).
  perform app.assert_bootstrap_preflight(v_owner);

  select * into v_member from public.workspace_members m
  where m.workspace_id = v_ws.id and m.user_id = v_wrong and m.is_data_owner;
  if not found then
    raise exception 'rebootstrap: the wrong owner has no data-owner membership';
  end if;
  v_before := app.member_snapshot(v_member.id);

  alter table public.workspaces disable trigger workspaces_guard;
  alter table public.workspace_members disable trigger workspace_members_data_owner_guard;

  update public.workspaces set data_key = v_owner where id = v_ws.id;
  update public.workspace_members
  set user_id = v_owner,
      email_snapshot = coalesce(v_email, ''),
      access_version = access_version + 1
  where id = v_member.id;

  -- Fire the deferred member-invariant checks NOW, on the re-keyed rows (and
  -- so the tables carry no pending trigger events when the guards come back).
  execute 'set constraints all immediate';

  alter table public.workspaces enable trigger workspaces_guard;
  alter table public.workspace_members enable trigger workspace_members_data_owner_guard;

  -- API keys: undo the wrong bootstrap's revocation for the new owner's keys,
  -- then revoke the wrong owner's (they would no longer resolve anyway).
  select a.after into v_bootstrap
  from public.access_audit_log a
  where a.workspace_id = v_ws.id and a.event = 'bootstrap.completed'
  order by a.id desc
  limit 1;

  with restored as (
    update public.api_keys k
    set is_active = true, revoked_at = null
    where k.user_id = v_owner
      and k.id in (
        select value::uuid
        from jsonb_array_elements_text(coalesce(v_bootstrap -> 'api_keys_revoked_ids', '[]'::jsonb))
      )
    returning k.id
  )
  select coalesce(array_agg(restored.id order by restored.id), '{}'::uuid[]) into v_restored from restored;

  with revoked as (
    update public.api_keys k
    set is_active = false, revoked_at = coalesce(k.revoked_at, now())
    where k.user_id = v_wrong
      and (k.is_active or k.revoked_at is null)
    returning k.id
  )
  select coalesce(array_agg(revoked.id order by revoked.id), '{}'::uuid[]) into v_revoked from revoked;

  perform app.write_audit(
    v_ws.id, 'bootstrap.rekeyed', 'system', null, null,
    'workspace', v_ws.id::text, 'success', null,
    jsonb_build_object('data_key', v_wrong, 'member', v_before),
    jsonb_build_object(
      'data_key', v_owner,
      'member', app.member_snapshot(v_member.id),
      'api_keys_restored_ids', to_jsonb(v_restored),
      'api_keys_revoked_ids', to_jsonb(v_revoked)
    ),
    '{}'::jsonb
  );
end
$rebootstrap$;

commit;
