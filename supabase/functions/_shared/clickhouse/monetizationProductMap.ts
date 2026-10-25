// Single source of truth for monetization product mapping.
//
// Audited reality (July 2026 warehouse audit): Palmer payment rows carry NO
// product_id / product_name. The signals are ff_billing_reason, amount,
// currency, timing and — since the 2026-10-22 analysis — the FunnelFox price
// id every Primer row carries (metadata.ff_price_point, ClickHouse
// analytics_transactions.price_point). Products are mapped HERE only: the
// price-point typing (monetizationTyping.ts) renders its SQL literals and its
// TS evaluator from the lists below and never hardcodes an id.

export interface KnownTokenAmount {
  amount: number;
  /** ISO currency the amount is quoted in. Omit to match any currency. */
  currency?: string;
}

/** Product ids that are funnel upsells (empty until Palmer sends ids). */
export const knownUpsellProductIds: readonly string[] = [];

/** Product ids that are web-app token/minute packs (empty until Palmer sends ids). */
export const knownTokenProductIds: readonly string[] = [];

/** Product-name patterns marking a funnel upsell. */
export const knownUpsellProductNamePatterns: readonly RegExp[] = [/upsell/i];

/** Product-name patterns marking a token/minute pack. */
export const knownTokenProductNamePatterns: readonly RegExp[] = [
  /\b(tokens?|minutes?|coins?|credits?)\b/i,
];

// Audit 2026-07: in-app token packs observed as unmarked (no ff_billing_reason)
// charges minutes after the trial. The ClickHouse classifiers render their
// tokenAmt column from this list (monetizationTyping.tokenAmountSql), and
// tokenAmt is part of the cohort-anchor eligibility: changing the list moves
// anchors, so it needs a COHORT_CLASSIFICATION_VERSION bump and a snapshot
// rebuild. New packs are mapped by price id (knownTokenPriceIds) instead.
export const knownTokenAmounts: readonly KnownTokenAmount[] = [
  { amount: 4.99, currency: "USD" },
  { amount: 9.99, currency: "USD" },
  { amount: 24.99, currency: "USD" },
  { amount: 4.99, currency: "EUR" },
  { amount: 17199, currency: "COP" },
];

/**
 * A successful unmarked payment this close to the trial cannot be a
 * subscription charge, so the classifier treats it as an in-app (token)
 * purchase even when the price is not in the config yet; unmapped prices are
 * additionally reported in the unknown-products diagnostics.
 *
 * Boundary comes from the billing audit: subscription auto-charges fire at
 * N days − 2h after trial (observed exactly at 70h / 118h / 166h for the
 * 3/5/7-day trials), while real in-app purchases land soon after the trial:
 * token packs mostly 3–10 min, in-product upsells ≤ 3 min (2026-10-22
 * timing analysis). 48h stays safely below the earliest 70h billing horizon.
 * The price-id rules of monetizationTyping.ts apply inside this window only.
 */
export const APP_ADDON_WINDOW_HOURS = 48;

/** FunnelFox price ids (ClickHouse analytics_transactions.price_point = Primer
 * metadata.ff_price_point) of web-app token/minute packs. Source: the owner's
 * FunnelFox token-product screenshots and the price-id analysis of 2026-10-22
 * (74 ids). A listed id within APP_ADDON_WINDOW_HOURS of the trial is a token
 * purchase whatever its amount or timing. The 2026-09-10 and 2026-09-18
 * creation batches were listed here too until 2026-10-25: in FunnelFox they
 * are paid Palmistry / Pastlife reports, now in knownAppUpsellPriceIds. */
