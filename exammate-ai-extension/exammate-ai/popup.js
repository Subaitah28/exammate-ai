// =====================================================
//  ExamMate AI – popup.js  v2.0
//  Changes from v1:
//  1. safeSendMessage kept — MV3 service worker retry
//  2. renderOutput() — smart renderer that styles
//     the strict template output without needing
//     markdown. Detects section headers and formats
//     cleanly for scanning.
//  3. Download uses blob in popup (MV3 fix kept)
//  4. Copy button gives visual feedback
// =====================================================

let currentResult = "";
let currentAction = "";
let timerInterval = null;
let timerRunning  = false;
let timerMode     = "work";
let timeLeft      = 25 * 60;
let totalTime     = 25 * 60;
let sessionsToday = 0;

const $selectedText   = document.getElementById("selectedText");
const $charCount      = document.getElementById("charCount");
const $outputBox      = document.getElementById("outputBox");
const $outputLabel    = document.getElementById("outputLabel");
const $loadingOverlay = document.getElementById("loadingOverlay");
const $loadingText    = document.getElementById("loadingText");
const $usageCount     = document.getElementById("usageCount");
const $toast          = document.getElementById("toast");
const $timerDisplay   = document.getElementById("timerDisplay");
const $timerLabel     = document.getElementById("timerLabel");
const $ringProgress   = document.getElementById("ringProgress");
const $sessionCount   = document.getElementById("sessionCount");
const $btnPlayPause   = document.getElementById("btnPlayPause");
const $iconPlay       = document.getElementById("iconPlay");
const $iconPause      = document.getElementById("iconPause");
const $btnCopy        = document.getElementById("btnCopy");
const $btnSave        = document.getElementById("btnSave");
const $btnReset       = document.getElementById("btnReset");
const $btnSkip        = document.getElementById("btnSkip");
const $tabWork        = document.getElementById("tabWork");
const $tabBreak       = document.getElementById("tabBreak");

// =====================================================
//  INIT
// =====================================================
document.addEventListener("DOMContentLoaded", async () => {
  await loadUsageCount();
  await loadSessions();
  await getSelectedText();
  updateRing();
});

// =====================================================
//  GET SELECTED TEXT FROM PAGE
// =====================================================
async function getSelectedText() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString().trim() || ""
    });
    const sel = results?.[0]?.result || "";
    if (sel) {
      $selectedText.value = sel.slice(0, 5000);
      updateCharCount();
    }
  } catch (_) {}
}

// =====================================================
//  CHAR COUNTER
// =====================================================
$selectedText.addEventListener("input", updateCharCount);
function updateCharCount() {
  const len = $selectedText.value.length;
  $charCount.textContent = len;
  $charCount.style.color =
    len > 4500 ? "#ff6b6b" :
    len > 4000 ? "#fbbf24" : "";
}

// =====================================================
//  SAFE SEND MESSAGE
//  Handles sleeping MV3 service workers gracefully.
// =====================================================
async function safeSendMessage(payload) {
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response === undefined) throw new Error("no_response");
    return response;
  } catch (err) {
    const msg = err?.message || "";
    const isConnectionErr =
      msg.includes("Could not establish connection") ||
      msg.includes("Receiving end does not exist") ||
      msg.includes("message channel closed") ||
      msg.includes("no_response");

    if (isConnectionErr) {
      await new Promise(r => setTimeout(r, 600));
      try {
        const retry = await chrome.runtime.sendMessage(payload);
        if (retry === undefined) throw new Error("still_no_response");
        return retry;
      } catch (_) {
        return { success: false, error: "Background not responding. Close and reopen the extension." };
      }
    }
    return { success: false, error: msg || "Extension error." };
  }
}

// =====================================================
//  AI ACTION BUTTONS
// =====================================================
const ACTION_META = {
  notes:      { loading: "Building study notes…",       title: "📝 Study Notes"        },
  keypoints:  { loading: "Extracting key points…",      title: "🎯 Key Points"         },
  simplify:   { loading: "Simplifying…",                title: "💡 Simple Explanation" },
  questions:  { loading: "Generating questions…",       title: "❓ Practice Questions" }
};

