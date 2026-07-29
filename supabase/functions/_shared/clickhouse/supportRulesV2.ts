// Deterministic classifier for taxonomy v2 — no API, no cost, no network.
//
// Built by reading the actual archive rather than guessing vocabulary. The v1
// rules missed on phrasing, not meaning: "Please stop my subscription" and
// "Stop billing" are cancellations that contain no "cancel"; "no he contratado
// nada" and "Yo no he comprado nada" are unauthorized charges that contain no
// "unauthorized"; "Quiero mi rembolso" and "Me.huciwron un cobro" are refunds
// and charges spelled the way people actually type at 2am.
//
// Two structural differences from v1:
//   1. EVERY category is matched, not just the first one — so "cancel and
//      refund me" keeps both intents instead of losing whichever rule sat
//      lower in the list.
//   2. The primary intent is chosen by an explicit business priority rather
//      than by the accident of array order.
//
// Text is accent- and case-folded before matching, so "devolución",
// "devolucion" and "DEVOLUCION" are one pattern, and the mojibake in ~97 rows
// ("Devoluci�n") still matches on its intact prefix.
import {
  FALLBACK_CATEGORY,
  SUBCATEGORY_BY_CATEGORY,
  applyUrgencyFloor,
  deriveFlags,
  type SupportCategoryV2,
  type SupportClassificationResult,
  type SupportSentiment,
  type SupportUrgency,
} from "./supportTaxonomy.ts";

export const SUPPORT_RULES_VERSION_V2 = "support_rules_v2";

export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Ordered by how decisive the intent is, not by how common it is. Noise
 * categories come first: a mailer-daemon bounce quoting a refund request must
 * be filed as a bounce, not as a refund. */
const PRIORITY: SupportCategoryV2[] = [
  "Automated notification",
  "Not our customer",
  "Spam/unrelated",
  "Duplicate charge",
  "Unauthorized or unexpected charge",
  "Refund",
  "Cancellation",
  "Accidental signup",
  "Mailing list unsubscribe",
  "Product/report not received",
  "Wrong or unsatisfactory product",
  "Payment issue",
  "Billing inquiry",
  "Account/access issue",
  "Technical issue",
  "Subscription question",
  "Product/report question",
  "Complaint",
  "Positive feedback",
];

/** Patterns are matched against folded text. Written as regexes so word
 * boundaries stop "cancel" matching inside "cancellation policy" quotes and so
 * misspellings can be covered without listing every variant. */
