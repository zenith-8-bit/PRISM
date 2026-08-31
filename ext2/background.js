// background.js (MV3 service worker) - DOM-ONLY MODE
// Orchestrator: DOM scan (content.js) -> redact -> send sanitized context to
// Python backend -> receive action plan -> execute.
//
// The local OCR/ONNX vision pass (screenshot -> offscreen worker -> Tesseract
// + YOLO) has been dropped for now. lib/domCapture.js's runDomCapture() is a
// drop-in replacement for the old runVisualLayer() - same return shape - so
// everything below this line that consumes its output is unchanged.

import { CONFIG } from "./lib/config.js";
import { initTriggers } from "./lib/visualLayer/triggerBridge.js";
import { runDomCapture, highlightElementInTab, autofillFormInTab } from "./lib/domCapture.js";
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
      const result = await runDomCapture("server_action", tabId, {
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
    const result = await runDomCapture(reason, tabId, extra);
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

  // ---- Demo feature 1: "find X on screen" ----
  if (message.type === "FIND_ELEMENT") {
    handleFindElement(message.query)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // ---- Demo feature 2: autofill a form from a saved profile ----
  if (message.type === "AUTOFILL_FORM") {
    handleAutofill(message.profile)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

// ==================== DEMO FEATURE 1: FIND ELEMENT ====================

async function handleFindElement(query) {
  /**
   * 1. Fresh DOM scan so we're matching against what's actually on screen.
   * 2. Ask the server (Qwen) to pick which ui_element best matches the
   *    natural-language query.
   * 3. Tell content.js to draw a highlight box around that element.
   */
  const tabId = await getActiveTabId();
  console.log("[find-element] Scanning page for query:", query);

  const screenState = await runDomCapture("find_element", tabId, { task: query });

  const response = await fetch(`${BACKEND_URL}/api/find_element`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      ui_elements: screenState.uiElements,
    }),
  });
  const data = await response.json();
  console.log("[find-element] Server match:", data);

  if (!data.selector) {
    return { found: false, reasoning: data.reasoning };
  }

  const highlightResult = await highlightElementInTab(tabId, {
    selector: data.selector,
    label: data.label || query,
  });

  return { found: highlightResult.ok, selector: data.selector, reasoning: data.reasoning };
}

// ==================== DEMO FEATURE 2: AUTOFILL ====================

async function handleAutofill(profile) {
  const tabId = await getActiveTabId();
  console.log("[autofill] Running autofill with profile keys:", Object.keys(profile || {}));
  const result = await autofillFormInTab(tabId, profile || {});
  console.log("[autofill] Result:", result);
  return result;
}

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
  // Always obtain a fresh DOM scan for every user request.
  let freshScreenState;

  try {
    const tabId = await getActiveTabId();

    console.log(
      "[dom-capture] Fresh scan for chat request:",
      message
    );

    freshScreenState = await runDomCapture(
      "chat_request",
      tabId,
      { task: message }
    );

    console.log("[dom-capture] Fresh scan result:", {
      uiElements: freshScreenState.uiElements?.length || 0,
      textBlocks: freshScreenState.textBlocks?.length || 0,
      piiMatches: freshScreenState.piiMatches?.length || 0
    });

  } catch (err) {
    console.error(
      "[dom-capture] Chat-request scan failed:",
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
  //
  // Also: runDomCapture() returns camelCase keys (uiElements/textBlocks/...)
  // but server.py's _screen_state_from_dict() reads snake_case
  // (ui_elements/text_blocks/...). Without this mapping the server always
  // saw an empty screen state here - it just used to paper over that by
  // having the model guess a plausible-looking page instead of saying so.
  const sanitizedScreenState = {
    tab_id: freshScreenState?.tab_id,
    timestamp: Date.now() / 1000,
    ui_elements: freshScreenState?.uiElements || [],
    text_blocks: freshScreenState?.textBlocks || [],
    pii_matches: freshScreenState?.piiMatches || [],
    redaction_manifest: freshScreenState?.redactionManifest || [],
  };

  try {
    const result = await backendConnector.sendChatMessage(message, sanitizedScreenState);
    
    if (result.error) {
      return { error: result.error };
    }

    // If the server planned a concrete click/fill/scroll, actually execute
    // it in the tab now - "actions_executed" used to just be the length of
    // the *planned* steps array (which was never 0, even for a plan nobody
    // ran), so the side panel's "N action(s) executed" toast was always
    // describing intent, not outcome. This is the part that makes "click
    // this button" / "fill in this field" actually happen on the page.
    let executionNote = "";
    let actionsExecuted = 0;

    if (result.action && result.action.type) {
      try {
        const tabId = await getActiveTabId();
        const execResult = await executeResolvedAction(tabId, result.action);
        actionsExecuted = execResult.success ? 1 : 0;
        executionNote = execResult.success
          ? `\n\n✓ ${execResult.message}`
          : `\n\n✗ Couldn't do that: ${execResult.message}`;
        console.log("[agent-action] Executed:", result.action, "->", execResult);
      } catch (err) {
        executionNote = `\n\n✗ Couldn't do that: ${err.message}`;
        console.error("[agent-action] Execution failed:", err);
      }
    }

    return {
      response: (result.response || "") + executionNote,
      actions_executed: actionsExecuted,
      actions: result.actions,
      pii_report: result.pii_report,
      redacted_total: result.redacted_items_total
    };
  } catch (err) {
    return { error: `Backend error: ${err.message}` };
  }
}

async function executeResolvedAction(tabId, action) {
  /**
   * action: {type: "click_element"|"fill_form"|"scroll_page", element_id,
   *          selector, text_value, direction}
   * Maps the server's tool names onto content.js's EXECUTE_ACTION contract
   * and prefers `selector` (a real, resolvable CSS path from the DOM scan)
   * over `element_id`, since element_id only matches via the data-pva-id
   * attribute content.js stamps on - selector works even if that attribute
   * got cleared by a page re-render between scan and execution.
   */
  const target = { selector: action.selector, element_id: action.element_id };

  if (action.type === "click_element") {
    const result = await sendToContent(tabId, { type: "EXECUTE_ACTION", action: { type: "click", ...target } });
    if (!result?.ok) return { success: false, message: result?.error || "Click failed" };
    return { success: true, message: result.result?.message || `Clicked ${action.label || "element"}` };
  }

  if (action.type === "fill_form") {
    const result = await sendToContent(tabId, {
      type: "EXECUTE_ACTION",
      action: { type: "fill", ...target, text_value: action.text_value || "" },
    });
    if (!result?.ok) return { success: false, message: result?.error || "Fill failed" };
    return { success: true, message: result.result?.message || `Filled ${action.label || "field"}` };
  }

  if (action.type === "scroll_page") {
    const y = action.direction === "up" ? -500 : 500;
    const result = await sendToContent(tabId, { type: "EXECUTE_ACTION", action: { type: "scroll", y } });
    if (!result?.ok) return { success: false, message: result?.error || "Scroll failed" };
    return { success: true, message: result.result?.message || "Scrolled" };
  }

  return { success: false, message: `Unknown action type: ${action.type}` };
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