export const knownTokenPriceIds: readonly string[] = [
  // token_screenshot (36)
  "price_01M3YBPYQMJ8NESTZGKYZ6GZYN", // ZAR 179
  "price_01M3YBPV1SE9X4MMRY2B5R13ZC", // PHP 619
  "price_01M3YBPQBBX4EZEQVK9V7WHXA6", // BRL 49.99
  "price_01KXNM6S6EWGQ2J74QBSGQBHHC", // NZD 17.09
  "price_01KXNM6EEZDS087C6AR8VKG577", // AUD 14.29
  "price_01KW8Z76MT2V6YM7GDEPTPDXKK", // COP 34549
  "price_01KW8YNQR1B5FVMYVX5FX8J80X", // CAD 14.19
  "price_01KW8YMVB3R9NRH78WGHZEESDT", // GBP 7.59
  "price_01KW8YM4HY9QJM4EHFDNEFHW64", // PEN 34.19
  "price_01KW8YKNJPGXH9TC75KYCJG9CA", // EUR 9.99
  "price_01KW8YKBAKPH2EX5HR6X558T8F", // COP 3459
  "price_01KW8YJS4EM67ZHCXWJTKPJZYR", // UYU 399
  "price_01M3YBRT26ZA9HP0YHK4F4QVJV", // ZAR 449
  "price_01M3YBRPBHF4CJ1025B4F59ZT7", // PHP 1549
  "price_01M3YBRJP11XXAH581T72T999S", // BRL 124.99
  "price_01KXNM5B8ZKK6BZB4JVM3X8H2Z", // NZD 42.39
  "price_01KXNM4MCCB2TJEQQWE69ZPZQK", // AUD 35.79
  "price_01KW912PZX3TCAJHNSEGGT54AV", // PEN 85.29
  "price_01KW8Z6522F2VFJX2WZ9KSTR48", // UYU 999
  "price_01KW8Z5EFEJPXAJ75F49VY5NJK", // COP 86419
  "price_01KW8Z2NVE84ZRMRYZV3DXYNWW", // PEN 3.39
  "price_01KW8Z20TSV8M3QDMAP093QAG0", // EUR 24.99
  "price_01KW8Z1P7M7AHQY5K6X32HTBXN", // GBP 18.99
  "price_01KW8Z174S2YMQF4XGW316CPDF", // CAD 35.49
  "price_01M3YBT1P6ENYRDAF7YN1VKTSG", // ZAR 1779
  "price_01M3YBSXZBZFKDPKH10PJD6BZ3", // PHP 6189
  "price_01M3YBST7ZHC3XHM68T3BAP8C5", // BRL 499.99
  "price_01KXNM3JYH61QF17PZ8087XDYG", // NZD 170.99
  "price_01KXNM34Q9B80Y9P4PN9FYJTJX", // AUD 142.99
  "price_01KW918SFPKBXV4WP5GR8NF0RG", // CAD 141.99
  "price_01KW918D6ARV28YSFEJM5CE0RC", // GBP 75.69
  "price_01KW9180V98VWH7ZW7JS0G32NQ", // PEN 339.99
  "price_01KW917BGDKHFPRA7ASKSG4J6R", // EUR 99.99
  "price_01KW9171B7CPDKPH88ACFHSJDK", // COP 345749
  "price_01KW916EP8A429Y5SZRFH1S4Y0", // UYU 4019
  "price_01KW915V40BKB0QTM23VV6YTEX", // CLP 92239
  // token_siblings (6)
  "price_01KW8YH0BY1BJF4GT0GADG5MA4", // MXN 174.99
  "price_01KW8YZJN6SE4J3X7C45D6EGE7", // MXN 259.00
  "price_01KW914C0WNYEWV8JYVG4WS8B0", // MXN 1749.00 / MXN 439.00
  "price_01KW9155M97NSZ634Y2DNVJW26", // ARS 36929.00
  "price_01KXNM7VDKNZPDQH22Y9A5FW53", // AUD 7.19
  "price_01KXNM897V9ECCTP0V7STJYR6P", // NZD 8.49
  // token_july (6)
  "price_01KS4RDQWZ0V5XB9TNFVPQS9DT", // USD 9.99
  "price_01KS4RF9CY5JKSRSZTDND13DNM", // USD 24.99 / USD 99.99
  "price_01KVQABX015ZGZFP3H82TJ9JKG", // USD 4.99
  "price_01KW24SQ8JTTK6600BKJDVTBJN", // MXN 89.00
  "price_01KW250B46P7MRH5W31EXQS68Y", // COP 17199.00
  "price_01KW2527N6WBG2D47NHG1WH3QA", // EUR 4.99
  // token_batch_2026_08_14 (26)
  "price_01M0049J2M1HAJNJEJ0W2RK15D", // EUR 3.99
  "price_01M0049J2M5C3H3RCG1RESSZ49", // MXN 70.00
  "price_01M0049J2MC5Y2RC7A6FYD940M", // ARS 5929.00
  "price_01M0049J2MCCMKQR35S6DH6TPJ", // CAD 5.99
  "price_01M0049J2MCTBH6YC8DF7JCMSR", // JPY 640.00
  "price_01M0049J2MMRWYPHCTV6Z7QJQ2", // BRL 20.99
  "price_01M0049J2MXF0827MZX9607P63", // USD 3.99
  "price_01M0049J2MZWXNVTPN7RJST407", // COP 13179.00
  "price_01M0049J2N09889GSQE4PTHCZH", // COP 9879.00
  "price_01M0049J2N486TK50BJWS5SQ5K", // EUR 2.99
  "price_01M0049J2NHX2F6T5YBWPCCJK3", // MXN 52.00
  "price_01M0049J2NK2TZXCCYGMM26ZWN", // ARS 4449.00
  "price_01M0049J2NSET42GC0NWPSRFR8", // USD 2.99
  "price_01M0049J2NVDWW555VYBZTPXPD", // EUR 1.00
  "price_01M0049J2NX8JWC3EK2FJHEZRN", // JPY 480.00
  "price_01M0049J2NYWYJ89AREYDK2J7R", // USD 1.00
  "price_01M0049J2P1FK94JW84JHZ9KB0", // COP 3299.00
  "price_01M0049J2P5VBW08FV32W8E24R", // MXN 52.00
  "price_01M0049J2P8TM4BJMHY7AN32VM", // COP 9879.00
  "price_01M0049J2P9VTHHT556Q8KZ1GZ", // COP 9879.00
  "price_01M0049J2PCN00C3ZM2FKRGQSQ", // EUR 2.99
  "price_01M0049J2PG9HHFJ7E2QFH8PB7", // USD 2.99
  "price_01M0049J2PV75PM2ZBWZK63Q0A", // JPY 480.00
  "price_01M0049J2PY0KJSAV8A9B7KVHG", // EUR 2.99
  "price_01M0049J2PZYNKYAZ6P579VRKH", // EUR 1.00
  "price_01M0049J2QN7CGAKZAAMPZBPZX", // BRL 0.99
];

