// lib/visualLayer/uiElementDetector.OPTIMIZED.js
// 
// PERFORMANCE: 
// - Cache ONNX session across calls (first load: 1-2s, subsequent: 100-300ms)
// - Use WebGPU executor with WASM fallback
// - Better error messages for debugging
// - Early exit for invalid inputs
//

import * as ort from "../vendor/onnxruntime-web/dist/ort.webgpu.min.mjs";
import { ACTIVE_CLASSES } from "./uiComponentSchema.js";

ort.env.wasm.wasmPaths = new URL("../vendor/onnxruntime-web/dist/", import.meta.url).href;

// Enable logging for debugging (set to false in production)
const DEBUG = false;

const MODEL_URL_DEFAULT = "./models/ui-yolov8n.onnx";
const INPUT_SIZE = 640;

// Session cache - single session shared across all detection calls
let sessionCache = {
  promise: null,
  preferWebGpu: true,
  modelUrl: null
};

/**
 * Get or create ONNX session with caching
 * The session is cached in memory to avoid repeated model loading
 */
async function getSession(modelUrl, preferWebGpu = true) {
  // Return cached session if it's for the same model/provider combo
  if (sessionCache.promise && sessionCache.modelUrl === modelUrl && sessionCache.preferWebGpu === preferWebGpu) {
    return sessionCache.promise;
  }
  
  // Create new session and cache it
  sessionCache.promise = createSessionInternal(modelUrl, preferWebGpu);
  sessionCache.modelUrl = modelUrl;
  sessionCache.preferWebGpu = preferWebGpu;
  
  return sessionCache.promise;
}

async function createSessionInternal(modelUrl, preferWebGpu) {
  console.log("[UI-DETECTOR] Loading model:", modelUrl);
  const t0 = performance.now();
  
  // Try WebGPU first if preferred, fall back to WASM
  const providers = preferWebGpu 
    ? ["webgpu", "wasm"]  // WebGPU primary, WASM fallback
    : ["wasm"];           // WASM only (for debugging)
  
  try {
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: providers,
      // Memory optimization: moderate session size
      sessionOptions: {
        graphOptimizationLevel: "all"
      }
    });
    
    const elapsed = performance.now() - t0;
    console.log(
      `[UI-DETECTOR] Model loaded in ${elapsed.toFixed(0)}ms, providers: ${providers.join(", ")}`
    );
    
    return session;
    
  } catch (err) {
    console.error("[UI-DETECTOR] Failed to load model:", err);
    sessionCache.promise = null; // Clear cache on failure
    throw new Error(`UI element model failed: ${err.message || err}`);
  }
}

/**
 * Detect UI elements in a screenshot
 * 
 * @param {ImageBitmap} bitmap - Screenshot from browser
 * @param {object} opts - Options
 * @param {string} opts.modelUrl - Override model path
 * @param {boolean} opts.preferWebGpu - Force WebGPU (default: true)
 * @param {number} opts.scoreThreshold - Detection confidence (0-1, default 0.4)
 * @param {number} opts.iouThreshold - NMS overlap threshold (default 0.45)
 * @returns {Promise<Array<{className, score, box:{x,y,width,height}}>>}
 */
export async function detectUiElements(bitmap, opts = {}) {
  const {
    modelUrl = new URL(MODEL_URL_DEFAULT, import.meta.url).href,
    preferWebGpu = true,
    scoreThreshold = 0.4,
    iouThreshold = 0.45,
  } = opts;

  if (!bitmap || bitmap.width === 0 || bitmap.height === 0) {
    console.warn("[UI-DETECTOR] Invalid bitmap");
    return [];
  }

  const t0 = performance.now();
  console.log(
    `[UI-DETECTOR] Detecting UI elements (${bitmap.width}x${bitmap.height}, model: ${modelUrl.split("/").pop()})`
  );

  const first = await runOnce(bitmap, { modelUrl, preferWebGpu, scoreThreshold, iouThreshold });

  // Known failure mode: onnxruntime-web's WebGPU (JSEP) backend can load and
  // run a session without throwing, yet produce degenerate/near-zero output
  // on some graphs — so the try/catch fallback never fires, and detection
  // silently returns nothing every time. If we preferred WebGPU and got
  // nothing back, retry once forcing WASM before giving up.
  if (first.elements.length === 0 && preferWebGpu) {
    console.warn(
      `[UI-DETECTOR] 0 elements on WebGPU (maxRawScore=${first.maxScore.toFixed(4)}). ` +
      `Retrying on WASM in case this is a WebGPU backend issue...`
    );
    const retry = await runOnce(bitmap, { modelUrl, preferWebGpu: false, scoreThreshold, iouThreshold });
    console.log(
      `[UI-DETECTOR] WASM retry: ${retry.elements.length} elements (maxRawScore=${retry.maxScore.toFixed(4)})`
    );
    const elapsed = performance.now() - t0;
    console.log(`[UI-DETECTOR] Total (with retry) ${elapsed.toFixed(0)}ms`);
    return retry.elements;
  }

  const elapsed = performance.now() - t0;
  if (DEBUG || first.elements.length > 0) {
    console.log(
      `[UI-DETECTOR] Found ${first.elements.length} elements in ${elapsed.toFixed(0)}ms (maxRawScore=${first.maxScore.toFixed(4)})`
    );
  }

  return first.elements;
}

