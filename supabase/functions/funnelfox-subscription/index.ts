/* global Deno */

import {
  fetchFunnelFox,
  getFunnelFoxSecret,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
  readRequestParams,
} from "../_shared/funnelfox.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const params = await readRequestParams(req);
  const subscriptionId = params.get("id")?.trim();

  if (!subscriptionId) {
    return jsonResponse({ error: "FunnelFox subscription id is required." }, 400);
  }

  const secret = getFunnelFoxSecret();
  if (!secret) {
    return jsonResponse({ error: "FunnelFox sync is not configured." }, 500);
  }

  try {
    const upstream = await fetchFunnelFox(`/subscriptions/${encodeURIComponent(subscriptionId)}`, secret);
    if (!upstream.ok) {
      return jsonResponse({ error: "FunnelFox subscription details request failed." }, upstream.status);
    }

    return jsonResponse(upstream.payload);
  } catch {
    return jsonResponse({ error: "FunnelFox subscription details request failed." }, 502);
  }
});
