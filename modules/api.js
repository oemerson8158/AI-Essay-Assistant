///////////////////////////////////////////////////////////////////////////
// api.js
//  The one place the app calls the AI worker from. Every request carries the
//  signed-in user's Firebase ID token, which the worker verifies, and passes
//  through ensureAiNotice() first.
//
//  The AI has a per-minute token limit, so features that send a long text cut
//  it into sections (splitIntoSections) and send them one request at a time
//  through a shared queue (requestWithRetry), waiting out the limit between
//  them. Both are ported from the AI Document Reader's worker-sections.js.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { getIdToken } from "./firebase.js";

// The essay assistant's own worker (not the Reader's). The first part is the
// worker's name and the last part is your Cloudflare account's workers.dev
// subdomain, shown on the worker's page in the dashboard. Check this matches.
const WORKER_BASE_URL = "https://essay-assistant-worker.oemerson8158.workers.dev";

const REQUEST_TIMEOUT_MS = 90000;   // a request with no answer by now is given up on
const MAX_ATTEMPTS_PER_SECTION = 3;
const MAX_WAIT_SECONDS = 90;        // longest single wait for the rate limit that we'll sit through
const MAX_RATE_LIMIT_WAITS = 6;     // rate-limit waits one section allows before giving up

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
// Calling the worker
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: postOnce
//  Inputs: path (worker route), body (JSON-serializable), token (or null)
//  Outputs: Promise<Response> — the raw fetch response
//  Summary: One POST with an Authorization header if there is a token. Gives
//    up (the fetch rejects with an AbortError) after REQUEST_TIMEOUT_MS, so a
//    stuck request can't block the queue forever.
///////////////////////////////////////////////////////////////////////////
async function postOnce(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: workerFetch
//  Inputs: path (worker route, e.g. "/transition/suggest"), body
//    (JSON-serializable)
//  Outputs: Promise<Response> — the raw fetch response. Rejects with
//    error.code === "ai-notice-declined" if ensureAiNotice() said no.
//  Summary: POSTs the body as JSON with the student's ID token. If the worker
//    answers 401 (the token may have expired while the tab sat open), gets a
//    freshly refreshed token and sends the request once more. If that also
//    fails, the 401 is returned and the caller shows the worker's message,
//    which asks the student to sign in again. If no token can be had at all,
//    the request is still sent so the worker can say so.
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

  const response = await postOnce(path, body, token);
  if (response.status !== 401) return response;

  let freshToken = null;
  try {
    freshToken = await getIdToken(true);
  } catch (err) {
    console.warn("API: couldn't refresh the ID token after a 401:", err);
    return response;
  }

  return postOnce(path, body, freshToken);
}

///////////////////////////////////////////////////////////////////////////
// Splitting a long text into sections
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: splitIntoSections
//  Inputs: items (the pieces of text to split, each with .text), maxChars
//    (the most text one request can carry)
//  Outputs: [{ startIndex, paragraphs: [text, ...], chars }]
//  Summary: Cuts the text into as few, evenly-sized sections as the limit
//    allows, so a long text doesn't end with a tiny last section that still
//    costs a full wait. Items are never split.
///////////////////////////////////////////////////////////////////////////
function splitIntoSections(items, maxChars) {
  const total = items.reduce((n, item) => n + item.text.length, 0);
  const sectionCount = Math.max(1, Math.ceil(total / maxChars));
  const target = total / sectionCount;

  const sections = [];
  let current = null;

  items.forEach((item, index) => {
    const len = item.text.length;
    const startNew =
      !current ||
      (current.paragraphs.length > 0 &&
        (current.chars + len > maxChars ||
          (current.chars >= target && sections.length < sectionCount)));

    if (startNew) {
      current = { startIndex: index, paragraphs: [], chars: 0 };
      sections.push(current);
    }
    current.paragraphs.push(item.text);
    current.chars += len;
  });

  return sections;
}

