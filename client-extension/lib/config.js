// Central config for the client-side agent. Keep every tunable knob here so
// judges/graders can see the accuracy/latency/resource trade-offs in one place.

export const CONFIG = {
  // Where the sanitized context is sent. Swap for your deployed server.
  SERVER_URL: "http://localhost:8787/analyze",

  // Transformers.js model used for local, in-browser vision inference.
  // Swap this for whatever you've validated for accuracy/latency on your
  // target hardware. Kept small/quantized on purpose (client is resource
  // constrained per the problem statement).
  VISION_MODEL: {
    task: "object-detection",           // -> also try "image-segmentation"
    modelId: "Xenova/detr-resnet-50",   // general purpose detector (swap-in point)
    faceModelId: "Xenova/face-detection", // placeholder id: swap for a real
                                           // ONNX face-detection model before
                                           // demo (e.g. a YOLO-face export)
    device: "webgpu",                   // "webgpu" -> falls back to "wasm"
    quantized: true,
    scoreThreshold: 0.55,               // recall/precision knob for detections
  },

  // Don't re-run inference more often than this — protects the client-side
  // resource-utilization score. Raise for smoother UX, lower for freshness.
  MIN_INFERENCE_INTERVAL_MS: 1200,

  // Visual redaction: how much margin (px, at capture resolution) to pad
  // around a detected sensitive region before blacking/blurring it out.
  REDACTION_PADDING_PX: 6,

  // Redaction strategy for pixel regions: "blackout" | "pixelate" | "blur"
  REDACTION_STYLE: "blackout",

  // Categories the DOM scanner treats as sensitive. Extend as needed —
  // this list is also sent (as *labels only*, never values) to the server
  // so its prompt can reason about what a given [REDACTED:TYPE] tag means.
  PII_DOM_CATEGORIES: [
    "password",
    "email",
    "phone",
    "credit-card",
    "ssn-or-national-id",
    "address",
    "name",
    "otp-code",
  ],

  DEBUG: true,
};