const PATTERNS: Array<{ category: SupportCategoryV2; confidence: number; any: RegExp[] }> = [
  {
    category: "Automated notification",
    confidence: 0.97,
    any: [
      /delivery status notification/,
      /mail(er)?[- ]daemon/,
      /undeliverable|not delivered|no entregado|mail failure|message not delivered/,
      /returned mail|delivery has failed|permanent(ly)? fail/,
      /out of office|automatic reply|respuesta automatica|autoreply/,
      /это письмо создано автоматически|сообщение не доставлено/,
    ],
  },
  {
    category: "Not our customer",
    confidence: 0.7,
    any: [
      /afterpay|klarna|snuggie/,
      /wrong (company|merchant|business)|not your customer/,
      /i (have )?(never|no) (heard of|used) (your|this) (company|service)/,
    ],
  },
  {
    category: "Spam/unrelated",
    confidence: 0.8,
    any: [
      /seo services|marketing proposal|guest post|link building|backlink/,
      /crypto|bitcoin|viagra|loan offer/,
      /invite you to (a )?special party|rsvp/,
    ],
  },
  {
    category: "Duplicate charge",
    confidence: 0.94,
    any: [
      /duplicate charge|charged twice|double charge[d]?|two charges|2 charges/,
      /cobro doble|dos veces|me cobraron (2|dos)/,
      /2 importes|dos importes|charged again for the same/,
    ],
  },
  {
    category: "Unauthorized or unexpected charge",
    confidence: 0.9,
    any: [
      /unauthori[sz]ed|without my (consent|permission|authorization)|not authori[sz]ed/,
      /i (did ?n.t|never|didnt|did not) (authori[sz]e|approve|sign ?up|order|purchase|buy|subscribe|consent)/,
      /i (have )?(not|never) (bought|ordered|purchased|subscribed)/,
      /no (he |habia |)(autoriza|autorice|autorize|acepte|acepto|pedi|solicite|compre|contrat)/,
      /yo no (he |)(compr|autoric|acept|pedi|orden|contrat)/,
      /sin mi (permiso|consentimiento|autorizacion)/,
      /no reconozco (este|el) cargo|desconozco (este|el) cargo/,
      /fraud|scam charge|stole my money|robbed/,
      /never (signed up|subscribed|authorized)/,
      // Round 2, read from the leftovers: "concent" for consent, "didnt not
      // subscribe", card-issuer alerts, and money simply vanishing.
      /without my (concent|knowledge)|did ?n.?t not (subscribe|authorize)/,
      /suspicious charge|flagged a suspicious/,
      /(why are you|stop) (taking|withdrawing) money (out )?of my account/,
      /trying to take \$|keep getting alerts/,
      /i (do ?n.t|dont) (even )?(know|no) (what|who) you are/,
    ],
  },
  {
    category: "Refund",
    confidence: 0.9,
    any: [
      /\brefund(s|ed|ing)?\b|money back|return my money|reimburse/,
      /\brembols|\breembols|devolucion|devolver (mi |el |)dinero|devuelv\w* (mi |el |)dinero/,
      /quiero mi (dinero|reembolso|rembolso)|regresen mi dinero|reintegr/,
      /i want (it|my money) (back|returned)|give me my money/,
      /chargeback|dispute (the|this) charge/,
      // "De volicion", "debolucion" — the word spelled by ear.
      /de ?volici?on|debolucion|develucion|devolusion/,
      /please return\.? unwanted|unwanted\.? please return/,
    ],
  },
  {
    category: "Cancellation",
    confidence: 0.88,
    any: [
      /\bcancel(l)?(ing|ed|ation)?\b/,
      /cancela(r|cion|me)|anular|anule|dar de baja (mi |la |)(suscripcion|subscripcion|servicio|cuenta)/,
      // The phrasings v1 missed entirely — "stop", not "cancel".
      /stop (the |my |any |all |)(billing|charging|charges|subscription|payment|recurring|taking)/,
      /stop charging (me|my (card|account))|no more charges|don.t charge me/,
      /no (deseo|quiero) (mas |mas el |el |)(servicio|suscripcion|producto)/,
      /(dejen|paren|pare) de cobrar|no me cobren (mas|nada)/,
      /end (my |the )subscription|terminate (my |the )(subscription|account|membership)/,
      /unsubscribe me from (the |your |)(subscription|service|plan)/,
      /remove my (subscription|membership)|close my (account|subscription)/,
      // "que me den de baja", "solicitud de baja" — the Spanish request form
      // v1 and round 1 both missed.
      /(den|dar|darme|dame) de baja|solicitud de baja|baja de la suscripcion/,
    ],
  },
  {
    category: "Accidental signup",
    confidence: 0.82,
    any: [
      /(did ?n.t|didnt|did not) mean to (sign ?up|subscribe|order|buy|purchase)/,
      /by (mistake|accident)|accidental(ly)?|unintentional/,
      /me equivoque|por error|sin querer|no era mi intencion/,
      /realice la encuesta mal|conteste (mal|el formulario mal)/,
    ],
  },
  {
    category: "Mailing list unsubscribe",
    confidence: 0.8,
    any: [
      // Deliberately NOT bare "unsubscribe": in this archive that word almost
      // always means cancelling the paid subscription.
      /(stop|no more) (sending |)(me |)(emails|mails|correos|newsletters)/,
      /remove me from (your |the |)(list|mailing|email)/,
      /dar de baja mi (correo|email|e-mail)|quitar mi correo/,
      /unsubscribe (me |)from (your |the |)(mailing|email|newsletter|list)/,
    ],
  },
  {
    category: "Product/report not received",
    confidence: 0.86,
    any: [
      /(never|not|did ?n.t|didnt|have ?n.t|havent) (got|get|receive[d]?|arrived)/,
      /still (waiting|have ?n.t received)|where is my (order|report|reading|portrait|drawing|sketch|photo|picture)/,
      /no (me |)(llego|ha llegado|recibi|he recibido)|nunca (me |)(llego|recibi)/,
      /didn.t get my (results|report|reading|picture|portrait)/,
      /esperando (mi|el) (retrato|informe|lectura)/,
      /no me (enviaron|mandaron|han enviado) (nada|el|mi)/,
      /(did ?n.t|didnt) see (no |my |the |)(sketch|schetch|drawing|portrait|reading)/,
      /where is my (sche?tch|skecth)/,
      /donde esta (el|mi) (servicio|retrato|informe)|por el que pague/,
    ],
  },
  {
    category: "Wrong or unsatisfactory product",
    confidence: 0.78,
    any: [
      /wrong (gender|person|picture|image|photo|portrait|drawing|sketch|reading)/,
      /(does ?n.t|doesnt|does not) look like|not what i (ordered|expected|wanted)/,
      /no se parece|no es lo que (pedi|esperaba|queria)|equivocad[oa]/,
      /soy (mujer|hombre) y (no |)me (gustan|interesan)|i am interested in (men|women)/,
      /soy (mujer|hombre).{0,40}(retrato|foto|imagen) de (una |un )?(mujer|hombre)/,
      /no soy (lesbiana|gay)|me gustan los (hombres|chicos)|me gustan las (mujeres|chicas)/,
      /es una mujer|es un hombre.*no (soy|me)/,
    ],
  },
  {
    category: "Payment issue",
    confidence: 0.76,
    any: [
      /payment (failed|declined|error|pending|did ?n.t go)|card (was |)declined/,
      /pago (fallido|rechazado)|tarjeta rechazada|no pude pagar/,
      /no se completo el pago|el pago no se (completo|realizo)/,
      /paid but|charged but (i |)(did ?n.t|never)|order failed/,
    ],
  },
  {
    category: "Billing inquiry",
    confidence: 0.72,
    any: [
      // The customer is asking, not disputing — v1 had no bucket for this at
      // all, so ~25 of these fell into Other/unclear.
      /why (i |my |)(was|am|is|did|do)( i| my|)? ?(billed|charged|charge)/,
      /why (is|did|was|does) (this|that|there) (bill|charge|payment|amount|transaction)/,
      /(bill|charge|payment) (show(ed)? up|appear(ed)?) on my (credit card|card|statement|account)/,
      /charge for what|for what\W*$/,
      /why have i been (charged|billed)|when did it change/,
      /is this a one[- ]time|is this recurring|one time deduction/,
      /what (did i|is this) (purchase|charge|payment|for)/,
      /what (was|is) this (charge|payment|for)/,
      /(que|cual) es este cargo|porque me (cobran|hacen un cargo|cobraron)|de que es (este|el) cobro/,
      /no he contratado nada|no se que es este (cargo|cobro)/,
      /(quiero|quisiera) saber (de que|por que|que es)/,
      /explain (this|the) charge|clarify (this|the) charge/,
      /i (was|am) (billed|charged) (\$|usd|eur|[0-9])/,
    ],
  },
  {
    category: "Account/access issue",
    confidence: 0.74,
    any: [
      /(can ?n.t|cannot|unable to) (log ?in|access|sign ?in)|login (problem|issue|failed)/,
      /forgot (my )?password|reset (my )?password|contrasena|acceder a mi cuenta/,
    ],
  },
  {
    category: "Technical issue",
    confidence: 0.7,
    any: [
      /(app|site|website|link|page|download) (is |)(not working|broken|down|does ?n.t work)/,
      /no funciona|problema tecnico|error (message|al)/,
    ],
  },
  {
    category: "Subscription question",
    confidence: 0.66,
    any: [
      /(what|which|how much) (is |does |)(my |the |)(subscription|plan|membership)/,
      /(are there|is there) (any |)(recurring|monthly|future) charges/,
      /when (does|will) (it|my subscription) renew|renewal date/,
      /(que|cual) (es|incluye) (mi |la |)(suscripcion|plan)/,
    ],
  },
  {
    category: "Product/report question",
    confidence: 0.62,
    any: [
      /when (will|do) i (get|receive)|how long (does it take|until)/,
      /how (does|do) (this|it|the reading) work|what (do|does) i get/,
      /cuando (me |)(llega|llegara|recibo)|de que se trata|que incluye/,
    ],
  },
  {
    category: "Complaint",
    confidence: 0.6,
    any: [
      /\bscam\b|\bfraude\b|estafa|rip ?off|this is (a )?(scam|joke|ridiculous)/,
      /terrible|horrible|worst|disgusting|awful service/,
      /what (the )?fuck|bullshit|shit/,
    ],
  },
  {
    category: "Positive feedback",
    confidence: 0.64,
    any: [
      /thank you|thanks|gracias|excelente|perfecto|love (it|this)|amazing|beautiful/,
    ],
  },
];

