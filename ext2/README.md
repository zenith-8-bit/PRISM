# Client Extension

Chrome/Chromium MV3 extension. The UI now lives in a **side panel** (not a
popup) — click the toolbar icon and it docks beside the page, stays open
while you browse, and is resized by dragging the browser's own panel
divider (bigger by default than the old popup, and genuinely resizable,
which a classic `action.default_popup` cannot be in Chrome).

## Load it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `client-extension/`
2. Click the toolbar icon — the side panel opens next to the current tab
3. Make sure the server (`../server/README.md`) is running at the URL in
   `lib/config.js` (`http://localhost:8787` by default)
4. Type a task in the composer and hit **Send** (or ⌘/Ctrl+Enter) — this
   works immediately, signed in or not

## What's new here

- **`sidepanel.html` / `sidepanel.js` / `sidepanel.css`** — the persistent
  assistant UI: a continuous chat thread (each message is one pipeline run:
  Scan → Vision → Redact → Send → Execute, shown inline per agent bubble),
  an expandable **redaction log** accordion, and a Google sign-in bar.
- **`theme.css`** — the shared design tokens/atoms (buttons, chips, stepper,
  toast) factored out so any future surface can reuse them.
- **`lib/auth.js` + `lib/firebaseClient.js` + `lib/firebaseConfig.js`** —
  Google sign-in and account/redaction-history persistence. See setup below.
- **`background.js`** — unchanged pipeline logic, plus one addition:
  `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so
  the toolbar icon opens the panel directly.
- `domScanner.js`, `piiRedactor.js`, `visionWorker.js`, `config.js`,
  `content.js` are **untouched** — same local-vision + redaction pipeline
  as before, just called once per chat turn instead of once per popup open.

The pipeline always completes visually even if the server is down: if the
"Send" step fails or times out (4.5s), the agent bubble is tagged
**SIMULATED**, a toast explains it, and a best-effort demo plan is shown —
so the chat never dead-ends mid-conversation.

## Firebase + Google sign-in setup

Sign-in and the redaction log's Firestore sync are **optional** — the panel
is fully usable signed-out (the log just lives in memory for that session
instead of persisting to your account). To enable them:

1. **Vendor the Firebase SDK locally.** MV3's CSP won't load it from a CDN
   `<script src>`, so it has to ship inside the extension — see
   `lib/vendor/README.md` for the two `curl` commands.
2. **Create a Firebase project** (console.firebase.google.com), enable
   **Authentication → Sign-in method → Google**, and enable **Firestore**
   (start in production mode; rules below).
3. **Copy your Web app config** (Project settings → General → Your apps →
   Web app) into `lib/firebaseConfig.js`.
4. **Create a Chrome-extension OAuth client**: Google Cloud Console (the
   project backing your Firebase project) → APIs & Services → Credentials →
   Create Credentials → OAuth client ID → Application type **Chrome
   Extension** → paste in this extension's ID (visible on
   `chrome://extensions` once loaded unpacked). Copy the generated client ID
   into `manifest.json`'s `oauth2.client_id`.
5. Reload the unpacked extension so the new `manifest.json` takes effect.

### Suggested Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      match /redactionEvents/{eventId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

Only category labels and counts are ever written to Firestore
(`{source, category}` — see `lib/firebaseClient.js:logRedactionEvent`);
no redacted content, coordinates, or page contents are persisted.

## Model swap-in

`lib/config.js` → `VISION_MODEL` controls which Transformers.js models are
loaded. Swap in whatever you've benchmarked for your accuracy/latency/VRAM
budget — see `../ADVICE.md` for a fuller discussion of trade-offs.

## Debugging

Set `CONFIG.DEBUG = true` (default) in `lib/config.js` to log redaction
counts and timings to the background service worker's console
(`chrome://extensions` → your extension → "service worker" → inspect). The
side panel itself can be inspected the normal way: right-click inside it →
**Inspect**.
