// lib/ui.js
// -----------------------------------------------------------------------
// Presentation-only helpers for the popup. Nothing in this file touches
// vision inference, DOM scanning, or redaction — it just renders state.
// Kept separate from popup.js so the "window/dialog" primitives (stepper,
// stamped chips, console log, toast) are reusable and testable in isolation.
// -----------------------------------------------------------------------

/** Category -> accent color, shared with the chip stamps + manifest legend. */
export const CATEGORY_COLOR = {
  face: "var(--ochre)",
  password: "var(--red)",
  email: "var(--blue)",
  phone: "var(--blue)",
  "credit-card": "var(--red)",
  "ssn-or-national-id": "var(--red)",
  address: "var(--green)",
  name: "var(--green)",
  "otp-code": "var(--red)",
  default: "var(--ink)",
};

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build the 5-node pipeline stepper. Returns handles to mutate step state. */
export function buildStepper(container, steps) {
  container.innerHTML = "";
  const nodes = steps.map((step, i) => {
    const wrap = document.createElement("div");
    wrap.className = "step";
    wrap.dataset.state = "pending";

    const node = document.createElement("div");
    node.className = "step-node";
    node.innerHTML = `<span class="step-index">${String(i + 1).padStart(2, "0")}</span>`;

    const label = document.createElement("div");
    label.className = "step-label";
    label.textContent = step;

    wrap.appendChild(node);
    wrap.appendChild(label);
    container.appendChild(wrap);

    if (i < steps.length - 1) {
      const rail = document.createElement("div");
      rail.className = "step-rail";
      container.appendChild(rail);
    }
    return wrap;
  });

  return {
    set(i, state) {
      // state: "pending" | "active" | "done" | "warn" | "error"
      const el = nodes[i];
      if (!el) return;
      el.dataset.state = state;
      if (state === "active") el.classList.add("is-pulsing");
      else el.classList.remove("is-pulsing");
    },
    reset() {
      nodes.forEach((el) => {
        el.dataset.state = "pending";
        el.classList.remove("is-pulsing");
      });
    },
  };
}

/** Stamp a redaction-category chip into a container with a staggered delay. */
export function stampChip(container, label, category, index = 0) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.style.setProperty("--chip-color", CATEGORY_COLOR[category] || CATEGORY_COLOR.default);
  chip.style.animationDelay = `${index * 70}ms`;
  chip.textContent = label;
  container.appendChild(chip);
  return chip;
}

export function clearChips(container) {
  container.innerHTML = "";
}

/** Append a monospace console line with a timestamp, auto-scrolling down. */
export function logLine(consoleEl, text, kind = "info") {
  const line = document.createElement("div");
  line.className = `console-line console-line--${kind}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="console-time">${time}</span><span class="console-glyph">${glyphFor(
    kind
  )}</span><span class="console-text"></span>`;
  line.querySelector(".console-text").textContent = text;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  return line;
}

function glyphFor(kind) {
  switch (kind) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "error":
      return "×";
    default:
      return "·";
  }
}

/** Small stamped toast in the corner — for one-off confirmations. */
export function showToast(root, text, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.textContent = text;
  root.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  setTimeout(() => {
    toast.classList.remove("is-visible");
    setTimeout(() => toast.remove(), 250);
  }, 2600);
}

/** Draw the header's grow-in rule; call once on load. */
export function runHeaderIntro(ruleEl) {
  ruleEl.classList.remove("is-grown");
  // force reflow so the animation can restart on repeated popup opens
  void ruleEl.offsetWidth;
  ruleEl.classList.add("is-grown");
}

// =========================================================================
// Side-panel additions: auth bar, chat bubbles, redaction-log accordion.
// =========================================================================

/**
 * Render the auth bar for either state. Returns nothing — callers pass
 * onSignIn/onSignOut and this function wires the click handlers itself so
 * sidepanel.js doesn't need to touch DOM internals.
 */
