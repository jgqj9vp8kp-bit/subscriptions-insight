// Payment System Health P2.5: the recommendation library of the alert engine
// (plan section Q "Рекомендация = факт → вероятное объяснение → непроверенная
// гипотеза → действие").
//
// Every alert carries an explanation built here, never free text from the
// engine: a FACT (the numbers, filled from a template), the LIKELY explanation
// (what usually causes this pattern), an UNVERIFIED hypothesis (labelled as
// such: what to check before believing it) and a list of COMPLIANT actions.
// The actions are only the lawful ones of plan Q: clear subscription terms and
// prices, a recognisable descriptor with one static prefix, reminders before
// trial conversions and renewals, simple cancellation, quick refunds on
// request (refund before dispute), honouring the network re-attempt rules
// (stop after Visa category 1 / Mastercard MAC 03 and 21, cap re-attempts),
// 3DS where the issuer requires it, traffic-quality review.
//
// THE BAN (plan Q "Никогда"). No text here may suggest hiding the merchant,
// changing what a payment is for, splitting transactions, creating artificial
// payments, evading monitoring, lowering authentication, or moving / splitting
// / balancing volume between MIDs, descriptors or PSPs to keep each below a
// network threshold. It is enforced in code, not by review:
//   * FORBIDDEN_RECOMMENDATION_PATTERNS names the phrasings (rerouting,
//     splitting, spreading, distributing, load balancing, moving traffic, "another
//     MID / descriptor / PSP", cascades and fallbacks, "below the threshold",
//     evading, hiding, descriptor rotation, artificial or micro payments,
//     disabling / skipping / exempting authentication, ...);
//   * every template is checked when this module loads (a violating template
//     throws, so the Edge function would not boot and the tests fail), and
//     buildAlertExplanation re-checks the texts it returns;
//   * paymentRiskAlerts.test.ts walks every rule and variant, and runs the
//     patterns against known-bad phrasings so the ban itself cannot rot.
// Declines are never called fraud: the fraud-suspicion texts say "the issuers'
// suspicion codes, not confirmed fraud".
//
// Pure module: no Deno globals, no I/O.

import type { AlertExplanation, AlertRuleKey } from "./paymentRiskAlertsContract.ts";

// ---------------------------------------------------------------------------
// The ban
// ---------------------------------------------------------------------------

const ACCOUNT_NOUNS = "(?:mids?|merchant accounts?|merchant ids?|descriptors?|psps?|processors?|acquirers?|gateways?|accounts?)";

