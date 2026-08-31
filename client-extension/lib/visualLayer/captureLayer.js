// lib/visualLayer/captureLayer.js
//
// "WebGPU-based capture layer" — to be precise about what runs where:
// screen capture itself (chrome.tabs.captureVisibleTab) is a browser/OS
// API, not a GPU workload, and it must run in background.js because only
// the extension's privileged context has chrome.tabs access. WebGPU comes
// in immediately after: it's the compute backend the visual-layer worker
// uses to run the UI-element detector and (where supported) OCR, via
// onnxruntime-web's "webgpu" execution provider / transformers.js's
// device:"webgpu" option. This file is the seam between the two: it
// captures the frame, probes WebGPU availability, and hands both to the
// worker in one message.
//
// Service workers can construct an ImageBitmap and check navigator.gpu,
// but WebGPU device/adapter creation itself only reliably works inside a
// Window or a dedicated Worker — hence still delegating actual inference to
// visualLayerWorker.js rather than running it here.

/**
 * @returns {Promise<{bitmap: ImageBitmap, capturedAt: number}>}
 */
export async function captureActiveTabFrame(tabId) {
  if (!tabId) {
    throw new Error("captureActiveTabFrame: missing tabId");
  }

  // Verify that the requested tab is actually a capturable webpage.
  const tab = await chrome.tabs.get(tabId);

  if (!tab?.url) {
    throw new Error(`Cannot capture tab ${tabId}: URL unavailable`);
  }

  if (
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("brave://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("devtools://") ||
    tab.url.startsWith("about:")
  ) {
    throw new Error(`Cannot capture protected page: ${tab.url}`);
  }

  console.log(
    "[capture-layer] Capturing tab:",
    tabId,
    tab.url
  );

  // captureVisibleTab captures the visible tab in the specified window.
  // Use the window containing the requested webpage rather than whatever
  // happens to be focused at the time.
  const dataUrl = await chrome.tabs.captureVisibleTab(
    tab.windowId,
    { format: "png" }
  );

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  console.log(
    "[capture-layer] Capture complete:",
    bitmap.width,
    "x",
    bitmap.height
  );

  return {
    bitmap,
    capturedAt: Date.now()
  };
}
/**
 * Best-effort WebGPU availability probe. `navigator.gpu` exists in MV3
 * service workers, but requestAdapter() support has historically been
 * spottier there than in a Window/Worker — so treat a `false` here as "the
 * worker should still try WebGPU itself and fall back to wasm", not as a
 * hard veto. This value is only used for telemetry/logging + choosing
 * which backend to *prefer* first.
 */
export async function probeWebGpuAvailable() {
  if (!("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}
