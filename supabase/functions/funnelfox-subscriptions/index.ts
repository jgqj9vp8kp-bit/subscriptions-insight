/* global Deno */

// funnelfox-subscriptions: proxy of FunnelFox GET /subscriptions (raw upstream
// page, customer emails included) for the data owner's Import page.
//
// Access (policies/funnelfox-subscriptions.ts): rawOnly + admin.sync.run on both
// actions — `list` (the raw page) and `connection_test` (the `debug` flag:
// counts only). The gate authenticates before anything runs; CORS, OPTIONS and
// the GET / POST method check come from it. Parameters are read exactly as
// before (query string first, then body keys).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { FUNNELFOX_SUBSCRIPTIONS_POLICY } from "../_shared/access/policies/funnelfox-subscriptions.ts";
import {
  FunnelFoxEdgeError,
  fetchFunnelFox,
  funnelFoxErrorResponse,
  funnelFoxFailure,
  funnelFoxRequestParams,
  getFunnelFoxSecret,
  subscriptionsDebugBody,
} from "../_shared/funnelfox.ts";

serveWithAccess(FUNNELFOX_SUBSCRIPTIONS_POLICY, async ({ ctx, action, body, url }) => {
  const params = funnelFoxRequestParams(url, body);
  const debug = action === "connection_test";
  const cursor = params.get("cursor")?.trim();
  const secret = getFunnelFoxSecret();

  if (!secret) {
    return debug
      ? subscriptionsDebugBody(false, false)
      : funnelFoxFailure(ctx, 500, { error: "FunnelFox sync is not configured." });
  }

  const path = cursor ? `/subscriptions?cursor=${encodeURIComponent(cursor)}` : "/subscriptions";

  try {
    const upstream = await fetchFunnelFox(path, secret);
    if (debug) {
      return subscriptionsDebugBody(true, upstream.ok, upstream.status, upstream.payload);
    }

    if (!upstream.ok) {
      return funnelFoxFailure(ctx, upstream.status, { error: "FunnelFox API request failed." });
    }

    return upstream.payload;
  } catch (error) {
    if (error instanceof FunnelFoxEdgeError) throw error;
    return debug
      ? subscriptionsDebugBody(true, false)
      : funnelFoxFailure(ctx, 502, { error: "FunnelFox API request failed." });
  }
}, { onError: funnelFoxErrorResponse });