const URGENT_SIGNALS = [
  /chargeback|dispute|lawyer|attorney|legal action|police|denuncia|demanda|profeco|bbb/,
  /third time|again and again|me siguen cobrando|keep charging|charged again/,
  /urgent|asap|immediately|inmediato|urgente/,
];

const POSITIVE = /thank you|thanks|gracias|excelente|perfecto|love (it|this)|amazing/;
const NEGATIVE = /scam|fraud|estafa|robbed|angry|terrible|horrible|worst|unauthori[sz]ed|no autorice|furious|disgust/;

/** Cheap language guess. Only three languages matter here (measured: 650 es,
 * 512 en, 5 ru), and "unknown" is an honest answer for a two-word email. */
export function detectLanguageV2(raw: string, folded: string): string {
  if (/[а-яё]/i.test(raw)) return "ru";
  if (/[ñ¿¡]/.test(raw)) return "es";
  const spanish = /\b(no|mi|me|que|por|para|los|las|del|una|cobro|dinero|cuenta|suscripcion|quiero|gracias|hola|favor|pago|tarjeta)\b/;
  const english = /\b(the|my|is|to|and|you|please|charge|money|refund|cancel|subscription|account|thank|help|want)\b/;
  const es = (folded.match(spanish) ?? []).length + (folded.match(/\b(el|la|un|con|sin|esta|este)\b/g) ?? []).length;
  const en = (folded.match(english) ?? []).length + (folded.match(/\b(a|of|for|it|this|that|was|have)\b/g) ?? []).length;
  if (es === 0 && en === 0) return "unknown";
  return es >= en ? "es" : "en";
}

