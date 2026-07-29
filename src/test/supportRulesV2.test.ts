// Rules engine v2, tested against the phrasings that actually appear in the
// archive. Every quoted string below was read out of the live mailbox during
// the audit — including the misspellings, the missing accents and the mojibake.
// If a change breaks one of these, it breaks a real email.
import { describe, expect, it } from "vitest";
import { classifySupportRequestV2, detectLanguageV2, foldText } from "../../supabase/functions/_shared/clickhouse/supportRulesV2.ts";

const classify = (subject: string | null, body: string | null = null) =>
  classifySupportRequestV2("row-1", subject, body);

describe("phrasings v1 missed entirely", () => {
  it("reads 'stop' as a cancellation — no 'cancel' anywhere in the text", () => {
    expect(classify("<Без темы>", "Please stop my subscription").category).toBe("Cancellation");
    expect(classify("Stop billing", "Stop charging my account. Any future charges are NOT AUTHORIZED! Stop now!").matched)
      .toContain("Cancellation");
    expect(classify(null, "Dejen de cobrar por favor").category).toBe("Cancellation");
  });

  it("reads Spanish denial as an unauthorized charge", () => {
    expect(classify("Cargo", "Hola Porque me hacen un cargo de 519 No he contratado nada con ustedes").matched)
      .toContain("Unauthorized or unexpected charge");
    expect(classify(null, "Yo no he comprado nada").category).toBe("Unauthorized or unexpected charge");
    expect(classify("Quiero mi rembolso", "Yo no acepté este cobro").matched)
      .toContain("Unauthorized or unexpected charge");
  });

  it("handles misspellings and stripped accents the way people actually type", () => {
    // "rembolso" (missing e), "Me.huciwron" (mangled), "Devoluci?n" (mojibake)
    expect(classify("Quiero mi rembolso").category).toBe("Refund");
    expect(classify("Devoluci�n", "Me hacen el favor y me devuelve mi dinero").category).toBe("Refund");
    expect(classify("Solución de cobro", "les pido que me devuelvan mi dinero").category).toBe("Refund");
  });

  it("files a billing question as a question, not as a dispute", () => {
    const billed = classify("Bill", "I want to know why I was billed. I paid the 1.00");
    expect(billed.category).toBe("Billing inquiry");
    expect(classify("I’m curious", "What did I purchase from you?").category).toBe("Billing inquiry");
    expect(classify("$29.99", "Why did this bill show up on my credit card?").category).toBe("Billing inquiry");
  });

  it("catches an accidental signup", () => {
    expect(classify("Pics", "I didn’t mean to sign up").category).toBe("Accidental signup");
    expect(classify("Es que realicé la encuesta mal.", "conteste el formulario mal").category).toBe("Accidental signup");
  });

  it("catches a not-delivered product", () => {
    expect(classify("Help", "Didn't get my results I was charged though").matched).toContain("Product/report not received");
    expect(classify("I never got my portrait", "I never got my portrait that I paid for.").category)
      .toBe("Product/report not received");
    expect(classify("Hola", "Realice el pago y anule la suscripción pero nunca me llegó el retrato").matched)
      .toContain("Product/report not received");
  });

  it("catches a wrong product", () => {
    expect(classify("Wrong gender", "I received a stretch of a female and I am interested in men.").category)
      .toBe("Wrong or unsatisfactory product");
    expect(classify("Soulmate drawing", "Doesn’t look like anyone I’ve even remotely thought about.").category)
      .toBe("Wrong or unsatisfactory product");
  });

  it("files machine mail as noise instead of letting it look like a support request", () => {
    expect(classify("Delivery Status Notification (Failure)", "Delivery to the following recipient failed permanently").category)
      .toBe("Automated notification");
    expect(classify("Ваше сообщение не доставлено. Mail failure.", "Это письмо создано автоматически сервером Mail.ru").category)
      .toBe("Automated notification");
    expect(classify("MARIANNE HAJDER INVITE YOU TO SPECIAL PARTY RSVP !!", "Please click the invitation").category)
      .toBe("Spam/unrelated");
    expect(classify("Snuggie", "This item snuggies sandals payment made through Afterpay").category).toBe("Not our customer");
  });
});

describe("multi-intent — the 324 emails that asked for two things", () => {
  it("keeps both intents, with the money request primary", () => {
    const result = classify("Subscription", "Cancel subscription and get refund");
    expect(result.category).toBe("Refund");
    expect(result.secondary_categories).toContain("Cancellation");
    expect(result.flags.requires_refund).toBe(true);
    expect(result.flags.requires_cancellation).toBe(true);
  });

  it("keeps cancellation alongside an unauthorized charge", () => {
    const result = classify("Cancel subscription", "I never approved any of this cancel whatever you have on my account");
    expect(result.category).toBe("Unauthorized or unexpected charge");
    expect(result.secondary_categories).toContain("Cancellation");
  });

  it("does not repeat the primary in the secondary list", () => {
    const result = classify("Refund", "refund me my money back please");
    expect(result.secondary_categories).not.toContain("Refund");
  });

  it("keeps a three-way ask", () => {
    const result = classify("Picture", "when do I get photo? How do I cancel? Are there recurring charges?");
    expect([result.category, ...result.secondary_categories]).toContain("Cancellation");
    expect([result.category, ...result.secondary_categories].length).toBeGreaterThan(1);
  });
});

