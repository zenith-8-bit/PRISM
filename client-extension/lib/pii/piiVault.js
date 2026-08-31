// lib/pii/piiVault.js
//
// Local-only PII <-> ID mapping store.
//
// IMPORTANT: this file touches chrome.storage.local, so it must only be
// imported from a context that has the chrome.* extension APIs — i.e.
// background.js (the service worker) or content.js. It must NEVER be
// imported into lib/visualLayer/visualLayerWorker.js, because that code
// runs inside a plain Web Worker (new Worker(...)), and dedicated Web
// Workers spawned this way do not have access to chrome.* APIs at all.
//
// Flow (see lib/visualLayer/visualLayerController.js):
//   1. The worker finds regex matches on OCR'd text and posts back
//      {category, value, box} tuples — raw values included, but this
//      never leaves the client; it's worker -> background, same machine.
//   2. background.js calls tokenize(category, value) for each match,
//      which returns a short local ID (never sent to the server).
//   3. The redaction pass draws over the box and (optionally) burns the
//      ID string into the redacted region so a human reviewing the
//      redacted screenshot can still see "this is [PII:a1b2c3d4]".
//   4. Only {category, id, box} — never the raw value — is put in the
//      redactionManifest that reaches the server.
//
// Reflecting IDs back out of an LLM response (e.g. the server's action
// plan says "type [PII:a1b2c3d4] into the confirmation field" and we need
// to substitute the *real* value back in locally before executing) is
// intentionally NOT implemented yet — see resolveTokensInText() below.

const STORAGE_KEY = "pva_pii_vault_v1";

// In-memory cache mirrors chrome.storage.local so repeated lookups within
// one background.js lifetime don't all round-trip through the storage API.
// It's rebuilt lazily from storage on first use, so it stays correct across
// service-worker restarts (MV3 SWs are killed/respawned constantly).
let cachePromise = null;

async function loadVault() {
  if (!cachePromise) {
    cachePromise = chrome.storage.local.get(STORAGE_KEY).then((result) => {
      return result[STORAGE_KEY] || { byId: {}, byFingerprint: {} };
    });
  }
  return cachePromise;
}

async function saveVault(vault) {
  await chrome.storage.local.set({ [STORAGE_KEY]: vault });
  cachePromise = Promise.resolve(vault);
}

// A short, stable fingerprint per (category, value) pair so the *same*
// phone number seen across multiple screenshots always maps back to the
// *same* local ID instead of minting a new one every capture.
async function fingerprint(category, value) {
  const enc = new TextEncoder().encode(`${category}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8) // 8 bytes is plenty of collision resistance for this use
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function shortId() {
  // Short, URL/label-safe, and cheap to burn into a redacted image region.
  return crypto.randomUUID().split("-")[0]; // e.g. "a1b2c3d4"
}

/**
 * Get-or-create a local ID for a detected PII value. Idempotent: the same
 * (category, value) always resolves to the same id.
 *
 * @param {string} category - "email" | "phone" | "iban" | "bank-account"
 * @param {string} value - the raw matched substring (never sent to server)
 * @param {object} [meta] - optional extra context (e.g. source box, page URL)
 * @returns {Promise<string>} local id, e.g. "a1b2c3d4"
 */
export async function tokenize(category, value, meta = {}) {
  const vault = await loadVault();
  const fp = await fingerprint(category, value);

  const existingId = vault.byFingerprint[fp];
  if (existingId && vault.byId[existingId]) {
    vault.byId[existingId].lastSeenAt = Date.now();
    vault.byId[existingId].occurrences += 1;
    await saveVault(vault);
    return existingId;
  }

  const id = shortId();
  vault.byId[id] = {
    category,
    value, // stored locally ONLY — this is the whole point of the vault
    fingerprint: fp,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    occurrences: 1,
    meta,
  };
  vault.byFingerprint[fp] = id;
  await saveVault(vault);
  return id;
}

/**
 * Look up the raw value behind a local ID. Used only client-side (e.g. to
 * render a human-readable debug view in the side panel) — never call this
 * to prepare data for a network request.
 */
export async function lookup(id) {
  const vault = await loadVault();
  return vault.byId[id] || null;
}

export async function debugDumpManifestSafe() {
  const vault = await loadVault();
  // Safe-for-display summary: counts per category, no raw values.
  const counts = {};
  for (const entry of Object.values(vault.byId)) {
    counts[entry.category] = (counts[entry.category] || 0) + 1;
  }
  return counts;
}

/**
 * TODO (not implemented yet, on purpose): reflecting IDs back out of an LLM
 * response.
 *
 * Once the server starts returning text/action-plans that reference local
 * PII by ID (e.g. an action like {type:"type", selector:"#email",
 * text:"[PII:a1b2c3d4]"}), this function is where we'd scan that string for
 * the [PII:<id>] token pattern, call lookup(id) for each, and substitute the
 * real value back in — entirely locally, right before content.js executes
 * the action, so the real value never has to round-trip through the
 * server in the first place.
 *
 * Deliberately left unimplemented for this milestone. Do not wire this into
 * background.js's action-execution path until it's built and reviewed —
 * substituting raw PII back into automated `type`/`click` actions is exactly
 * the kind of thing that needs its own careful pass (e.g. validating the
 * action's target selector actually corresponds to the same field/category
 * the ID was tokenized from, so the server can't trick the client into
 * pasting one field's PII into a different, attacker-controlled field).
 */
export async function resolveTokensInText(_text) {
  throw new Error(
    "piiVault.resolveTokensInText() is not implemented yet — see the TODO comment above this function."
  );
}