/** Price-point name patterns of app token packs ("price_web_tokens_*"). */
export const knownTokenPricePointPrefixes: readonly string[] = ["price_web_tokens"];

/** In-product purchases (Cohorts "In-product upsell" columns), unmarked (no
 * ff_billing_reason):
 * - the in-product upsell offered right after the funnel checkout, batch
 *   2026-09-29, 7 ids (owner, 2026-10-22);
 * - paid reports bought inside the product (owner, 2026-10-25): every price
 *   of the FunnelFox products Palmistry - Wealth Line / Mysterious Sign /
 *   Second Hand / Year by Hand and Pastlife - Unlock All Days (80 ids, read
 *   from the products' price pages). Their JPY prices (¥480 / ¥799 / ¥1,499 /
 *   ¥1,559) were mistaken for token packs; the JPY token packs are ¥649+.
 * Most amounts equal token-pack amounts — ids are the only separator; never
 * add these amounts to knownTokenAmounts (that would move cohort anchors). */
export const knownAppUpsellPriceIds: readonly string[] = [
  // app_upsell_batch_2026_09_29 (7)
  "price_01M3P1WF72Y5FBFV1SKKCF12TX", // USD 2.99
  "price_01M3P1WFEQWXCNW4E41FY5YA74", // EUR 2.99
  "price_01M3P1WGDZNA8VC0STG9GGH9JW", // NZD 5.99
  "price_01M3P1WGNFTM4SSR42XV4QGPNS", // JPY 480.00
  "price_01M3P1WH3STAZBRPK753XGTKE3", // BRL 15.99
  "price_01M3P1WHVYT3XN4EPTMJPCY5B1", // COP 9879.00
  "price_01M3P1WJH2N7F3CS70SXMHDH1F", // PHP 179.00
  // report_palmistry_wealth_line_2026_09_18 (16) — "Palmistry - Wealth Line", product 01M2SSG5N6QM4WCDV7QTRB5XAX
  "price_01M2SSJSK2S6CTKHTASXV9FME7", // ZAR 89.00
  "price_01M2SSJS76PE5GW1783V286RQW", // PHP 309.00
  "price_01M2SSJRVPNC90EA2SF65RD0CM", // UYU 199.00
  "price_01M2SSJRF790JGN5XP3XAY6HE1", // PEN 16.99
  "price_01M2SSJR3D5A8NY9XRGZHBB2QN", // COP 17249
  "price_01M2SSJQQWBH0V62RK7B78F6JK", // CLP 4599
  "price_01M2SSJQA3QFB75N5SG84KMKCS", // ARS 7399.00
  "price_01M2SSJPYFXW0Y68WGZTM50SSG", // BRL 24.99
  "price_01M2SSJPJGPDQH0XB4EC1P8F48", // MXN 89.00
  "price_01M2SSJP60614ZNS4FXBE277J5", // JPY 799
  "price_01M2SSJNT04XJF7HZ7D5Z8GA2H", // NZD 8.49
  "price_01M2SSJNDN8W5DSAAV70VD7J3T", // AUD 6.99
  "price_01M2SSJN1MEVSTF6D6XG5RBMKQ", // CAD 6.99
  "price_01M2SSJMMVDKQW1YK01CT6SW53", // GBP 3.79
  "price_01M2SSJM8Q6S9FQMCX4ABRC7DE", // EUR 4.99
  "price_01M2SSJ069JQFW5ZG3NY1B0FGH", // USD 4.99
  // report_palmistry_mysterious_sign_2026_09_18 (16) — "Palmistry - Mysterious Sign", product 01M2SSME0EBV249DDGAYFFDYVE
  "price_01M2SSMMVHBT1FANXTKGS40BT9", // ZAR 48.00
  "price_01M2SSMMES8JY55CMX80GKHCYX", // PHP 179.00
  "price_01M2SSMM2SVQHMN33WE59TYCWS", // UYU 119.00
  "price_01M2SSMKN4ZA7PSCS638XRXCBP", // PEN 10.99
  "price_01M2SSMJXJ39T54WTGHCH5BZFD", // COP 9879
  "price_01M2SSMJF4EHSG0PYWFEVHF8WA", // CLP 2769
  "price_01M2SSMHYZX4G6KRAGBJYNANQQ", // ARS 4449.00
  "price_01M2SSMHF7J7Z3SXJ8KKR26ARW", // BRL 15.99
  "price_01M2SSMH3N0KD8RREHX3X79EBV", // MXN 52.00
  "price_01M2SSMGQPM0D80Q5WHQZAEG4H", // JPY 480
  "price_01M2SSMGC46H8G9TC3JBJE9F77", // NZD 5.99
  "price_01M2SSMG0CFXFQ1C1DDEM99MRH", // AUD 4.99
  "price_01M2SSMFMHC64NE8BKT48CB9Y4", // CAD 4.99
  "price_01M2SSMF849M09PQ99S4C71N01", // GBP 2.99
  "price_01M2SSMEVR7G4T0RBGFM567543", // EUR 2.99
  "price_01M2SSMEG10966ZZYW4GSEGX9J", // USD 2.99
  // report_palmistry_second_hand_2026_09_18 (16) — "Palmistry - Second Hand: Fate and Choice", product 01M2SSM754ZYAP9M7H1QKVDX7S
  "price_01M2SSMDCX7CMDKBWTGCBD5GW0", // ZAR 149.00
  "price_01M2SSMCYDPYWE35MC9Q15J9BQ", // PHP 559.00
  "price_01M2SSMCJT7KYW45BC89GXBCSD", // UYU 359.00
  "price_01M2SSMC6ZQZ24AMRTAHVBY8C2", // PEN 30.99
  "price_01M2SSMBVBBR1G27NK63H5R3AM", // COP 31099
  "price_01M2SSMBEAQ60JEWY9HGX9BWVH", // CLP 8299
  "price_01M2SSMB2479GD7HPCK8RH6QFE", // ARS 13299.00
  "price_01M2SSMAPDJFEJX5NDZ39KA4BM", // BRL 45.99
  "price_01M2SSMAAEB0K8SJP5C08Y06BV", // MXN 159.00
  "price_01M2SSM9YEY6KFKCPPF6Q8AZ51", // JPY 1499
  "price_01M2SSM9JFMGZ9G6BRKZZD8J5D", // NZD 15.49
  "price_01M2SSM91GGEZPTENWHFX1ACKC", // AUD 12.99
  "price_01M2SSM8N8DHHW978NEYFJW8BF", // CAD 12.99
  "price_01M2SSM894DP228ZHK77QW3XXQ", // GBP 6.99
  "price_01M2SSM7X0MTXVKBS81GV5QHQH", // EUR 8.99
  "price_01M2SSM7GRSQGTZKC05EZ5QBKE", // USD 8.99
  // report_palmistry_year_by_hand_2026_09_18 (16) — "Palmistry - Year by Hand", product 01M2SSKB3N5PR5WQJCZZJ82TX5
  "price_01M2SSM6SEFRXMHK007CA0T1CC", // ZAR 165.00
  "price_01M2SSM6DB247V0HV6505VJWKD", // PHP 616.00
  "price_01M2SSM61B5H21W6GA1SZXK58M", // UYU 399.00
  "price_01M2SSM5KK3PYHJMZY4Q530X1K", // PEN 33.99
  "price_01M2SSM57EP31DH64SRZNFCQ4H", // COP 33119
  "price_01M2SSM4VRJDAQ553934C0DPRF", // CLP 9199
  "price_01M2SSM4FWAZ48DQP4TETT8459", // ARS 14859.00
  "price_01M2SSM43X58CHPAQ6CKGPFJPP", // BRL 51.00
  "price_01M2SSM3F2GFVB9K1G6P362C7N", // MXN 169.00
  "price_01M2SSM2ZTFYCXT1EH2KQ20XN7", // JPY 1559
  "price_01M2SSM2JZ7DDHP60BGXPWEW9J", // NZD 17.09
  "price_01M2SSM272WGZXP4MZ2DMPV5JH", // AUD 14.29
  "price_01M2SSM1V60YS9GK1RCQ4D32EY", // CAD 13.99
  "price_01M2SSM1F0W8GAJNSVJAPB3M2T", // GBP 7.39
  "price_01M2SSM138KQ1ACA3DJAX1T570", // EUR 9.99
  "price_01M2SSM0Q8MBRGGZJYYN3DFKHD", // USD 9.99
  // report_pastlife_unlock_all_days_2026_09_10 (16) — "Pastlife - Unlock All Days", product 01M2607KQGV17SNA0SM6V535J0
  "price_01M263A7PMAKB91NJR696H18GQ", // PHP 179.00
  "price_01M2639MWX6KX5ZMHFET630P6T", // ZAR 48.00
  "price_01M26390P1VZ352J4VD8XYJEZE", // UYU 119.00
  "price_01M2638B801SM2BSQDJN1861FB", // CLP 2769
  "price_01M2637VMQGSHASEA6JFT10TYA", // PEN 10.99
  "price_01M2637B8HN500HVR87CEGDHR5", // ARS 4449.00
  "price_01M2636WRVES4Y7AVAV1HFKZVQ", // COP 9879
  "price_01M2636EEMJNNA08XBR58P1F53", // BRL 15.99
  "price_01M2635VBE40ZCHFAPYSBAPKTG", // MXN 52.00
  "price_01M2635D04JQZYR9S1AR8P3EJV", // NZD 5.99
  "price_01M2634TGH3MA5SDBACBV8ZDWV", // AUD 4.99
  "price_01M2634E452W6ZM315CBWPT9PH", // CAD 4.99
  "price_01M2633N90CBB3VX9W548A97KP", // GBP 2.99
  "price_01M2632WE6284ZZJWFZ5EPG6BT", // JPY 480
  "price_01M26326TEEDTMEGSM643TZAJ5", // EUR 2.99
  "price_01M260883ZSH31PKMB75KD3QJH", // USD 2.99
];

