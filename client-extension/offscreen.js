let worker = null;
let workerReadyPromise = null;
let _workerReadyResolve = null;
let _workerReadyReject = null;

console.log("[OFFSCREEN] OFFSCREEN SCRIPT LOADED");

function getWorker() {
  if (!worker) {
    console.log("[OFFSCREEN] Creating visual layer worker");

    worker = new Worker(
      chrome.runtime.getURL(
        "lib/visualLayer/visualLayerWorker.js"
      ),
      {
        type: "module"
      }
    );

    // Create a readiness promise that resolves when the worker posts WORKER_READY
    workerReadyPromise = new Promise((resolve, reject) => {
      _workerReadyResolve = resolve;
      _workerReadyReject = reject;
    });

    worker.addEventListener("message", (event) => {
      try {
        const data = event.data;
        if (data && data.type === "WORKER_READY") {
          console.log("[OFFSCREEN] Worker signaled READY");
          if (_workerReadyResolve) _workerReadyResolve();
        }
      } catch (e) {
        console.error("[OFFSCREEN] Worker message handler error:", e);
      }
    });

    worker.onerror = (event) => {
      console.error(
        "[OFFSCREEN] Worker error:",
        event.message,
        event.filename,
        event.lineno,
        event.colno
      );
      if (_workerReadyReject) {
        _workerReadyReject(new Error(`Worker failed to initialize: ${event.message}`));
      }
      // Also surface to background so runVisualLayer can see the immediate problem
      chrome.runtime.sendMessage({
        target: "background-visual-layer",
        requestId: null,
        ok: false,
        error: `Worker failed to initialize: ${event.message} (${event.filename}:${event.lineno})`
      }).catch(() => {});
    };
  }

  return worker;
}

// Simplified: just use chrome.runtime.sendMessage to reply
chrome.runtime.onMessage.addListener(
  (message, sender) => {

    if (
      message.target !==
      "visual-layer-offscreen"
    ) {
      return;
    }

    if (
      message.type !==
      "RUN_VISUAL_LAYER"
    ) {
      return;
    }

    console.log("[OFFSCREEN] RUN_VISUAL_LAYER received, requestId:", message.requestId);

    // Start async work but don't wait for it here
    runVisualLayer(message).catch(err => {
      console.error("[OFFSCREEN] Unhandled error in runVisualLayer:", err);
    });

    // Don't return true - we're not using the synchronous sendResponse
    // Instead, we'll use chrome.runtime.sendMessage to send the reply
  }
);

async function runVisualLayer(message) {

  const worker = getWorker();
  const requestId = message.requestId;

  console.log("[OFFSCREEN] Starting visual layer processing");

  // Wait for worker to initialize (short timeout) so we fail fast if it never does.
  try {
    await Promise.race([
      workerReadyPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Worker init timeout")), 10000))
    ]);
  } catch (err) {
    console.error("[OFFSCREEN] Worker failed to become ready:", err);
    chrome.runtime.sendMessage({
      target: "background-visual-layer",
      requestId,
      ok: false,
      error: `Worker failed to initialize: ${String(err?.message || err)}`
    }).catch(() => {});
    return;
  }

  // Add timeout for overall operation
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("Visual layer processing timed out after 120 seconds"));
    }, 120000); // 2 minutes (reduced from 300s for faster failure feedback)
  });

  try {
    console.log("[OFFSCREEN] Fetching image data URL");
    const response = await fetch(
      message.imageDataUrl
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch image data: ${response.statusText}`);
    }

    const blob =
      await response.blob();

    console.log("[OFFSCREEN] Creating imageBitmap");
    const imageBitmap =
      await createImageBitmap(blob);

    console.log("[OFFSCREEN] ImageBitmap ready, posting to worker");

    // Race between worker response and timeout
    const result = await Promise.race([

      new Promise((resolve, reject) => {

        const handleMessage =
          (event) => {

            if (
              event.data.requestId !==
              requestId
            ) {
              return;
            }

            worker.removeEventListener(
              "message",
              handleMessage
            );

            console.log("[OFFSCREEN] Received worker response:", event.data.type);

            if (
              event.data.type ===
              "VISUAL_LAYER_RESULT"
            ) {

              resolve(event.data);

            } else if (event.data.type === "VISUAL_LAYER_ERROR") {

              reject(
                new Error(event.data.error || "Worker failed")
              );

            } else {

              // Intermediate messages (e.g. VISUAL_LAYER_PROGRESS) aren't
              // the final answer — keep listening instead of failing the
              // whole request on the first non-terminal message.
              worker.addEventListener(
                "message",
                handleMessage
              );
            }
          };

        worker.addEventListener(
          "message",
          handleMessage
        );

        console.log("[OFFSCREEN] Posting work to worker");

        // Post the work only AFTER worker reported READY above.
        worker.postMessage(
          {
            type:
              "RUN_VISUAL_LAYER",

            imageBitmap,

            options:
              message.options,

            requestId
          },
          [imageBitmap]
        );
      }),
      timeoutPromise
    ]);

    clearTimeout(timeoutHandle);

    console.log("[OFFSCREEN] Sending success response back to background");

    // Send response back to background via chrome.runtime.sendMessage
    chrome.runtime.sendMessage({
      target:
        "background-visual-layer",
      requestId,
      ok: true,
      result
    }).catch(err => {
      console.error("[OFFSCREEN] Failed to send success response:", err);
    });

  } catch (error) {
    clearTimeout(timeoutHandle);

    console.error(
      "[OFFSCREEN] Visual layer failed:",
      error
    );

    // Send error response back to background
    chrome.runtime.sendMessage({
      target:
        "background-visual-layer",
      requestId,
      ok: false,
      error:
        String(
          error?.message || error
        )
    }).catch(err => {
      console.error("[OFFSCREEN] Failed to send error response:", err);
    });
  }
}