export const FORBIDDEN_RECOMMENDATION_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "reroute", pattern: /\bre-?rout(?:e|es|ed|ing)\b/i },
  { id: "route_volume", pattern: /\brout(?:e|es|ed|ing)\s+(?:\w+\s+){0,3}(?:traffic|volume|payments?|transactions?|charges?|cards?)\b/i },
  { id: "routing_rules", pattern: /\b(?:smart|dynamic|conditional)\s+routing\b|\brouting\s+(?:rules?|logic|strateg\w*)\b/i },
  { id: "split", pattern: /\bsplit(?:s|ting)?\b/i },
  { id: "spread", pattern: /\bspread(?:s|ing)?\b/i },
  { id: "distribute", pattern: /\b(?:re)?distribut\w*\b/i },
  { id: "load_balance", pattern: /\bload[- ]?balanc\w*\b/i },
  { id: "balance_volume", pattern: /\b(?:re)?balanc\w*\s+(?:\w+\s+){0,2}(?:volume|traffic|load|transactions|payments)\b/i },
  {
    id: "move_volume",
    pattern: /\b(?:move|moving|shift|shifting|transfer|transferring|divert|diverting|migrate|migrating|channel|channelling|steer|steering|send|sending|push|pushing|allocat\w*)\s+(?:\w+\s+){0,3}(?:volume|traffic|transactions|payments|charges)\b/i,
  },
  { id: "other_account", pattern: new RegExp(`\\b(?:another|other|different|new|second|additional|backup|alternative|alternate|separate|fresh|extra|spare)\\s+${ACCOUNT_NOUNS}\\b`, "i") },
  { id: "multiple_accounts", pattern: new RegExp(`\\b(?:multiple|several|many|two|three|more)\\s+${ACCOUNT_NOUNS}\\b`, "i") },
  { id: "across_accounts", pattern: new RegExp(`\\b(?:across|between|among|amongst)\\s+(?:\\w+\\s+){0,2}${ACCOUNT_NOUNS}\\b`, "i") },
  { id: "switch_account", pattern: new RegExp(`\\b(?:switch\\w*|chang\\w*|swap\\w*)\\s+(?:to\\s+)?(?:\\w+\\s+){0,2}${ACCOUNT_NOUNS}\\b`, "i") },
  { id: "cascade", pattern: /\bcascad\w*\b/i },
  { id: "fallback", pattern: /\bfall[- ]?back\b/i },
  { id: "below_threshold", pattern: /\b(?:below|under|beneath|short of)\s+(?:the\s+)?(?:\w+\s+){0,2}(?:thresholds?|limits?|radar|ratios?|levels?)\b/i },
  { id: "evade", pattern: /\b(?:evad\w*|evasion|circumvent\w*|bypass\w*|get around|work around|workaround|dodg\w*|gam(?:e|ing) the)\b/i },
  { id: "avoid_monitoring", pattern: /\bavoid\w*\s+(?:\w+\s+){0,3}(?:monitoring|programs?|thresholds?|detection|flags?|vamp|ecp|ecm|hecm|efm|fines?)\b/i },
  { id: "hide", pattern: /\b(?:hide|hiding|hidden|conceal\w*|disguis\w*|obscur\w*|masking|mask the)\b/i },
  { id: "descriptor_rotation", pattern: /\b(?:rotat\w*|vary|varying|alternat\w*|chang\w*|renam\w*)\s+(?:\w+\s+){0,2}descriptors?\b/i },
  { id: "artificial", pattern: /\b(?:artificial|dummy|fake|fabricat\w*|padding|inflat\w*)\b/i },
  { id: "dilute", pattern: /\bdilut\w*\b/i },
  { id: "micro_payments", pattern: /\bmicro[- ]?(?:transactions?|payments?|charges?|authori[sz]ations?)\b|\bsmall[- ]value\s+(?:transactions?|payments?|charges?)\b/i },
  { id: "change_mcc", pattern: /\b(?:chang\w*|switch\w*|alter\w*|recod\w*)\s+(?:\w+\s+){0,2}(?:mcc|merchant category)\b/i },
  {
    id: "lower_authentication",
    pattern: /\b(?:disabl\w*|turn(?:s|ing)? off|switch(?:es|ing)? off|remov\w*|skip\w*|drop\w*|lower\w*|reduc\w*|weaken\w*|relax\w*|loosen\w*|exempt\w*|avoid\w*|without|fewer|less)\s+(?:\w+\s+){0,3}(?:3ds|3-d secure|3d secure|authentication|sca|strong customer authentication|cvv|cvc|avs|challenges?)\b/i,
  },
  { id: "exemption", pattern: /\bexemptions?\b/i },
  { id: "frictionless", pattern: /\bfrictionless\b/i },
  { id: "retry_after_ban", pattern: /\bretry\s+(?:\w+\s+){0,3}(?:after|despite|regardless of)\s+(?:\w+\s+){0,2}(?:do[- ]not[- ]retry|bans?|category 1|mac 0?3|mac 21|hard declines?)\b/i },
];

/** The ids of the forbidden patterns a text matches ([] = compliant). */
export function forbiddenRecommendationHits(text: string): string[] {
  return FORBIDDEN_RECOMMENDATION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}

export class NonCompliantRecommendationError extends Error {
  constructor(where: string, hits: string[]) {
    super(`Recommendation text breaks the plan Q ban (${hits.join(", ")}): ${where}`);
    this.name = "NonCompliantRecommendationError";
  }
}

