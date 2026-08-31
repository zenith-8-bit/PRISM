// lib/visualLayer/visualLayerController.js
//
// Runs in background.js. Ties together:
//   captureLayer.js       -> grab the frame + probe WebGPU
//   visualLayerWorker.js  -> UI element detection + OCR + raw PII matches
//   pii/piiVault.js       -> raw PII value -> local-only ID (needs chrome.storage,
//                            hence done here and not inside the worker)
//   drawRedactions()      -> burns redaction boxes onto the frame, for both
//                            regex-matched PII text AND structurally-sensitive
//                            UI elements (e.g. a password field redacts even
//                            though there's no OCR text to regex against)
//
// Output is what background.js's existing runAgentTask() flow (or the new
// trigger-driven flow) sends to the server: redacted image + a manifest of
// {source, category, id} — never raw values, never coordinates the server
// doesn't need.

import { CONFIG } from "../config.js";
import { captureActiveTabFrame, probeWebGpuAvailable } from "./captureLayer.js";
import { tokenize } from "../pii/piiVault.js";
import { isSensitiveClass } from "./uiComponentSchema.js";

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification:
      "Run local ONNX and OCR inference inside a Web Worker without blocking the MV3 service worker.",
  });

  console.log("[visual-layer] Offscreen document created");
}

/**
 * @param {"dom-interaction" | "api-signal"} reason
 * @param {number} tabId
 * @param {object} [extra]
 * @returns {Promise<{redactedImageDataUrl: string, uiElements: Array, textBlocks: Array, piiMatches: Array, redactionManifest: Array, latencyMs: number}>}
 *
 * NOTE: redactedImageDataUrl is kept on this return value for local-only
 * uses (e.g. rendering a debug preview inside the side panel), but it must
 * NEVER be forwarded to the backend. background.js is responsible for
 * stripping it before anything crosses the network — the server only ever
 * receives uiElements/textBlocks/redactionManifest (structured text), never
 * pixels. See background.js's sendScreenToBackend()/handleChatMessage().
 */
export async function runVisualLayer(reason, tabId, extra = {}) {
  const t0 = performance.now();

  const [{ bitmap, capturedAt }, webGpuAvailable] = await Promise.all([
    captureActiveTabFrame(tabId),
    probeWebGpuAvailable(),
  ]);

  console.log("[visual-layer] Captured frame and probed WebGPU, starting worker inference...");

  const workerResult = await runWorker(bitmap, {
    uiDetector: { preferWebGpu: webGpuAvailable },
    textDetector: {},
  });

  console.log("[visual-layer] Worker returned results, processing PII tokenization...");

  // Tokenize every raw PII match into a local-only ID. This is the one
  // place raw values exist outside the worker — they're consumed here and
  // never stored anywhere except piiVault's chrome.storage.local entry.
  const piiManifestEntries = [];
  for (const match of workerResult.piiMatches) {
    const id = await tokenize(match.category, match.value, { reason, tabId });
    piiManifestEntries.push({ source: "pii-regex", category: match.category, id, box: match.box });
  }

  // Structurally-sensitive UI elements (password fields, etc.) redact by
  // *type*, no PII value/ID involved — there's nothing to tokenize.
  const structuralManifestEntries = workerResult.uiElements
    .filter((el) => isSensitiveClass(el.className))
    .map((el) => ({ source: "ui-element-type", category: el.className, box: el.box }));

  const allRedactionBoxes = [...piiManifestEntries, ...structuralManifestEntries];
  const redactedCanvas = drawRedactions(bitmap, allRedactionBoxes);
  const redactedBlob = await redactedCanvas.convertToBlob({ type: "image/png" });
  const redactedImageDataUrl = await blobToDataUrl(redactedBlob);

  const totalLatency = performance.now() - t0;

  if (CONFIG.DEBUG) {
    console.log(
      `[visual-layer] trigger=${reason} capturedAt=${capturedAt} webgpu=${webGpuAvailable} ` +
        `uiElements=${workerResult.uiElements.length} piiMatches=${workerResult.piiMatches.length} ` +
        `workerLatencyMs=${workerResult.latencyMs.toFixed(0)} totalLatencyMs=${totalLatency.toFixed(0)}`
    );
  }

  return {
    reason,
    task: extra.task,
    redactedImageDataUrl, // local-only — never sent to the backend, see note above
    uiElements: workerResult.uiElements, // full structural signal, not sensitive itself
    // OCR text blocks (post-redaction-relevant, but the boxes/text themselves
    // are not sensitive on their own — raw PII values were already stripped
    // out into piiVault by the tokenize() step above). This was previously
    // dropped here, which meant the server always got text_blocks: [] no
    // matter what the worker actually detected.
    textBlocks: workerResult.textBlocks || [],
    // Tokenized PII matches (category + local vault id, never the raw value)
    // so the server/agent can reason about "there's a redacted email here"
    // without ever seeing the email itself.
    piiMatches: piiManifestEntries.map((m) => ({ category: m.category, id: m.id })),
    // Server-facing manifest: category + local id only — never a raw value,
    // never a page coordinate the server has no use for.
    redactionManifest: allRedactionBoxes.map((m) => ({
      source: m.source,
      category: m.category,
      id: m.id, // undefined for structural entries — that's fine, there's no value behind them
    })),
    latencyMs: totalLatency,
  };
}

