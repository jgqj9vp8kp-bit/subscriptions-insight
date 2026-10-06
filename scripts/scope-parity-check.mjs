// Live parity check for funnel-restricted reads (access Phase 2, spec §7 / §8 step 8).
//
// Restricted SQL is proven against recorded SQL and fixtures only (there is no
// local ClickHouse), so before the first real media buyer the owner runs this
// against production with a TEST member: the owner's own reads filtered to the
// member's funnels must equal what the member is served.
//
//   1. COHORTS   clickhouse-cohorts list: owner with filters.campaign_path =
//                MEMBER_PATHS vs the member. Same cohort keys both ways; every
//                numeric field equal (the FB columns excepted: campaigns shared
//                with other funnels are hidden from the member by design).
//   2. REVENUE   clickhouse-revenue bundle, attributed fields only: totals,
//                buckets, by_funnel, by_plan, by_age (minus "unattributed").
//   3. OPTIONS   clickhouse-cohorts options: per dimension the member's values
//                are a subset of the owner's (campaign_path ⊆ MEMBER_PATHS).
//   4. FB        clickhouse-facebook report at campaign level: member rows ⊆
//                owner rows, per-row FB metrics equal, blended values ≤ owner's.
//
// Read-only: it sends read actions only and never writes anything. The JWTs are
// never printed. Exit 0 when every difference is within TOLERANCE, 1 when one
// exceeds it, 2 on a usage / transport error (e.g. 409: the member's snapshot is
// not ready — run `select public.invoke_cohort_membership_tick(true);` and retry).
//
// Synthetic unknown_user_* ids are owner-only by design (they would show as a
// difference): pick a test funnel without them (README "Funnel-scoped access").
//
// Usage (PowerShell: node.exe; get each JWT from a signed-in browser session):
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
//   OWNER_JWT=... MEMBER_JWT=... MEMBER_PATHS=soulmate-sketch,palm-reading \
//   node scripts/scope-parity-check.mjs [--date-from 2026-09-01] [--date-to 2026-09-30] [--tolerance 0.01]

import { pathToFileURL } from "node:url";

export const DEFAULT_TOLERANCE = 0.01;
const PATH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FB_METRICS = ["spend", "impressions", "clicks", "outbound_clicks", "fb_purchases", "purchase_value", "reach", "link_clicks"];
const FB_BLENDED = ["trial_users", "first_subscription_users", "refund_users", "tx_gross_revenue", "tx_net_revenue"];
const REVENUE_TOTALS = ["gross", "refunds", "net", "gross_new", "gross_existing", "net_new", "net_existing"];
const REVENUE_BUCKET = ["gross", "refunds", "net", "gross_new", "gross_existing", "net_new", "net_existing", "paying_users", "new_paying_users"];
const REVENUE_SLICE = ["gross", "net", "gross_new", "gross_existing"];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Numeric fields of a cohort row / totals that a restricted read must reproduce. */
function cohortNumericFields(row) {
  return Object.keys(row ?? {}).filter((key) => isNumber(row[key]) && !key.startsWith("fb_") && key !== "coverage_rate");
}

function diff(surface, key, field, owner, member) {
  return { surface, key, field, owner, member, delta: Math.abs(Number(owner ?? 0) - Number(member ?? 0)) };
}

function compareFields(surface, key, owner, member, fields, tolerance, out) {
  for (const field of fields) {
    const a = Number(owner?.[field] ?? 0);
    const b = Number(member?.[field] ?? 0);
    if (Math.abs(a - b) > tolerance) out.push(diff(surface, key, field, a, b));
  }
}

function keyed(rows, keyOf) {
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [keyOf(row), row]));
}

/** 1. Same cohort keys both ways; every non-FB numeric field equal. */
export function compareCohortLists(owner, member, tolerance = DEFAULT_TOLERANCE) {
  const out = [];
  const keyOf = (row) => `${row.cohort_date}|${row.funnel}|${row.campaign_path}`;
  const ownerRows = keyed(owner?.rows, keyOf);
  const memberRows = keyed(member?.rows, keyOf);
  for (const [key, row] of ownerRows) {
    if (!memberRows.has(key)) out.push({ surface: "cohorts", key, field: "row", owner: "present", member: "missing", delta: Infinity });
    else compareFields("cohorts", key, row, memberRows.get(key), cohortNumericFields(row), tolerance, out);
  }
  for (const key of memberRows.keys()) {
    if (!ownerRows.has(key)) out.push({ surface: "cohorts", key, field: "row", owner: "missing", member: "present", delta: Infinity });
  }
  compareFields("cohorts", "totals", owner?.totals, member?.totals, cohortNumericFields(owner?.totals), tolerance, out);
  return { compared: ownerRows.size, diffs: out };
}

