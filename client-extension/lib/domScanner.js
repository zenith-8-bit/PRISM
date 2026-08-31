// domScanner.js
// Structural PII detector. Runs against the *live DOM*, not pixels, so it
// catches things a vision model alone would miss (e.g. a password field
// that's currently empty, or an email input with no visible text yet).
//
// This is channel #1 of the two-channel redaction pipeline. Channel #2
// (pixel-based, faces/visual PII) lives in visionWorker.js + piiRedactor.js.

const REGEXES = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
  "credit-card": /\b(?:\d[ -]*?){13,16}\b/g,
  "ssn-or-national-id": /\b\d{3}-\d{2}-\d{4}\b|\b\d{4}\s?\d{4}\s?\d{4}\b/g, // covers US SSN + 12-digit IDs (e.g. Aadhaar-shaped)
  "otp-code": /\b\d{4,8}\b(?=.{0,20}(otp|code|verification))/gi,
};

// input[type] / autocomplete / name-attribute hints that strongly imply PII
// even when the regex channel finds nothing (e.g. an empty password field).
const FIELD_HINTS = [
  { category: "password", test: (el) => el.type === "password" },
  {
    category: "email",
    test: (el) =>
      el.type === "email" ||
      /email/i.test(el.autocomplete || "") ||
      /email/i.test(el.name || el.id || ""),
  },
  {
    category: "credit-card",
    test: (el) =>
      /cc-number|cc-exp|cc-csc/i.test(el.autocomplete || "") ||
      /card.?number|cvv|cvc/i.test(el.name || el.id || el.placeholder || ""),
  },
  {
    category: "phone",
    test: (el) =>
      el.type === "tel" || /phone|mobile/i.test(el.name || el.id || ""),
  },
  {
    category: "address",
    test: (el) =>
      /street-address|address-line/i.test(el.autocomplete || "") ||
      /address/i.test(el.name || el.id || ""),
  },
  {
    category: "name",
    test: (el) =>
      /^(given-name|family-name|name)$/i.test(el.autocomplete || "") ||
      /^(fname|lname|fullname|full[-_]?name)$/i.test(el.name || el.id || ""),
  },
];

/**
 * Walk the DOM and return:
 *  - findings: [{category, selector, rect, reason}]  (never includes raw values)
 *  - domSummary: a redacted, structure-only description of the page safe to
 *    send to the server (tag, role, aria-label, and a REDACTED placeholder
 *    in place of any sensitive text/value).
 */
export function scanDom(root = document) {
  const findings = [];
  const domSummaryNodes = [];

  // 1) Form fields via hints (works even on empty/untouched fields)
  const fields = root.querySelectorAll("input, textarea, select");
  fields.forEach((el, idx) => {
    const hit = FIELD_HINTS.find((h) => h.test(el));
    const selector = cssPathFor(el, idx);
    const rect = el.getBoundingClientRect();
    if (hit) {
      findings.push({
        category: hit.category,
        selector,
        rect: rectToJSON(rect),
        reason: "field-hint",
      });
    }
    domSummaryNodes.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      role: el.getAttribute("role"),
      label: safeLabelFor(el),
      selector,
      sensitive: !!hit,
      // NOTE: value/placeholder text is *never* forwarded verbatim.
      placeholder: hit ? `[REDACTED:${hit.category.toUpperCase()}]` : trimSafe(el.placeholder),
    });
  });

  // 2) Free text nodes via regex (catches PII rendered as plain text,
  //    e.g. "Contact: jane@doe.com" in a <p>, or a card number left on screen)
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent;
    if (!text || text.trim().length < 4) continue;
    for (const [category, regex] of Object.entries(REGEXES)) {
      regex.lastIndex = 0;
      if (regex.test(text)) {
        const parentEl = node.parentElement;
        if (!parentEl) continue;
        const rect = parentEl.getBoundingClientRect();
        findings.push({
          category,
          selector: cssPathFor(parentEl),
          rect: rectToJSON(rect),
          reason: "text-regex",
        });
      }
    }
  }

  // 3) Interactive/structural elements the server needs to reason about
  //    (buttons, links, headings) — non-sensitive, forwarded as-is.
  root.querySelectorAll("button, a, h1, h2, h3, [role='button']").forEach((el, idx) => {
    domSummaryNodes.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      label: safeLabelFor(el),
      selector: cssPathFor(el, idx),
      sensitive: false,
      placeholder: null,
    });
  });

  return { findings: dedupe(findings), domSummary: domSummaryNodes };
}

function safeLabelFor(el) {
  // Button/link text is generally not PII (e.g. "Submit", "Continue") but we
  // still guard against someone naming a button after themselves, etc.
  const raw = (el.getAttribute("aria-label") || el.innerText || el.textContent || "").trim().slice(0, 60);
  for (const regex of Object.values(REGEXES)) {
    regex.lastIndex = 0;
    if (regex.test(raw)) return "[REDACTED:LABEL]";
  }
  return raw || null;
}

function trimSafe(s) {
  if (!s) return null;
  for (const regex of Object.values(REGEXES)) {
    regex.lastIndex = 0;
    if (regex.test(s)) return "[REDACTED:TEXT]";
  }
  return s.slice(0, 80);
}

function rectToJSON(r) {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.category}:${f.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Minimal, good-enough CSS path builder (id > nth-of-type chain).
function cssPathFor(el, fallbackIdx = 0) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let selector = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    parts.unshift(selector);
    node = parent;
  }
  return parts.length ? parts.join(">") : `${el.tagName.toLowerCase()}[data-pva-idx="${fallbackIdx}"]`;
}
