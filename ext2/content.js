/**
 * content.js - Runs in web page context
 *
 * DOM-ONLY MODE: the OCR / ONNX UI-element-detection pipeline that used to
 * run here (screenshot -> offscreen worker -> Tesseract + YOLO) has been
 * removed. Every signal this file produces now comes from the live DOM:
 * getBoundingClientRect() for boxes, tag/role/aria for labels, and the same
 * PII field-hint heuristics the old domScanner.js used. Nothing here is a
 * stand-in that pretends to be vision output — ui_elements/text_blocks sent
 * to the server are exactly what querySelectorAll() found, no more, no less.
 * The console.log lines are kept (and relabeled "[dom-capture]") because
 * they're genuinely useful for watching what got scanned during a demo.
 *
 * Handles DOM scanning, interaction logging, and action execution.
 * Communicates with background.js via chrome.runtime messages.
 */

// ==================== DOM SCANNING ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN_DOM") {
    const scanResult = scanDOM();
    sendResponse(scanResult);
  } 
  else if (message.type === "EXECUTE_ACTION") {
    handleExecuteAction(message.action)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  else if (message.type === "EXECUTE_PLAN") {
    handleExecutePlan(message.plan)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
  else if (message.type === "HIGHLIGHT_ELEMENT") {
    const result = highlightElement(message.target || {});
    sendResponse(result);
  }
  else if (message.type === "AUTOFILL_FORM") {
    handleAutofillForm(message.profile || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
});

function scanDOM() {
  /**
   * Full DOM scan, DOM-only (no screenshot, no OCR, no ONNX):
   * - findings: sensitive input fields + PII-shaped visible text (unchanged
   *   behavior from before, still used for the redaction report)
   * - ui_elements: every visible, interactive element on screen (buttons,
   *   links, inputs, [role=button/link/tab/menuitem], anything clickable) -
   *   this is the "what can I click/fill right now" signal the demo's two
   *   features (find-element, autofill) both run on.
   * - text_blocks: visible block-level text, for "what's on this page"
   *   style questions.
   */
  console.log("[dom-capture] Starting scan...");
  const t0 = performance.now();

  const findings = [];
  const devicePixelRatio = window.devicePixelRatio || 1;
  let nextId = 0;
  const idFor = (el) => {
    if (!el.dataset.pvaId) el.dataset.pvaId = `pva-${Date.now().toString(36)}-${nextId++}`;
    return el.dataset.pvaId;
  };

  // Scan input fields for sensitive categories (PII redaction, unchanged logic)
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const type = el.type?.toLowerCase() || "text";
    const sensitive = isInputSensitive(type, el);

    if (sensitive) {
      const rect = el.getBoundingClientRect();
      findings.push({
        source: "dom",
        category: getInputCategory(type, el),
        type: type,
        selector: getSelector(el),
        box: {
          x: rect.left * devicePixelRatio,
          y: rect.top * devicePixelRatio,
          width: rect.width * devicePixelRatio,
          height: rect.height * devicePixelRatio,
        },
      });
    }
  });

  // Scan visible text for PII patterns (lightweight)
  scanVisibleText().forEach((match) => {
    findings.push({
      source: "dom_text",
      category: match.category,
      value: match.value,
      box: match.box,
    });
  });

  console.log(`[dom-capture] Found ${findings.length} sensitive findings, scanning UI elements...`);

  const uiElements = collectUiElements(idFor);
  console.log(`[dom-capture] Found ${uiElements.length} interactive UI elements`);

  const textBlocks = collectTextBlocks();
  console.log(`[dom-capture] Found ${textBlocks.length} visible text blocks`);

  const latencyMs = performance.now() - t0;
  console.log(`[dom-capture] Scan complete in ${latencyMs.toFixed(0)}ms`);

  return {
    findings,
    uiElements,
    textBlocks,
    domSummary: {
      title: document.title,
      url: window.location.href,
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input").length,
      timestamp: Date.now(),
    },
    devicePixelRatio,
    latencyMs,
  };
}

// ==================== UI ELEMENT / TEXT COLLECTION ====================