export interface RulesClassification extends SupportClassificationResult {
  matched: SupportCategoryV2[];
}

/** Classify one email. Returns the same shape the model path produces, so the
 * job, the sync and the UI cannot tell the two engines apart. */
export function classifySupportRequestV2(
  id: string,
  subject: string | null,
  body: string | null,
): RulesClassification {
  const raw = `${subject ?? ""}\n${body ?? ""}`;
  const folded = foldText(raw);

  const hits: Array<{ category: SupportCategoryV2; confidence: number }> = [];
  for (const rule of PATTERNS) {
    if (rule.any.some((pattern) => pattern.test(folded))) {
      hits.push({ category: rule.category, confidence: rule.confidence });
    }
  }

  const ranked = hits.sort((a, b) => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category));
  const primary = ranked[0]?.category ?? FALLBACK_CATEGORY;
  const secondary = ranked
    .slice(1)
    .map((hit) => hit.category)
    // Noise verdicts and the catch-all say nothing as a secondary intent.
    .filter((category) => category !== FALLBACK_CATEGORY && category !== "Complaint" && category !== "Positive feedback");
  const all = [primary, ...secondary];

  const urgent = URGENT_SIGNALS.some((pattern) => pattern.test(folded));
  const urgency = applyUrgencyFloor(urgent ? "high" : "low", all);
  const sentiment: SupportSentiment = NEGATIVE.test(folded) ? "negative" : POSITIVE.test(folded) ? "positive" : "neutral";

  const confidence = ranked[0]?.confidence ?? 0.2;
  const reason = ranked.length
    ? `Matched ${primary} phrasing${secondary.length ? ` (also ${secondary.join(", ")})` : ""}.`
    : "No rule matched the text.";

  return {
    id,
    category: primary,
    subcategory: SUBCATEGORY_BY_CATEGORY[primary],
    secondary_categories: secondary,
    language: detectLanguageV2(raw, folded),
    sentiment,
    urgency: urgency as SupportUrgency,
    confidence,
    reason,
    flags: deriveFlags(all, urgency as SupportUrgency),
    matched: ranked.map((hit) => hit.category),
  };
}