/** Funnel-upsell price ids that never carry the upsell mark (empty: the
 * "ever marked" rule covers today's unmarked funnel upsells, e.g. the JPY 2400
 * price_01M3BW7TT3TXZRHCRY4BFGS8M7 with 2 of 26 rows unmarked). */
export const knownFunnelUpsellPriceIds: readonly string[] = [];

/** Unknown unmarked one-off charge this close to the trial = in-product upsell
 * (2026-10-22 timing: marked funnel upsells 100% ≤ 3 min, the 09-29 in-product
 * upsell 83% ≤ 3 min, token packs only 6% ≤ 3 min — mostly 3–10 min). */
export const APP_UPSELL_FALLBACK_MINUTES = 2;

/** The legacy "common upsell amount within 1 h" rule (14.98). */
export const COMMON_UPSELL_WINDOW_MINUTES = 60;

/** A FunnelFox price id as the classifier inlines it into SQL literals. */
export const PRICE_ID_RE = /^price_[A-Za-z0-9_]+$/;

/** Throws an Error naming the offending id when a listed id is not a plain
 * price id (which keeps the inline SQL literals of monetizationTyping.ts safe)
 * or sits in two lists (the typing precedence must never be what decides a
 * listed id). Runs on this module's lists at load. */
export function assertValidPriceIdLists(
  lists: ReadonlyArray<readonly [string, readonly string[]]>,
  prefixes: readonly string[] = [],
): void {
  const owner = new Map<string, string>();
  for (const [name, ids] of lists) {
    for (const id of ids) {
      if (!PRICE_ID_RE.test(id)) throw new Error(`monetizationProductMap: invalid price id in ${name}: ${id}`);
      const previous = owner.get(id);
      if (previous) throw new Error(`monetizationProductMap: price id ${id} is listed in both ${previous} and ${name}`);
      owner.set(id, name);
    }
  }
  for (const prefix of prefixes) {
    if (!PRICE_ID_RE.test(prefix)) throw new Error(`monetizationProductMap: invalid price-point prefix: ${prefix}`);
  }
}

