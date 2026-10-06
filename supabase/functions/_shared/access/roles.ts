// Seeded role templates (plan §8). Seeded into access_roles by the Owner via
// access_seed_role_templates (idempotent by key) and clonable afterwards.
//
// Rules the tests pin down:
//   * every template is a subset of the ENFORCED catalog and closed under `requires`;
//   * none of the non-admin templates carries PII keys or anything privileged
//     (admin.*, funnels.manage, api_export.use) — a privileged role may only be
//     assigned by the Owner to full-scope members, and templates are meant to be
//     handed out freely;
//   * the Owner is NOT a template: bootstrap_workspace creates the single
//     is_owner role, which implicitly holds every enforced key.
// New catalog keys are never auto-added to roles already stored in the DB; the
// `admin` template below only reflects the catalog at seeding time.

import { ENFORCED_PERMISSION_KEYS, closeUnderRequires } from "./permissions.ts";

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

function template(key: string, name: string, description: string, permissions: readonly string[]): RoleTemplate {
  return { key, name, description, permissions: closeUnderRequires(permissions) };
}

export const ROLE_TEMPLATES: RoleTemplate[] = [
  template(
    "admin",
    "Admin",
    "Every enforced permission, including member, role and warehouse administration. Full funnel scope only; assigned by the Owner.",
    ENFORCED_PERMISSION_KEYS,
  ),
  template(
    "head_of_marketing",
    "Head of Marketing",
    "Marketing performance end to end: dashboard, cohorts, funnels, Facebook analytics, forecasting and reports, with exports and AI. No customer personal data.",
    [
      "dashboard.view",
      "cohorts.view",
      "cohorts.export",
      "funnels.view",
      "facebook_analytics.view",
      "facebook_analytics.export",
      "forecasting.view",
      "forecasting.create",
      "forecasting.edit",
      "reports.view",
      "reports.create",
      "reports.edit",
      "reports.publish",
      "reports.export",
      "ai.use",
      "ai.history.view",
    ],
  ),
  template(
    "media_buyer",
    "Media Buyer",
    "Campaign performance for the assigned funnels: dashboard, cohorts, funnels and Facebook analytics, with the AI assistant.",
    ["dashboard.view", "cohorts.view", "funnels.view", "facebook_analytics.view", "ai.use"],
  ),
  template(
    "product_manager",
    "Product Manager",
    "Product and monetization health: dashboard, cohorts, funnels, payment pass, user aggregates, support aggregates, forecasting and report drafting.",
    [
      "dashboard.view",
      "cohorts.view",
      "funnels.view",
      "payment_pass.view",
      "users.view",
      "users.details.view",
      "support.view",
      "forecasting.view",
      "forecasting.create",
      "forecasting.edit",
      "reports.view",
      "reports.create",
      "reports.edit",
      "ai.use",
    ],
  ),
  template(
    "analyst",
    "Analyst",
    "Read access across analytics pages with exports and report drafting. No customer personal data and no administration.",
    [
      "dashboard.view",
      "cohorts.view",
      "cohorts.export",
      "funnels.view",
      "facebook_analytics.view",
      "facebook_analytics.export",
      "forecasting.view",
      "transactions.view",
      "payment_pass.view",
      "payment_pass.banks.view",
      "users.view",
      "users.details.view",
      "support.view",
      "reports.view",
      "reports.create",
      "reports.edit",
      "reports.export",
      "ai.use",
      "ai.history.view",
    ],
  ),
  template(
    "viewer",
    "Viewer",
    "Read-only overview: dashboard, cohorts, funnels and published reports.",
    ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"],
  ),
];
