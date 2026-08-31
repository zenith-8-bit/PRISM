// background.js (MV3 service worker) - UPDATED WITH BACKEND INTEGRATION
// Orchestrator: capture -> local vision inference -> DOM scan -> redact ->
// send sanitized context to Python backend -> receive action plan -> execute

import { CONFIG } from "./lib/config.js";
import { initTriggers } from "./lib/visualLayer/triggerBridge.js";
import { runVisualLayer } from "./lib/visualLayer/visualLayerController.js";
import { BackendConnector } from "./lib/backendConnector.js";

// ==================== INITIALIZATION ====================

const BACKEND_URL = CONFIG.BACKEND_URL || "http://localhost:8000";
const WS_URL = CONFIG.WS_URL || "ws://localhost:8000";

let backendConnector = null;
let sessionId = null;
let currentChatId = null;

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  
  // Initialize backend connection
  sessionId = generateSessionId();
  chrome.storage.local.set({ 
    "session_id": sessionId,
    "backend_url": BACKEND_URL,
    "initialized_at": Date.now()
  });
});

// ==================== BACKEND CONNECTOR ====================

async function initBackendConnector() {
  if (backendConnector) return backendConnector;
  
  backendConnector = new BackendConnector(WS_URL, sessionId);
  await backendConnector.connect();
  
  // Listen for incoming actions from backend
  backendConnector.on("action_received", async (action) => {
    if (CONFIG.DEBUG) console.log("[backend] Action received:", action);
    await executeServerAction(action);
  });
  
  return backendConnector;
}

async function executeServerAction(action) {
  /**
   * Execute actions sent from Python backend:
   * - click: Click UI element by ID or coordinates
   * - fill: Fill form field with text
   * - extract_text: Extract text from specified region
   * - screenshot: Capture and send new screenshot
   *
   * The backend's agent loop blocks after pushing a click/fill action until
   * it hears back via reportActionResult() - without that report, every
   * multi-step task would time out after the first action.
   */
  
  const tabId = await getActiveTabId();
  
  if (action.type === "click") {
    try {
      const result = await sendToContent(tabId, {
        type: "EXECUTE_ACTION",
        action: {
          type: "click",
          element_id: action.element_id,
          coordinates: action.coordinates
        }
      });
      await reportActionResult(action.action_id, result?.result?.success ?? true, result?.result?.message ?? "");
    } catch (err) {
      await reportActionResult(action.action_id, false, String(err?.message || err));
    }
  } 
  else if (action.type === "fill") {
    try {
      // content.js's executeFill reads action.text_value, not action.text.
      const result = await sendToContent(tabId, {
        type: "EXECUTE_ACTION",
        action: {
          type: "fill",
          element_id: action.element_id,
          text_value: action.text_value
        }
      });
      await reportActionResult(action.action_id, result?.result?.success ?? true, result?.result?.message ?? "");
    } catch (err) {
      await reportActionResult(action.action_id, false, String(err?.message || err));
    }
  }
  else if (action.type === "screenshot") {
    setTimeout(async () => {
      const result = await runVisualLayer("server_action", tabId, {
        reason: "server_requested",
        action_type: action.type
      });
      await sendScreenToBackend(result);
    }, action.delay_ms || 500);
  }
}

async function reportActionResult(actionId, success, message) {
  if (!actionId || !backendConnector) return;
  try {
    await backendConnector.reportActionResult(actionId, success, message);
  } catch (err) {
    if (CONFIG.DEBUG) console.warn("[backend] Failed to report action result:", err);
  }
}

