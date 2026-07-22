// Pure bearer-session gate shared by ClickHouse Edge Functions. Keeping token
// parsing and user-session validation dependency-free makes the security
// contract testable without importing the Deno/Supabase runtime.

export interface VerifiedEdgeIdentity {
  id: string;
  email: string | null;
  token: string;
}

export type EdgeAuthDecision =
  | VerifiedEdgeIdentity
  | { status: 401; body: { error: string } };

export function extractBearerToken(authorization: string | null | undefined): string {
  return (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

export async function verifyEdgeBearerSession(input: {
  authorization: string | null | undefined;
  getUser: (token: string) => Promise<{
    data: { user: { id?: string | null; email?: string | null } | null };
    error: { message?: string } | null;
  }>;
}): Promise<EdgeAuthDecision> {
  const token = extractBearerToken(input.authorization);
  if (!token) return { status: 401, body: { error: "Authentication required." } };
  const { data, error } = await input.getUser(token);
  if (error || !data.user?.id) return { status: 401, body: { error: "Invalid or expired session." } };
  return { id: data.user.id, email: data.user.email ?? null, token };
}
