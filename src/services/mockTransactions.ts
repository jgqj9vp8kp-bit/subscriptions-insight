import type { Transaction, Funnel, TrafficSource, TransactionType, TransactionStatus } from "./types";

// Deterministic PRNG so the dataset is stable across reloads.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260425);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

const FUNNELS: readonly Funnel[] = ["past_life", "soulmate", "starseed"];
const SOURCES: readonly TrafficSource[] = ["facebook", "tiktok", "google"];
const FIRST_NAMES = ["alex","jamie","casey","jordan","taylor","morgan","sam","riley","quinn","reese","drew","sky","nora","leo","mia","ivan","ella","theo","luna","kai","ruby","milo","zoe","owen","ada","finn","iris","noah","eva","jack","lily","max","ivy","ben","cleo","ezra","mae","oscar","nina","henry","amelie","felix","ari","june","silas","elise","reed","nico","tess","ronan"];

const TODAY = new Date("2026-04-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function isoAt(date: Date, offsetDays: number, hourJitter = true): string {
  const d = new Date(date.getTime() + offsetDays * DAY);
  if (hourJitter) {
    d.setUTCHours(Math.floor(rand() * 24), Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
  }
  return d.toISOString();
}

let txCounter = 1000;
function nextTxId(): string {
  txCounter += 1;
  return `tx_${txCounter}`;
}

function makeTx(
  user: { user_id: string; email: string; funnel: Funnel; source: TrafficSource; campaign: string },
  type: TransactionType,
  amount: number,
  status: TransactionStatus,
  eventTime: string,
  product: string,
  reason: string,
): Transaction {
  const refundAmount = status === "refunded" || status === "chargeback" ? Math.abs(amount) : 0;
  const grossAmount = amount > 0 ? amount : 0;
  return {
    transaction_id: nextTxId(),
    user_id: user.user_id,
    email: user.email,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: grossAmount,
    refund_amount_usd: refundAmount,
    net_amount_usd: grossAmount - refundAmount,
    is_refunded: refundAmount > 0,
    currency: "USD",
    status,
    transaction_type: type,
    funnel: user.funnel,
    campaign_path: user.campaign,
    product,
    traffic_source: user.source,
    campaign_id: user.campaign,
    classification_reason: reason,
  };
}

/**
 * Build 50 users spread across ~90 days with a mix of journeys.
 * Scenarios:
 *  A) trial $1 only
 *  B) trial $1 + upsell $14.98
 *  C) trial $1 + first subscription $29.99 after 7d
 *  D) trial $1 + upsell + subscription + renewals
 *  E) failed payment journey
 *  F) refund / chargeback
 */
function buildTransactions(): Transaction[] {
  const txs: Transaction[] = [];
  const scenarios = ["A","B","C","D","D","D","E","F","B","C"] as const;

  for (let i = 0; i < 50; i++) {
    const funnel = pick(FUNNELS);
    const source = pick(SOURCES);
    const campaign = `${source}_${funnel}_${(Math.floor(rand() * 9) + 1)}`;
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const email = `${first}${i + 1}@example.com`;
    const user = {
      user_id: `u_${1000 + i}`,
      email,
      funnel,
      source,
      campaign,
    };

    // trial date: 1..88 days ago
    const trialDaysAgo = 1 + Math.floor(rand() * 88);
    const trialBase = new Date(TODAY.getTime() - trialDaysAgo * DAY);
    const trialIso = isoAt(trialBase, 0);

    const scenario = scenarios[i % scenarios.length];

    // every user has a trial $1
    txs.push(makeTx(user, "trial", 1, "success", trialIso, "Trial 7-day", "initial trial charge"));

    if (scenario === "A") {
      // nothing else
    } else if (scenario === "B") {
      txs.push(makeTx(user, "upsell", 14.98, "success", isoAt(trialBase, 0), "Premium Reading Upsell", "post-trial upsell"));
    } else if (scenario === "C") {
      // first subscription after 7d if trial is old enough
      if (trialDaysAgo >= 7) {
        txs.push(makeTx(user, "first_subscription", 29.99, "success", isoAt(trialBase, 7), "Monthly Subscription", "trial converted to subscription"));
        // some renewals
        const months = Math.min(Math.floor((trialDaysAgo - 7) / 30), 3);
        for (let m = 1; m <= months; m++) {
          txs.push(makeTx(user, "renewal", 29.99, "success", isoAt(trialBase, 7 + m * 30), "Monthly Subscription", `renewal #${m}`));
        }
      }
    } else if (scenario === "D") {
      txs.push(makeTx(user, "upsell", 14.98, "success", isoAt(trialBase, 0), "Premium Reading Upsell", "post-trial upsell"));
      if (trialDaysAgo >= 7) {
        txs.push(makeTx(user, "first_subscription", 29.99, "success", isoAt(trialBase, 7), "Monthly Subscription", "trial converted to subscription"));
        const months = Math.min(Math.floor((trialDaysAgo - 7) / 30), 4);
        for (let m = 1; m <= months; m++) {
          // small chance a renewal fails
          if (rand() < 0.12) {
            txs.push(makeTx(user, "failed_payment", 29.99, "failed", isoAt(trialBase, 7 + m * 30), "Monthly Subscription", "card declined"));
          } else {
            txs.push(makeTx(user, "renewal", 29.99, "success", isoAt(trialBase, 7 + m * 30), "Monthly Subscription", `renewal #${m}`));
          }
        }
      }
    } else if (scenario === "E") {
      // attempted upsell that failed
      txs.push(makeTx(user, "failed_payment", 14.98, "failed", isoAt(trialBase, 0), "Premium Reading Upsell", "card declined on upsell"));
      if (trialDaysAgo >= 7 && rand() < 0.5) {
        txs.push(makeTx(user, "failed_payment", 29.99, "failed", isoAt(trialBase, 7), "Monthly Subscription", "card declined on subscription"));
      }
    } else if (scenario === "F") {
      txs.push(makeTx(user, "upsell", 14.98, "success", isoAt(trialBase, 0), "Premium Reading Upsell", "post-trial upsell"));
      if (rand() < 0.5) {
        txs.push(makeTx(user, "refund", -14.98, "refunded", isoAt(trialBase, 2), "Premium Reading Upsell", "customer requested refund"));
      } else {
        txs.push(makeTx(user, "chargeback", -14.98, "chargeback", isoAt(trialBase, 5), "Premium Reading Upsell", "issuer chargeback"));
      }
    }
  }

  // sort by event_time desc for nicer default display
  return txs.sort((a, b) => (a.event_time < b.event_time ? 1 : -1));
}

export const MOCK_TRANSACTIONS: Transaction[] = buildTransactions();