document.querySelectorAll(".action-btn").forEach(btn => {
  btn.addEventListener("click", () => handleAction(btn.dataset.action));
});

async function handleAction(action) {
  const text = $selectedText.value.trim();
  if (!text) {
    showToast("Paste or select some text first!", "error");
    return;
  }
  currentAction = action;
  showLoading(ACTION_META[action].loading);

  const response = await safeSendMessage({ type: "GENERATE_AI", action, text });
  hideLoading();

  if (!response || typeof response.success === "undefined") {
    showToast("No response from extension. Reload the popup.", "error");
    return;
  }
  if (!response.success) {
    showToast(response.error || "Something went wrong.", "error");
    return;
  }

  currentResult = response.result;
  renderOutput(ACTION_META[action].title, currentResult);

  if (typeof response.newCount === "number") {
    $usageCount.textContent = response.newCount;
  }
}

// =====================================================
//  renderOutput — smart template-aware renderer
//
//  The AI now outputs strict plain-text templates.
//  This renderer detects section headers (ALL CAPS
//  lines followed by dashes) and question blocks,
//  and applies clean CSS styling without needing
//  markdown symbols in the AI output.
// =====================================================
function renderOutput(title, content) {
  // Update label
  while ($outputLabel.childNodes.length > 1) {
    $outputLabel.removeChild($outputLabel.lastChild);
  }
  $outputLabel.appendChild(document.createTextNode(" " + title));

  // Clear output box
  $outputBox.innerHTML = "";

  const lines = content.split("\n");
  const frag  = document.createDocumentFragment();

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line → small spacer
      const spacer = document.createElement("div");
      spacer.style.height = "4px";
      frag.appendChild(spacer);
      return;
    }

    // Detect section header: ALL CAPS line or line ending with dashes
    const isDivider    = /^[-─]{3,}$/.test(trimmed);
    const isSectionHdr = !isDivider &&
      trimmed === trimmed.toUpperCase() &&
      trimmed.length > 3 &&
      /[A-Z]/.test(trimmed);

    // Detect question lines: Q1. Q2. etc.
    const isQuestion = /^Q\d+\./.test(trimmed);

    // Detect answer lines
    const isAnswer = /^Answer:/.test(trimmed) || /^WATCH OUT:/.test(trimmed) || /^BIG IDEA:/.test(trimmed);

    // Detect MCQ options: A) B) C) D)
    const isMCQOption = /^[A-D]\)/.test(trimmed);

    // Detect numbered key points: 1. 2. etc.
    const isNumbered = /^\d+\./.test(trimmed);

    // Detect colon-separated note lines: "Label: content"
    const isNoteLine = trimmed.includes(":") && !isQuestion && !isAnswer && !isMCQOption && !isNumbered;

    const el = document.createElement("div");

    if (isDivider) {
      el.style.cssText = "border-top:1px solid #1e2d45;margin:6px 0;";

    } else if (isSectionHdr) {
      el.textContent = trimmed;
      el.style.cssText = `
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.5px;
        color: #00ff88;
        text-transform: uppercase;
        margin: 10px 0 4px;
        font-family: 'Space Mono', monospace;
      `;

    } else if (isQuestion) {
      el.textContent = trimmed;
      el.style.cssText = `
        font-size: 12.5px;
        font-weight: 600;
        color: #e2e8f0;
        margin: 10px 0 3px;
        line-height: 1.5;
      `;

    } else if (isAnswer) {
      // Split "Answer: X" into label + value
      const colon  = trimmed.indexOf(":");
      const label  = trimmed.slice(0, colon + 1);
      const value  = trimmed.slice(colon + 1).trim();

      el.style.cssText = "margin: 3px 0 6px; font-size: 12.5px; line-height: 1.5;";

      const labelSpan = document.createElement("span");
      labelSpan.textContent = label + " ";
      labelSpan.style.cssText = "color: #00ff88; font-weight: 700; font-family: 'Space Mono', monospace; font-size: 11px;";

      const valueSpan = document.createElement("span");
      valueSpan.textContent = value;
      valueSpan.style.cssText = "color: #94a3b8;";

      el.appendChild(labelSpan);
      el.appendChild(valueSpan);

    } else if (isMCQOption) {
      el.textContent = trimmed;
      el.style.cssText = `
        font-size: 12px;
        color: #94a3b8;
        padding: 1px 0 1px 12px;
        line-height: 1.6;
      `;

    } else if (isNumbered) {
      // Numbered key points
      const dotIdx  = trimmed.indexOf(".");
      const num     = trimmed.slice(0, dotIdx + 1);
      const rest    = trimmed.slice(dotIdx + 1).trim();

      el.style.cssText = "display:flex;gap:8px;margin:4px 0;align-items:flex-start;font-size:12.5px;line-height:1.6;";

      const numSpan = document.createElement("span");
      numSpan.textContent = num;
      numSpan.style.cssText = "color:#00ff88;font-weight:700;font-family:'Space Mono',monospace;font-size:11px;min-width:18px;margin-top:1px;";

      const textSpan = document.createElement("span");
      textSpan.textContent = rest;
      textSpan.style.color = "#e2e8f0";

      el.appendChild(numSpan);
      el.appendChild(textSpan);

    } else if (isNoteLine) {
      // "Label: content" → label in neon, content in normal
      const colon = trimmed.indexOf(":");
      const label = trimmed.slice(0, colon);
      const value = trimmed.slice(colon + 1).trim();

      el.style.cssText = "display:flex;gap:0;margin:3px 0;font-size:12.5px;line-height:1.6;flex-wrap:wrap;";

      const labelSpan = document.createElement("span");
      labelSpan.textContent = label + ": ";
      labelSpan.style.cssText = "color:#00ff88;font-weight:600;white-space:nowrap;";

      const valueSpan = document.createElement("span");
      valueSpan.textContent = value;
      valueSpan.style.color = "#cbd5e1";

      el.appendChild(labelSpan);
      el.appendChild(valueSpan);

    } else {
      // Plain line (simplify paragraphs, etc.)
      el.textContent = trimmed;
      el.style.cssText = "font-size:12.5px;color:#cbd5e1;line-height:1.75;margin:3px 0;";
    }

    frag.appendChild(el);
  });

  $outputBox.appendChild(frag);
  $outputBox.scrollTop = 0;
}

