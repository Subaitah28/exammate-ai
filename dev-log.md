# Development Log — ExamMate AI

A running log of the build process: what was built, what broke, and what was learned. Written contemporaneously as development happened, not reconstructed afterward.

---

## April 2026

### Goals
- Validate the core idea: can selected webpage text be turned into useful study material via an AI API, inside a Chrome extension?
- Get a working Manifest V3 extension running locally — no polish, no security hardening, just proof of concept

### Features Built
- Basic MV3 scaffold: `manifest.json`, `popup.html`, `popup.js`, `background.js`, `content.js`
- Text selection capture via `chrome.scripting.executeScript`
- Direct `fetch()` call from `background.js` to the Gemini 2.5 Flash API
- Four initial AI modes: Study Notes, Key Points, Simplify, Practice Questions
- Dark navy + neon green UI theme

### Problems Encountered
- Gemini API key was hardcoded as a constant in `background.js`. This is fine for local testing but is a known dead end for distribution — flagged early as something to fix before sharing the extension with anyone outside of local testing.
- No structure yet for managing API costs — nothing stopping unlimited requests during testing.

### Lessons Learned
- Manifest V3's permission model (`host_permissions`, `activeTab`, `scripting`) takes some trial and error to get right — under-scoping permissions causes silent failures rather than clear errors.
- Chrome extension development has a much faster local iteration loop than expected once `chrome://extensions` reload is part of the workflow.

---

## May 2026

### Goals
- Eliminate the exposed API key before doing anything else
- Add basic cost controls so the extension can't be abused if anyone else gets a copy of it
- Start thinking seriously about whether this is worth turning into something other people use

### Features Built
- Daily request limit (15/day) using `chrome.storage.local`, checked before every API call
- 8-second cooldown between requests, tracked in service worker memory
- Input trimming — text capped at 5,000 characters before being sent to the model
- First version of a Vercel backend proxy (`api/generate.js`) to move the API key server-side

### Bugs Discovered
- **CORS rejection on first proxy deploy.** The extension's requests to the new Vercel endpoint were blocked because the serverless function wasn't returning the right CORS headers. Fixed by explicitly setting `Access-Control-Allow-Origin: *` and handling the `OPTIONS` preflight request in the function.
- **Vercel cold starts causing timeouts.** The free-tier function would spin down after inactivity, and the first request after a period of idle time would sometimes take 10+ seconds to respond — long enough that the original code (no timeout handling) would appear to hang with no feedback.

### How They Were Solved
- CORS: added explicit headers and an `OPTIONS` handler at the top of the proxy function.
- Cold starts: not fully solved in June — flagged as a problem to revisit, since adding proper timeout/retry logic required restructuring the fetch call in `background.js`, which felt like a bigger change than was needed at the time.

### Lessons Learned
- Moving from "it works on my machine calling the API directly" to "it works through a deployed proxy" surfaces a category of bugs (CORS, environment variables, cold starts) that don't show up at all in local-only development. Backend deployment is its own skill, separate from writing the extension code.
- Environment variables in Vercel need a redeploy to take effect after being added — lost some time before realizing this.

---

## June 2026

### Goals
- Fix the reliability problems that surfaced from continued use of the extension after the proxy migration
- Fix a broken download feature
- Rework the AI prompts — outputs were technically correct but too long and inconsistent to actually be useful for studying
- Get the extension to a state stable enough to hand to a few people for real testing

### Features Built
- `safeSendMessage` wrapper in `popup.js` to handle MV3 service worker termination gracefully
- Full rewrite of response handling in `background.js` to inspect Gemini's `finishReason` field and return specific errors instead of a generic "empty response" message
- `AbortController`-based timeout (25s) with one automatic retry, finally addressing the cold-start issue flagged in June
- Pomodoro timer (25 min work / 5 min break) with animated SVG progress ring and persisted session counts
- Rewritten prompt templates for all four AI modes, with explicit formatting constraints
- New plain-text output renderer in `popup.js` that detects line patterns (headers, numbered points, MCQ options, key-value pairs) and applies styling without relying on markdown

### Bugs Discovered
- **AI buttons failing silently.** After the extension had been open for a while, clicking any AI button would do nothing. No error, no output, no console warning visible to a typical user.
  - *Root cause:* MV3 service workers are terminated by Chrome after ~30 seconds of inactivity. A message sent to a terminated worker throws `"Could not establish connection. Receiving end does not exist."` The original code had no error handling around `chrome.runtime.sendMessage`, so the error was thrown, uncaught, and the UI simply did nothing.
- **Downloads reporting success but no file appearing in Downloads.**
  - *Root cause:* The download logic used `Blob` and `URL.createObjectURL()` inside `background.js` — but MV3 service workers have no DOM access, so neither API is available there. The code was failing inside a try/catch that logged to a console the user never sees, while the UI had already shown a success message before the failure occurred.
- **Intermittent "Empty response from AI" across all four modes**, appearing more frequently the longer the extension had been in use.
  - *Root cause:* Gemini returns HTTP 200 with no text under multiple distinct conditions — safety filter blocks (`finishReason: "SAFETY"`), copyright filter triggers (`"RECITATION"`), and occasional malformed candidate arrays. The original code checked only for the presence of `candidates[0].content.parts[0].text` and returned an identical generic error regardless of which condition had occurred, making the bug impossible to diagnose without inspecting the raw API response directly.

### How They Were Solved
- Service worker termination: added `safeSendMessage` in `popup.js`, which catches the specific connection-error message text, waits 600ms, and retries the message once. The first failed attempt wakes the service worker back up; the retry then succeeds.
- Download failure: moved all Blob creation and download triggering into `popup.js`, which has full DOM access as a regular extension page. The popup creates an invisible `<a>` element pointing to a blob URL and clicks it programmatically.
- Empty responses: rewrote the response parser to check `finishReason` explicitly and return a distinct, specific error message for each known cause, plus one automatic retry for genuinely ambiguous cases.

### Output Quality Work
This took longer than the bug fixes. The initial prompts asked the model to "create study notes" or "simplify this" with no hard constraints, and the results — while accurate — read like textbook paragraphs, not revision material. Fixing this required:
- Adding explicit negative instructions (no markdown, no preamble, no summary sentence at the end) — the model would otherwise add `**bold**` and `## headers` by default, which look fine in a chat interface but are just visual noise in a plain-text popup
- Switching from descriptive instructions ("make it concise") to literal templates the model fills in (a fixed line format for notes, a 5-point cap for key points, a ~50-word cap for the simplify mode) — vague length guidance was consistently ignored; explicit structural templates were not
- Building a corresponding renderer that styles the now-predictable plain-text output by pattern-matching line types, instead of asking the model to produce HTML or rely on markdown rendering that the popup didn't support anyway

### Lessons Learned
- Bugs that depend on elapsed time (service worker termination, cold starts) are much harder to catch in quick manual testing than bugs that show up immediately. Several of these issues weren't visible during short test sessions and only appeared during longer, more realistic usage.
- "It returned 200 OK" is not the same as "it worked." Treating any successful HTTP response as a successful result was the root cause of the empty-response bug — the actual content of a 200 response still needs to be validated.
- For prompt engineering, showing the model an exact template to fill in produces far more consistent results than describing the desired qualities of the output in prose. This was the single biggest lever for output quality in the entire project.
- A feature that reports success without verifying the action actually happened (the original download flow) is worse than a feature that fails loudly — it actively misleads the user and makes the bug harder to notice.

---