/** 2. Attributed revenue only: the unattributed / spend streams are never served to a member. */
export function compareRevenue(owner, member, tolerance = DEFAULT_TOLERANCE) {
  const out = [];
  compareFields("revenue", "totals", owner?.totals, member?.totals, REVENUE_TOTALS, tolerance, out);
  for (const type of ["trial", "first_subscription", "renewals", "upsells", "tokens"]) {
    const a = Number(owner?.totals?.by_type?.[type] ?? 0);
    const b = Number(member?.totals?.by_type?.[type] ?? 0);
    if (Math.abs(a - b) > tolerance) out.push(diff("revenue", "totals.by_type", type, a, b));
  }
  let compared = 1;
  for (const [block, keyOf, fields, skip] of [
    ["buckets", (row) => row.date, REVENUE_BUCKET, () => false],
    ["by_funnel", (row) => row.key, REVENUE_SLICE, () => false],
    ["by_plan", (row) => row.key, REVENUE_SLICE, () => false],
    ["by_age", (row) => row.bucket, ["gross", "net"], (key) => key === "unattributed"],
  ]) {
    const ownerRows = keyed(owner?.[block], keyOf);
    const memberRows = keyed(member?.[block], keyOf);
    for (const key of new Set([...ownerRows.keys(), ...memberRows.keys()])) {
      if (skip(key)) continue;
      compared += 1;
      compareFields("revenue", `${block}:${key}`, ownerRows.get(key), memberRows.get(key), fields, tolerance, out);
    }
  }
  if (member?.diagnostics?.filters_active !== true) out.push({ surface: "revenue", key: "diagnostics", field: "filters_active", owner: true, member: member?.diagnostics?.filters_active, delta: Infinity });
  return { compared, diffs: out };
}

function optionValue(item) {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const value = Object.entries(item).find(([key, entry]) => typeof entry === "string" && !/name|label/.test(key));
    return value ? value[1] : JSON.stringify(item);
  }
  return String(item);
}

/** 3. Every member option exists for the owner; member campaign paths ⊆ MEMBER_PATHS. */
export function compareOptions(owner, member, memberPaths) {
  const out = [];
  let compared = 0;
  const ownerOptions = owner?.filter_options ?? {};
  for (const [dimension, list] of Object.entries(member?.filter_options ?? {})) {
    if (!Array.isArray(list)) continue;
    const ownerValues = new Set((Array.isArray(ownerOptions[dimension]) ? ownerOptions[dimension] : []).map(optionValue));
    for (const value of list.map(optionValue)) {
      compared += 1;
      const outsideScope = dimension === "campaign_path" && !memberPaths.includes(value);
      if (outsideScope || !ownerValues.has(value)) {
        out.push({ surface: "options", key: dimension, field: value, owner: ownerValues.has(value) ? "present" : "missing", member: outsideScope ? "outside MEMBER_PATHS" : "present", delta: Infinity });
      }
    }
  }
  return { compared, diffs: out };
}

/** 4. FB report rows: member ⊆ owner, FB metrics equal, blended values ≤ owner's. */
export function compareFbReports(owner, member, tolerance = DEFAULT_TOLERANCE) {
  const out = [];
  const ownerRows = keyed(owner?.rows, (row) => row.key);
  const memberRows = keyed(member?.rows, (row) => row.key);
  for (const [key, row] of memberRows) {
    const ownerRow = ownerRows.get(key);
    if (!ownerRow) {
      out.push({ surface: "fb", key, field: "row", owner: "missing", member: "present", delta: Infinity });
      continue;
    }
    compareFields("fb", key, ownerRow, row, FB_METRICS, tolerance, out);
    for (const field of FB_BLENDED) {
      const a = Number(ownerRow.blended?.[field] ?? 0);
      const b = Number(row.blended?.[field] ?? 0);
      if (b - a > tolerance) out.push(diff("fb", key, `blended.${field} (member > owner)`, a, b));
    }
  }
  return { compared: memberRows.size, diffs: out };
}

// ---- transport ---------------------------------------------------------------------------

export class EdgeCallError extends Error {
  constructor(fn, who, status, body) {
    super(`${fn} as ${who}: HTTP ${status}${body?.error_code ? ` ${body.error_code}` : ""}${body?.error ? ` — ${body.error}` : ""}`);
    this.name = "EdgeCallError";
    this.status = status;
    this.body = body;
  }
}