async function runOnce(bitmap, { modelUrl, preferWebGpu, scoreThreshold, iouThreshold }) {
  try {
    // Get session (cached after first load)
    const session = await getSession(modelUrl, preferWebGpu);

    // Preprocess image to 640x640 tensor
    const { tensor, scaleX, scaleY, padX, padY } = await preprocess(bitmap);

    // Run inference
    const feeds = { [session.inputNames[0]]: tensor };
    const results = await session.run(feeds);
    const output = results[session.outputNames[0]];

    // Decode YOLO output
    const { detections, maxScore } = decodeYolov8Output(output, {
      scoreThreshold,
      classNames: ACTIVE_CLASSES,
    });

    // Non-maximum suppression (remove overlapping boxes)
    const kept = nonMaxSuppression(detections, iouThreshold);

    // Map boxes back to original bitmap coordinates
    const elements = kept.map((d) => ({
      className: d.className,
      score: d.score,
      box: {
        x: (d.box.x - padX) / scaleX,
        y: (d.box.y - padY) / scaleY,
        width: d.box.width / scaleX,
        height: d.box.height / scaleY,
      },
    }));

    return { elements, maxScore };

  } catch (err) {
    console.error("[UI-DETECTOR] Detection failed:", err.message || err);
    throw err;
  }
}

/**
 * Preprocess image for YOLOv8 model
 * Resize to 640x640 with letterboxing, normalize to [0,1]
 */
async function preprocess(bitmap) {
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Letterbox: maintain aspect ratio, pad with gray
  const scale = Math.min(INPUT_SIZE / bitmap.width, INPUT_SIZE / bitmap.height);
  const scaledW = bitmap.width * scale;
  const scaledH = bitmap.height * scale;
  const padX = (INPUT_SIZE - scaledW) / 2;
  const padY = (INPUT_SIZE - scaledH) / 2;

  // Fill background (neutral gray helps model)
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  // Draw resized image centered
  ctx.drawImage(bitmap, padX, padY, scaledW, scaledH);

  // Extract pixel data
  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixelData = imageData.data;

  // Normalize to float32 [0, 1]
  const normalized = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let i = 0; i < pixelData.length; i += 4) {
    const outIdx = (i / 4) * 3;
    normalized[outIdx + 0] = pixelData[i] / 255;       // R
    normalized[outIdx + 1] = pixelData[i + 1] / 255;   // G
    normalized[outIdx + 2] = pixelData[i + 2] / 255;   // B
    // Alpha (pixelData[i+3]) skipped intentionally
  }

  // Create ONNX tensor [1, 3, 640, 640]
  const tensor = new ort.Tensor("float32", normalized, [1, 3, INPUT_SIZE, INPUT_SIZE]);

  return { tensor, scaleX: scale, scaleY: scale, padX, padY };
}

/**
 * Decode YOLOv8 model output
 * Shape: [1, num_detections, 84] where:
 *   - indices 0-3: x, y, w, h (center + size)
 *   - indices 4-83: class confidences (80 classes)
 */
