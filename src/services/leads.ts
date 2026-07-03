import type { DeclineReason, Funnel, MediaBuyer, Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";
import { countryCodeForUserTransactions, normalizeCountryCode } from "@/services/userCountry";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import { declineDetailsForTransaction, isFailedPaymentTransaction } from "@/services/paymentFailures";

/**
 * Leads = FunnelFox contacts who left an email but never completed a successful payment.
 *
 * Per the Phase 1 research, FunnelFox exposes no customer/profile *list* endpoint, so the lead
 * population is derived entirely from data already cached in the app store — the transaction
 * warehouse plus synced FunnelFox subscriptions. This module is pure (no I/O), so the Leads page can
 * memoize it and never re-pull FunnelFox on render.
 *
 * A lead is an email/customer where:
 *   - a valid email exists, AND
 *   - no successful payment exists (no warehouse transaction with status "success", any type), AND
 *   - no active subscription exists (no FunnelFox subscription with is_active_now).
 *
 * This module intentionally does not import or alter Users / Cohorts / Dashboard / Forecasting /
 * Export logic; it only re-uses the shared, read-only attribution helpers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LeadRecord {
  customer_id: string;
  email: string;
  funnel: Funnel;
  campaign_path: string;
  campaign_id: string;
  utm_source: string | null;
  media_buyer: MediaBuyer;
  country: string | null;
  /** First captured contact (earliest event for the customer). */
  session_date: string;
  user_agent: string | null;
  days_since_visit: number | null;
  has_declines: boolean;
  decline_reason: DeclineReason | null;
  // Phase 5 — cohort attribution. Null by construction for true leads (a converted email is excluded
  // from the lead set), but computed generically so the columns populate if the data ever contains a
  // successful trial / first subscription for a lead email.
  lead_created: string;
  trial_date: string | null;
  first_subscription_date: string | null;
  days_to_trial: number | null;
  days_to_first_sub: number | null;
  source: "warehouse" | "funnelfox_subscription";
}

export interface LeadSummary {
  total_leads: number;
  leads_today: number;
  leads_last_7_days: number;
  /** Converted-to-trial share of the whole contact base (distinct emails that ever left contact). */
  lead_to_trial_cr: number;
  lead_to_first_sub_cr: number;
}

export type LeadSortKey = "newest" | "oldest" | "email" | "country";

export interface LeadFilters {
  dateFrom: string;
  dateTo: string;
  funnel: string;
  campaignPath: string;
  campaignId: string;
  mediaBuyer: string;
  country: string;
  hasDeclines: "all" | "has" | "none";
}