// =====================================================
//  COPY
// =====================================================
$btnCopy.addEventListener("click", async () => {
  if (!currentResult) { showToast("Nothing to copy yet.", "error"); return; }
  try {
    await navigator.clipboard.writeText(currentResult);
    const orig = $btnCopy.innerHTML;
    $btnCopy.textContent = "Copied ✓";
    $btnCopy.style.color = "#00ff88";
    setTimeout(() => { $btnCopy.innerHTML = orig; $btnCopy.style.color = ""; }, 2000);
  } catch (_) {
    showToast("Copy failed.", "error");
  }
});

// =====================================================
//  SAVE — Blob download in popup context (MV3 fix)
// =====================================================
$btnSave.addEventListener("click", () => {
  if (!currentResult) { showToast("Nothing to save yet.", "error"); return; }

  try {
    const now   = new Date();
    const date  = now.toISOString().slice(0, 10);
    const time  = now.toTimeString().slice(0, 8).replace(/:/g, "-");
    const fname = `exammate-notes-${date}-${time}.txt`;

    const header = [
      "ExamMate AI – Study Notes",
      "===========================",
      `Type      : ${ACTION_META[currentAction]?.title || "Notes"}`,
      `Generated : ${now.toLocaleString()}`,
      `Source    : ${$selectedText.value.trim().slice(0, 150)}...`,
      "===========================",
      ""
    ].join("\n");

    const blob = new Blob([header + currentResult], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = fname;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a); }, 5000);
    showToast(`Saved: ${fname} ✅`, "success");
  } catch (err) {
    showToast("Save failed: " + err.message, "error");
  }
});

