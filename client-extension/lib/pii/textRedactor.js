// lib/pii/textRedactor.js
//
// Pure text/box logic, no chrome.* APIs — safe to run inside
// lib/visualLayer/visualLayerWorker.js (a plain Web Worker).
//
// Input: OCR'd text blocks from lib/visualLayer/textRegionDetector.js, each
// carrying word-level boxes:
//   { text: "Contact jane@doe.com or 987-654-3210",
//     box: {x,y,width,height},               // whole-line box
//     words: [{ text: "Contact", box:{...} }, { text: "jane@doe.com", box:{...} }, ...] }
//
// Output: a list of *raw* PII matches — category, matched substring, and a
// pixel box tight around just the matched word(s) (not the whole line).
// Raw values are included here because this is still client-side-only
// data; background.js is the one place that turns these into anonymous
// local IDs (lib/pii/piiVault.js) before anything is put in a manifest
// that could reach the server.
//
// This module intentionally does NOT decide redaction *style* (blackout vs
// blur vs pixelate) or draw anything — that stays in piiRedactor.js so
// there's exactly one place that touches pixels.

import { REGEX_PATTERNS, hasNearbyBankKeyword } from "./regexPatterns.js";

/**
 * @param {Array} textBlocks - output of textRegionDetector.js
 * @returns {Array<{category, value, box}>}
 */
export function findPiiMatches(textBlocks) {
  const matches = [];

  for (const block of textBlocks) {
    if (!block.text || !block.words || block.words.length === 0) continue;

    // Build a char-offset -> word-index map so a regex match spanning
    // characters [start,end) in the joined line text can be traced back to
    // the specific word box(es) it fell on, instead of redacting the whole
    // line (which would over-redact surrounding non-sensitive words).
    const { joined, wordSpans } = joinWordsWithSpans(block.words);

    // Track which character ranges are already claimed by an earlier
    // (higher-priority) category so e.g. an email's digits don't also get
    // reported as a bank-account match.
    const claimed = new Array(joined.length).fill(false);

    for (const [category, { regex, requiresKeywordContext }] of Object.entries(REGEX_PATTERNS)) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(joined)) !== null) {
        const [matchText] = m;
        const start = m.index;
        const end = start + matchText.length;

        if (isRangeClaimed(claimed, start, end)) continue;
        if (requiresKeywordContext && !hasNearbyBankKeyword(joined, start, matchText.length)) {
          continue;
        }

        const box = boxForCharRange(wordSpans, start, end);
        if (!box) continue;

        markClaimed(claimed, start, end);
        matches.push({ category, value: matchText, box });
      }
    }
  }

  return matches;
}

function joinWordsWithSpans(words) {
  let joined = "";
  const wordSpans = [];
  for (const w of words) {
    const start = joined.length;
    joined += w.text;
    const end = joined.length;
    wordSpans.push({ start, end, box: w.box });
    joined += " ";
  }
  return { joined, wordSpans };
}

function isRangeClaimed(claimed, start, end) {
  for (let i = start; i < end && i < claimed.length; i++) {
    if (claimed[i]) return true;
  }
  return false;
}

function markClaimed(claimed, start, end) {
  for (let i = start; i < end && i < claimed.length; i++) claimed[i] = true;
}

// Union the boxes of every word that overlaps [start, end) in the joined
// string — a PII match can legitimately span multiple OCR "words" (e.g.
// phone numbers OCR'd with internal spaces).
function boxForCharRange(wordSpans, start, end) {
  let box = null;
  for (const span of wordSpans) {
    const overlaps = span.start < end && span.end > start;
    if (!overlaps) continue;
    box = box ? unionBox(box, span.box) : { ...span.box };
  }
  return box;
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