export const DEFAULT_LEAD_FILTERS: LeadFilters = {
  dateFrom: "",
  dateTo: "",
  funnel: "all",
  campaignPath: "all",
  campaignId: "all",
  mediaBuyer: "all",
  country: "all",
  hasDeclines: "all",
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

function dateKey(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function msOf(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function daysBetween(fromIso: string, toMs: number): number | null {
  const fromMs = msOf(fromIso);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.floor((toMs - fromMs) / DAY_MS);
}

function readUserAgent(tx: Transaction): string | null {
  const sources: Array<Record<string, unknown> | undefined> = [tx.metadata, tx.raw];
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["user_agent", "userAgent", "ua", "browser_user_agent"]) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function mapSubscriptionFunnel(...values: Array<string | null | undefined>): Funnel {
  const haystack = values.filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes("past") || haystack.includes("life")) return "past_life";
  if (haystack.includes("soul")) return "soulmate";
  if (haystack.includes("star")) return "starseed";
  return "unknown";
}

/**
 * Build the lead list from the cached warehouse transactions and synced FunnelFox subscriptions.
 * `now` is injectable for deterministic tests / "days since" math.
 */
export function computeLeads(
  transactions: Transaction[],
  subscriptions: SubscriptionClean[] = [],
  now: number = Date.now(),
): LeadRecord[] {
  // Emails that have ever paid (any successful transaction) — these are not leads.
  const paidEmails = new Set<string>();
  // Emails seen anywhere in the warehouse, so we know which subscription emails are warehouse-only.
  const warehouseEmails = new Set<string>();
  const byCustomer = new Map<string, Transaction[]>();

  for (const tx of transactions) {
    const email = normalizeEmail(tx.email);
    if (email) {
      warehouseEmails.add(email);
      if (tx.status === "success") paidEmails.add(email);
    }
    const key = tx.user_id || email || tx.transaction_id;
    if (!key) continue;
    const list = byCustomer.get(key);
    if (list) list.push(tx);
    else byCustomer.set(key, [tx]);
  }

  // Emails with a currently-active subscription — these are not leads.
  const activeSubEmails = new Set<string>();
  for (const sub of subscriptions) {
    const email = normalizeEmail(sub.email);
    if (email && sub.is_active_now) activeSubEmails.add(email);
  }

  const leads: LeadRecord[] = [];
  const leadEmails = new Set<string>();

  for (const [customerId, group] of byCustomer) {
    const email = normalizeEmail(group.find((tx) => tx.email)?.email);
    if (!email) continue;
    if (paidEmails.has(email) || activeSubEmails.has(email)) continue;

    const sorted = [...group].sort((a, b) => msOf(a.event_time) - msOf(b.event_time));
    const firstTouch = sorted[0];
    const sessionDate = firstTouch.event_time;

    const failed = sorted.filter(isFailedPaymentTransaction);
    const latestDecline = failed
      .map((tx) => declineDetailsForTransaction(tx))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .sort((a, b) => msOf(a.date) - msOf(b.date))
      .at(-1);

    const { utm_source, media_buyer } = mediaBuyerForUserTransactions(sorted);

    // By definition a lead has no successful trial / first subscription, so these resolve to null;
    // kept generic so the attribution columns are correct if the lead definition is ever relaxed.
    const trial = sorted.find((tx) => tx.transaction_type === "trial" && tx.status === "success");
    const firstSub = sorted.find((tx) => tx.transaction_type === "first_subscription" && tx.status === "success");

    leads.push({
      customer_id: customerId,
      email,
      funnel: firstTouch.funnel,
      campaign_path: firstTouch.campaign_path || "unknown",
      campaign_id: firstTouch.campaign_id || "",
      utm_source,
      media_buyer,
      country: countryCodeForUserTransactions(sorted),
      session_date: sessionDate,
      user_agent: sorted.map(readUserAgent).find(Boolean) ?? null,
      days_since_visit: daysBetween(sessionDate, now),
      has_declines: failed.length > 0,
      decline_reason: latestDecline?.reason ?? null,
      lead_created: sessionDate,
      trial_date: trial?.event_time ?? null,
      first_subscription_date: firstSub?.event_time ?? null,
      days_to_trial: trial ? daysBetween(sessionDate, msOf(trial.event_time)) : null,
      days_to_first_sub: firstSub ? daysBetween(sessionDate, msOf(firstSub.event_time)) : null,
      source: "warehouse",
    });
    leadEmails.add(email);
  }

  // Subscription-only leads: FunnelFox contacts that never reached the warehouse, have no active
  // subscription and never paid. Attribution is sparse (FunnelFox subscriptions carry only
  // funnel/session), so most fields fall back to unknown/null.
  for (const sub of subscriptions) {
    const email = normalizeEmail(sub.email);
    if (!email) continue;
    if (paidEmails.has(email) || activeSubEmails.has(email)) continue;
    if (warehouseEmails.has(email) || leadEmails.has(email)) continue;
    if (sub.price_usd > 0 && !sub.is_cancelled) continue; // looks like a paid, non-cancelled sub

    const sessionDate = sub.created_at || sub.period_starts_at || "";
    leads.push({
      customer_id: sub.profile_id || sub.subscription_id,
      email,
      funnel: mapSubscriptionFunnel(sub.funnel_alias, sub.funnel_title),
      campaign_path: "unknown",
      campaign_id: "",
      utm_source: null,
      media_buyer: "Unknown",
      country: null,
      session_date: sessionDate,
      user_agent: null,
      days_since_visit: sessionDate ? daysBetween(sessionDate, now) : null,
      has_declines: false,
      decline_reason: null,
      lead_created: sessionDate,
      trial_date: null,
      first_subscription_date: null,
      days_to_trial: null,
      days_to_first_sub: null,
      source: "funnelfox_subscription",
    });
    leadEmails.add(email);
  }

  return leads;
}

export function computeLeadSummary(
  leads: LeadRecord[],
  transactions: Transaction[],
  now: number = Date.now(),
): LeadSummary {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const sevenDaysAgoMs = now - 7 * DAY_MS;

  let leadsToday = 0;
  let leadsLast7 = 0;
  for (const lead of leads) {
    if (dateKey(lead.session_date) === todayKey) leadsToday += 1;
    const ms = msOf(lead.session_date);
    if (Number.isFinite(ms) && ms >= sevenDaysAgoMs && ms <= now) leadsLast7 += 1;
  }

  // Conversion is measured across the whole contact base (every distinct email that ever left
  // contact), since the lead set itself excludes anyone who converted.
  const contacts = new Set<string>();
  const trialEmails = new Set<string>();
  const firstSubEmails = new Set<string>();
  for (const tx of transactions) {
    const email = normalizeEmail(tx.email);
    if (!email) continue;
    contacts.add(email);
    if (tx.status === "success" && tx.transaction_type === "trial") trialEmails.add(email);
    if (tx.status === "success" && tx.transaction_type === "first_subscription") firstSubEmails.add(email);
  }
  const totalContacts = contacts.size;

  return {
    total_leads: leads.length,
    leads_today: leadsToday,
    leads_last_7_days: leadsLast7,
    lead_to_trial_cr: totalContacts ? trialEmails.size / totalContacts : 0,
    lead_to_first_sub_cr: totalContacts ? firstSubEmails.size / totalContacts : 0,
  };
}

export function filterLeads(leads: LeadRecord[], filters: LeadFilters): LeadRecord[] {
  return leads.filter((lead) => {
    const key = dateKey(lead.session_date);
    if (filters.dateFrom && (!key || key < filters.dateFrom)) return false;
    if (filters.dateTo && (!key || key > filters.dateTo)) return false;
    if (filters.funnel !== "all" && lead.funnel !== filters.funnel) return false;
    if (filters.campaignPath !== "all" && lead.campaign_path !== filters.campaignPath) return false;
    if (filters.campaignId !== "all" && lead.campaign_id !== filters.campaignId) return false;
    if (filters.mediaBuyer !== "all" && lead.media_buyer !== filters.mediaBuyer) return false;
    if (filters.country !== "all" && (lead.country ?? "") !== filters.country) return false;
    if (filters.hasDeclines === "has" && !lead.has_declines) return false;
    if (filters.hasDeclines === "none" && lead.has_declines) return false;
    return true;
  });
}

export function sortLeads(leads: LeadRecord[], key: LeadSortKey): LeadRecord[] {
  const sorted = [...leads];
  switch (key) {
    case "newest":
      return sorted.sort((a, b) => msOf(b.session_date) - msOf(a.session_date));
    case "oldest":
      return sorted.sort((a, b) => msOf(a.session_date) - msOf(b.session_date));
    case "email":
      return sorted.sort((a, b) => a.email.localeCompare(b.email));
    case "country":
      return sorted.sort((a, b) => (a.country ?? "").localeCompare(b.country ?? ""));
    default:
      return sorted;
  }
}

export function leadFilterOptions(leads: LeadRecord[]): {
  funnels: string[];
  campaignPaths: string[];
  campaignIds: string[];
  mediaBuyers: string[];
  countries: string[];
} {
  const funnels = new Set<string>();
  const campaignPaths = new Set<string>();
  const campaignIds = new Set<string>();
  const mediaBuyers = new Set<string>();
  const countries = new Set<string>();
  for (const lead of leads) {
    funnels.add(lead.funnel);
    if (lead.campaign_path) campaignPaths.add(lead.campaign_path);
    if (lead.campaign_id) campaignIds.add(lead.campaign_id);
    mediaBuyers.add(lead.media_buyer);
    if (lead.country) countries.add(lead.country);
  }
  return {
    funnels: [...funnels].sort(),
    campaignPaths: [...campaignPaths].sort(),
    campaignIds: [...campaignIds].sort(),
    mediaBuyers: [...mediaBuyers].sort(),
    countries: [...countries].sort(),
  };
}

export { normalizeCountryCode };
