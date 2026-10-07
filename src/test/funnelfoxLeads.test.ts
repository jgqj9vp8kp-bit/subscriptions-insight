import { describe, expect, it } from "vitest";
import {
  emailFromListRow,
  joinSessionsToProfiles,
  mediaBuyerFromUtmSource,
  parseOriginUrl,
  parseProfileListRow,
  parseSessionRow,
  profileUpsertRow,
  selectLeadsSource,
  sessionAttributionRow,
  type ParsedSession,
} from "@/services/funnelfoxLeadsTransform";

// Conversion (paid / active subscription → not a lead) is decided by the SQL function
// public.funnelfox_leads_reconcile now, not by a browser-computed context; its tests live with
// the migration. The sync stores only list rows that carry an email.

describe("1. profile list parsing", () => {
  it("extracts profile_id (from id, prefix stripped), created_at, funnel_id, preview", () => {
    const parsed = parseProfileListRow({ id: "pro_1", created_at: "2026-06-10T00:00:00Z", funnel_id: "fn_9", preview: false });
    expect(parsed.profile_id).toBe("1");
    expect(parsed.created_at).toBe("2026-06-10T00:00:00Z");
    expect(parsed.funnel_id).toBe("fn_9");
    expect(parsed.preview).toBe(false);
    expect(parsed.email).toBeNull();
    expect(parsed.normalized_email).toBeNull();
  });

  it("uses a list-row email when present, and finds one inside a preview string", () => {
    expect(emailFromListRow({ email: "A@Example.com" })).toBe("a@example.com");
    expect(emailFromListRow({ preview: "Lead: jane@example.com (US)" })).toBe("jane@example.com");
    expect(emailFromListRow({ preview: { email: "x@y.com" } })).toBe("x@y.com");
    expect(emailFromListRow({ preview: "no email here" })).toBeNull();
    // `preview` is a boolean on live rows — it never carries an email.
    expect(emailFromListRow({ preview: true })).toBeNull();
  });

  it("keeps the email as sent plus its normalized form", () => {
    const parsed = parseProfileListRow({ id: "p", email: "  Jane.Doe@Example.COM " });
    expect(parsed.email).toBe("Jane.Doe@Example.COM");
    expect(parsed.normalized_email).toBe("jane.doe@example.com");
  });
});

describe("3. session parsing", () => {
  it("extracts attribution fields, normalizes country and the profile id", () => {
    const s = parseSessionRow({
      id: "sess_1",
      profile_id: "pro_1",
      country: "us",
      user_agent: "Mozilla/5.0",
      funnel_id: "fn_9",
      funnel_version: "v2",
      origin: "https://lp/x?utm_source=4",
      created_at: "2026-06-10T10:00:00Z",
      city: "Austin",
      postal: "78701",
    });
    expect(s).toMatchObject({
      session_id: "sess_1",
      profile_id: "1",
      country_code: "US",
      user_agent: "Mozilla/5.0",
      funnel_version: "v2",
      city: "Austin",
      postal: "78701",
    });
  });
});

describe("4. session → profile join", () => {
  it("keeps the earliest session per profile_id and drops sessions without profile_id", () => {
    const sessions: ParsedSession[] = [
      parseSessionRow({ id: "s_late", profile_id: "pro_1", created_at: "2026-06-12T00:00:00Z", origin: "late" }),
      parseSessionRow({ id: "s_early", profile_id: "1", created_at: "2026-06-10T00:00:00Z", origin: "early" }),
      parseSessionRow({ id: "s_orphan", profile_id: "", created_at: "2026-06-11T00:00:00Z" }),
    ];
    const joined = joinSessionsToProfiles(sessions);
    expect(joined.size).toBe(1);
    expect(joined.get("1")?.session_id).toBe("s_early");
  });
});

