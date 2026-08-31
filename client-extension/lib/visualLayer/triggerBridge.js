// lib/visualLayer/triggerBridge.js
//
// Two ways to fire the visual layer, per the spec: (a) whenever a DOM
// element gets interacted with, and (b) whenever a signal arrives at an
// API endpoint (localhost:2000 for now). Both funnel into the same
// onTrigger(reason, tabId, extra) callback that background.js wires to
// visualLayerController.runVisualLayer().
//
// Runs in background.js (needs chrome.tabs to know which tab to capture).

const DOM_INTERACTION_DEBOUNCE_MS = 800;
//const SIGNAL_ENDPOINT = "ws://localhost:2000"; // per spec: "for now localhost 2000"
const SIGNAL_ENDPOINT = null; // per spec: "for now localhost 2000"

const SIGNAL_RECONNECT_BASE_MS = 2000;
const SIGNAL_RECONNECT_MAX_MS = 30000;

let domDebounceTimer = null;
let socket = null;
let reconnectDelay = SIGNAL_RECONNECT_BASE_MS;
let reconnectTimer = null;

/**
 * Wire both trigger sources.
 * @param {(reason: "dom-interaction" | "api-signal", tabId: number, extra?: object) => void} onTrigger
 */
export function initTriggers(onTrigger) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type !== "DOM_INTERACTION") return;
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    // Debounce: a burst of clicks/keystrokes should trigger the pipeline
    // once, not once per keystroke — this is a direct lever on the
    // client-resource-utilization score.
    clearTimeout(domDebounceTimer);
    domDebounceTimer = setTimeout(() => {
      onTrigger("dom-interaction", tabId, { interaction: message.interaction });
    }, DOM_INTERACTION_DEBOUNCE_MS);
  });
  if (SIGNAL_ENDPOINT) {
          connectSignalSocket(onTrigger);
      }
  //connectSignalSocket(onTrigger);

}

function connectSignalSocket(onTrigger) {
  try {
    socket = new WebSocket(SIGNAL_ENDPOINT);
  } catch (err) {
    scheduleReconnect(onTrigger);
    return;
  }

  socket.addEventListener("open", () => {
    reconnectDelay = SIGNAL_RECONNECT_BASE_MS; // reset backoff on success
    console.log("[visual-layer] connected to signal endpoint", SIGNAL_ENDPOINT);
  });

  socket.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // ignore malformed signals
    }
    if (payload?.type !== "trigger") return;

    const tabId = payload.tabId ?? (await getActiveTabId());
    if (tabId == null) return;
    onTrigger("api-signal", tabId, { task: payload.task });
  });

  socket.addEventListener("close", () => scheduleReconnect(onTrigger));
  socket.addEventListener("error", () => socket?.close());
}

function scheduleReconnect(onTrigger) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, SIGNAL_RECONNECT_MAX_MS);
    connectSignalSocket(onTrigger);
  }, reconnectDelay);
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// NOTE ON MV3 SERVICE-WORKER LIFETIME: the service worker can be killed
// after ~30s of inactivity, which will drop this WebSocket. For a hackathon
// demo this is usually fine (an active demo keeps the SW alive via message
// traffic), but for a robust deployment, pair this with a
// chrome.alarms-based keepalive ping, or move the socket to an offscreen
// document (chrome.offscreen), which has a longer-lived context than the SW.
