/* global Deno */

// funnelfox-subscription: proxy of FunnelFox GET /subscriptions/{id} (raw
// upstream detail, customer email included) for the data owner's Import page.
//
// Access (policies/funnelfox-subscription.ts): rawOnly + admin.sync.run. The
// gate authenticates before anything runs; CORS, OPTIONS and the GET / POST
// method check come from it. Parameters are read exactly as before (query
// string first, then body keys).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { FUNNELFOX_SUBSCRIPTION_POLICY } from "../_shared/access/policies/funnelfox-subscription.ts";
import {
  FunnelFoxEdgeError,
  fetchFunnelFox,
  funnelFoxErrorResponse,
  funnelFoxFailure,
  funnelFoxRequestParams,
  getFunnelFoxSecret,
} from "../_shared/funnelfox.ts";

serveWithAccess(FUNNELFOX_SUBSCRIPTION_POLICY, async ({ ctx, body, url }) => {
  const params = funnelFoxRequestParams(url, body);
  const subscriptionId = params.get("id")?.trim();

  if (!subscriptionId) {
    return funnelFoxFailure(ctx, 400, { error: "FunnelFox subscription id is required." });
  }

  const secret = getFunnelFoxSecret();
  if (!secret) {
    return funnelFoxFailure(ctx, 500, { error: "FunnelFox sync is not configured." });
  }

  try {
    const upstream = await fetchFunnelFox(`/subscriptions/${encodeURIComponent(subscriptionId)}`, secret);
    if (!upstream.ok) {
      return funnelFoxFailure(ctx, upstream.status, { error: "FunnelFox subscription details request failed." });
    }

    return upstream.payload;
  } catch (error) {
    if (error instanceof FunnelFoxEdgeError) throw error;
    return funnelFoxFailure(ctx, 502, { error: "FunnelFox subscription details request failed." });
  }
}, { onError: funnelFoxErrorResponse });