function decodeYolov8Output(output, { scoreThreshold, classNames }) {
  const data = output.data;
  const shape = output.dims;

  if (shape.length < 3) {
    console.warn("[UI-DETECTOR] Unexpected output shape:", shape);
    return { detections: [], maxScore: 0 };
  }

  const numClasses = classNames.length;
  const expectedStride = 4 + numClasses; // 4 bbox coords + one score per class

  // Ultralytics' raw (non-end2end) ONNX export — which is what this model
  // is (see the embedded metadata: dynamic=False, nms=False) — is
  // channel-first: [1, 4+nc, numAnchors], e.g. [1, 12, 8400] for our 8
  // classes. Don't assume the last dim is always the per-box stride
  // (that's only true for a channel-last/detections-first layout); check
  // which axis actually matches 4+nc and read accordingly.
  const dimA = shape[shape.length - 2];
  const dimB = shape[shape.length - 1];

  let numAnchors, channelFirst;
  if (dimA === expectedStride) {
    channelFirst = true;
    numAnchors = dimB;
  } else if (dimB === expectedStride) {
    channelFirst = false;
    numAnchors = dimA;
  } else {
    console.warn(
      `[UI-DETECTOR] Output shape [${shape}] doesn't match expected stride ` +
      `${expectedStride} (4 + ${numClasses} classes) on either axis`
    );
    return { detections: [], maxScore: 0 };
  }

  const detections = [];
  let maxScoreSeen = 0;

  for (let i = 0; i < numAnchors; i++) {
    let x, y, w, h;
    let maxScore = 0;
    let maxClassIdx = -1;

    if (channelFirst) {
      // Layout is [feature][anchor]: value for feature f, anchor i lives at
      // data[f * numAnchors + i].
      x = data[0 * numAnchors + i];
      y = data[1 * numAnchors + i];
      w = data[2 * numAnchors + i];
      h = data[3 * numAnchors + i];
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * numAnchors + i];
        if (score > maxScore) {
          maxScore = score;
          maxClassIdx = c;
        }
      }
    } else {
      // Layout is [anchor][feature]: contiguous stride per anchor.
      const offset = i * expectedStride;
      x = data[offset + 0];
      y = data[offset + 1];
      w = data[offset + 2];
      h = data[offset + 3];
      for (let c = 0; c < numClasses; c++) {
        const score = data[offset + 4 + c];
        if (score > maxScore) {
          maxScore = score;
          maxClassIdx = c;
        }
      }
    }

    if (maxScore > maxScoreSeen) maxScoreSeen = maxScore;

    // Only keep detections above threshold
    if (maxScore >= scoreThreshold && maxClassIdx >= 0 && classNames[maxClassIdx]) {
      detections.push({
        className: classNames[maxClassIdx],
        score: maxScore,
        box: {
          x: x - w / 2,     // Convert from center to top-left
          y: y - h / 2,
          width: w,
          height: h,
        },
      });
    }
  }

  return { detections, maxScore: maxScoreSeen };
}

/**
 * Non-maximum suppression (remove overlapping boxes)
 */
function nonMaxSuppression(detections, iouThreshold) {
  if (detections.length === 0) return [];

  // Sort by confidence (highest first)
  const sorted = [...detections].sort((a, b) => b.score - a.score);

  const kept = [];
  for (const detection of sorted) {
    // Check if this box overlaps with any already-kept box
    let shouldKeep = true;

    for (const keptDet of kept) {
      const iou = calculateIoU(detection.box, keptDet.box);
      if (iou > iouThreshold) {
        shouldKeep = false;
        break;
      }
    }

    if (shouldKeep) {
      kept.push(detection);
    }
  }

  return kept;
}

/**
 * Calculate Intersection over Union of two boxes
 */
function calculateIoU(box1, box2) {
  const x1_min = box1.x;
  const y1_min = box1.y;
  const x1_max = box1.x + box1.width;
  const y1_max = box1.y + box1.height;

  const x2_min = box2.x;
  const y2_min = box2.y;
  const x2_max = box2.x + box2.width;
  const y2_max = box2.y + box2.height;

  const x_min = Math.max(x1_min, x2_min);
  const y_min = Math.max(y1_min, y2_min);
  const x_max = Math.min(x1_max, x2_max);
  const y_max = Math.min(y1_max, y2_max);

  const intersectionArea = Math.max(0, x_max - x_min) * Math.max(0, y_max - y_min);
  const box1Area = box1.width * box1.height;
  const box2Area = box2.width * box2.height;
  const unionArea = box1Area + box2Area - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
}

/**
 * Clear cached session (call on extension unload)
 */
export async function clearSession() {
  try {
    if (sessionCache.promise) {
      const session = await sessionCache.promise;
      if (session && typeof session.release === "function") {
        session.release();
      }
    }
  } catch (err) {
    console.warn("[UI-DETECTOR] Failed to release session:", err);
  }
  sessionCache = { promise: null, preferWebGpu: true, modelUrl: null };
}

/**
 * Get session info for debugging
 */
export async function getSessionInfo() {
  if (!sessionCache.promise) return { cached: false };
  try {
    const session = await sessionCache.promise;
    return {
      cached: true,
      modelUrl: sessionCache.modelUrl,
      preferWebGpu: sessionCache.preferWebGpu,
      inputNames: session.inputNames,
      outputNames: session.outputNames
    };
  } catch (err) {
    return { cached: false, error: err.message };
  }
}