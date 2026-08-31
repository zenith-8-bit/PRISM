/**
 * sidepanel.js
 * Chat UI logic for the real sidepanel.html markup (chatThread / composer /
 * task / logAccordion / authBar / toastRoot). The previous version of this
 * file queried #chat-container, #message-input, #send-button, #status,
 * #stats, #loading-spinner - none of which exist in sidepanel.html - which
 * threw "Cannot set properties of null" on load and crashed the panel.
 */

import { signInWithGoogle, signOut } from "./lib/auth.js";
import { onAuthStateChanged } from "./lib/firebaseClient.js";

// ==================== STATE ====================

let sessionId = null;
let isLoading = false;
let redactedLog = []; // { category, source, time }
let currentUser = null;

// ==================== DOM ELEMENTS ====================

const clockEl = document.getElementById("clock");
const authBar = document.getElementById("authBar");
const logAccordion = document.getElementById("logAccordion");
const logToggle = document.getElementById("logToggle");
const logCount = document.getElementById("logCount");
const logBody = document.getElementById("logBody");
const chatThread = document.getElementById("chatThread");
const composer = document.getElementById("composer");
const taskInput = document.getElementById("task");
const sendButton = document.getElementById("send");
const toastRoot = document.getElementById("toastRoot");

// ==================== INITIALIZATION ====================

document.addEventListener("DOMContentLoaded", async () => {
  startClock();
  setupEventListeners();
  await initSession();
  initAuth();
});

async function initSession() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SESSION_ID" });
    if (response?.ok) {
      sessionId = response.session_id;
    } else {
      showToast("Could not reach the extension background page.", "error");
    }
  } catch (err) {
    showToast(`Failed to initialize: ${err.message || err}`, "error");
  }
}

function initAuth() {
  // Firebase's compat SDK is expected to be vendored into lib/vendor/ (see
  // lib/vendor/README.md) - it isn't fetched from a CDN because MV3's CSP
  // forbids that. If it hasn't been vendored yet, degrade gracefully
  // instead of throwing on load: show a local-only auth bar rather than
  // crashing the whole panel.
  try {
    onAuthStateChanged((user) => {
      currentUser = user;
      renderAuthBar();
    });
  } catch (err) {
    renderAuthBar({ unavailable: true });
  }
}

function setupEventListeners() {
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSendMessage();
  });

  taskInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSendMessage();
    }
  });

  logToggle.addEventListener("click", () => {
    const isOpen = logAccordion.classList.toggle("is-open");
    logToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

// ==================== CHAT FUNCTIONALITY ====================

async function handleSendMessage() {
  const message = taskInput.value.trim();
  if (!message || isLoading) return;

  addBubble("user", message);
  taskInput.value = "";
  taskInput.focus();

  setLoadingState(true);
  const thinkingBubble = addBubble("agent", "Thinking…", { pending: true });

  try {
    const screenState = await getScreenState();
    const response = await chrome.runtime.sendMessage({
      type: "SEND_CHAT_MESSAGE",
      message,
      screen_state: screenState
    });

    if (!response?.ok) {
      throw new Error(response?.error || "No response from background page");
    }
    const result = response.result;
    if (result.error) {
      throw new Error(result.error);
    }

    updateBubble(thinkingBubble, result.response || "(no response)", {
      steps: result.actions,
      simulated: !result.actions_executed
    });

    if (result.pii_report) {
      recordRedactions(result.pii_report);
    }

    if (result.actions_executed) {
      showToast(`${result.actions_executed} action(s) executed`, "ok");
    }
  } catch (error) {
    updateBubble(thinkingBubble, `Error: ${error.message || "Failed to process message"}`, { isError: true });
    showToast("Error communicating with backend", "error");
  } finally {
    setLoadingState(false);
  }
}

async function getScreenState() {
  /**
   * Pull the most recent local vision-layer result (set by background.js's
   * visual-layer triggers) out of session storage, if one exists yet.
   */
  try {
    const result = await chrome.storage.session.get("pva_last_visual_layer_result");
    const vl = result?.pva_last_visual_layer_result;
    if (!vl) return null;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return {
      tab_id: activeTab?.id,
      timestamp: Date.now() / 1000,
      ui_elements: vl.uiElements || [],
      text_blocks: vl.textBlocks || [],
      pii_matches: vl.piiMatches || [],
      images: vl.classifiedImages || [],
      redaction_manifest: vl.redactionManifest,
      pii_vault: vl.piiVaultSummary
      // Deliberately no redacted_screenshot / image data here. All visual
      // processing (UI detection, OCR, PII redaction) happens locally in
      // the browser; the backend only ever gets the structured text output
      // of that pipeline, never a screenshot.
    };
  } catch (e) {
    console.log("[sidepanel] Could not get visual layer result:", e);
    return null;
  }
}

// ==================== CHAT THREAD UI ====================

function addBubble(role, text, opts = {}) {
  const bubble = document.createElement("div");
  bubble.className = `bubble bubble--${role}`;
  if (opts.simulated) bubble.classList.add("bubble--simulated");

  const meta = document.createElement("div");
  meta.className = "bubble__meta";
  const roleLabel = document.createElement("span");
  roleLabel.textContent = role === "user" ? "YOU" : role === "agent" ? "AGENT" : "SYSTEM";
  const timeLabel = document.createElement("span");
  timeLabel.textContent = new Date().toLocaleTimeString();
  meta.appendChild(roleLabel);
  meta.appendChild(timeLabel);

  const textEl = document.createElement("div");
  textEl.className = "bubble__text";
  textEl.textContent = text;

  bubble.appendChild(meta);
  bubble.appendChild(textEl);

  if (opts.steps && opts.steps.length > 0) {
    bubble.appendChild(renderStepChips(opts.steps));
  }

  chatThread.appendChild(bubble);
  chatThread.scrollTop = chatThread.scrollHeight;
  return bubble;
}

function updateBubble(bubble, text, opts = {}) {
  bubble.classList.remove("bubble--simulated");
  if (opts.simulated) bubble.classList.add("bubble--simulated");
  if (opts.isError) bubble.classList.add("bubble--error");

  const textEl = bubble.querySelector(".bubble__text");
  textEl.textContent = text;

  const existingChips = bubble.querySelector(".bubble__chips");
  if (existingChips) existingChips.remove();

  if (opts.steps && opts.steps.length > 0) {
    bubble.appendChild(renderStepChips(opts.steps));
  }

  chatThread.scrollTop = chatThread.scrollHeight;
}

function renderStepChips(steps) {
  const chips = document.createElement("div");
  chips.className = "bubble__chips";
  steps.forEach((step, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const ok = step.observation?.success !== false;
    chip.textContent = `${i + 1}. ${step.tool} ${ok ? "✓" : "○"}`;
    chips.appendChild(chip);
  });
  return chips;
}

// ==================== REDACTION LOG ====================

function recordRedactions(piiReport) {
  const time = new Date().toLocaleTimeString();

  Object.entries(piiReport.redacted_categories || {}).forEach(([category, count]) => {
    redactedLog.unshift({ category, source: `${count} match(es)`, time });
  });

  (piiReport.sensitive_ui_elements || []).forEach((el) => {
    redactedLog.unshift({ category: el.class || "sensitive-field", source: "DOM element", time });
  });

  renderRedactionLog();
}

function renderRedactionLog() {
  logCount.textContent = String(redactedLog.length);

  if (redactedLog.length === 0) {
    logBody.innerHTML = `<span class="log-empty">Nothing redacted yet this session.</span>`;
    return;
  }

  logBody.innerHTML = "";
  redactedLog.slice(0, 100).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `
      <span class="log-row__swatch"></span>
      <span class="log-row__category">${escapeHtml(entry.category)}</span>
      <span class="log-row__source">${escapeHtml(entry.source)}</span>
      <span class="log-row__time">${escapeHtml(entry.time)}</span>
    `;
    logBody.appendChild(row);
  });
}

