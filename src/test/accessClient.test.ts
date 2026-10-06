import { describe, expect, it, vi } from "vitest";
import {
  fetchMyAccess,
  isMissingRpcError,
  MY_ACCESS_RPC,
  parseMyAccessPayload,
  type MyAccessRpcClient,
} from "@/services/accessClient";

function okRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    workspace_id: "8d1c2c51-0000-4000-8000-000000000001",
    member_id: "8d1c2c51-0000-4000-8000-000000000002",
    user_id: "8d1c2c51-0000-4000-8000-000000000003",
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: false,
    raw_access: false,
    role: { id: "role-1", key: "viewer", name: "Viewer", is_owner: false, permissions: ["dashboard.view", "cohorts.view"] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "3",
    partition: "a".repeat(64),
    ...overrides,
  };
}

function clientReturning(response: unknown): MyAccessRpcClient & { rpc: ReturnType<typeof vi.fn> } {
  return { rpc: vi.fn(async () => response) };
}

describe("fetchMyAccess", () => {
  it("calls the my_access RPC and passes an ok payload through", async () => {
    const client = clientReturning({ data: okRow(), error: null, status: 200 });
    const access = await fetchMyAccess(client);

    expect(client.rpc).toHaveBeenCalledWith(MY_ACCESS_RPC);
    expect(access.status).toBe("ok");
    expect(access.member_id).toBe("8d1c2c51-0000-4000-8000-000000000002");
    expect(access.role).toEqual({ id: "role-1", key: "viewer", name: "Viewer", is_owner: false, permissions: ["dashboard.view", "cohorts.view"] });
    expect(access.funnel_scope).toEqual({ mode: "all", funnel_ids: [], paths: [] });
    expect(access.access_version).toBe("3");
    expect(access.partition).toBe("a".repeat(64));
  });

  it("never keeps data_key, even if the server sends it", async () => {
    const client = clientReturning({ data: okRow({ data_key: "8d1c2c51-0000-4000-8000-0000000000ff" }), error: null, status: 200 });
    const access = await fetchMyAccess(client);
    expect(access.status).toBe("ok");
    expect(JSON.stringify(access)).not.toContain("data_key");
    expect(JSON.stringify(access)).not.toContain("0000000000ff");
  });

  it("maps a missing RPC (PGRST202) to legacy", async () => {
    const client = clientReturning({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.my_access without parameters in the schema cache" },
      status: 404,
    });
    expect((await fetchMyAccess(client)).status).toBe("legacy");
  });

  it("maps a bare 404 to legacy", async () => {
    const client = clientReturning({ data: null, error: { code: "", message: "Not Found" }, status: 404 });
    expect((await fetchMyAccess(client)).status).toBe("legacy");
  });

  it("maps status no_workspace to legacy", async () => {
    const client = clientReturning({ data: { status: "no_workspace", user_id: "u", workspace_id: null }, error: null, status: 200 });
    expect((await fetchMyAccess(client)).status).toBe("legacy");
  });

  it("maps no client (Supabase not configured) to legacy", async () => {
    expect((await fetchMyAccess(null)).status).toBe("legacy");
  });

  it("passes no_membership and disabled through without permissions", async () => {
    for (const status of ["no_membership", "disabled"] as const) {
      const client = clientReturning({ data: { status, user_id: "user-x", workspace_id: "ws-1" }, error: null, status: 200 });
      const access = await fetchMyAccess(client);
      expect(access.status).toBe(status);
      expect(access.user_id).toBe("user-x");
      expect(access.workspace_id).toBe("ws-1");
      expect(access.role).toBeNull();
      expect(access.partition).toBe("");
    }
  });

  it("maps other RPC errors to error (never legacy)", async () => {
    const client = clientReturning({ data: null, error: { code: "42501", message: "permission denied for function my_access" }, status: 403 });
    const access = await fetchMyAccess(client);
    expect(access.status).toBe("error");
    expect(access.error).toContain("42501");
  });

  it("maps a thrown client error to error", async () => {
    const client: MyAccessRpcClient = { rpc: () => Promise.reject(new TypeError("Failed to fetch")) };
    const access = await fetchMyAccess(client);
    expect(access.status).toBe("error");
    expect(access.error).toContain("Failed to fetch");
  });

  it("times out a hung RPC as error", async () => {
    const client: MyAccessRpcClient = { rpc: () => new Promise(() => {}) };
    const access = await fetchMyAccess(client, { timeoutMs: 10 });
    expect(access.status).toBe("error");
  });

  it("maps empty data to error", async () => {
    const client = clientReturning({ data: null, error: null, status: 200 });
    expect((await fetchMyAccess(client)).status).toBe("error");
  });
});

describe("parseMyAccessPayload", () => {
  it("parses a JSON string payload", () => {
    expect(parseMyAccessPayload(JSON.stringify(okRow())).status).toBe("ok");
  });

  it("rejects unknown statuses", () => {
    expect(parseMyAccessPayload({ status: "admin", user_id: "u" }).status).toBe("error");
    expect(parseMyAccessPayload([okRow()]).status).toBe("error");
  });

  it("fails closed when an ok payload misses what the UI keys on", () => {
    for (const field of ["partition", "access_version", "member_id", "workspace_id", "user_id", "role"]) {
      const access = parseMyAccessPayload(okRow({ [field]: null }));
      expect(access.status, field).toBe("error");
      expect(access.error, field).toContain(field);
    }
    expect(parseMyAccessPayload(okRow({ role: { id: "", key: "viewer", permissions: [] } })).status).toBe("error");
  });

  it("treats a missing or unknown funnel scope as none (no rule ⇒ no data)", () => {
    expect(parseMyAccessPayload(okRow({ funnel_scope: null })).funnel_scope?.mode).toBe("none");
    expect(parseMyAccessPayload(okRow({ funnel_scope: { mode: "everything" } })).funnel_scope?.mode).toBe("none");
    const selected = parseMyAccessPayload(okRow({ funnel_scope: { mode: "selected", funnel_ids: ["f1", 7], paths: ["soulmate-sketch"] } }));
    expect(selected.funnel_scope).toEqual({ mode: "selected", funnel_ids: ["f1"], paths: ["soulmate-sketch"] });
  });

  it("drops non-string permission entries", () => {
    const access = parseMyAccessPayload(okRow({ role: { id: "r", key: "k", name: "K", is_owner: false, permissions: ["cohorts.view", 1, null] } }));
    expect(access.role?.permissions).toEqual(["cohorts.view"]);
  });
});

describe("isMissingRpcError", () => {
  it("matches only PGRST202 or HTTP 404", () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpcError(null, 404)).toBe(true);
    expect(isMissingRpcError({ code: "PGRST301" }, 401)).toBe(false);
    expect(isMissingRpcError({ code: "42883" }, 400)).toBe(false);
    expect(isMissingRpcError(null, 200)).toBe(false);
  });
});