///////////////////////////////////////////////////////////////////////////
// Sending with waits and retries
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: waitWithCountdown
//  Inputs: seconds, buildText(remaining) -> status string, shouldStop(),
//    setStatus(text)
//  Outputs: Promise<boolean> — false if the student stopped the wait
//  Summary: Waits one second at a time, updating the status line each tick.
///////////////////////////////////////////////////////////////////////////
async function waitWithCountdown(seconds, buildText, shouldStop, setStatus) {
  for (let remaining = Math.ceil(seconds); remaining > 0; remaining--) {
    if (shouldStop()) return false;
    setStatus(buildText(remaining));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return !shouldStop();
}

///////////////////////////////////////////////////////////////////////////
//  Function: sendWithRetry
//  Inputs:
//    path — worker route, e.g. "/transition/suggest"
//    body — the request body
//    label — name for this request in status text ("Reading section 2 of 4...")
//    isStale() — true if what the request was for is gone (a different
//      document was opened). Default: never.
//    shouldStop() — true if the student pressed Stop (or isStale()). Default:
//      never.
//    setStatus(text) — shows a status line while waiting. Default: nothing.
//    fallbackMessage — shown if the worker gives no message of its own
//  Outputs, one of:
//    { ok: true, data }                            — the worker's JSON
//    { cancelled: true }                           — stopped, or no longer wanted
//    { ok: false, tooLong: true, message? }        — too big to send at all
//    { ok: false, message, retryAfterSeconds? }    — failed; message is fit to show
//  Summary: Sends one request. If the AI reports its per-minute limit, waits
//    the time it asks for (with a countdown) and tries again.
///////////////////////////////////////////////////////////////////////////
async function sendWithRetry({
  path,
  body,
  label = "Working...",
  isStale = () => false,
  shouldStop = () => false,
  setStatus = () => {},
  fallbackMessage = "Couldn't reach the AI right now. Try again in a moment."
}) {
  // Rate-limit waits are expected, so they're counted separately and don't
  // use up the request's attempts.
  let rateLimitWaits = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SECTION; attempt++) {
    if (shouldStop()) return { cancelled: true };

    let response;
    let data;
    try {
      response = await workerFetch(path, body);
      data = await response.json();
    } catch (err) {
      if (err && err.code === "ai-notice-declined") {
        return { ok: false, message: "The AI tools can't be used until the notice is accepted." };
      }
      console.error(`${path}: network error:`, err);
      return {
        ok: false,
        message: err && err.name === "AbortError"
          ? "The server took too long to answer. Try again in a moment."
          : "Couldn't reach the server. Check your connection and try again."
      };
    }

    // What this was for is gone (for example, a different document was opened).
    if (isStale()) return { cancelled: true };

    if (response.ok && !data.error) return { ok: true, data };

    const wait = Number(data.retryAfterSeconds) || 60;
    const willWait =
      data.error === "rate_limited" &&
      rateLimitWaits < MAX_RATE_LIMIT_WAITS &&
      wait <= MAX_WAIT_SECONDS;

    if (willWait) {
      console.info(`${path}: the AI is at its per-minute limit. Waiting ${wait}s, then retrying (wait ${rateLimitWaits + 1} of ${MAX_RATE_LIMIT_WAITS}).`);

      const finished = await waitWithCountdown(
        wait + 1,
        secs => `${label} Waiting ${secs}s for the AI's per-minute limit to reset...`,
        shouldStop,
        setStatus
      );
      if (!finished) return { cancelled: true };
      rateLimitWaits++;
      attempt--;
      continue;
    }

    // Unreadable answers are random rather than a sign the request is bad,
    // so just ask again.
    if (data.error === "unreadable_response" && attempt < MAX_ATTEMPTS_PER_SECTION) {
      console.warn(`${path}: the AI's answer couldn't be read; trying again (attempt ${attempt} of ${MAX_ATTEMPTS_PER_SECTION}).`);
      setStatus(`${label} Retrying...`);
      continue;
    }

    console.error(`${path}: worker error:`, data.error || data);

    // The caller skips a too-big section rather than failing the whole run.
    // The worker's message says how long the text was and what to try, which
    // single-request callers show to the student.
    if (data.error === "too_long") {
      return { ok: false, tooLong: true, message: typeof data.message === "string" ? data.message : undefined };
    }

    return {
      ok: false,
      message: typeof data.message === "string" ? data.message : fallbackMessage,
      // Lets the caller hold off retrying for as long as the worker asked.
      retryAfterSeconds: data.error === "rate_limited" ? wait : undefined
    };
  }

  return { ok: false, message: "The AI stayed busy. Wait a minute and try again." };
}

