// funnels.ts is a thin wrapper around Supabase's PostgREST/RPC calls, so
// these tests fake the query builder rather than a real client — asserting
// the exact table/column/filter shape sent, and that the funnel_tags(tags(*))
// embed is correctly flattened, is what actually protects against a
// silently wrong query.
import { beforeEach, describe, expect, it, vi } from "vitest";

const authGetUser = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock("@/services/supabaseClient", () => ({
  supabase: {
    auth: { getUser: authGetUser },
    from: fromMock,
    rpc: rpcMock,
  },
}));

// A minimal thenable query builder: every chain method records its call and
// returns `this`; `.single()` and bare `await` both resolve to the injected
// result, matching how supabase-js builders behave.
function fakeBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn((..._args: unknown[]) => builder),
    insert: vi.fn((..._args: unknown[]) => builder),
    update: vi.fn((..._args: unknown[]) => builder),
    delete: vi.fn((..._args: unknown[]) => builder),
    eq: vi.fn((..._args: unknown[]) => builder),
    order: vi.fn((..._args: unknown[]) => builder),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

async function importFunnels() {
  return import("@/services/funnels");
}

beforeEach(() => {
  vi.resetModules();
  authGetUser.mockReset();
  fromMock.mockReset();
  rpcMock.mockReset();
  authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
});