// ==================== AUTH BAR ====================

function renderAuthBar(opts = {}) {
  authBar.innerHTML = "";

  if (opts.unavailable) {
    const note = document.createElement("span");
    note.className = "auth-status auth-status--local";
    note.textContent = "Local only (sign-in not configured)";
    authBar.appendChild(note);
    return;
  }

  if (currentUser) {
    const identity = document.createElement("div");
    identity.className = "auth-identity";

    if (currentUser.photoURL) {
      const avatar = document.createElement("img");
      avatar.className = "auth-avatar";
      avatar.src = currentUser.photoURL;
      avatar.alt = "";
      identity.appendChild(avatar);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "auth-avatar auth-avatar--placeholder";
      placeholder.textContent = (currentUser.displayName || "?")[0].toUpperCase();
      identity.appendChild(placeholder);
    }

    const text = document.createElement("div");
    text.className = "auth-text";
    const name = document.createElement("span");
    name.className = "auth-name";
    name.textContent = currentUser.displayName || currentUser.email || "Signed in";
    const status = document.createElement("span");
    status.className = "auth-status auth-status--synced";
    status.textContent = "Synced";
    text.appendChild(name);
    text.appendChild(status);
    identity.appendChild(text);

    const signOutBtn = document.createElement("button");
    signOutBtn.className = "btn btn-ghost";
    signOutBtn.textContent = "Sign out";
    signOutBtn.addEventListener("click", async () => {
      try {
        await signOut();
      } catch (err) {
        showToast(`Sign-out failed: ${err.message || err}`, "error");
      }
    });

    authBar.appendChild(identity);
    authBar.appendChild(signOutBtn);
  } else {
    const signInBtn = document.createElement("button");
    signInBtn.className = "btn btn-primary";
    signInBtn.textContent = "Sign in with Google";
    signInBtn.addEventListener("click", async () => {
      try {
        await signInWithGoogle();
      } catch (err) {
        showToast(`Sign-in failed: ${err.message || err}`, "error");
      }
    });
    authBar.appendChild(signInBtn);

    const status = document.createElement("span");
    status.className = "auth-status auth-status--local";
    status.textContent = "Local only";
    authBar.appendChild(status);
  }
}

// ==================== TOASTS ====================

function showToast(message, level = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${level}`;
  toast.textContent = message;
  toastRoot.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("is-visible"));

  setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// ==================== MISC UI ====================

function setLoadingState(loading) {
  isLoading = loading;
  sendButton.disabled = loading;
  taskInput.disabled = loading;
}

function startClock() {
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}