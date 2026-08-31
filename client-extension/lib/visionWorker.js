// visionWorker.js
// Runs entirely inside a Web Worker so local inference never blocks the
// page/UI thread (this is what keeps the "client-side resource utilization"
// score reasonable). Uses Transformers.js, which auto-selects WebGPU and
// falls back to quantized WASM when WebGPU isn't available (Firefox, older
// Chrome, some corporate lockdowns) — satisfying the "popular browsers"
// requirement without hand-rolling two code paths.
//
// This worker is intentionally model-agnostic: swap CONFIG.VISION_MODEL.*
// for whatever detector you've validated for your accuracy/latency budget.

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

// Keep everything local — never let Transformers.js quietly hit the HF hub
// for anything at inference time beyond the initial (cached) model download.
env.allowRemoteModels = true; // model *weights* still need to be fetched once
env.useBrowserCache = true;   // ...but are cached after that (IndexedDB)

let detectorPromise = null;
let faceDetectorPromise = null;

async function getDetector(modelId, device, quantized) {
  if (!detectorPromise) {
    detectorPromise = pipeline("object-detection", modelId, {
      device,        // "webgpu" — transformers.js falls back to wasm internally
      quantized,
    }).catch((err) => {
      // WebGPU unavailable / model load failure -> retry once on wasm.
      detectorPromise = null;
      return pipeline("object-detection", modelId, { device: "wasm", quantized: true });
    });
  }
  return detectorPromise;
}

async function getFaceDetector(modelId, device, quantized) {
  if (!faceDetectorPromise) {
    faceDetectorPromise = pipeline("object-detection", modelId, { device, quantized }).catch(() =>
      pipeline("object-detection", modelId, { device: "wasm", quantized: true })
    );
  }
  return faceDetectorPromise;
}

self.onmessage = async (event) => {
  const { type, imageBitmap, modelConfig, requestId } = event.data;
  if (type !== "INFER") return;

  const t0 = performance.now();
  try {
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imageBitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const imageUrl = URL.createObjectURL(blob);

    const [detector, faceDetector] = await Promise.all([
      getDetector(modelConfig.modelId, modelConfig.device, modelConfig.quantized),
      getFaceDetector(modelConfig.faceModelId, modelConfig.device, modelConfig.quantized),
    ]);

    const [generalResults, faceResults] = await Promise.all([
      detector(imageUrl, { threshold: modelConfig.scoreThreshold }),
      faceDetector(imageUrl, { threshold: modelConfig.scoreThreshold }).catch(() => []),
    ]);

    URL.revokeObjectURL(imageUrl);

    const objects = (generalResults || []).map(normalizeDetection("object"));
    const faces = (faceResults || []).map(normalizeDetection("face"));

    self.postMessage({
      type: "INFER_RESULT",
      requestId,
      objects,
      faces, // faces are always treated as sensitive -> feeds piiRedactor.js
      latencyMs: performance.now() - t0,
      backend: modelConfig.device,
    });
  } catch (err) {
    self.postMessage({
      type: "INFER_ERROR",
      requestId,
      error: String(err && err.message ? err.message : err),
      latencyMs: performance.now() - t0,
    });
  }
};

function normalizeDetection(kind) {
  return (d) => ({
    kind,
    label: d.label,
    score: d.score,
    box: {
      x: d.box.xmin,
      y: d.box.ymin,
      width: d.box.xmax - d.box.xmin,
      height: d.box.ymax - d.box.ymin,
    },
  });
}