const INTERACTIVE_SELECTOR =
  "button, a[href], input, textarea, select, [role='button'], [role='link'], " +
  "[role='tab'], [role='menuitem'], [role='checkbox'], [role='radio'], " +
  "[onclick], [tabindex]:not([tabindex='-1'])";

function collectUiElements(idFor) {
  const dpr = window.devicePixelRatio || 1;
  const seen = new Set();
  const elements = [];

  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => {
    if (!isVisible(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const selector = getSelector(el);
    if (seen.has(selector)) return;
    seen.add(selector);

    const type = (el.type || "").toLowerCase();
    const sensitive = el.tagName === "INPUT" || el.tagName === "TEXTAREA"
      ? isInputSensitive(type, el)
      : false;

    elements.push({
      id: idFor(el),
      tag: el.tagName.toLowerCase(),
      type: type || null,
      role: el.getAttribute("role") || null,
      // className kept for the existing isSensitiveClass()-style structural
      // redaction check the server already does.
      className: sensitive ? getInputCategory(type, el) : (el.className || "").toString().slice(0, 60),
      label: sensitive ? `[REDACTED:${getInputCategory(type, el).toUpperCase()}]` : safeLabelFor(el),
      selector,
      clickable: el.tagName === "BUTTON" || el.tagName === "A" || /button|link|tab|menuitem/.test(el.getAttribute("role") || ""),
      fillable: isFilableInput(el),
      box: {
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
      },
    });
  });

  return elements;
}

function collectTextBlocks() {
  const dpr = window.devicePixelRatio || 1;
  const blocks = [];
  const seenParents = new Set();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length < 3) continue;

    const parent = node.parentElement;
    if (!parent || seenParents.has(parent) || !isVisible(parent)) continue;
    // Skip text inside form controls/scripts - not page "content"
    if (/^(script|style|input|textarea|option)$/i.test(parent.tagName)) continue;

    seenParents.add(parent);
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Redact PII-shaped text before it ever leaves the page.
    const safeText = trimSafe(parent.innerText || text);

    blocks.push({
      text: (safeText || "").slice(0, 200),
      selector: getSelector(parent),
      box: {
        x: rect.left * dpr,
        y: rect.top * dpr,
        width: rect.width * dpr,
        height: rect.height * dpr,
      },
    });

    if (blocks.length >= 200) break; // demo-scale cap
  }

  return blocks;
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function safeLabelFor(el) {
  const raw = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || "").trim().slice(0, 60);
  return trimSafe(raw) || null;
}

const PII_REGEXES = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
  "credit-card": /\b(?:\d[ -]*?){13,16}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
};

function trimSafe(s) {
  if (!s) return s;
  let out = s;
  for (const [category, regex] of Object.entries(PII_REGEXES)) {
    regex.lastIndex = 0;
    out = out.replace(regex, `[REDACTED:${category.toUpperCase()}]`);
  }
  return out;
}

// ==================== FEATURE 1: FIND / HIGHLIGHT ELEMENT ====================

let highlightOverlay = null;

function highlightElement(target) {
  /**
   * Draws a "spotlight" outline + label over a found element so the user can
   * see exactly what the agent means by "the Submit button". target can
   * reference the element by selector, the pva-id assigned during scanDOM(),
   * or raw coordinates (device-pixel space, like click/fill actions).
   */
  clearHighlight();

  let el = null;
  if (target.selector) el = document.querySelector(target.selector);
  if (!el && target.element_id) el = document.querySelector(`[data-pva-id="${CSS.escape(target.element_id)}"]`);
  if (!el && target.coordinates) {
    const dpr = window.devicePixelRatio || 1;
    el = document.elementFromPoint(target.coordinates.x / dpr, target.coordinates.y / dpr);
  }

  if (!el) {
    console.warn("[dom-capture] highlightElement: no match for", target);
    return { ok: false, error: "Element not found" };
  }

  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const rect = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.setAttribute("data-pva-highlight", "1");
  Object.assign(box.style, {
    position: "fixed",
    left: `${rect.left - 4}px`,
    top: `${rect.top - 4}px`,
    width: `${rect.width + 8}px`,
    height: `${rect.height + 8}px`,
    border: "3px solid #22c55e",
    borderRadius: "6px",
    boxShadow: "0 0 0 4000px rgba(0,0,0,0.35), 0 0 12px 2px rgba(34,197,94,0.8)",
    pointerEvents: "none",
    zIndex: 2147483647,
    transition: "all 0.15s ease-out",
  });

  if (target.label) {
    const tag = document.createElement("div");
    tag.textContent = target.label;
    Object.assign(tag.style, {
      position: "absolute",
      top: "-28px",
      left: "0",
      background: "#22c55e",
      color: "#0b1a10",
      font: "600 12px system-ui, sans-serif",
      padding: "2px 8px",
      borderRadius: "4px",
      whiteSpace: "nowrap",
    });
    box.appendChild(tag);
  }

  document.body.appendChild(box);
  highlightOverlay = box;
  console.log("[dom-capture] Highlighted element:", getSelector(el));

  // Auto-clear after a few seconds so it doesn't linger forever on a demo.
  setTimeout(clearHighlight, 4000);

  return { ok: true, selector: getSelector(el) };
}

