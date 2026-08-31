// lib/pii/regexPatterns.js
//
// Single source of truth for the regex-based PII categories this milestone
// covers: email, phone, bank account number / IBAN. Kept deliberately
// separate from domScanner.js's REGEXES (which pattern-match live DOM text)
// because this set runs against *OCR'd pixel text* coming out of the visual
// layer (lib/visualLayer/textRegionDetector.js) — a different input source
// with different noise characteristics (OCR artifacts, no element context).
//
// Ordering matters: textRedactor.js scans categories in this order and
// treats a span already claimed by an earlier category as unavailable, so
// put the most specific/least-ambiguous patterns first (email, IBAN) and
// the broadest (raw digit runs) last.

// A plain "9-18 digit run" is a hopeless regex on its own — it fires on
// phone numbers, dates, order IDs, zip+4s, whatever. We only classify a
// digit run as a *bank account number* when a nearby keyword makes the
// intent unambiguous. KEYWORD_WINDOW_CHARS controls how far around the
// match we look (in the same OCR text block) for one of BANK_KEYWORDS.
export const BANK_KEYWORD_WINDOW_CHARS = 24;

export const BANK_KEYWORDS = [
  "account",
  "acct",
  "a/c",
  "iban",
  "routing",
  "sort code",
  "ifsc",
  "swift",
  "bank",
];

export const REGEX_PATTERNS = {
  // name -> { regex, requiresKeywordContext }
  email: {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    requiresKeywordContext: false,
  },
  iban: {
    // ISO 13616 IBAN shape: 2 letters + 2 check digits + up to 30 alnum.
    // Checked before the generic bank-account rule since it's unambiguous
    // on shape alone (no keyword needed).
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    requiresKeywordContext: false,
  },
  phone: {
    // Intentionally requires a leading + or a separator so it doesn't eat
    // plain 10-digit bank account numbers that happen to have no context
    // keyword nearby.
    regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]\d{3,4}[-.\s]?\d{0,4}\b/g,
    requiresKeywordContext: false,
  },
  "bank-account": {
    // Raw 9-18 digit run, ONLY counted as PII when BANK_KEYWORDS appears
    // within BANK_KEYWORD_WINDOW_CHARS of the match in the same text block.
    regex: /\b\d{9,18}\b/g,
    requiresKeywordContext: true,
  },
};

export function hasNearbyBankKeyword(text, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - BANK_KEYWORD_WINDOW_CHARS);
  const end = Math.min(text.length, matchIndex + matchLength + BANK_KEYWORD_WINDOW_CHARS);
  const window = text.slice(start, end).toLowerCase();
  return BANK_KEYWORDS.some((kw) => window.includes(kw));
}
