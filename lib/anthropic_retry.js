// lib/anthropic_retry.js
// Single source of truth for upstream Anthropic retry/backoff, shared by all
// three assessment tiers (assess.js, assess_deep.js, assess_full.js) so the
// logic can never drift between them.
//
// Anthropic calls fail transiently under load in two recoverable ways:
//   • 429 Too Many Requests — our request rate hit the tier ceiling. The
//     response carries a Retry-After header telling us exactly how long to wait.
//   • 529 Overloaded — Anthropic-side capacity, not our fault. No header to
//     honor, so we back off exponentially with full jitter (so many clients
//     retrying after one overload don't all fire again in lockstep).
//
// We retry ONLY these two fast-failing statuses — never a timeout, since a
// timed-out call has already spent the function's time budget — and only while
// an absolute deadline leaves room, so total time stays inside Vercel's limit.
// Timeouts and network errors propagate to the caller's existing handling.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with an abort-based timeout.
export async function fetchTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Exponential backoff with full jitter (529 / overloaded). attempt is 1-based.
function backoffWithJitter(attempt, baseMs = 500, capMs = 8000) {
  const ceil = Math.min(capMs, baseMs * Math.pow(2, attempt - 1));
  return Math.floor(Math.random() * ceil); // full jitter: [0, ceil)
}

// 429 → honor Retry-After (delta-seconds or HTTP-date). Falls back to jittered
// backoff when the header is absent or unparseable.
function retryAfterMs(resp, attempt) {
  try {
    const h = resp.headers && resp.headers.get && resp.headers.get('retry-after');
    if (h) {
      const secs = Number(h);
      if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
      const when = Date.parse(h);
      if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
    }
  } catch (_) {}
  return backoffWithJitter(attempt);
}

// Retry an upstream Anthropic call on 429/529. `doFetch(remainingMs)` performs a
// single attempt and owns its own timeout/abort — it receives the remaining
// budget so a per-attempt timeout never overruns the deadline. Returns the
// Response with body UNREAD, so JSON and streaming callers both work. After
// maxAttempts, or when the next wait wouldn't fit the deadline, returns the last
// (error) Response so the caller's existing !ok handling fires unchanged.
export async function anthropicWithRetry(doFetch, { deadlineMs = 55000, maxAttempts = 3, label = 'anthropic' } = {}) {
  const deadline = Date.now() + deadlineMs;
  let attempt = 0;
  while (true) {
    attempt++;
    const remaining = Math.max(0, deadline - Date.now());
    const resp = await doFetch(remaining);
    const retryable = resp.status === 429 || resp.status === 529;
    if (!retryable || attempt >= maxAttempts) return resp;
    const waitMs = resp.status === 429 ? retryAfterMs(resp, attempt) : backoffWithJitter(attempt);
    if (Date.now() + waitMs >= deadline) return resp; // no budget left → surface the error
    try { await resp.text(); } catch (_) {}            // drain so the socket frees
    console.warn(`[${label}] upstream ${resp.status} on attempt ${attempt}/${maxAttempts}; retry in ${waitMs}ms`);
    await sleep(waitMs);
  }
}
