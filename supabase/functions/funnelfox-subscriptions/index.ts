/* global Deno */

import {
  fetchFunnelFox,
  getFunnelFoxSecret,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
  readRequestParams,
  subscriptionsDebugBody,
} from "../_shared/funnelfox.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const params = await readRequestParams(req);
  const debug = params.get("debug") === "1" || params.get("debug") === "true";
  const cursor = params.get("cursor")?.trim();
  const secret = getFunnelFoxSecret();

  if (!secret) {
    return debug
      ? jsonResponse(subscriptionsDebugBody(false, false))
      : jsonResponse({ error: "FunnelFox sync is not configured." }, 500);
  }

  const path = cursor ? `/subscriptions?cursor=${encodeURIComponent(cursor)}` : "/subscriptions";

  try {
    const upstream = await fetchFunnelFox(path, secret);
    if (debug) {
      return jsonResponse(subscriptionsDebugBody(true, upstream.ok, upstream.status, upstream.payload));
    }

    if (!upstream.ok) {
      return jsonResponse({ error: "FunnelFox API request failed." }, upstream.status);
    }

    return jsonResponse(upstream.payload);
  } catch {
    return debug
      ? jsonResponse(subscriptionsDebugBody(true, false))
      : jsonResponse({ error: "FunnelFox API request failed." }, 502);
  }
});
