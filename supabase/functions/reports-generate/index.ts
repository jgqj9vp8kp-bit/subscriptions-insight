/* global Deno */

// reports-generate: the only place a model is asked to write report prose.
//
// The browser sends the ALREADY COMPUTED narrative input — the same snapshot
// and findings the page is showing — and gets back validated text. It does not
// send a prompt: prompt construction, the response schema and every validation
// rule live in _shared/clickhouse/reportNarrative.ts, so a caller cannot widen
// what the model is allowed to say by changing what it posts.
//
// Two consequences worth stating plainly:
//   * the API key never leaves this function;
//   * the function computes nothing. It receives numbers, hands them to the
//     model as strings, and checks that everything that comes back was already
//     in what it received.
//
// Access is decided by REPORTS_GENERATE_POLICY before the handler runs
// (reports.edit + ai.use; funnel-restricted members are refused) and the
// session is verified before the body is parsed. The handler (./handler.ts,
// pure, unit-tested) then proves report_id belongs to the actor (else 404),
// takes the model from the server allowlist and logs the run under the actor.
//
// verify_jwt stays on: only a signed-in browser calls this.

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { REPORTS_GENERATE_POLICY } from "../_shared/access/policies/reports-generate.ts";
import { createReportsGenerateHandler } from "./handler.ts";

serveWithAccess(
  REPORTS_GENERATE_POLICY,
  createReportsGenerateHandler({ apiKey: anthropicApiKey, createModelCaller: createAnthropicModelCaller }),
);
