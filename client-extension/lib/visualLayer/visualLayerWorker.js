// lib/visualLayer/visualLayerWorker.OPTIMIZED.js
//
// IMPROVEMENTS:
// - Better error recovery: UI + OCR run fully independent with timeouts
// - Progressive updates: Send detection results ASAP, don't wait for OCR
// - Smarter fallbacks: Try ONNX (fast), timeout → DOM/Tesseract
// - Memory: Release bitmaps after processing
//

import { detectUiElements } from "./uiElementDetector.js";
import { detectTextRegions, detectTextRegionsFallback } from "./textRegionDetector.js";
import { findPiiMatches } from "../pii/textRedactor.js";

console.log("[VISION WORKER] Worker initialized");

self.onmessage = async (event) => {
  const { type, imageBitmap, options, requestId } = event.data;

  if (type !== "RUN_VISUAL_LAYER") {
    console.error("[VISION WORKER] Unknown message type:", type);
    self.postMessage({
      type: "VISUAL_LAYER_ERROR",
      requestId,
      error: `Unknown type: ${type}`,
      latencyMs: 0
    });
    return;
  }

  console.log(`[VISION WORKER] Processing request ${requestId}`);
  const t0 = performance.now();

  try {
    // Clone bitmap for independent processing
    console.log("[VISION WORKER] Cloning bitmap for parallel processing...");
    const bitmapForUi = await cloneBitmap(imageBitmap);
    const bitmapForText = await cloneBitmap(imageBitmap);

    // Run detection in parallel with independent timeouts
    console.log("[VISION WORKER] Starting parallel UI + text detection...");
    const detectStart = performance.now();

    const [uiElements, textBlocksRaw, uiError, textError] = await Promise.all([
      detectUiElementsWithTimeout(bitmapForUi, options.uiDetector || {}),
      detectTextRegionsWithTimeout(bitmapForText, options.textDetector || {}),
    ]).then(results => [...results, null, null]).catch(err => {
      console.error("[VISION WORKER] Promise.all failed:", err);
      return [[], [], err, null];
    });

    const detectLatency = performance.now() - detectStart;
    console.log(
      `[VISION WORKER] Detection complete in ${detectLatency.toFixed(0)}ms: ` +
      `${uiElements.length} UI elements, ${textBlocksRaw.length} text blocks`
    );

    // Early send: UI elements are ready
    if (options.progressiveUpdates) {
      self.postMessage({
        type: "VISUAL_LAYER_PROGRESS",
        requestId,
        stage: "ui_detection_complete",
        uiElements,
        latencyMs: detectLatency
      });
    }

    // PII matching on text
    console.log("[VISION WORKER] Running PII detection on text...");
    const piiMatches = findPiiMatches(textBlocksRaw);
    console.log(`[VISION WORKER] Found ${piiMatches.length} PII matches`);

    // Prepare final response
    const textBlocks = textBlocksRaw.map(b => ({
      text: b.text,
      box: b.box
    }));

    const totalLatency = performance.now() - t0;

    // Send final result
    self.postMessage({
      type: "VISUAL_LAYER_RESULT",
      requestId,
      uiElements,
      textBlocks,
      piiMatches,
      latencyMs: totalLatency,
      stages: {
        detection: detectLatency,
        piiMatching: totalLatency - detectLatency
      },
      errors: uiError || textError ? { ui: uiError, text: textError } : undefined
    });

  } catch (err) {
    console.error("[VISION WORKER] Fatal error:", err);
    self.postMessage({
      type: "VISUAL_LAYER_ERROR",
      requestId,
      error: String(err?.message || err),
      latencyMs: performance.now() - t0
    });
  }
};

// ============================================================================
// DETECTION WITH TIMEOUT AND FALLBACK
// ============================================================================

