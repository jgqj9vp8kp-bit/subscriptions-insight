-- Shared Cohorts views: default view per role (2026-10-18).
--
-- The Owner marks a shared view (202610180002) as the default for access roles
-- (access_roles.key: media_buyer, head_of_marketing, …). A member of such a role
-- who has not picked a layout yet lands on it the first time they open Cohorts
-- (src/pages/Cohorts.tsx landing effect; sharedCohortViews.ts). Several views
-- naming the same role: the most recently updated wins.
--
-- Keys, not ids: readable, and a role key is unique per workspace. A key with no
-- role behind it is simply never matched. Writes stay Owner-only through the
-- existing update policy; readers (cohorts.view) see the keys, which name roles
-- only.

alter table public.shared_cohort_views
  add column default_role_keys text[] not null default '{}';

alter table public.shared_cohort_views
  add constraint shared_cohort_views_default_roles_check
  check (cardinality(default_role_keys) <= 50 and array_position(default_role_keys, null) is null);