function assertCompliant(where: string, text: string): void {
  const hits = forbiddenRecommendationHits(text);
  if (hits.length) throw new NonCompliantRecommendationError(where, hits);
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/** Values a fact template may name: numbers and registry / funnel labels only. */
export type RecommendationFacts = Record<string, string | number | null | undefined>;

/** One explanation variant (a rule can have several, e.g. CIT / MIT). */
export interface RecommendationTemplate {
  /** `{name}` placeholders, filled from RecommendationFacts. */
  fact: string;
  likely_explanation: string;
  hypothesis: string;
  action: readonly string[];
}

export interface RuleRecommendations {
  /** The variant used when the engine asks for none or for one that does not exist. */
  default: RecommendationTemplate;
  variants?: Readonly<Record<string, RecommendationTemplate>>;
}

const UNVERIFIED_RULES =
  "Unverified: the network re-attempt rules were read from secondary sources; confirm the exact rules and fees with the acquirer before treating these as violations.";

const ACTION_DECLINES_TAB = "Open the Declines tab for this account and window and compare the decline classes and issuer codes with the previous window.";
const ACTION_RETRY_LATER = "If issuer soft declines grew (insufficient funds), retry them later in the billing cycle, within the network re-attempt limits.";
const ACTION_3DS = "Apply 3DS where the issuer requires it (Primer AUTHENTICATION_REQUIRED, soft decline 1A), so genuine customers can authenticate.";
const ACTION_TRAFFIC = "Review traffic quality for the affected funnels and sources (attempt velocity per card and per user, country and card mix) before scaling them.";
const ACTION_DESCRIPTOR = "Make the billing descriptor clear and recognisable: one static prefix with the brand name and a support contact, shown at checkout too.";
const ACTION_TERMS = "Show the subscription terms and the price clearly before payment, and send a reminder before every trial conversion and renewal.";
const ACTION_CANCEL = "Keep cancellation simple: a visible cancel link in every billing e-mail and in the account.";
const ACTION_REFUND = "Refund quickly on request, before the customer goes to the bank: a refund prevents a dispute.";
const ACTION_HONOUR_BANS = "Stop every re-attempt on a card after a do-not-retry decline: honour Visa category 1, Mastercard MAC 03 / 21 and the DO_NOT_RETRY / STOP_ALL_PAYMENTS advice.";
const ACTION_PROCESSOR_IRRELEVANT = "A processor change does not lift a ban: the re-attempt still counts on the card whichever processor carries it.";

export const RECOMMENDATIONS: Readonly<Record<AlertRuleKey, RuleRecommendations>> = {
  approval_drop: {
    default: {
      fact:
        "Approval of {initiation} attempts on {account} fell from {baseline} to {current} ({change} pp) in {window} against {baseline_window}: {attempts} attempts. {significance}",
      likely_explanation:
        "An approval drop on one account usually follows a change in the decline mix: more issuer soft declines (insufficient funds, do not honour) in a renewal wave, an issuer or card-network incident, or a change in the traffic and card mix behind the account.",
      hypothesis:
        "Unverified: the drop may follow an update of the PSP's risk rules or of the merchant category on its side, or new traffic sources in the affected funnels; check the decline classes before acting.",
      action: [ACTION_DECLINES_TAB, ACTION_RETRY_LATER, ACTION_3DS, "If PSP / integration errors grew, check the integration and the PSP status page and ask the PSP to confirm the error codes.", ACTION_TRAFFIC],
    },
    variants: {
      // The PSP-wide line (every merchant account of one PSP together): raised where no single account is conclusive.
      processor: {
        fact:
          "Approval of {initiation} attempts on {account} fell from {baseline} to {current} ({change} pp) in {window} against {baseline_window}: {attempts} attempts. {significance}",
        likely_explanation:
          "A drop on every merchant account of one PSP at once usually points to the PSP or the issuers: a PSP incident or risk-rule update, an issuer or card-network incident, or a renewal wave with more issuer soft declines (insufficient funds, do not honour).",
        hypothesis:
          "Unverified: one large merchant account may carry most of the drop; open the merchant-account breakdown of the same window before treating it as PSP-wide.",
        action: [
          "Open the Declines tab for this window by merchant account and compare the decline classes and issuer codes with the previous window.",
          ACTION_RETRY_LATER,
          ACTION_3DS,
          "Check the PSP status page for the window and ask the PSP to confirm whether its risk rules or error codes were updated.",
          ACTION_TRAFFIC,
        ],
      },
    },
  },
  issuer_fraud_rise: {
    default: {
      fact:
        "Issuer fraud-suspicion declines (issuer codes 59 / 63 / 83, or Primer SUSPECTED_FRAUD without an issuer code) on {account} rose from {baseline} to {current} of attempts ({change} pp) in {window}: {count} declines. These are the issuers' suspicion codes, not confirmed fraud. {significance}",
      likely_explanation:
        "Issuers raise suspicion codes when a merchant's traffic carries more card testing, stolen-card use or charges the cardholder does not recognise; a new traffic source or a burst of attempts on few cards raises the rate.",
      hypothesis:
        "Unverified: the rise may be concentrated in one funnel, country or card range, or follow customers not recognising the billing descriptor; check the funnel and country breakdowns first.",
      action: [
        ACTION_TRAFFIC,
        "Treat fraud-suspicion declines as final: do not re-attempt those cards.",
        ACTION_3DS,
        ACTION_DESCRIPTOR,
        "Watch support for unauthorized-charge complaints on the same account and refund promptly on request.",
      ],
    },
  },
  psp_integration_rise: {
    default: {
      fact: "PSP / integration declines (AUTHORIZATION_FAILED without an issuer code) on {account} rose from {baseline} to {current} of attempts ({change} pp) in {window}: {count} declines. {significance}",
      likely_explanation:
        "These declines happen before an issuer sees the payment: request validation errors, PSP incidents or time-outs, or data missing from the request.",
      hypothesis:
        "Unverified: a recent release of the checkout or a change of the Primer workflow may send incomplete requests; ask the PSP for the error detail of a few affected payments.",
      action: [
        "Check the PSP status page and the integration logs for the window; ask the PSP or Primer to confirm the error codes behind these declines.",
        "Compare the window with recent releases of the checkout and of the Primer workflow, and fix requests with missing or invalid fields.",
        "Do not resubmit the same request unchanged while the error persists: fix the request first.",
      ],
    },
    variants: {
      tenant: {
        fact:
          "Declines that never reached an issuer, PSP / integration errors plus attempts declined before routing (cause not verified), rose from {baseline} to {current} of all attempts ({change} pp) in {window}: {count} declines. {significance}",
        likely_explanation:
          "Declines before the issuer come from request errors, PSP incidents or Primer declining an attempt before it reaches a processor (the export does not say why).",
        hypothesis:
          "Unverified: the unrouted part may be Primer rules or a workflow condition that blocks the attempt; the Primer dashboard shows the reason per payment.",
        action: [
          "Check the Primer workflow and the PSP status pages for the window; ask Primer for the decline reason of a few unrouted attempts.",
          "Compare the window with recent releases of the checkout and of the Primer workflow, and fix requests with missing or invalid fields.",
          "Do not resubmit the same request unchanged while the error persists: fix the request first.",
        ],
      },
    },
  },
  post_ban_retries: {
    default: {
      fact:
        "{count} {initiation} re-attempts were made in {window} on cards that had received a do-not-retry decline (DO_NOT_RETRY / STOP_ALL_PAYMENTS advice, Visa category 1 or Mastercard MAC 03 / 21); {succeeded} of them settled and {after_processor_change} came after a processor change.",
      likely_explanation: "Re-attempts after a do-not-retry decline come from a retry flow that does not read the decline's advice.",
      hypothesis: UNVERIFIED_RULES,
      action: [ACTION_HONOUR_BANS, ACTION_PROCESSOR_IRRELEVANT],
    },
    variants: {
      mit: {
        fact:
          "{count} MIT (merchant-initiated) re-attempts were made in {window} on cards that had received a do-not-retry decline (DO_NOT_RETRY / STOP_ALL_PAYMENTS advice, Visa category 1 or Mastercard MAC 03 / 21); {succeeded} of them settled and {after_processor_change} came after a processor change.",
        likely_explanation:
          "MIT re-attempts after a ban come from the dunning schedule (FunnelFox / Primer retries) continuing after a decline whose advice says to stop.",
        hypothesis: `${UNVERIFIED_RULES} Some of these may be renewals of a new billing period on the same card, which the rules treat the same way.`,
        action: [
          ACTION_HONOUR_BANS,
          "Make the dunning schedule read the advised action and the advice code, and end the retry sequence on a ban; ask the customer to update the card instead.",
          ACTION_PROCESSOR_IRRELEVANT,
        ],
      },
      cit: {
        fact:
          "{count} CIT (customer-initiated) re-attempts were made in {window} on cards that had received a do-not-retry decline (DO_NOT_RETRY / STOP_ALL_PAYMENTS advice, Visa category 1 or Mastercard MAC 03 / 21); {succeeded} of them settled and {after_processor_change} came after a processor change.",
        likely_explanation: "CIT re-attempts after a ban come from the checkout letting the customer resubmit the same card after a hard decline.",
        hypothesis: `${UNVERIFIED_RULES} A burst of resubmissions on one card can also be card testing.`,
        action: [
          ACTION_HONOUR_BANS,
          "After a hard decline at checkout, ask the customer for another payment method instead of resubmitting the same card.",
          ACTION_PROCESSOR_IRRELEVANT,
          ACTION_TRAFFIC,
        ],
      },
    },
  },
  excessive_reattempts: {
    default: {
      fact: "{count} card x merchant-account pairs had more than {limit} declines in a rolling {rolling_days}-day window ending in {window} (largest: {max_declines} declines).",
      likely_explanation: "The retry schedule keeps re-attempting cards that keep declining (insufficient funds), or customers resubmit the same card many times at checkout.",
      hypothesis: `${UNVERIFIED_RULES} Some of these declines may be distinct purchases rather than re-attempts of one payment.`,
      action: [
        "Cap re-attempts per card: at most 15 in 30 days over the whole dunning schedule, spaced out (retry insufficient funds later in the cycle, not daily).",
        "Stop retrying a card once it reaches the cap and ask the customer to update the payment method.",
        "Limit repeated checkout submissions of the same card in a short time (a velocity limit) and review the traffic quality where it happens.",
      ],
    },
  },
  unauthorized_complaints_rise: {
    default: {
      fact:
        "Support requests flagged as a possible unauthorized charge and attributed to {account} (the customer's last settled payment within 30 days) rose from {baseline} to {current} of its settled payments ({change} pp) in {window}: {count} requests. A complaint is an early signal, not a dispute. {significance}",
      likely_explanation: "Customers do not recognise the charge: an unclear descriptor, a trial that converts without a clear reminder, or a renewal they forgot.",
      hypothesis:
        "Unverified: the rise may come from one funnel or plan (a trial or upsell flow), or from a change of the support classifier (classification_version) rather than from customers.",
      action: [ACTION_DESCRIPTOR, ACTION_TERMS, ACTION_CANCEL, ACTION_REFUND],
    },
  },
  refund_rate_rise: {
    default: {
      fact:
        "The refund rate of payments made on {account} in {window} rose from {baseline} to {current} ({change} pp): {count} refunds of {settled} settled payments, by original payment date, read {maturity_days} days after the window. {significance}",
      likely_explanation: "More customers ask for their money back: an offer that did not meet expectations, trial conversions they did not expect, or duplicate charges.",
      hypothesis: "Unverified: the rise may be concentrated in one funnel or plan, or reflect a change in the refund policy or in how support handles requests.",
      action: [
        "Review the offers and funnels with the highest refund rates: the price and terms shown before payment and what the customer receives.",
        ACTION_TERMS,
        ACTION_CANCEL,
        "Keep refunding quickly on request: a refund prevents a dispute and is not a problem in itself.",
      ],
    },
  },
  data_stale: {
    default: {
      fact: "The newest payment in the warehouse is from {data_through}, {lag_days} days ago. Alerts and the page describe the payments up to that day only.",
      likely_explanation: "The Primer CSV export has not been imported (the import is manual), or the warehouse sync did not run after the last import.",
      hypothesis: "Unverified: a failed import or sync may also have left part of a day missing.",
      action: ["Import the latest Primer export on the Import page and let the warehouse sync run.", "Check the Data sources tab for the last import and sync times afterwards."],
    },
    variants: {
      warehouse_sync: {
        fact: "The last ClickHouse sync of payment rows was {sync_hours} hours ago ({last_synced_at}). Imports after it are not in the analytics yet.",
        likely_explanation: "No import ran since, or the warehouse sync after an import failed.",
        hypothesis: "Unverified: the sync may have stopped on an error; its state is on the Data sources tab.",
        action: ["Check the Data sources tab for the sync state, and run the warehouse sync after the next import."],
      },
      support_sync: {
        fact:
          "The last ClickHouse sync of support requests was {sync_hours} hours ago ({last_synced_at}). Complaint figures after it are missing, not zero, so the unauthorized-charge complaint alerts stay low confidence.",
        likely_explanation: "The support mail import, its classification or the support sync to ClickHouse has not run since, or failed.",
        hypothesis: "Unverified: the mailbox connection or the classification run may have stopped; the Data sources tab shows the support requests by month.",
        action: ["Check the support import and its sync state, and run the support sync once the new requests are imported.", "Until it catches up, read complaint rates as incomplete."],
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Validation at load + the builder
// ---------------------------------------------------------------------------

function templatesOf(rule: RuleRecommendations): Array<[string, RecommendationTemplate]> {
  return [["default", rule.default], ...Object.entries(rule.variants ?? {})];
}

/** Every template string of the library, with where it lives (the load-time check and the tests walk it). */
export function recommendationTexts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const [ruleKey, rule] of Object.entries(RECOMMENDATIONS)) {
    for (const [variant, template] of templatesOf(rule)) {
      const base = `${ruleKey}.${variant}`;
      out.push({ where: `${base}.fact`, text: template.fact }, { where: `${base}.likely_explanation`, text: template.likely_explanation }, { where: `${base}.hypothesis`, text: template.hypothesis });
      template.action.forEach((text, index) => out.push({ where: `${base}.action[${index}]`, text }));
      if (!template.hypothesis.startsWith("Unverified")) throw new Error(`${base}.hypothesis must be labelled "Unverified"`);
      if (!template.action.length) throw new Error(`${base} has no action`);
    }
  }
  return out;
}

// Fail closed at load: a template that breaks the ban stops the module (and the Edge function) from loading.
for (const { where, text } of recommendationTexts()) assertCompliant(where, text);

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(template: string, facts: RecommendationFacts): string {
  return template
    .replace(PLACEHOLDER, (_match, name: string) => {
      const value = facts[name];
      return value == null || value === "" ? "n/a" : String(value);
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The explanation of one alert. Only the fact is filled (numbers and labels);
 * the explanation, hypothesis and actions are the library's text verbatim and
 * are re-checked against the ban on the way out.
 */
export function buildAlertExplanation(ruleKey: AlertRuleKey, facts: RecommendationFacts, variant?: string | null): AlertExplanation {
  const rule = RECOMMENDATIONS[ruleKey];
  const template = (variant && rule.variants?.[variant]) || rule.default;
  const explanation: AlertExplanation = {
    fact: fill(template.fact, facts),
    likely_explanation: template.likely_explanation,
    hypothesis: template.hypothesis,
    action: [...template.action],
  };
  assertCompliant(`${ruleKey}.likely_explanation`, explanation.likely_explanation);
  assertCompliant(`${ruleKey}.hypothesis`, explanation.hypothesis);
  explanation.action.forEach((text, index) => assertCompliant(`${ruleKey}.action[${index}]`, text));
  return explanation;
}
