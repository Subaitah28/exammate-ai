// =====================================================
//  ExamMate AI – background.js  v2.0
//  FIXES:
//  1. Empty response bug — caused by Gemini returning
//     finishReason:"SAFETY" or "MAX_TOKENS" with no text.
//     Now inspects finishReason and returns clear errors.
//  2. Vercel cold-start timeout — added AbortController
//     with 25s timeout + 1 automatic retry on timeout.
//  3. Service worker lastRequestTime resets to 0 on
//     worker restart, making cooldown always pass on
//     first call after idle. This is correct behaviour.
//  4. Prompts fully redesigned — strict templates,
//     no markdown, ultra-compact, exam-focused output.
// =====================================================

const PROXY_URL     = "https://exammate-proxy.vercel.app/api/generate";
const MAX_DAILY     = 15;
const MAX_CHARS     = 5000;
const COOLDOWN_MS   = 8000;
const FETCH_TIMEOUT = 25000; // 25s — covers Vercel cold starts

let lastRequestTime = 0;

// =====================================================
//  MESSAGE LISTENER
// =====================================================
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GENERATE_AI") {
    handleGenerate(message)
      .then(r  => sendResponse(r))
      .catch(e => sendResponse({ success: false, error: e.message || "Unknown error" }));
    return true; // MUST return true for async in MV3
  }
  return false;
});

// =====================================================
//  handleGenerate
// =====================================================
async function handleGenerate({ action, text }) {

  // 1. Sanitise input
  const trimmed = (text || "").trim().slice(0, MAX_CHARS);
  if (!trimmed) return { success: false, error: "No text provided." };

  // 2. Daily limit
  const today = new Date().toISOString().slice(0, 10);
  const store = await chrome.storage.local.get(["usageDate", "usageCount"]);
  let count = (store.usageDate === today) ? (store.usageCount || 0) : 0;
  if (store.usageDate !== today) {
    await chrome.storage.local.set({ usageDate: today, usageCount: 0 });
  }
  if (count >= MAX_DAILY) {
    return { success: false, error: `Daily limit reached (${MAX_DAILY}/day). Resets at midnight.` };
  }

  // 3. Cooldown — only applies after at least one request this session
  if (lastRequestTime > 0) {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      return { success: false, error: `Wait ${wait}s before the next request.` };
    }
  }

  // 4. Build prompt
  const prompt = buildPrompt(action, trimmed);

  // 5. Fetch with timeout + 1 retry
  lastRequestTime = Date.now();
  const result = await fetchWithRetry(prompt);
  if (!result.success) return result;

  // 6. Increment usage
  await chrome.storage.local.set({ usageDate: today, usageCount: count + 1 });
  return { success: true, result: result.text, newCount: count + 1 };
}

// =====================================================
//  fetchWithRetry — timeout + 1 auto-retry
//  Covers Vercel cold start (can take 8-15s on free tier)
// =====================================================
async function fetchWithRetry(prompt, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(PROXY_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ prompt }),
      signal:  controller.signal
    });

    clearTimeout(timer);

    // HTTP-level error from Vercel/Gemini
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const msg  = body?.error?.message || `Server error ${response.status}`;

      // 429 = rate limit from Gemini
      if (response.status === 429) {
        return { success: false, error: "Gemini rate limit hit. Wait 60s and try again." };
      }
      return { success: false, error: msg };
    }

    const data = await response.json();

    // ── EMPTY RESPONSE ROOT CAUSE ANALYSIS ──────────
    // Gemini can return HTTP 200 with NO text for these reasons:
    //   a) finishReason: "SAFETY"    → content blocked by safety filter
    //   b) finishReason: "MAX_TOKENS"→ response cut off mid-generation
    //   c) finishReason: "RECITATION"→ copyright filter triggered
    //   d) candidates array is empty → usually a billing/quota issue
    //   e) parts array is empty      → rare malformed response
    // Previous code returned generic "Empty response" for ALL of these.
    // Now we detect each case and return a specific, useful error.
    // ────────────────────────────────────────────────

    const candidate = data?.candidates?.[0];

    if (!candidate) {
      // No candidates at all — check for top-level error
      const topError = data?.error?.message;
      if (topError) return { success: false, error: `Gemini error: ${topError}` };
      // Could be quota/billing issue
      return { success: false, error: "No response from Gemini. Check your API quota." };
    }

    const finishReason = candidate?.finishReason;
    const text = candidate?.content?.parts?.[0]?.text;

    if (!text) {
      // Diagnose WHY text is missing
      if (finishReason === "SAFETY") {
        return { success: false, error: "Gemini blocked this content (safety filter). Try different text." };
      }
      if (finishReason === "RECITATION") {
        return { success: false, error: "Gemini blocked this content (copyright filter). Try different text." };
      }
      if (finishReason === "MAX_TOKENS") {
        // Response was cut off — still usable if partial text exists
        // (In this case text would be non-empty, so this is rare)
        return { success: false, error: "Response was too long and got cut off. Try shorter text." };
      }
      // Unknown empty — retry once
      if (attempt < 2) {
        await sleep(1500);
        return fetchWithRetry(prompt, 2);
      }
      return { success: false, error: `Empty AI response (reason: ${finishReason || "unknown"}). Try again.` };
    }

    return { success: true, text: text.trim() };

  } catch (err) {
    clearTimeout(timer);

    // Timeout or network error
    if (err.name === "AbortError") {
      if (attempt < 2) {
        // Retry once — Vercel may have been waking up
        await sleep(2000);
        return fetchWithRetry(prompt, 2);
      }
      return { success: false, error: "Request timed out (25s). Vercel may be cold-starting. Try again in 10s." };
    }

    if (attempt < 2) {
      await sleep(1500);
      return fetchWithRetry(prompt, 2);
    }

    return { success: false, error: "Network error. Check your internet connection." };
  }
}

