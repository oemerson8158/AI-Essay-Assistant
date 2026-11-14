///////////////////////////////////////////////////////////////////////////
// api.js
//  The one place the app calls the AI worker from. Every request carries the
//  signed-in user's Firebase ID token, which the worker verifies, and passes
//  through ensureAiNotice() first.
//
//  Phase 1 has only the basics. Phase 2 (step 2.4) adds the single retry on
//  a 401 with a refreshed token, and ports the Reader's request queue and
//  section splitter (requestWithRetry, splitIntoSections).
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { getIdToken } from "./firebase.js";

// The essay assistant's own worker (not the Reader's). The first part is the
// worker's name and the last part is your Cloudflare account's workers.dev
// subdomain, shown on the worker's page in the dashboard. Check this matches.
const WORKER_BASE_URL = "https://essay-assistant-worker.oemerson8158.workers.dev";

///////////////////////////////////////////////////////////////////////////
//  Function: ensureAiNotice
//  Inputs: None
//  Outputs: Promise<boolean> — true if the AI call may go ahead
//  Summary: The hook for a future consent notice (see Architecture 9). Every
//    AI call passes through here, so a notice can be added in this one place
//    without touching any feature. In v1 it does nothing and always allows
//    the call. A real version would show a dialog the first time and
//    remember the answer (users/{uid}.aiNoticeAcceptedAt), resolving false if
//    the student declines.
///////////////////////////////////////////////////////////////////////////
async function ensureAiNotice() {
  return true;
}

///////////////////////////////////////////////////////////////////////////
//  Function: workerFetch
//  Inputs: path (worker route, e.g. "/transition/suggest"), body
//    (JSON-serializable)
//  Outputs: Promise<Response> — the raw fetch response. Rejects with
//    error.code === "ai-notice-declined" if ensureAiNotice() said no.
//  Summary: POSTs the body as JSON with an Authorization header. If no token
//    can be had, the request is still sent; the worker answers 401 and the
//    caller shows that message.
///////////////////////////////////////////////////////////////////////////
async function workerFetch(path, body) {
  if (!(await ensureAiNotice())) {
    const err = new Error("The AI notice was not accepted.");
    err.code = "ai-notice-declined";
    throw err;
  }

  let token = null;
  try {
    token = await getIdToken();
  } catch (err) {
    console.warn("API: couldn't get an ID token:", err);
  }

  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  return fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

export { workerFetch, ensureAiNotice, WORKER_BASE_URL };