async function runWorker(bitmap, options) {
  await ensureOffscreenDocument();

  const requestId = crypto.randomUUID();

  console.log("[visual-layer] Converting bitmap to data URL...");

  // Convert ImageBitmap → PNG data URL.
  // This remains entirely inside the extension/browser.
  const canvas = new OffscreenCanvas(
    bitmap.width,
    bitmap.height
  );

  const ctx = canvas.getContext("2d");

  ctx.drawImage(bitmap, 0, 0);

  const blob = await canvas.convertToBlob({
    type: "image/png"
  });

  const imageDataUrl = await blobToDataUrl(blob);

  console.log(`[visual-layer] Image data URL created (${(blob.size / 1024).toFixed(1)}KB), sending to worker...`);

  return await new Promise((resolve, reject) => {
    // Increased timeout to 300 seconds (5 minutes) to allow for:
    // 1. First-time ONNX model initialization/download
    // 2. Tesseract language data download (first run)
    // 3. Actual inference on the image
    const timeout = setTimeout(() => {
      console.error("[visual-layer] Worker timeout after 300 seconds");
      reject(
        new Error(
          "Visual layer offscreen worker timed out after 300 seconds. " +
          "This usually means the ONNX model or Tesseract language data failed to initialize. " +
          "Check the browser console for detailed error messages."
        )
      );
    }, 300000); // 5 minutes

    const listener = (message) => {
      console.log("[visual-layer] Received message from offscreen:", message);

      if (
        message.target !== "background-visual-layer" ||
        message.requestId !== requestId
      ) {
        return;
      }

      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);

      if (message.ok) {
        console.log("[visual-layer] Worker completed successfully");
        resolve(message.result);
      } else {
        console.error("[visual-layer] Worker returned error:", message.error);
        reject(
          new Error(
            message.error ||
            "Visual layer failed"
          )
        );
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    console.log("[visual-layer] Posting RUN_VISUAL_LAYER message to offscreen document");

    chrome.runtime.sendMessage({
      target: "visual-layer-offscreen",
      type: "RUN_VISUAL_LAYER",
      requestId,
      imageDataUrl,
      options
    }).catch((error) => {
      console.error("[visual-layer] Failed to send message to offscreen:", error);

      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);

      reject(error);
    });
  });
}

// Local redaction-drawing pass. Deliberately self-contained rather than
// reusing lib/piiRedactor.js's redactImage() — that function's signature is
// shaped around the DOM-scan pipeline (faceBoxes + domFindings); this one
// takes the visual-layer's own {category, id, box} shape. Both ultimately
// do the same blackout/pixelate/blur primitive; if you want a single
// shared drawing function, factor applyRedactionStyle() out of
// piiRedactor.js into a small shared module.
function drawRedactions(bitmap, entries) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  const pad = CONFIG.REDACTION_PADDING_PX;
  for (const entry of entries) {
    const box = padBox(entry.box, pad);
    applyRedactionStyle(ctx, box, CONFIG.REDACTION_STYLE);

    if (CONFIG.DEBUG && entry.id) {
      // Small on-image debug label so a human reviewing the redacted
      // screenshot can see which vault entry a box corresponds to, without
      // the raw value ever being drawn. Safe to leave on during dev; turn
      // off (CONFIG.DEBUG=false) before any real demo/screen-share.
      ctx.fillStyle = "#ffffff";
      ctx.font = "10px monospace";
      ctx.fillText(`#${entry.id}`, box.x + 2, box.y + 10);
    }
  }
  return canvas;
}

function padBox(box, pad) {
  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function applyRedactionStyle(ctx, box, style) {
  const { x, y, width, height } = box;
  if (width <= 0 || height <= 0) return;

  switch (style) {
    case "pixelate": {
      const blockSize = Math.max(6, Math.floor(Math.min(width, height) / 8));
      const imgData = ctx.getImageData(x, y, width, height);
      const tmp = new OffscreenCanvas(width, height);
      tmp.getContext("2d").putImageData(imgData, 0, 0);
      const small = new OffscreenCanvas(Math.max(1, width / blockSize), Math.max(1, height / blockSize));
      small.getContext("2d").drawImage(tmp, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, width, height);
      break;
    }
    case "blur": {
      ctx.save();
      ctx.filter = "blur(12px)";
      ctx.drawImage(ctx.canvas, x, y, width, height, x, y, width, height);
      ctx.restore();
      break;
    }
    case "blackout":
    default: {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, width, height);
      break;
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}