// =====================================================
//  sleep helper
// =====================================================
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// =====================================================
//  buildPrompt — v2.0
//
//  REDESIGN GOALS:
//  • No markdown symbols (no **, no ##, no _)
//  • Strict output templates — AI cannot freestyle
//  • Ultra-compact: max 1 line per concept
//  • Exam-focused density: every word earns its place
//  • Consistent structure across all 4 modes
//  • Explicit negative instructions to prevent bloat
// =====================================================
function buildPrompt(action, text) {

  // Shared rules injected into every prompt
  const RULES = `
STRICT RULES (follow exactly, no exceptions):
- NO markdown: no **, no ##, no __, no backticks
- NO intro sentences like "Here are..." or "Sure, I'll..."
- NO conclusions or summaries at the end
- NO explanations of what you're doing
- NO filler words, transitions, or padding
- Maximum 1 line per point
- Output ONLY what the template specifies, nothing else
`.trim();

  switch (action) {

    // ── STUDY NOTES ──────────────────────────────────
    case "notes":
      return `${RULES}

STUDY MATERIAL:
${text}

TASK: Create STUDY NOTES using this EXACT template:

STUDY NOTES
-----------
[Topic/concept label]: [one-line fact or definition]
[Topic/concept label]: [one-line fact or definition]
[Topic/concept label]: [one-line fact or definition]
... (6 to 10 lines total, no more)

EXAMPLE FORMAT (do not copy, just follow structure):
Photosynthesis: process by which plants make glucose using sunlight
Location: occurs inside chloroplasts
Inputs: sunlight, CO2, water
Output: glucose + oxygen
Stages: light reactions (ATP) + Calvin cycle (glucose)

Now write the study notes for the provided material:`;

    // ── KEY POINTS ───────────────────────────────────
    case "keypoints":
      return `${RULES}

STUDY MATERIAL:
${text}

TASK: Extract KEY EXAM POINTS using this EXACT template:

KEY EXAM POINTS
---------------
1. [single most important fact — max 12 words]
2. [second most important fact — max 12 words]
3. [third most important fact — max 12 words]
4. [fourth most important fact — max 12 words]
5. [fifth most important fact — max 12 words]

WATCH OUT: [one common mistake students make — max 15 words]

Rules for key points:
- Each point must be a standalone fact that could be an exam answer
- No duplicates, no overlap between points
- Most critical fact goes first
- No explanations, just the fact

Now write the key points for the provided material:`;

    // ── SIMPLIFY ─────────────────────────────────────
    case "simplify":
      return `${RULES}

STUDY MATERIAL:
${text}

TASK: Write a SIMPLE EXPLANATION using this EXACT template:

SIMPLE EXPLANATION
------------------
[2-3 plain sentences explaining the core idea. No jargon. Write like explaining to a 12-year-old. Maximum 50 words total.]

BIG IDEA: [One sentence. Complete the blank: "Basically, this is about ___"]

Rules:
- The explanation must be under 50 words
- Replace every technical term with plain English
- No bullet points in this section — flowing sentences only
- BIG IDEA must be one sentence, max 15 words

Now write the simple explanation for the provided material:`;

    // ── PRACTICE QUESTIONS ───────────────────────────
    case "questions":
      return `${RULES}

STUDY MATERIAL:
${text}

TASK: Write 5 PRACTICE QUESTIONS using this EXACT template:

PRACTICE QUESTIONS
------------------
Q1. [question text]
A) [option]
B) [option]
C) [option]
D) [option]
Answer: [letter]

Q2. [question text]
A) [option]
B) [option]
C) [option]
D) [option]
Answer: [letter]

Q3. [short answer question]
Answer: [max 10-word answer]

Q4. [short answer question]
Answer: [max 10-word answer]

Q5. [one deeper thinking question — "Why..." or "How..."]
Answer: [max 15-word answer]

Rules:
- Q1 and Q2 must be multiple choice with exactly 4 options
- Q3 and Q4 must be short answer (one line answer only)
- Q5 must start with Why or How
- Wrong MCQ options must be plausible, not obviously wrong
- Answers must be factually correct based only on the provided material

Now write the practice questions for the provided material:`;

    default:
      return `${RULES}

STUDY MATERIAL:
${text}

TASK: Summarise the key facts in bullet points. Max 8 bullets. One line each. No markdown.`;
  }
}