/* global Deno */

import {
  fetchFunnelFox,
  getFunnelFoxSecret,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
  profileDebugBody,
  readRequestParams,
} from "../_shared/funnelfox.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const params = await readRequestParams(req);
  const profileId = params.get("id")?.trim();

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

    return jsonResponse(profileDebugBody(profileId, upstream.payload));
  } catch {
    return jsonResponse({ error: "FunnelFox profile request failed." }, 502);
  }
});