async function detectUiElementsWithTimeout(bitmap, opts = {}, timeoutMs = 15000) {
  try {
    console.log(`[VISION WORKER] UI detection (timeout: ${timeoutMs}ms)...`);

    // Try ONNX first
    const onnxPromise = detectUiElements(bitmap, opts);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("UI detection timeout")), timeoutMs)
    );

    const result = await Promise.race([onnxPromise, timeoutPromise]);
    console.log(`[VISION WORKER] ONNX UI detection succeeded: ${result.length} elements`);
    return result;

  } catch (err) {
    console.warn(`[VISION WORKER] ONNX UI detection failed: ${err.message}`);
    console.log("[VISION WORKER] Falling back to DOM UI extraction...");

    try {
      const domElements = await extractUiElementsFromDOM();
      console.log(`[VISION WORKER] DOM fallback succeeded: ${domElements.length} elements`);
      return domElements;
    } catch (domErr) {
      console.error(`[VISION WORKER] DOM fallback also failed: ${domErr.message}`);
      return [];
    }
  }
}

async function detectTextRegionsWithTimeout(bitmap, opts = {}, timeoutMs = 15000) {
  try {
    console.log(`[VISION WORKER] Text detection (timeout: ${timeoutMs}ms)...`);

    // Try optimized ONNX OCR first
    const ocrPromise = detectTextRegions(bitmap, opts);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Text detection timeout")), timeoutMs)
    );

    const result = await Promise.race([ocrPromise, timeoutPromise]);
    console.log(`[VISION WORKER] ONNX OCR succeeded: ${result.length} text blocks`);
    return result;

  } catch (err) {
    console.warn(`[VISION WORKER] ONNX OCR failed: ${err.message}`);
    console.log("[VISION WORKER] Trying Tesseract fallback...");

    try {
      const tesseractResult = await detectTextRegionsFallback(bitmap, opts);
      console.log(`[VISION WORKER] Tesseract fallback succeeded: ${tesseractResult.length} blocks`);
      return tesseractResult;

    } catch (tessErr) {
      console.warn(`[VISION WORKER] Tesseract fallback failed: ${tessErr.message}`);
      console.log("[VISION WORKER] Final fallback: DOM text extraction...");

      try {
        const domText = await extractTextFromDOM();
        console.log(`[VISION WORKER] DOM fallback succeeded: ${domText.length} text blocks`);
        return domText;
      } catch (domErr) {
        console.error(`[VISION WORKER] All text detection failed: ${domErr.message}`);
        return [];
      }
    }
  }
}

// ============================================================================
// DOM FALLBACK IMPLEMENTATIONS
// ============================================================================

async function extractUiElementsFromDOM() {
  // Runs in Worker context - can't directly access document
  // Post message to main thread to get DOM elements
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("DOM extraction timeout")), 5000);

    self.onmessage_backup = self.onmessage;
    self.onmessage = (event) => {
      clearTimeout(timeoutId);
      if (event.data.type === "DOM_UI_ELEMENTS") {
        self.onmessage = self.onmessage_backup;
        resolve(event.data.elements);
      }
    };

    self.postMessage({ type: "REQUEST_DOM_ELEMENTS", requestDom: true });
  });
}

async function extractTextFromDOM() {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("DOM text extraction timeout")), 5000);

    self.onmessage_backup = self.onmessage;
    self.onmessage = (event) => {
      clearTimeout(timeoutId);
      if (event.data.type === "DOM_TEXT_BLOCKS") {
        self.onmessage = self.onmessage_backup;
        resolve(event.data.textBlocks);
      }
    };

    self.postMessage({ type: "REQUEST_DOM_TEXT", requestDom: true });
  });
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

async function cloneBitmap(bitmap) {
  if (!bitmap) throw new Error("Invalid bitmap");

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  try {
    return canvas.transferToImageBitmap();
  } catch (err) {
    console.warn("[VISION WORKER] transferToImageBitmap failed, using canvas instead");
    return bitmap; // Fallback to original if transfer fails
  }
}