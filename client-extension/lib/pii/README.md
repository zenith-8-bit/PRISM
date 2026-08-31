# lib/pii/ — regex-based PII redaction + local ID vault

Scope for this milestone, per spec: **phone, email, bank account number**
(IBAN counted as a bank-account sub-case). This is a separate channel from:
- `lib/domScanner.js` — regex/field-hint matching against *live DOM* text
  and input types (existing, unchanged).
- `lib/visualLayer/uiComponentSchema.js`'s `ALWAYS_SENSITIVE_CLASSES` —
  redacts by UI element *type* (e.g. a password field), no text/regex
  involved at all.

This module's job is specifically: OCR'd on-screen *text* → regex match →
local ID.

## Files

- `regexPatterns.js` — the three (four, counting IBAN) patterns, with a
  keyword-context rule for the bank-account pattern so a bare 12-digit
  number doesn't get flagged unless "account"/"IBAN"/"routing"/etc. appears
  nearby in the same OCR'd text line.
- `textRedactor.js` — pure function, **no chrome.\* APIs**, safe to run
  inside the Web Worker (`lib/visualLayer/visualLayerWorker.js`). Scans OCR
  text blocks, returns `{category, value, box}` matches.
- `piiVault.js` — **does** use `chrome.storage.local`, so it only runs in
  background.js. Turns a raw matched value into a short local ID
  (`tokenize()`), idempotently — the same phone number always gets the same
  ID across screenshots, via a SHA-256 fingerprint of `category:value`.

## Why the split

Web Workers spawned via `new Worker(...)` (which is how the heavy
inference in this codebase runs — see `visionWorker.js` and
`visualLayerWorker.js`) do **not** have access to `chrome.*` APIs. So the
regex matching (pure JS/text, fine to run in the worker) and the ID
storage (needs `chrome.storage`, only available in background.js) are
necessarily two different files, even though conceptually they're one
step. `visualLayerController.js` is the glue: it gets raw matches back
from the worker and calls `tokenize()` on each before anything is put in a
manifest.

## What ends up where

- **Stays in the browser only, forever**: the raw value (`jane@doe.com`,
  the actual account number). Stored in `chrome.storage.local` under
  `pva_pii_vault_v1`, keyed by local ID.
- **Reaches the server**: `{source, category, id}` — e.g.
  `{source: "pii-regex", category: "email", id: "a1b2c3d4"}`. Enough for
  the server's prompt to reason about "there's a redacted email here"
  without ever seeing what it is.

## Explicitly NOT implemented yet

`piiVault.resolveTokensInText()` — reflecting a `[PII:<id>]` token back out
of an LLM response into the real value before `content.js` executes an
action. Per the brief, this is left for later. See the TODO comment on
that function for what it'll need (in particular: validating that the
action's target actually matches the category the ID was tokenized from,
so a compromised/hallucinating server response can't be tricked into
pasting field A's PII into field B).