///////////////////////////////////////////////////////////////////////////
// Request queue
//  All AI features share one per-minute AI budget, so running two at once
//  would make them rate-limit each other. Every request goes through this
//  queue and is sent only after the one before it finishes. Stop (or opening
//  another document) still works while a request waits.
///////////////////////////////////////////////////////////////////////////

let queueTail = Promise.resolve();
let activeRequests = 0; // running + waiting

///////////////////////////////////////////////////////////////////////////
//  Function: waitForTurn
//  Inputs: previous (promise for the request ahead), shouldStop()
//  Outputs: Promise<boolean> — true when it's this request's turn, false if
//    stopped while waiting
//  Summary: Resolves when the request ahead finishes, or earlier if stopped.
///////////////////////////////////////////////////////////////////////////
function waitForTurn(previous, shouldStop) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve(value);
    };
    const poll = setInterval(() => { if (shouldStop()) finish(false); }, 500);
    previous.then(() => finish(true));
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: requestWithRetry
//  Inputs: options — same as sendWithRetry
//  Outputs: Same as sendWithRetry
//  Summary: Queues the request behind any others, then sends it. This is
//    the function the features call.
///////////////////////////////////////////////////////////////////////////
async function requestWithRetry(options) {
  const opts = {
    label: "Working...",
    isStale: () => false,
    shouldStop: () => false,
    setStatus: () => {},
    ...options
  };

  const previous = queueTail;
  let release;
  queueTail = new Promise(resolve => { release = resolve; });

  if (activeRequests > 0) {
    opts.setStatus(`${opts.label} Waiting for another AI task to finish...`);
  }
  activeRequests++;

  try {
    const myTurn = await waitForTurn(previous, opts.shouldStop);
    if (!myTurn) return { cancelled: true };
    return await sendWithRetry(opts);
  } finally {
    activeRequests--;
    // Release the next request only once the one ahead has finished, even
    // if this one gave up while still waiting.
    previous.then(release);
  }
}

///////////////////////////////////////////////////////////////////////////
// Features
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: suggestTransition
//  Inputs: { fromIdea, toIdea, methodId, setStatus } — methodId is one of
//    "echo", "spatial-temporal", "pivot", "umbrella", "double-agent";
//    setStatus(text) is optional
//  Outputs: Promise of one of
//    { ok: true, suggestion, explanation }
//    { ok: false, message }       — message is fit to show the student
//    { ok: false, cancelled: true }
//  Summary: Asks the worker's /transition/suggest route for an example
//    transition. The Phase 6 Transition Helper uses this; until then it is
//    handy for testing from the browser console.
///////////////////////////////////////////////////////////////////////////
async function suggestTransition({ fromIdea, toIdea, methodId, setStatus = () => {} }) {
  const result = await requestWithRetry({
    path: "/transition/suggest",
    body: { fromIdea, toIdea, methodId },
    label: "Thinking...",
    setStatus,
    fallbackMessage: "Couldn't suggest a transition right now. Try again in a moment."
  });

  if (result.cancelled) return { ok: false, cancelled: true };
  if (!result.ok) return { ok: false, message: result.message };

  const { suggestion, explanation } = result.data;
  if (typeof suggestion !== "string" || typeof explanation !== "string") {
    console.error("TRANSITION: invalid worker result format:", result.data);
    return { ok: false, message: "The server sent back something unexpected. Try again." };
  }

  return { ok: true, suggestion, explanation };
}

export {
  workerFetch,
  ensureAiNotice,
  splitIntoSections,
  requestWithRetry,
  suggestTransition,
  WORKER_BASE_URL
};