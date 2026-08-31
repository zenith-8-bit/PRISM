// lib/visualLayer/uiComponentSchema.js
//
// Class taxonomy for the "structure of the screen" detector
// (uiElementDetector.js). Two tiers, so you can ship something working
// fast and grow into the fuller taxonomy without re-touching pipeline code
// — only this file and the model weights change.
//
// TIER_1_CLASSES matches the ready-to-train Roboflow "Website Screenshots"
// dataset (~1.2k images, already YOLO-annotated, zero labeling work) —
// use this to get an end-to-end demo working first.
//
// TIER_2_CLASSES is the fuller, fine-grained taxonomy (form-field types,
// interactive controls) modeled on RICO/CLAY's 25-category mobile UI
// semantics plus web-specific additions (navbar, tab, iframe-ad). Getting
// here requires combining datasets and/or your own labeling pass — see
// lib/visualLayer/README.md for sources.
//
// isSensitiveClass() is consulted by piiRedactor.js: any detected box whose
// class is flagged sensitive gets redacted purely from its *type*, with no
// OCR/regex needed at all (this is how a password field with dots instead
// of characters still gets redacted — there's no text content to regex
// against).

export const TIER_1_CLASSES = [
  "button",
  "field", // generic form field box (Roboflow's dataset doesn't split by input type)
  "heading",
  "iframe",
  "image",
  "label",
  "link",
  "text", // ads / third-party embeds
];

export const TIER_2_CLASSES = [
  // Buttons / actions
  "button",
  "submit-button",
  "icon-button",
  "link",

  // Text
  "heading",
  "label",
  "paragraph-text",

  // Form fields — split by type because redaction policy differs per type
  // (password/email/tel/card fields are *always* sensitive regardless of
  // OCR content; a plain "search" field is not).
  "input-text",
  "input-password",
  "input-email",
  "input-tel",
  "input-number",
  "input-search",
  "textarea",

  // Other interactive controls
  "checkbox",
  "radio-button",
  "toggle-switch",
  "dropdown-select",
  "slider",
  "date-picker",
  "stepper",
  "tab",

  // Structural / layout
  "navbar",
  "toolbar",
  "drawer",
  "form",
  "card",
  "modal-dialog",
  "table",
  "list-item",
  "pager-indicator",

  // Media
  "image",
  "icon",
  "video",
  "iframe-ad",
];

// Classes that are redacted purely because of *what they are*, independent
// of any OCR/regex hit on their contents.
export const ALWAYS_SENSITIVE_CLASSES = new Set([
  "input-password",
  "input-email", // conservative default — flip off if false-positive rate hurts precision score
  "input-tel",
  "field", // Tier 1 fallback: can't tell field *type* apart, so treat generically as sensitive
]);

export function isSensitiveClass(className) {
  return ALWAYS_SENSITIVE_CLASSES.has(className);
}

// Which class list is active. Flip to TIER_2_CLASSES once you've trained/
// exported a model on the fuller taxonomy (see README.md for how).
export const ACTIVE_CLASSES = TIER_1_CLASSES;