function clearHighlight() {
  if (highlightOverlay) {
    highlightOverlay.remove();
    highlightOverlay = null;
  }
  document.querySelectorAll("[data-pva-highlight]").forEach((n) => n.remove());
}

// ==================== FEATURE 2: AUTOFILL ====================

// Same field-hint categories the sensitive-input scanner already uses, so
// autofill and PII redaction agree on what a "phone field" is.
const AUTOFILL_HINTS = [
  { category: "name", test: (el) => /^(given-name|family-name|name)$/i.test(el.autocomplete || "") || /\b(fname|lname|fullname|full[-_]?name)\b/i.test(hints(el)) },
  { category: "email", test: (el) => el.type === "email" || /email/i.test(el.autocomplete || "") || /email/i.test(hints(el)) },
  { category: "phone", test: (el) => el.type === "tel" || /phone|mobile/i.test(hints(el)) },
  { category: "address", test: (el) => /street-address|address-line/i.test(el.autocomplete || "") || /address/i.test(hints(el)) },
  { category: "city", test: (el) => /city/i.test(hints(el)) },
  { category: "zip", test: (el) => /zip|postal/i.test(hints(el)) },
];

function hints(el) {
  return `${el.placeholder || ""} ${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
}

async function handleAutofillForm(profile) {
  /**
   * Demo autofill: walks visible fillable fields, matches each to a
   * category in `profile` using the same hint-matching approach as the PII
   * scanner, and fills every match through the existing executeFill() path
   * (so it gets the same human-like typing simulation + events).
   */
  console.log("[dom-capture] Autofill starting with profile keys:", Object.keys(profile));
  const results = [];

  const fields = Array.from(document.querySelectorAll("input, textarea")).filter(
    (el) => isVisible(el) && isFilableInput(el)
  );

  for (const el of fields) {
    const hint = AUTOFILL_HINTS.find((h) => h.test(el));
    if (!hint || profile[hint.category] == null) continue;

    try {
      const result = await executeFill({ selector: getSelector(el), text_value: String(profile[hint.category]) });
      results.push({ category: hint.category, selector: getSelector(el), ...result });
      console.log(`[dom-capture] Autofilled ${hint.category} ->`, getSelector(el));
    } catch (err) {
      results.push({ category: hint.category, selector: getSelector(el), success: false, error: String(err) });
    }
  }

  console.log(`[dom-capture] Autofill complete: ${results.length} field(s) touched`);
  return { fieldsFilled: results.length, results };
}

function isInputSensitive(type, el) {
  /**
   * Check if input type is sensitive PII field
   */
  const sensitiveTypes = [
    "password",
    "email",
    "tel",
    "ssn",
    "cc-number",
    "cc-exp",
    "cc-csc",
  ];

  if (sensitiveTypes.includes(type)) return true;

  // Check placeholder, name, id for hints
  const text = (
    el.placeholder +
    el.name +
    el.id +
    el.getAttribute("aria-label") || ""
  ).toLowerCase();

  const sensitiveHints = [
    "password",
    "secret",
    "pin",
    "cvv",
    "cvc",
    "ssn",
    "social",
    "account",
    "credit",
    "card",
    "token",
    "api",
  ];

  return sensitiveHints.some((hint) => text.includes(hint));
}

function getInputCategory(type, el) {
  const hints = (
    el.placeholder +
    el.name +
    el.id +
    el.getAttribute("aria-label") || ""
  ).toLowerCase();

  if (hints.includes("password") || type === "password") return "input-password";
  if (hints.includes("email") || type === "email") return "input-email";
  if (
    hints.includes("card") ||
    hints.includes("credit") ||
    hints.includes("number")
  )
    return "input-cc";
  if (hints.includes("ssn") || hints.includes("social")) return "input-ssn";
  if (hints.includes("phone") || type === "tel") return "input-phone";
  if (hints.includes("pin")) return "input-pin";
  if (hints.includes("account")) return "input-account";

  return "input-text";
}

function scanVisibleText() {
  /**
   * Lightweight PII detection in visible text
   */
  const matches = [];
  const patterns = {
    email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    phone: /(?:\+?\d{1,3}[\s\-]?)?\(?(?:\d{3})?\)?[\s\-]?\d{3}[\s\-]?\d{4}/g,
    ssn: /\d{3}-\d{2}-\d{4}/g,
    cc: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
  };

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;

    Object.entries(patterns).forEach(([category, pattern]) => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        try {
          const range = node.ownerDocument.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);

          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            matches.push({
              category,
              value: match[0],
              box: {
                x: rect.left * (window.devicePixelRatio || 1),
                y: rect.top * (window.devicePixelRatio || 1),
                width: rect.width * (window.devicePixelRatio || 1),
                height: rect.height * (window.devicePixelRatio || 1),
              },
            });
          }
        } catch (e) {
          // Ignore range errors
        }
      }
    });
  }

  return matches;
}

// ==================== ACTION EXECUTION ====================

async function handleExecuteAction(action) {
  /**
   * Execute single action: click, fill, scroll, etc.
   */

  if (action.type === "click") {
    return executeClick(action);
  } else if (action.type === "fill") {
    return executeFill(action);
  } else if (action.type === "scroll") {
    return executeScroll(action);
  } else if (action.type === "hover") {
    return executeHover(action);
  } else if (action.type === "submit") {
    return executeSubmit(action);
  } else {
    throw new Error(`Unknown action type: ${action.type}`);
  }
}

async function executeClick(action) {
  const element = findElement(action);
  if (!element) throw new Error("Element not found");

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  // Simulate human-like click
  await simulateMouseEvent(element, "mouseover", x, y);
  await sleep(50);
  await simulateMouseEvent(element, "mousedown", x, y);
  await sleep(50);
  element.click();
  await sleep(100);
  await simulateMouseEvent(element, "mouseup", x, y);

  return {
    success: true,
    element: element.tagName,
    message: `Clicked ${element.tagName} element`,
  };
}

async function executeFill(action) {
  const element = findElement(action);
  if (!element) throw new Error("Element not found");

  if (!isFilableInput(element)) {
    throw new Error("Element is not a fillable input");
  }

  // Focus
  element.focus();
  await sleep(100);

  // Clear existing value
  element.value = "";
  element.dispatchEvent(new Event("input", { bubbles: true }));

  // Type text character by character (simulates human typing)
  const text = action.text_value || "";
  for (let i = 0; i < text.length; i++) {
    element.value += text[i];
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: text[i],
        bubbles: true,
        cancelable: true,
      })
    );
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: text[i],
        bubbles: true,
        cancelable: true,
      })
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(10 + Math.random() * 20); // Variable typing speed
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.blur();

  return {
    success: true,
    element: element.tagName,
    message: `Filled ${element.tagName} with ${text.length} characters`,
  };
}

async function executeScroll(action) {
  const element = findElement(action);
  const target = element || window;

  target.scrollBy({
    top: action.y || 0,
    left: action.x || 0,
    behavior: "smooth",
  });

  await sleep(500);

  return {
    success: true,
    message: `Scrolled by ${action.y || 0}px`,
  };
}

async function executeHover(action) {
  const element = findElement(action);
  if (!element) throw new Error("Element not found");

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  await simulateMouseEvent(element, "mouseover", x, y);

  return {
    success: true,
    message: "Hovered over element",
  };
}

async function executeSubmit(action) {
  const element = findElement(action);
  if (!element) throw new Error("Element not found");

  const form = element.tagName === "FORM" ? element : element.closest("form");
  if (!form) throw new Error("No form found");

  form.submit();

  return {
    success: true,
    message: "Form submitted",
  };
}

// ==================== ACTION PLAN EXECUTION ====================

async function handleExecutePlan(plan) {
  /**
   * Execute a sequence of actions with monitoring
   */

  const results = [];

  for (let i = 0; i < (plan.actions || []).length; i++) {
    const action = plan.actions[i];

    try {
      const result = await handleExecuteAction(action);
      results.push({ step: i, action, result, success: true });

      // Wait between actions for page to update
      if (i < plan.actions.length - 1) {
        await sleep(action.delay_after || 500);
      }
    } catch (err) {
      results.push({
        step: i,
        action,
        error: err.message,
        success: false,
      });

      if (action.critical) {
        throw err;
      }
    }
  }

  return {
    plan_id: plan.id || "unknown",
    executed: results.length,
    results,
  };
}

// ==================== HELPER FUNCTIONS ====================

function findElement(action) {
  if (action.selector) {
    const bySelector = document.querySelector(action.selector);
    if (bySelector) return bySelector;
  }

  // Vision-detected elements never have a real DOM id, so element_id only
  // resolves for DOM-scan-sourced actions. Don't return early on a miss -
  // fall through to coordinates, which is how vision-sourced clicks work.
  if (action.element_id) {
    const byId = document.getElementById(action.element_id);
    if (byId) return byId;
  }

  if (action.coordinates) {
    // Coordinates from the vision/DOM-scan pipeline are reported in
    // device-pixel space (to match the captured screenshot's resolution),
    // but elementFromPoint() expects CSS pixels. Convert before querying,
    // or clicks land off-target on any HiDPI (devicePixelRatio > 1) screen.
    const dpr = window.devicePixelRatio || 1;
    return document.elementFromPoint(
      action.coordinates.x / dpr,
      action.coordinates.y / dpr
    );
  }

  return null;
}

function isFilableInput(element) {
  const fillableTypes = [
    "text",
    "email",
    "password",
    "number",
    "tel",
    "url",
    "search",
    "date",
    "time",
  ];

  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName === "INPUT") {
    const type = element.type.toLowerCase();
    return fillableTypes.includes(type);
  }

  return false;
}

function getSelector(element) {
  if (element.id) return `#${element.id}`;

  const path = [];
  while (element.parentElement) {
    let selector = element.tagName.toLowerCase();

    if (element.id) {
      selector += `#${element.id}`;
      path.unshift(selector);
      break;
    } else {
      const sibling = element.parentElement.querySelectorAll(
        element.tagName
      );
      if (sibling.length > 1) {
        const index = Array.from(sibling).indexOf(element);
        selector += `:nth-of-type(${index + 1})`;
      }
    }

    path.unshift(selector);
    element = element.parentElement;
  }

  return path.join(" > ");
}

async function simulateMouseEvent(element, type, x, y) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
  });
  element.dispatchEvent(event);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== DOM INTERACTION LOGGING ====================

// Log DOM interactions to background for visual layer triggers
document.addEventListener(
  "click",
  debounce(() => {
    chrome.runtime.sendMessage({
      type: "DOM_INTERACTION",
      interaction: {
        kind: "click",
        timestamp: Date.now(),
      },
    });
  }, 800)
);

document.addEventListener(
  "focusin",
  debounce(() => {
    chrome.runtime.sendMessage({
      type: "DOM_INTERACTION",
      interaction: {
        kind: "focusin",
        timestamp: Date.now(),
      },
    });
  }, 800)
);

document.addEventListener(
  "input",
  debounce(() => {
    chrome.runtime.sendMessage({
      type: "DOM_INTERACTION",
      interaction: {
        kind: "input",
        timestamp: Date.now(),
      },
    });
  }, 800)
);

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ==================== INITIALIZATION ====================

console.log("[content.js] Initialized (DOM-only capture mode - no OCR/vision)");