describe("noise never becomes a secondary intent", () => {
  it("drops complaint/praise from the secondary list, keeping the actionable ask primary", () => {
    const result = classify("What fuck is this shit I am paying for ?", "cancel this scam and refund me");
    expect(result.category).toBe("Refund");
    expect(result.secondary_categories).not.toContain("Complaint");
    expect(result.secondary_categories).toContain("Cancellation");
  });

  it("a bounce quoting a refund request is still a bounce", () => {
    const result = classify("Delivery Status Notification (Failure)", "Original message: I want a refund of my money");
    expect(result.category).toBe("Automated notification");
  });
});

describe("mailing list vs subscription", () => {
  it("treats pure mailing-list wording as an email opt-out", () => {
    expect(classify(null, "remove me from your mailing list").category).toBe("Mailing list unsubscribe");
    expect(classify(null, "stop sending me emails").category).toBe("Mailing list unsubscribe");
  });

  it("keeps the paid cancellation primary when the customer asks for both", () => {
    // Real email: the subject says the service is no longer wanted, the body
    // asks to be taken off the mailing list. Stopping the money is the
    // actionable half, so it leads — but the opt-out is not lost.
    const result = classify("No deseo más el servicio", "quiero dar de baja mi correo electrónico");
    expect(result.category).toBe("Cancellation");
    expect(result.secondary_categories).toContain("Mailing list unsubscribe");
  });

  it("treats a bare 'unsubscribe' as cancelling the paid subscription", () => {
    // In this archive "Unsubscribe" in the subject is almost always about the
    // paid plan — the body proves it.
    expect(classify("Unsubscribe", "cancel subscription don’t use it enough").category).toBe("Cancellation");
  });
});

describe("urgency and sentiment", () => {
  it("raises legal or repeat-charge threats to high", () => {
    expect(classify(null, "I will file a chargeback with my bank").urgency).toBe("high");
    expect(classify(null, "me siguen cobrando cada mes").urgency).toBe("high");
  });

  it("floors money requests at medium and leaves questions low", () => {
    expect(classify(null, "please cancel my account").urgency).toBe("medium");
    expect(classify(null, "when will I get my reading?").urgency).toBe("low");
  });

  it("reads sentiment without inventing it", () => {
    expect(classify(null, "Thank you so much, this was beautiful").sentiment).toBe("positive");
    expect(classify(null, "This is a scam, you robbed me").sentiment).toBe("negative");
    expect(classify(null, "when will I get my reading?").sentiment).toBe("neutral");
  });
});

describe("language detection", () => {
  it("separates the three languages that appear and admits ignorance otherwise", () => {
    expect(classify(null, "Quiero cancelar mi suscripcion por favor").language).toBe("es");
    expect(classify(null, "Please cancel my subscription and refund the money").language).toBe("en");
    expect(classify("Ваше сообщение не доставлено", null).language).toBe("ru");
    expect(classify("RETRATO", null).language).toBe("unknown");
  });

  it("ignores importer placeholders when reading the language", () => {
    // Regression: the spreadsheet importer writes "<Без темы>" as its own
    // "no subject" marker. Counting it as customer text labelled 158 English
    // and Spanish emails as Russian.
    expect(classify("<Без темы>", "I would like to cancel my subscription").language).toBe("en");
    expect(classify("<Без темы>", "El retrato no llegó").language).toBe("es");
    expect(classify("<Без темы>", "Hello I didn't get the image. Sent from Yahoo Mail for iPhone").language).toBe("en");
    // A genuinely Russian email is still Russian.
    expect(classify("Ваше сообщение не доставлено", "Это письмо создано автоматически").language).toBe("ru");
  });

  it("folds accents and case so one pattern covers every spelling", () => {
    expect(foldText("DEVOLUCIÓN  Ya")).toBe("devolucion ya");
    expect(detectLanguageV2("¿Por qué?", foldText("¿Por qué?"))).toBe("es");
  });
});

describe("fallback", () => {
  it("uses Other/unclear only when nothing at all can be read", () => {
    const result = classify("RETRATO", null);
    expect(result.category).toBe("Other/unclear");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reason).toContain("No rule matched");
  });

  it("never crashes on empty or exotic input", () => {
    for (const [subject, body] of [[null, null], ["", ""], ["🚀🚀🚀", " "], ["a".repeat(5000), "b".repeat(5000)]]) {
      expect(() => classify(subject, body)).not.toThrow();
    }
  });
});