describe("funnels service", () => {
  it("listFunnels: queries the embedded tag select and flattens funnel_tags(tags(*)) into tags[]", async () => {
    const builder = fakeBuilder({
      data: [
        {
          id: "f1",
          funnel_path: "soulmate-sketch",
          display_name: "Soulmate",
          is_active: true,
          created_by: "user-1",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-02T00:00:00Z",
          funnel_tags: [{ tags: { id: "t1", name: "Live", created_by: "user-1", created_at: "2026-06-01T00:00:00Z" } }],
        },
        {
          id: "f2",
          funnel_path: "palm-reading",
          display_name: "",
          is_active: false,
          created_by: null,
          created_at: "2026-07-03T00:00:00Z",
          updated_at: "2026-07-03T00:00:00Z",
          funnel_tags: [],
        },
      ],
      error: null,
    });
    fromMock.mockReturnValue(builder);

    const { listFunnels } = await importFunnels();
    const result = await listFunnels();

    expect(fromMock).toHaveBeenCalledWith("funnels");
    expect(builder.select).toHaveBeenCalledWith(
      "id,funnel_path,display_name,is_active,created_by,created_at,updated_at,funnel_tags(tags(id,name,created_by,created_at))",
    );
    expect(builder.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(result).toHaveLength(2);
    expect(result[0].tags).toEqual([{ id: "t1", name: "Live", created_by: "user-1", created_at: "2026-06-01T00:00:00Z" }]);
    expect(result[0]).not.toHaveProperty("funnel_tags");
    expect(result[1].tags).toEqual([]);
  });

  it("listFunnels: surfaces the Supabase error with a descriptive prefix", async () => {
    fromMock.mockReturnValue(fakeBuilder({ data: null, error: { message: "boom" } }));
    const { listFunnels } = await importFunnels();
    await expect(listFunnels()).rejects.toThrow("Could not load funnels: boom");
  });

  it("createFunnel: trims funnel_path, stamps created_by from the session, and requests tags: []", async () => {
    const builder = fakeBuilder({
      data: { id: "f1", funnel_path: "soulmate-sketch", display_name: "Soulmate", is_active: true, created_by: "user-1", created_at: "t", updated_at: "t" },
      error: null,
    });
    fromMock.mockReturnValue(builder);

    const { createFunnel } = await importFunnels();
    const result = await createFunnel({ funnel_path: "  soulmate-sketch  ", display_name: " Soulmate " });

    expect(builder.insert).toHaveBeenCalledWith({ funnel_path: "soulmate-sketch", display_name: "Soulmate", created_by: "user-1" });
    expect(builder.single).toHaveBeenCalled();
    expect(result.tags).toEqual([]);
  });

  it("createFunnel: rejects an empty funnel_path without calling Supabase", async () => {
    const { createFunnel } = await importFunnels();
    await expect(createFunnel({ funnel_path: "   ", display_name: "x" })).rejects.toThrow("Funnel path is required.");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("createFunnel: turns a unique-violation (23505) into a friendly duplicate-path message", async () => {
    fromMock.mockReturnValue(fakeBuilder({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }));
    const { createFunnel } = await importFunnels();
    await expect(createFunnel({ funnel_path: "soulmate-sketch", display_name: "x" })).rejects.toThrow(
      'A funnel with path "soulmate-sketch" already exists.',
    );
  });

  it("updateFunnelDisplayName: does not touch funnel_path — only display_name is in the update payload", async () => {
    const builder = fakeBuilder({
      data: { id: "f1", funnel_path: "soulmate-sketch", display_name: "New Name", is_active: true, created_by: "user-1", created_at: "t", updated_at: "t" },
      error: null,
    });
    fromMock.mockReturnValue(builder);

    const { updateFunnelDisplayName } = await importFunnels();
    await updateFunnelDisplayName("f1", "  New Name  ");

    expect(builder.update).toHaveBeenCalledWith({ display_name: "New Name" });
    expect(builder.update.mock.calls[0][0]).not.toHaveProperty("funnel_path");
    expect(builder.eq).toHaveBeenCalledWith("id", "f1");
  });

  it("setFunnelActive: updates only is_active, by id, and returns void on success", async () => {
    const builder = fakeBuilder({ data: null, error: null });
    fromMock.mockReturnValue(builder);
    const { setFunnelActive } = await importFunnels();

    await expect(setFunnelActive("f1", false)).resolves.toBeUndefined();
    expect(builder.update).toHaveBeenCalledWith({ is_active: false });
    expect(builder.eq).toHaveBeenCalledWith("id", "f1");
  });

  it("listTags: orders alphabetically by name", async () => {
    const builder = fakeBuilder({ data: [{ id: "t1", name: "Live", created_by: null, created_at: "t" }], error: null });
    fromMock.mockReturnValue(builder);
    const { listTags } = await importFunnels();

    const result = await listTags();
    expect(fromMock).toHaveBeenCalledWith("tags");
    expect(builder.order).toHaveBeenCalledWith("name", { ascending: true });
    expect(result).toHaveLength(1);
  });

  it("createTag: rejects empty/whitespace-only names before calling Supabase", async () => {
    const { createTag } = await importFunnels();
    await expect(createTag("   ")).rejects.toThrow("Tag name is required.");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("createTag: turns a unique-violation into a friendly duplicate-tag message (matches the case/whitespace-insensitive index)", async () => {
    fromMock.mockReturnValue(fakeBuilder({ data: null, error: { code: "23505", message: "duplicate key" } }));
    const { createTag } = await importFunnels();
    await expect(createTag("Live")).rejects.toThrow('A tag named "Live" already exists.');
  });

  it("renameTag: trims and updates by id", async () => {
    const builder = fakeBuilder({ data: { id: "t1", name: "Testing", created_by: null, created_at: "t" }, error: null });
    fromMock.mockReturnValue(builder);
    const { renameTag } = await importFunnels();

    await renameTag("t1", "  Testing  ");
    expect(builder.update).toHaveBeenCalledWith({ name: "Testing" });
    expect(builder.eq).toHaveBeenCalledWith("id", "t1");
  });

  it("deleteTag: deletes by id", async () => {
    const builder = fakeBuilder({ data: null, error: null });
    fromMock.mockReturnValue(builder);
    const { deleteTag } = await importFunnels();

    await deleteTag("t1");
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "t1");
  });

  it("replaceFunnelTags: calls the RPC with the exact p_funnel_id/p_tag_ids param names — one atomic call, not two writes", async () => {
    rpcMock.mockResolvedValue({ data: { funnel_id: "f1", tag_count: 2 }, error: null });
    const { replaceFunnelTags } = await importFunnels();

    await replaceFunnelTags("f1", ["t1", "t2"]);
    expect(rpcMock).toHaveBeenCalledWith("replace_funnel_tags", { p_funnel_id: "f1", p_tag_ids: ["t1", "t2"] });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("replaceFunnelTags: surfaces the RPC's rejection (e.g. an unknown tag id) as a descriptive error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "Unknown tag id(s): {00000000-0000-0000-0000-000000000000}" } });
    const { replaceFunnelTags } = await importFunnels();

    await expect(replaceFunnelTags("f1", ["missing"])).rejects.toThrow("Could not update funnel tags: Unknown tag id(s)");
  });
});