async function callEdge(env, fn, who, jwt, body) {
  const response = await fetch(`${env.url}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, apikey: env.anonKey },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!response.ok || json?.ok === false) throw new EdgeCallError(fn, who, response.status, json);
  return json;
}

// ---- CLI -----------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--date-from") args.dateFrom = argv[++index];
    else if (flag === "--date-to") args.dateTo = argv[++index];
    else if (flag === "--tolerance") args.tolerance = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

function usage() {
  return [
    "Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... OWNER_JWT=... MEMBER_JWT=... MEMBER_PATHS=a-path,b-path \\",
    "       node scripts/scope-parity-check.mjs [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--tolerance 0.01]",
    "Read-only. Compares the member's cohorts list, revenue bundle, cohort options and FB campaign report",
    "with the owner's reads filtered to MEMBER_PATHS. Exit 0 = parity, 1 = a difference > tolerance, 2 = error.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), environment = process.env, log = console.log) {
  const args = parseArgs(argv);
  if (args.help) {
    log(usage());
    return 0;
  }
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "OWNER_JWT", "MEMBER_JWT", "MEMBER_PATHS"].filter((name) => !environment[name]);
  if (missing.length) {
    log(`Missing environment: ${missing.join(", ")}\n${usage()}`);
    return 2;
  }
  const memberPaths = String(environment.MEMBER_PATHS).split(",").map((path) => path.trim()).filter(Boolean);
  const invalid = memberPaths.filter((path) => !PATH_RE.test(path) || path === "unknown");
  if (!memberPaths.length || invalid.length) {
    log(`MEMBER_PATHS must list canonical campaign paths (a-z, 0-9, single dashes): ${invalid.join(", ") || "(empty)"}`);
    return 2;
  }
  const tolerance = Number.isFinite(args.tolerance) && args.tolerance >= 0 ? args.tolerance : DEFAULT_TOLERANCE;
  const today = new Date();
  const dateTo = args.dateTo ?? isoDay(today);
  const dateFrom = args.dateFrom ?? isoDay(new Date(today.getTime() - 29 * 86_400_000));
  const env = { url: String(environment.SUPABASE_URL).replace(/\/+$/, ""), anonKey: environment.SUPABASE_ANON_KEY };
  const owner = (fn, body) => callEdge(env, fn, "owner", environment.OWNER_JWT, body);
  const member = (fn, body) => callEdge(env, fn, "member", environment.MEMBER_JWT, body);
  const window = { date_from: dateFrom, date_to: dateTo };
  const scoped = { campaign_path: memberPaths };

  log(`Scope parity ${dateFrom}..${dateTo}, member paths: ${memberPaths.join(", ")}, tolerance ${tolerance}`);
  const results = [];
  try {
    const [ownerList, memberList] = await Promise.all([
      owner("clickhouse-cohorts", { action: "list", ...window, filters: scoped }),
      member("clickhouse-cohorts", { action: "list", ...window }),
    ]);
    if (memberList?.meta?.access?.scope !== "restricted") {
      log("MEMBER_JWT is not a funnel-restricted member (no meta.access on its cohorts list): nothing to compare.");
      return 2;
    }
    results.push(["cohorts list", compareCohortLists(ownerList, memberList, tolerance)]);
    const [ownerRevenue, memberRevenue] = await Promise.all([
      owner("clickhouse-revenue", { action: "bundle", ...window, filters: scoped }),
      member("clickhouse-revenue", { action: "bundle", ...window }),
    ]);
    results.push(["revenue bundle", compareRevenue(ownerRevenue, memberRevenue, tolerance)]);
    const [ownerOptions, memberOptions] = await Promise.all([
      owner("clickhouse-cohorts", { action: "options", ...window, filters: scoped }),
      member("clickhouse-cohorts", { action: "options", ...window }),
    ]);
    results.push(["cohort options", compareOptions(ownerOptions, memberOptions, memberPaths)]);
    const fbRequest = { action: "report", level: "campaign", filters: window };
    const [ownerFb, memberFb] = await Promise.all([owner("clickhouse-facebook", fbRequest), member("clickhouse-facebook", fbRequest)]);
    results.push(["FB campaign report", compareFbReports(ownerFb, memberFb, tolerance)]);
  } catch (error) {
    if (error instanceof EdgeCallError && error.status === 409) {
      log(`${error.message}\nThe member's funnel-scoped snapshot is not ready: run \`select public.invoke_cohort_membership_tick(true);\` and retry.`);
    } else {
      log(error instanceof Error ? error.message : String(error));
    }
    return 2;
  }

  let failed = 0;
  for (const [surface, { compared, diffs }] of results) {
    log(`${diffs.length ? "DIFF" : "OK  "}  ${surface}: ${compared} compared, ${diffs.length} difference(s)`);
    for (const entry of diffs.slice(0, 50)) {
      log(`      ${entry.key} · ${entry.field}: owner=${entry.owner} member=${entry.member}${Number.isFinite(entry.delta) ? ` (Δ ${Math.round(entry.delta * 100) / 100})` : ""}`);
    }
    if (diffs.length > 50) log(`      … ${diffs.length - 50} more`);
    failed += diffs.length;
  }
  log(failed ? `FAILED: ${failed} difference(s) above ${tolerance}.` : "PARITY: the member's reads equal the owner's reads filtered to its funnels.");
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