export function renderAuthBar(container, { user, onSignIn, onSignOut, syncEnabled }) {
  container.innerHTML = "";

  if (!user) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "Sign in with Google";
    btn.addEventListener("click", onSignIn);

    const status = document.createElement("span");
    status.className = "auth-status";
    status.textContent = "Not signed in — local only";

    container.appendChild(status);
    container.appendChild(btn);
    return;
  }

  const identity = document.createElement("div");
  identity.className = "auth-identity";

  let avatar;
  if (user.photoURL) {
    avatar = document.createElement("img");
    avatar.className = "auth-avatar";
    avatar.src = user.photoURL;
    avatar.alt = "";
  } else {
    avatar = document.createElement("div");
    avatar.className = "auth-avatar auth-avatar--placeholder";
    avatar.textContent = (user.displayName || user.email || "?").slice(0, 1).toUpperCase();
  }

  const text = document.createElement("div");
  text.className = "auth-text";
  const name = document.createElement("span");
  name.className = "auth-name";
  name.textContent = user.displayName || user.email || "Signed in";
  const status = document.createElement("span");
  status.className = `auth-status ${syncEnabled ? "auth-status--synced" : "auth-status--local"}`;
  status.textContent = syncEnabled ? "Synced to account" : "Signed in";

  text.appendChild(name);
  text.appendChild(status);
  identity.appendChild(avatar);
  identity.appendChild(text);

  const signOutBtn = document.createElement("button");
  signOutBtn.className = "btn btn-ghost";
  signOutBtn.textContent = "Sign out";
  signOutBtn.addEventListener("click", onSignOut);

  container.appendChild(identity);
  container.appendChild(signOutBtn);
}

/** Append a right-aligned user message bubble. */
export function appendUserBubble(thread, text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--user";
  bubble.innerHTML = `
    <div class="bubble__meta"><span>You</span><span>${nowLabel()}</span></div>
    <div class="bubble__text"></div>
  `;
  bubble.querySelector(".bubble__text").textContent = text;
  thread.appendChild(bubble);
  scrollToBottom(thread);
  return bubble;
}

/**
 * Append an in-progress agent bubble with an embedded compact stepper.
 * Returns handles to update it in place as the pipeline advances, plus a
 * `finish()` to lock in the final text/plan/chips.
 */
export function appendAgentBubble(thread, stepLabels) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--agent";
  bubble.innerHTML = `
    <div class="bubble__meta"><span>Agent</span><span class="bubble__time">${nowLabel()}</span></div>
    <div class="bubble__stepper"></div>
    <div class="bubble__text"><span class="typing"><span></span><span></span><span></span></span></div>
    <div class="bubble__chips"></div>
  `;
  thread.appendChild(bubble);
  scrollToBottom(thread);

  const stepperEl = bubble.querySelector(".bubble__stepper");
  const stepper = buildStepper(stepperEl, stepLabels);
  const textEl = bubble.querySelector(".bubble__text");
  const chipsEl = bubble.querySelector(".bubble__chips");

  return {
    stepper,
    setText(text) {
      textEl.textContent = text;
    },
    addChip(label, category, index) {
      stampChip(chipsEl, label, category, index);
    },
    finish({ text, plan, simulated }) {
      if (simulated) bubble.classList.add("bubble--simulated");
      textEl.textContent = text;
      if (plan) {
        const planEl = document.createElement("div");
        planEl.className = "bubble__plan";
        planEl.textContent = JSON.stringify(plan, null, 0);
        bubble.appendChild(planEl);
      }
      scrollToBottom(thread);
    },
  };
}

export function appendSystemBubble(thread, text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bubble--system";
  bubble.textContent = text;
  thread.appendChild(bubble);
  scrollToBottom(thread);
  return bubble;
}

function scrollToBottom(thread) {
  thread.scrollTop = thread.scrollHeight;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

/** Wire the accordion's open/close toggle. Call once at startup. */
export function initAccordion(toggleEl, accordionEl) {
  toggleEl.addEventListener("click", () => {
    const open = accordionEl.classList.toggle("is-open");
    toggleEl.setAttribute("aria-expanded", String(open));
  });
}

/** Re-render the full redaction-log list from an array of log entries. */
export function renderLogEntries(bodyEl, countEl, entries) {
  countEl.textContent = String(entries.length);

  if (entries.length === 0) {
    bodyEl.innerHTML = `<span class="log-empty">Nothing redacted yet this session.</span>`;
    return;
  }

  bodyEl.innerHTML = "";
  // newest first
  for (const entry of [...entries].reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML = `
      <span class="log-row__swatch" style="--chip-color:${CATEGORY_COLOR[entry.category] || CATEGORY_COLOR.default}"></span>
      <span class="log-row__category">${escapeHtml(entry.category)}</span>
      <span class="log-row__source">${escapeHtml(entry.source || "")}</span>
      <span class="log-row__time">${entry.time || ""}</span>
    `;
    bodyEl.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
