/* global Deno */

import {
  fetchFunnelFox,
  getFunnelFoxSecret,
  isFunnelFoxDebugEnabled,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
  profileDebugBody,
  profileMinimalBody,
  readRequestParams,
} from "../_shared/funnelfox.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const params = await readRequestParams(req);
  const profileId = params.get("id")?.trim();
  const debugRequested = ["1", "true"].includes((params.get("debug") ?? "").trim().toLowerCase());
  // Rich profile payload is exposed only when the server explicitly enables debug AND the caller
  // opts in. In production (FUNNELFOX_DEBUG unset) this is always false (P0-5).
  const debug = isFunnelFoxDebugEnabled() && debugRequested;

  if (!profileId) {
    return jsonResponse({ error: "FunnelFox profile id is required." }, 400);
  }

  const secret = getFunnelFoxSecret();
  if (!secret) {
    return jsonResponse({ error: "FunnelFox sync is not configured." }, 500);
  }

  try {
    const upstream = await fetchFunnelFox(`/profiles/${encodeURIComponent(profileId)}`, secret);
    if (!upstream.ok) {
      return jsonResponse({ error: "FunnelFox profile request failed." }, upstream.status);
    }

    return jsonResponse(
      debug
        ? profileDebugBody(profileId, upstream.payload)
        : profileMinimalBody(profileId, upstream.payload),
    );
  } catch {
    return jsonResponse({ error: "FunnelFox profile request failed." }, 502);
  }
});
