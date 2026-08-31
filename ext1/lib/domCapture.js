// lib/domCapture.js
//
// DOM-only replacement for lib/visualLayer/visualLayerController.js.
// The OCR + ONNX UI-detection pipeline (offscreen worker, Tesseract,
// ui-yolov8n.onnx) has been removed. This module gets the same signal
// (what's clickable/fillable, what text is visible) straight from the
// page's DOM via content.js's scanDOM(), and returns the exact same shape
// runVisualLayer() used to, so background.js's sendScreenToBackend() /
// handleChatMessage() need no changes downstream.
//
// Trade-off, stated plainly: this sees what the DOM says is there, not
// what's visually rendered on top of it (e.g. a canvas-drawn UI, or an
// element covered by an unrelated overlay, won't show up). That's the
// known limitation of dropping vision - it's not hidden or logged as if
// vision ran.

import { CONFIG } from "./config.js";

/**
 * @param {string} reason
 * @param {number} tabId
 * @param {object} [extra]
 * @returns {Promise<{reason: string, task: any, uiElements: Array, textBlocks: Array, piiMatches: Array, redactionManifest: Array, latencyMs: number}>}
 */
export async function runDomCapture(reason, tabId, extra = {}) {
  const t0 = performance.now();

  console.log(`[dom-capture] trigger=${reason} - requesting DOM scan from tab ${tabId}...`);

  const scan = await sendScanRequest(tabId);

  console.log(
    `[dom-capture] Scan returned: uiElements=${scan.uiElements?.length || 0} ` +
      `textBlocks=${scan.textBlocks?.length || 0} findings=${scan.findings?.length || 0}`
  );

  // Tokenize sensitive findings into {category, id} pairs the same way the
  // old pipeline did, minus the pixel/vault step - there's no image to draw
  // redaction boxes on anymore, so this is just the category + a local
  // sequence id for the server-facing manifest.
  const piiMatches = (scan.findings || []).map((f, i) => ({
    category: f.category,
    id: `dom-${i}`,
  }));

  const redactionManifest = piiMatches.map((m) => ({
    source: "dom-field-hint",
    category: m.category,
    id: m.id,
  }));

  const totalLatency = performance.now() - t0;

  if (CONFIG.DEBUG) {
    console.log(
      `[dom-capture] trigger=${reason} uiElements=${scan.uiElements?.length || 0} ` +
        `piiMatches=${piiMatches.length} totalLatencyMs=${totalLatency.toFixed(0)}`
    );
  }

  return {
    reason,
    task: extra.task,
    uiElements: scan.uiElements || [],
    textBlocks: scan.textBlocks || [],
    piiMatches,
    redactionManifest,
    latencyMs: totalLatency,
  };
}

function sendScanRequest(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM" }, async (response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || "";
        // content.js is only auto-injected into pages loaded *after* the
        // extension started. A tab that was already open when the extension
        // was installed/reloaded has no content script yet, so the first
        // sendMessage always fails with this exact error. Inject it on
        // demand and retry once before giving up.
        if (errMsg.includes("Receiving end does not exist")) {
          console.warn("[dom-capture] content.js not present in tab, injecting now and retrying...");
          try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
          } catch (injectErr) {
            console.error("[dom-capture] Injection failed (page may be protected):", injectErr.message);
            reject(new Error(`Could not inject content script: ${injectErr.message}`));
            return;
          }
          chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM" }, (retryResponse) => {
            if (chrome.runtime.lastError) {
              console.error("[dom-capture] SCAN_DOM retry failed:", chrome.runtime.lastError.message);
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(retryResponse || {});
          });
          return;
        }
        console.error("[dom-capture] SCAN_DOM failed:", errMsg);
        reject(new Error(errMsg));
        return;
      }
      resolve(response || {});
    });
  });
}

/**
 * Feature 1 helper: ask the content script to draw a highlight box around
 * an element the agent/user is pointing at.
 */
export function highlightElementInTab(tabId, target) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "HIGHLIGHT_ELEMENT", target }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[dom-capture] highlight failed:", chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false });
    });
  });
}

/**
 * Feature 2 helper: ask the content script to autofill visible fields from
 * a demo profile object ({ name, email, phone, address, city, zip }).
 */
export function autofillFormInTab(tabId, profile) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "AUTOFILL_FORM", profile }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.ok === false) {
        reject(new Error(response.error || "Autofill failed"));
        return;
      }
      resolve(response?.result || response);
    });
  });
}