async function sendScreenToBackend(visualLayerResult) {
  /**
   * Send screen state to backend via HTTP POST
   */
  if (!sessionId || !backendConnector) return;
  
  try {
    const payload = {
      session_id: sessionId,
      tab_id: await getActiveTabId(),
      timestamp: Date.now() / 1000,
      ui_elements: visualLayerResult.uiElements || [],
      text_blocks: visualLayerResult.textBlocks || [],
      pii_matches: visualLayerResult.piiMatches || [],
      images: visualLayerResult.classifiedImages || [],
      redaction_manifest: visualLayerResult.redactionManifest,
      pii_vault: visualLayerResult.piiVaultSummary
      // NOTE: redactedImageDataUrl is intentionally NOT included here.
      // All visual/OCR processing (YOLO UI detection, Tesseract OCR, PII
      // regex matching) already happened locally in the browser - the
      // server never needs, and must never receive, pixel data. Everything
      // it needs to reason about the page (ui_elements/text_blocks/
      // redaction_manifest) is already plain structured text above.
    };
    
    const response = await fetch(`${BACKEND_URL}/api/screen/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    if (CONFIG.DEBUG) console.log("[backend] Screen received:", result);
  } catch (err) {
    if (CONFIG.DEBUG) console.error("[backend] Error sending screen:", err);
  }
}

// ==================== VISUAL LAYER TRIGGERS ====================

let lastVisualLayerAt = 0;
initTriggers(async (reason, tabId, extra) => {
  const now = Date.now();
  if (now - lastVisualLayerAt < CONFIG.MIN_INFERENCE_INTERVAL_MS) return;
  lastVisualLayerAt = now;
  
  try {
    const result = await runVisualLayer(reason, tabId, extra);
    await chrome.storage.session?.set?.({ pva_last_visual_layer_result: result }).catch(() => {});
    
    // Send to backend if it's a user interaction
    if (reason === "dom_interaction" && backendConnector) {
      await sendScreenToBackend(result);
    }
  } catch (err) {
    if (CONFIG.DEBUG) console.warn("[visual-layer] trigger run failed:", err);
  }
});

// ==================== MESSAGE HANDLER ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_CHAT_MESSAGE") {
    handleChatMessage(message.message, message.screen_state)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  
  if (message.type === "GET_SESSION_ID") {
    sendResponse({ ok: true, session_id: sessionId });
    return false;
  }
});

async function handleChatMessage(message, screenState) {
  /**
   * Handle user message from side panel:
   * 1. Get or create chat session
   * 2. Send to backend over the WebSocket connection
   * 3. The backend pushes click/fill actions as it plans them; each one is
   *    executed and reported back by executeServerAction/reportActionResult
   *    (wired up in initBackendConnector's "action_received" listener) -
   *    this function does NOT execute actions itself.
   * 4. Return the final response + step log to the side panel once the
   *    backend's agent loop finishes.
   */
  
  if (!sessionId) {
    const data = await chrome.storage.local.get("session_id");
    sessionId = data.session_id;
  }
  
  await initBackendConnector();
  
  if (!currentChatId) {
    currentChatId = await createChatSession();
  }
  // Always obtain fresh local vision state for every user request.
  let freshScreenState;

  try {
    const tabId = await getActiveTabId();

    console.log(
      "[visual-layer] Fresh scan for chat request:",
      message
    );

    freshScreenState = await runVisualLayer(
      "chat_request",
      tabId,
      { task: message }
    );

    console.log("[visual-layer] Fresh scan result:", {
      uiElements: freshScreenState.uiElements?.length || 0,
      textBlocks: freshScreenState.textBlocks?.length || 0,
      piiMatches: freshScreenState.piiMatches?.length || 0
    });

  } catch (err) {
    console.error(
      "[visual-layer] Chat-request scan failed:",
      err
    );

    freshScreenState = {
      uiElements: [],
      textBlocks: [],
      piiMatches: [],
      redactionManifest: []
    };
  }
  
  // Belt-and-suspenders: strip any screenshot/image data before this ever
  // reaches the network, regardless of what the side panel attached. The
  // server only gets text (ui_elements/text_blocks/redaction_manifest);
  // all image/OCR processing already happened locally in the browser.
  const sanitizedScreenState = {
  ...(freshScreenState || {}),
  };

  // Never allow pixel data to reach backend.
  delete sanitizedScreenState.redactedImageDataUrl;
  delete sanitizedScreenState.redacted_screenshot;

  try {
    const result = await backendConnector.sendChatMessage(message, sanitizedScreenState);
    
    if (result.error) {
      return { error: result.error };
    }
    
    return {
      response: result.response,
      actions_executed: result.actions ? result.actions.length : 0,
      actions: result.actions,
      pii_report: result.pii_report,
      redacted_total: result.redacted_items_total
    };
  } catch (err) {
    return { error: `Backend error: ${err.message}` };
  }
}

async function createChatSession() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/chat/${sessionId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    return data.chat_id;
  } catch (err) {
    console.error("Failed to create chat session:", err);
    return null;
  }
}

function sendToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => null);
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active tab found");
  }

  if (
    !tab.url ||
    tab.url.startsWith("devtools://") ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("brave://") ||
    tab.url.startsWith("edge://") ||
    tab.url.startsWith("about:")
  ) {
    throw new Error(
      `Cannot scan protected page: ${tab.url || "unknown"}`
    );
  }

  return tab.id;
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ==================== INITIALIZATION ====================

async function initialize() {
  const data = await chrome.storage.local.get(["session_id"]);
  sessionId = data.session_id || generateSessionId();
  
  if (!data.session_id) {
    await chrome.storage.local.set({ "session_id": sessionId });
  }
  
  // Initialize backend connection
  await initBackendConnector();
}

// Auto-initialize on service worker start
initialize().catch(err => {
  if (CONFIG.DEBUG) console.error("[background] Initialization failed:", err);
});