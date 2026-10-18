-- Project-qualified campaign paths for the Brainza FunnelFox project (2026-10-18).
--
-- Two FunnelFox projects publish the same landing path on different domains:
-- quiz.brainza.app/test-iq (project 01KKEGM9PVW291BKJKYNC7QPSV, 2026-04..06) and
-- f.foxiq.app/test-iq (project 01M36MDN39CQYEKTPZ92PN2R33, from 2026-10). The
-- importer drops the host (palmerTransform.ts normalizeCampaignPath), so both
-- landed in one cohort `test-iq`. palmerTransform.ts (withProjectPathPrefix) now
-- prefixes every path of the Brainza project with `brainza-`; this migration
-- rewrites the rows already stored with the same rule. Owner decision
-- 2026-10-18: prefix Brainza only — FoxIQ, Azora and every other project keep
-- the bare path. Keyed by metadata.ff_project_id, not the host: the project also
-- served its default *.fnlfx.com domain.
--
-- Per account (auth_user_id), in this order:
--   1. normalized_payload.cohort_id of every row of a user whose successful
--      trial is a Brainza row: `{funnel}_{path}_{date}` ->
--      `{funnel}_brainza-{path}_{date}` (addCohortFields builds it from the
--      trial's path), and the legacy `{path}_{date}` -> `brainza-{path}_{date}`
--      (the stored shape is kept). That includes the user's later payments that carry no
--      FunnelFox metadata (first subscription, failed retries) — their own
--      campaign_path stays 'unknown', exactly as a fresh import leaves it.
--      Matched by (user, the trial's old cohort_id), never by the cohort_id
--      alone: a FoxIQ trial on the same date carries the same old cohort_id.
--   2. campaign_path (the column and normalized_payload) of every Brainza row.
-- Nothing else: raw_payload and normalized_payload->'metadata' keep the
-- FunnelFox values verbatim. No Brainza path is in public.funnels,
-- public.funnel_paths or project_forecasts (checked on production 2026-10-18).
--
-- After it: the updated_at trigger moves every touched row past the ClickHouse
-- backfill cursor, so the next "Continue backfill" rewrites them (each batch
-- evicts the old copies first — campaign_path is in the sorting key); the cohort
-- membership snapshot then rebuilds on the new warehouse fingerprint.
--
-- Idempotent: already prefixed rows are skipped, so a second run changes nothing.

with brainza_trials as (
  select distinct
    t.auth_user_id,
    coalesce(nullif(t.normalized_payload->>'user_id', ''), t.user_id) as uid,
    t.normalized_payload->>'cohort_id' as old_cohort_id,
    t.normalized_payload->>'campaign_path' as path
  from public.transactions t
  where t.normalized_payload->'metadata'->>'ff_project_id' = '01KKEGM9PVW291BKJKYNC7QPSV'
    and t.normalized_payload->>'transaction_type' = 'trial'
    and t.normalized_payload->>'status' = 'success'
    and coalesce(t.normalized_payload->>'campaign_path', '') not in ('', 'unknown')
    and t.normalized_payload->>'campaign_path' not like 'brainza-%'
    -- `{path}_YYYY-MM-DD` at the end — the suffix the rewrite below replaces —
    -- either the whole value (the legacy `{path}_{date}` shape, still on most
    -- rows imported before 2026-06) or after `{funnel}_`.
    and (
      t.normalized_payload->>'cohort_id' like ((t.normalized_payload->>'campaign_path') || '\_____-__-__')
      or t.normalized_payload->>'cohort_id' like ('%\_' || (t.normalized_payload->>'campaign_path') || '\_____-__-__')
    )
)
update public.transactions t
set normalized_payload = jsonb_set(
  t.normalized_payload,
  '{cohort_id}',
  to_jsonb(
    left(b.old_cohort_id, length(b.old_cohort_id) - length(b.path) - 11)
    || 'brainza-' || b.path || right(b.old_cohort_id, 11)
  )
)
from brainza_trials b
where t.auth_user_id = b.auth_user_id
  and coalesce(nullif(t.normalized_payload->>'user_id', ''), t.user_id) = b.uid
  and t.normalized_payload->>'cohort_id' = b.old_cohort_id;

update public.transactions t
set campaign_path = 'brainza-' || (t.normalized_payload->>'campaign_path'),
    normalized_payload = jsonb_set(
      t.normalized_payload,
      '{campaign_path}',
      to_jsonb('brainza-' || (t.normalized_payload->>'campaign_path'))
    )
where t.normalized_payload->'metadata'->>'ff_project_id' = '01KKEGM9PVW291BKJKYNC7QPSV'
  and coalesce(t.normalized_payload->>'campaign_path', '') not in ('', 'unknown')
  and t.normalized_payload->>'campaign_path' not like 'brainza-%';

do $$
declare
  v_left int;
begin
  select count(*) into v_left
  from public.transactions t
  where t.normalized_payload->'metadata'->>'ff_project_id' = '01KKEGM9PVW291BKJKYNC7QPSV'
    and (
      (coalesce(t.normalized_payload->>'campaign_path', '') not in ('', 'unknown')
        and t.normalized_payload->>'campaign_path' not like 'brainza-%')
      or (t.normalized_payload->>'campaign_path' like 'brainza-%'
        and t.campaign_path is distinct from t.normalized_payload->>'campaign_path')
    );
  if v_left > 0 then
    raise exception 'brainza_campaign_path_prefix: % Brainza rows left without the prefix', v_left;
  end if;
end
$$;
