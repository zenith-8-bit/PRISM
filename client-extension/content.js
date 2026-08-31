/**
 * content.js (updated) - Runs in web page context
 * Handles DOM scanning, interaction logging, and action execution
 * Communicates with background.js via chrome.runtime messages
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
});

function scanDOM() {
  /**
   * Scan DOM for:
   * - Input fields (password, email, etc.)
   * - Text content for PII
   * - Form structure
   * - Interactive elements
   */
  
  const findings = [];
  const devicePixelRatio = window.devicePixelRatio || 1;

  // Scan input fields
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

  return {
    findings,
    domSummary: {
      title: document.title,
      url: window.location.href,
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input").length,
      timestamp: Date.now(),
    },
    devicePixelRatio,
  };
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

console.log("[content.js] Initialized");