// =====================================================
//  USAGE COUNT
// =====================================================
async function loadUsageCount() {
  const today = new Date().toISOString().slice(0, 10);
  const { usageDate, usageCount } = await chrome.storage.local.get(["usageDate", "usageCount"]);
  $usageCount.textContent = (usageDate === today) ? (usageCount || 0) : 0;
}

// =====================================================
//  SESSIONS
// =====================================================
async function loadSessions() {
  const today = new Date().toISOString().slice(0, 10);
  const { sessDate, sessCount } = await chrome.storage.local.get(["sessDate", "sessCount"]);
  sessionsToday = (sessDate === today) ? (sessCount || 0) : 0;
  $sessionCount.textContent = sessionsToday;
}
async function incrementSession() {
  sessionsToday++;
  $sessionCount.textContent = sessionsToday;
  await chrome.storage.local.set({
    sessDate: new Date().toISOString().slice(0, 10),
    sessCount: sessionsToday
  });
}

// =====================================================
//  POMODORO TIMER
// =====================================================
const RING_C = 2 * Math.PI * 52;

function updateRing() {
  $ringProgress.style.strokeDashoffset = RING_C * (1 - timeLeft / totalTime);
}
function formatTime(s) {
  return `${Math.floor(s/60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;
}
function setPlayIcon(playing) {
  $iconPlay.style.display  = playing ? "none"  : "block";
  $iconPause.style.display = playing ? "block" : "none";
}
function setMode(mode) {
  timerMode = mode; timerRunning = false;
  clearInterval(timerInterval); setPlayIcon(false);
  if (mode === "work") {
    timeLeft = totalTime = 25 * 60;
    $timerLabel.textContent = "FOCUS"; $timerLabel.style.color = "#00ff88";
    $ringProgress.classList.remove("break-mode");
    $tabWork.classList.add("active"); $tabBreak.classList.remove("active");
  } else {
    timeLeft = totalTime = 5 * 60;
    $timerLabel.textContent = "BREAK"; $timerLabel.style.color = "#60a5fa";
    $ringProgress.classList.add("break-mode");
    $tabBreak.classList.add("active"); $tabWork.classList.remove("active");
  }
  $timerDisplay.textContent = formatTime(timeLeft);
  updateRing();
}

$btnPlayPause.addEventListener("click", () => {
  if (timerRunning) {
    clearInterval(timerInterval); timerRunning = false; setPlayIcon(false);
  } else {
    timerRunning = true; setPlayIcon(true);
    timerInterval = setInterval(() => {
      timeLeft--;
      $timerDisplay.textContent = formatTime(timeLeft);
      updateRing();
      if (timeLeft <= 0) {
        clearInterval(timerInterval); timerRunning = false; setPlayIcon(false);
        if (timerMode === "work") {
          incrementSession();
          showToast("🎉 Session done! Take a break.", "success");
          setMode("break");
        } else {
          showToast("⚡ Break over! Back to work.", "success");
          setMode("work");
        }
      }
    }, 1000);
  }
});
$btnReset.addEventListener("click", () => {
  clearInterval(timerInterval); timerRunning = false; setPlayIcon(false);
  timeLeft = totalTime;
  $timerDisplay.textContent = formatTime(timeLeft);
  updateRing();
});
$btnSkip.addEventListener("click", () => {
  clearInterval(timerInterval); timerRunning = false; setPlayIcon(false);
  timerMode === "work" ? (incrementSession(), setMode("break")) : setMode("work");
});
$tabWork.addEventListener("click",  () => setMode("work"));
$tabBreak.addEventListener("click", () => setMode("break"));

// =====================================================
//  LOADING / TOAST
// =====================================================
function showLoading(text = "Processing…") {
  $loadingText.textContent = text;
  $loadingOverlay.classList.add("active");
}
function hideLoading() {
  $loadingOverlay.classList.remove("active");
}
let toastTimer;
function showToast(msg, type = "") {
  $toast.textContent = msg;
  $toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove("show"), 3200);
}