describe("5. origin URL parsing", () => {
  it("extracts campaign_path, campaign_id and utm_source from a full URL", () => {
    const a = parseOriginUrl("https://lp.example.com/soulmate?utm_source=4&utm_campaign=soulmate-reading&campaign_id=cmp123");
    expect(a).toEqual({ campaign_path: "soulmate-reading", campaign_id: "cmp123", utm_source: "4" });
  });

  it("falls back to the first path segment and tolerates bare query strings", () => {
    expect(parseOriginUrl("https://lp.example.com/past-life/start").campaign_path).toBe("past-life");
    expect(parseOriginUrl("utm_source=22&utm_content=ad9").utm_source).toBe("22");
    expect(parseOriginUrl("utm_source=22&utm_content=ad9").campaign_id).toBe("ad9");
    expect(parseOriginUrl(null)).toEqual({ campaign_path: null, campaign_id: null, utm_source: null });
  });
});

describe("6. media buyer mapping", () => {
  it("maps numeric utm_source codes", () => {
    expect(mediaBuyerFromUtmSource("4")).toBe("Ivan");
    expect(mediaBuyerFromUtmSource("19")).toBe("Artem A");
    expect(mediaBuyerFromUtmSource("22")).toBe("Artem D");
    expect(mediaBuyerFromUtmSource("999")).toBe("Unknown");
  });
});

describe("10. upsert rows (dedup key = profile_id)", () => {
  it("a profile row carries only the columns the list owns — never conversion state or raw payloads", () => {
    const profile = parseProfileListRow({ id: "pro_1", created_at: "2026-06-10T00:00:00Z", funnel_id: "fn_9", preview: true, email: "Lead@Example.com" });
    const row = profileUpsertRow(profile, "2026-10-06T00:00:00.000Z");
    expect(row).toEqual({
      profile_id: "1",
      email: "Lead@Example.com",
      normalized_email: "lead@example.com",
      email_source: "list",
      detail_checked: true,
      preview: true,
      created_at: "2026-06-10T00:00:00Z",
      updated_at: null,
      synced_at: "2026-10-06T00:00:00.000Z",
      funnel_id: "fn_9",
    });
    for (const key of ["is_lead", "has_successful_payment", "has_active_subscription", "raw_profile_list", "raw_profile_detail"]) {
      expect(row).not.toHaveProperty(key);
    }
    // No funnel_id in the list row → the key is absent, so a stored funnel_id is never nulled.
    expect(profileUpsertRow(parseProfileListRow({ id: "p2", email: "b@x.com" }), "t")).not.toHaveProperty("funnel_id");
  });

  it("a session row attaches joined attribution + media buyer to a stored profile, light columns only", () => {
    const session = parseSessionRow({
      id: "sess_1", profile_id: "pro_1", country: "us", user_agent: "UA", funnel_id: "fn_s",
      origin: "https://lp/x?utm_source=4&utm_campaign=soulmate-reading&campaign_id=cmp1", created_at: "2026-06-10T10:00:00Z",
    });
    const row = sessionAttributionRow("1", session, { session_created_at: null, funnel_id: "fn_9" }, "t");
    expect(row).toMatchObject({
      profile_id: "1",
      session_id: "sess_1",
      campaign_path: "soulmate-reading",
      campaign_id: "cmp1",
      utm_source: "4",
      media_buyer: "Ivan",
      country_code: "US",
      funnel_id: "fn_9", // the stored funnel wins over the session's
    });
    expect(row).not.toHaveProperty("raw_session");
    expect(row).not.toHaveProperty("email");
    // Not stored (no email) → nothing to write; an earlier stored session wins.
    expect(sessionAttributionRow("1", session, undefined, "t")).toBeNull();
    expect(sessionAttributionRow("1", session, { session_created_at: "2026-06-09T00:00:00Z", funnel_id: null }, "t")).toBeNull();
    expect(sessionAttributionRow("1", session, { session_created_at: "2026-06-11T00:00:00Z", funnel_id: null }, "t")?.funnel_id).toBe("fn_s");
  });
});

describe("12. Leads page source priority", () => {
  it("prefers FunnelFox leads and only falls back to warehouse when empty", () => {
    expect(selectLeadsSource([{ a: 1 }], [{ b: 2 }]).source).toBe("funnelfox");
    expect(selectLeadsSource([], [{ b: 2 }]).source).toBe("warehouse");
    expect(selectLeadsSource([], [{ b: 2 }]).warehouse).toHaveLength(1);
  });
});