assertValidPriceIdLists(
  [
    ["knownTokenPriceIds", knownTokenPriceIds],
    ["knownAppUpsellPriceIds", knownAppUpsellPriceIds],
    ["knownFunnelUpsellPriceIds", knownFunnelUpsellPriceIds],
  ],
  knownTokenPricePointPrefixes,
);

export const AMOUNT_TOLERANCE = 0.005;

export function isKnownTokenAmount(amount: number, currency: string | null | undefined): boolean {
  const normalizedCurrency = String(currency ?? "").trim().toUpperCase();
  return knownTokenAmounts.some(
    (rule) =>
      Math.abs(rule.amount - amount) < AMOUNT_TOLERANCE &&
      (!rule.currency || rule.currency.toUpperCase() === normalizedCurrency || !normalizedCurrency),
  );
}

export function matchesKnownTokenProduct(productId: string | null, productName: string | null): boolean {
  if (productId && knownTokenProductIds.includes(productId)) return true;
  if (productName && knownTokenProductNamePatterns.some((pattern) => pattern.test(productName))) return true;
  return false;
}

export function matchesKnownUpsellProduct(productId: string | null, productName: string | null): boolean {
  if (productId && knownUpsellProductIds.includes(productId)) return true;
  if (productName && knownUpsellProductNamePatterns.some((pattern) => pattern.test(productName))) return true;
  return false;
}
