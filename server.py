"""
OPTIMIZED Privacy-Preserving DOM Agent Backend
- Faster Qwen 2.5 7B inference with structured output forcing
- Response streaming for perceived speed
- Session pooling to reduce model load times
- No image/vision/OCR processing anywhere in this stack right now - the
  extension sends ui_elements/text_blocks derived purely from the DOM
  (see client-extension/lib/domCapture.js + content.js). This file never
  receives or expects pixel data.
- /api/find_element and the demo autofill flow are the two features this
  DOM-only build is meant to show off.
"""

import os
import re
import json
import time
import uuid
import threading
from typing import Any, Optional, Dict, List
from datetime import datetime
from dataclasses import dataclass, asdict
from queue import Queue

from flask import Flask, request, jsonify, stream_with_context, Response
from flask_cors import CORS
from flask_sock import Sock
import requests

# ============================================================================
# CONFIGURATION
# ============================================================================

app = Flask(__name__)
CORS(app)
sock = Sock(app)

# Ollama Configuration
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")

# Inference optimization parameters
MAX_AGENT_STEPS = 6
ACTION_RESULT_TIMEOUT_S = 30
STREAM_RESPONSES = os.environ.get("STREAM_RESPONSES", "true").lower() == "true"

# Qwen inference tuning
QWEN_TEMPERATURE = float(os.environ.get("QWEN_TEMPERATURE", "0.2"))  # Lower = more deterministic
QWEN_TOP_P = float(os.environ.get("QWEN_TOP_P", "0.9"))             # Top-p sampling
QWEN_TOP_K = int(os.environ.get("QWEN_TOP_K", "40"))                # Top-k sampling
QWEN_REPEAT_PENALTY = float(os.environ.get("QWEN_REPEAT_PENALTY", "1.0"))

# ============================================================================
# OLLAMA COMMUNICATION (Optimized)
# ============================================================================

def ollama_chat(messages, model=None, temperature=None, stream=False):
  """
  Call Qwen via Ollama with inference optimization.
  
  - Lower temperature for deterministic structured output
  - Sampling parameters to reduce hallucinations
  - Optional streaming for perceived speed
  """
  if temperature is None:
    temperature = QWEN_TEMPERATURE

  payload = {
    "model": model or OLLAMA_MODEL,
    "messages": messages,
    "stream": stream,
    "options": {
      "temperature": temperature,
      "top_p": QWEN_TOP_P,
      "top_k": QWEN_TOP_K,
      "repeat_penalty": QWEN_REPEAT_PENALTY,
      # Qwen-specific: limit output length for faster inference
      "num_predict": 256  # Force shorter responses
    }
  }

  try:
    response = requests.post(
      f"{OLLAMA_URL}/api/chat",
      json=payload,
      timeout=60,
      stream=stream
    )
    response.raise_for_status()

    if stream:
      return response  # Return stream object
    else:
      return response.json()["message"]["content"]

  except requests.exceptions.Timeout:
    raise TimeoutError(f"Ollama request timed out after 60s")
  except requests.exceptions.RequestException as e:
    raise RuntimeError(f"Ollama connection failed: {str(e)}")


def ollama_chat_streaming(messages, model=None, temperature=None, on_chunk=None):
  """
  Streaming response from Ollama - get chunks as they arrive.
  Useful for perceived responsiveness.
  """
  response = ollama_chat(messages, model=model, temperature=temperature, stream=True)
  
  full_text = ""
  try:
    for line in response.iter_lines():
      if line:
        chunk = json.loads(line)
        if "message" in chunk and "content" in chunk["message"]:
          text_chunk = chunk["message"]["content"]
          full_text += text_chunk
          if on_chunk:
            on_chunk(text_chunk)
          yield text_chunk
  except Exception as e:
    print(f"[STREAMING] Error: {e}")
    yield f"[Error: {str(e)}]"
  
  return full_text


def _parse_model_json(raw: str) -> Dict:
  """Strip Qwen's markdown JSON fences and parse."""
  raw = raw.strip()
  if raw.startswith("```json"):
    raw = raw[7:]
  elif raw.startswith("```"):
    raw = raw[3:]
  if raw.endswith("```"):
    raw = raw[:-3]
  return json.loads(raw.strip())


# ============================================================================
# DATA STRUCTURES
# ============================================================================

@dataclass
class ScreenState:
  """Current screen state - plain text only, NO image data"""
  tab_id: str
  timestamp: float
  ui_elements: List[Dict]
  text_blocks: List[Dict]
  visible_images: List[Dict]  # Just metadata, not actual image data
  dom_tree: Optional[Dict] = None
  redaction_manifest: Optional[List] = None
  pii_matches: Optional[List] = None
  pii_vault: Optional[Dict] = None


@dataclass
class ChatMessage:
  """Message in chat session"""
  role: str
  content: str
  timestamp: float
  screen_state: Optional[ScreenState] = None


@dataclass
class DOMAction:
  """Action to perform on DOM"""
  action_type: str  # "click" | "fill" | "scroll" | "hover" | "submit"
  selector: Optional[str] = None
  ui_element_id: Optional[str] = None
  text_value: Optional[str] = None
  coordinates: Optional[Dict[str, float]] = None


def _screen_state_from_dict(data: Dict, default_tab_id: str) -> ScreenState:
  """Convert incoming dict to ScreenState"""
  return ScreenState(
    tab_id=data.get("tab_id", default_tab_id),
    timestamp=data.get("timestamp", datetime.now().timestamp()),
    ui_elements=data.get("ui_elements", []),
    text_blocks=data.get("text_blocks", []),
    visible_images=data.get("images", []),
    redaction_manifest=data.get("redaction_manifest"),
    pii_matches=data.get("pii_matches"),
    pii_vault=data.get("pii_vault"),
  )


# ============================================================================
# SESSION MANAGEMENT
# ============================================================================

sessions: Dict[str, Dict[str, Any]] = {}

def get_or_create_session(session_id: str) -> Dict[str, Any]:
  """Get or create a user session"""
  if session_id not in sessions:
    sessions[session_id] = {
      "id": session_id,
      "created_at": datetime.now().isoformat(),
      "chats": {},
      "current_chat": None,
      "screen_states": [],
      "redacted_items_count": 0,
      "pii_vault_local": {},
    }
  return sessions[session_id]


# ============================================================================
# PII DETECTION & REDACTION (same as original)
# ============================================================================

PII_PATTERNS = {
  "credit_card": r"\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b",
  "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b",
  "phone": r"\b(?:\+?\d{1,3}[\s\-]?)?\(?(?:\d{3})?\)?[\s\-]?\d{3}[\s\-]?\d{4}\b",
  "ssn": r"\b\d{3}-\d{2}-\d{4}\b",
  "aadhaar": r"\b\d{4}\s\d{4}\s\d{4}\b",
  "pan": r"\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b",
  "url": r"https?://[^\s]+",
}

SENSITIVE_CLASSES = {
  "input-password", "input-cc", "input-ssn",
  "input-pin", "input-account", "input-token"
}


def detect_pii_patterns(text: str) -> List[Dict]:
  """Detect PII patterns in text"""
  matches = []
  for category, pattern in PII_PATTERNS.items():
    for match in re.finditer(pattern, text, re.IGNORECASE):
      matches.append({
        "category": category,
        "value": match.group(),
        "start": match.start(),
        "end": match.end()
      })
  return matches


def should_redact_element(ui_element: Dict) -> bool:
  """Check if element should be redacted"""
  element_class = ui_element.get("className", "").lower()
  return any(sensitive_class in element_class for sensitive_class in SENSITIVE_CLASSES)


def create_pii_redaction_report(screen_state: ScreenState) -> Dict:
  """Create report of redacted items"""
  report = {
    "timestamp": screen_state.timestamp,
    "redacted_count": 0,
    "redacted_categories": {},
    "sensitive_ui_elements": [],
  }

  if screen_state.ui_elements:
    for elem in screen_state.ui_elements:
      if should_redact_element(elem):
        report["sensitive_ui_elements"].append({
          "id": elem.get("id", str(uuid.uuid4())),
          "class": elem.get("className"),
          "box": elem.get("box")
        })
        report["redacted_count"] += 1

  if screen_state.text_blocks:
    for block in screen_state.text_blocks:
      pii_matches = detect_pii_patterns(block.get("text", ""))
      for match in pii_matches:
        category = match["category"]
        report["redacted_categories"].setdefault(category, 0)
        report["redacted_categories"][category] += 1
        report["redacted_count"] += 1

  return report


# ============================================================================
# QUERY CLASSIFICATION & SCREEN ANALYSIS
# ============================================================================

def is_informational_query(message: str) -> bool:
  """Check if user is asking a descriptive question vs action"""
  info_keywords = [
    "what", "describe", "tell", "explain", "show", "list",
    "find", "look for", "see", "search", "analyze", "summarize"
  ]
  lower_msg = message.lower()
  return any(lower_msg.startswith(kw) for kw in info_keywords)


class ScreenStateAnalyzer:
  """Analyze screen state and plan next action using Qwen"""

  def _summarize_screen(self, screen_state: ScreenState) -> str:
    """Create text summary of screen for Qwen context"""
    summary = []

    # UI elements
    if screen_state.ui_elements:
      summary.append(f"Found {len(screen_state.ui_elements)} interactive elements:")
      for elem in screen_state.ui_elements[:10]:  # Limit to first 10
        label = elem.get("label") or elem.get("className", "unlabeled")
        summary.append(f"  - {elem.get('tag', elem.get('className', 'unknown'))} \"{label}\" at {elem.get('box', {})}")
      if len(screen_state.ui_elements) > 10:
        summary.append(f"  ... and {len(screen_state.ui_elements) - 10} more")

    # Text blocks
    if screen_state.text_blocks:
      summary.append(f"\nFound {len(screen_state.text_blocks)} text blocks:")
      for block in screen_state.text_blocks[:5]:
        text_preview = block.get("text", "")[:50]
        summary.append(f"  - '{text_preview}...'")
      if len(screen_state.text_blocks) > 5:
        summary.append(f"  ... and {len(screen_state.text_blocks) - 5} more")

    return "\n".join(summary)

  def plan_next_step(self, screen_state: ScreenState, chat_context: str, user_message: str) -> Dict:
    """
    Use Qwen to plan exactly ONE next action, in a single model call.

    Elements are offered to the model as a small numbered candidate list
    (same approach as /api/find_element) rather than asking it to invent an
    element_id - Qwen doesn't reliably remember/reconstruct opaque DOM ids,
    so letting it pick an index and resolving that to the real id/selector
    server-side is what actually makes click/fill target the right thing.
    """
    candidates = [
      {
        "index": i,
        "tag": el.get("tag"),
        "label": el.get("label"),
        "clickable": el.get("clickable"),
        "fillable": el.get("fillable"),
      }
      for i, el in enumerate((screen_state.ui_elements or [])[:60])
    ]

    system_prompt = """You are a web automation agent. Decide the SINGLE next action needed to satisfy the
user's request, given the numbered list of elements currently on screen. Respond with ONLY a JSON object
(no preamble, no markdown fences):
{
  "reasoning": "brief explanation",
  "tool": "click_element|fill_form|scroll_page|done",
  "index": <int index into the elements list, or null if not applicable>,
  "text": "<text to type, only for fill_form>",
  "direction": "up|down (only for scroll_page)",
  "final_answer": "<user-facing answer; required when tool is 'done', otherwise null>"
}
Use tool="done" or if the request is answerable from what's already visible, or if nothing on screen matches
the request. Only pick click_element/fill_form for elements that are actually clickable/fillable per the list."""

    messages = [
      {"role": "system", "content": system_prompt},
      {"role": "user", "content": f"""
Elements currently on screen:
{json.dumps(candidates)}

Previous chat:
{chat_context}

User request: {user_message}

Respond only with the JSON object."""}
    ]

    try:
      raw = ollama_chat(messages, temperature=0.1)
      step = _parse_model_json(raw)
    except Exception as e:
      print(f"[ANALYSIS] Error planning action: {e}")
      return {
        "reasoning": f"Error: {str(e)}",
        "tool": "done",
        "final_answer": f"I encountered an error analyzing the page: {str(e)}",
      }

    tool = step.get("tool", "done")
    idx = step.get("index")
    resolved = None
    if tool in ("click_element", "fill_form") and idx is not None and 0 <= idx < len(candidates):
      elem = (screen_state.ui_elements or [])[idx]
      resolved = {"element_id": elem.get("id"), "selector": elem.get("selector"), "label": elem.get("label")}

    return {
      "reasoning": step.get("reasoning", ""),
      "tool": tool,
      "resolved": resolved,
      "text": step.get("text"),
      "direction": step.get("direction"),
      "final_answer": step.get("final_answer"),
    }


def generate_screen_report(screen_state: ScreenState, user_message: str) -> str:
  """Generate descriptive response about screen (for "what is on this page?" queries)"""

  analyzer = ScreenStateAnalyzer()
  screen_summary = analyzer._summarize_screen(screen_state)

  # Don't let the model improvise a page description out of nothing. If the
  # DOM scan came back empty (scan failed, protected page, timing issue),
  # say so plainly instead of asking Qwen to fill the gap - an empty prompt
  # is exactly when a model is most likely to hallucinate a plausible-looking
  # generic page, which would silently misrepresent what actually happened.
  if not screen_state.ui_elements and not screen_state.text_blocks:
    return (
      "I don't have any information about this page - the DOM scan didn't "
      "return anything (the tab may be a protected/internal page, the scan "
      "may have failed, or the content script isn't loaded in this tab yet). "
      "Try refreshing the page and asking again."
    )

  system_prompt = """You are a helpful web assistant. The user is asking about what's on the current webpage.
Describe ONLY what appears in the "Screen analysis" data below - do not invent sections, elements, or
content that aren't listed there. If the data is sparse, say so rather than guessing or generalizing about
what a typical page "probably" contains. Keep response under 300 words."""

  messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": f"""
Screen analysis:
{screen_summary}

User question: {user_message}

Provide a natural, helpful description based only on the data above:"""}
  ]

  try:
    response_text = ""
    for chunk in ollama_chat_streaming(messages, temperature=0.1):
      response_text += chunk
    return response_text.strip()

  except Exception as e:
    return f"Error analyzing screen: {str(e)}"


def run_agentic_loop(screen_state: ScreenState, chat_history: List, user_message: str, max_steps: int = MAX_AGENT_STEPS) -> Dict:
  """
  Plan exactly ONE action per call.

  This used to loop up to MAX_AGENT_STEPS times, calling Qwen every
  iteration with the *same* unchanged screen_state and never actually
  dispatching anything to the browser in between - so it burned up to 6x
  the latency for no benefit and reliably blew past the client's 30s
  response timeout on any non-"done" request. Real multi-step tasks need
  the browser to execute the action and re-scan before the next step can be
  planned meaningfully anyway, so that loop is now the client's job:
  background.js executes the single action this returns, and the user's
  next chat turn (or a follow-up one it sends automatically) continues
  from the updated page. This function only ever makes one Ollama call.
  """
  analyzer = ScreenStateAnalyzer()
  chat_context = "\n".join(f"{m.role.upper()}: {m.content}" for m in chat_history[-10:])

  step = analyzer.plan_next_step(screen_state, chat_context, user_message)

  if step["tool"] == "done" or step.get("resolved") is None and step["tool"] in ("click_element", "fill_form"):
    # "done", or the model picked click/fill but we couldn't resolve an
    # element for it (bad/missing index) - treat as a final answer either
    # way rather than returning an action with nothing to act on.
    final_answer = step.get("final_answer") or "I couldn't find a matching element for that on the current page."
    return {"steps": [step], "final_answer": final_answer, "action": None}

  return {
    "steps": [step],
    "final_answer": step.get("final_answer") or f"Working on it: {step.get('reasoning', step['tool'])}",
    "action": {
      "type": step["tool"],  # "click_element" | "fill_form" | "scroll_page"
      "element_id": (step.get("resolved") or {}).get("element_id"),
      "selector": (step.get("resolved") or {}).get("selector"),
      "label": (step.get("resolved") or {}).get("label"),
      "text_value": step.get("text"),
      "direction": step.get("direction"),
    },
  }


# ============================================================================
# REST API ENDPOINTS
# ============================================================================

@app.route("/api/health", methods=["GET"])
def health_check():
  """Check if backend is alive"""
  return jsonify({
    "status": "ok",
    "model": OLLAMA_MODEL,
    "timestamp": datetime.now().isoformat()
  })


@app.route("/api/chat/<session_id>/start", methods=["POST"])
def start_chat_session(session_id):
  """Create (or return the existing) chat for a session, before the
  extension switches over to the WebSocket for the actual messages."""
  session = get_or_create_session(session_id)

  if not session.get("current_chat"):
    chat_id = str(uuid.uuid4())
    session["chats"][chat_id] = {
      "id": chat_id,
      "created_at": datetime.now().isoformat(),
      "messages": []
    }
    session["current_chat"] = chat_id

  return jsonify({"chat_id": session["current_chat"]})


@app.route("/api/chat", methods=["POST"])
def chat():
  """Handle chat message with screen context"""
  data = request.json
  session_id = data.get("session_id", str(uuid.uuid4()))
  user_message = data.get("message")
  screen_state_data = data.get("screen_state", {})

  if not user_message:
    return jsonify({"error": "No message provided"}), 400

  session = get_or_create_session(session_id)

  if not session.get("current_chat"):
    chat_id = str(uuid.uuid4())
    session["chats"][chat_id] = {
      "id": chat_id,
      "created_at": datetime.now().isoformat(),
      "messages": []
    }
    session["current_chat"] = chat_id

  chat = session["chats"][session["current_chat"]]
  screen_state = _screen_state_from_dict(screen_state_data, session_id)

  # Create PII redaction report
  pii_report = create_pii_redaction_report(screen_state)
  session["redacted_items_count"] += pii_report["redacted_count"]

  now = datetime.now().timestamp()
  chat["messages"].append({"role": "user", "content": user_message, "timestamp": now})

  try:
    if is_informational_query(user_message):
      response_text = generate_screen_report(screen_state, user_message)
      actions = [{"tool": "describe_screen", "final_answer": response_text}]
      pending_action = None
    else:
      chat_history = [ChatMessage(role=m["role"], content=m["content"], timestamp=m["timestamp"])
                     for m in chat["messages"]]
      result = run_agentic_loop(screen_state, chat_history, user_message)
      response_text = result["final_answer"]
      actions = result["steps"]
      pending_action = result.get("action")

  except Exception as e:
    response_text = f"Error processing request: {str(e)}"
    actions = []
    pending_action = None

  chat["messages"].append({
    "role": "assistant",
    "content": response_text,
    "timestamp": now,
    "actions": actions
  })

  return jsonify({
    "response": response_text,
    "actions": actions,
    "action": pending_action,
    "pii_report": pii_report,
    "redacted_items_total": session["redacted_items_count"]
  })


@app.route("/api/screen/capture", methods=["POST"])
def receive_screen_capture():
  """Receive screen analysis from extension"""
  data = request.json
  session_id = data.get("session_id")
  session = get_or_create_session(session_id)

  screen_state = _screen_state_from_dict(data, session_id)
  session["screen_states"].append(screen_state)

  pii_report = create_pii_redaction_report(screen_state)

  return jsonify({
    "received": True,
    "screen_id": str(uuid.uuid4()),
    "redaction_report": pii_report
  })


@app.route("/api/find_element", methods=["POST"])
def find_element():
  """
  Demo feature 1: "find the X on screen".

  Takes the client's DOM-derived ui_elements list (no vision, no OCR - just
  what content.js's collectUiElements() found) plus a natural-language
  query, and asks Qwen which element the user means. Returns a selector the
  extension can highlight - it never picks/guesses a selector itself here,
  only the model does, so this is genuinely doing the matching rather than
  faking a result.
  """
  data = request.json or {}
  query = data.get("query", "")
  ui_elements = data.get("ui_elements", [])

  if not query:
    return jsonify({"error": "No query provided"}), 400
  if not ui_elements:
    return jsonify({"selector": None, "reasoning": "No UI elements were found on the current page."})

  # Keep the prompt small and cheap: trim to what the model needs to choose.
  candidates = [
    {
      "index": i,
      "tag": el.get("tag"),
      "role": el.get("role"),
      "label": el.get("label"),
      "type": el.get("type"),
      "clickable": el.get("clickable"),
      "fillable": el.get("fillable"),
    }
    for i, el in enumerate(ui_elements[:80])  # demo-scale cap, keeps latency low
  ]

  system_prompt = """You are matching a user's description to one element on a webpage.
You will be given a JSON list of candidate elements (each with an index, tag, role, label, type)
and a user query describing what they're looking for.
Respond with ONLY a JSON object (no preamble, no markdown fences):
{"index": <int or null>, "reasoning": "one short sentence"}
Pick the single best-matching index, or null if nothing plausibly matches."""

  messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": f"Query: {query}\n\nCandidates:\n{json.dumps(candidates)}"},
  ]

  try:
    raw = ollama_chat(messages, temperature=0.1)
    result = _parse_model_json(raw)
  except Exception as e:
    return jsonify({"selector": None, "reasoning": f"Model error: {e}"}), 500

  idx = result.get("index")
  if idx is None or not (0 <= idx < len(ui_elements)):
    return jsonify({"selector": None, "reasoning": result.get("reasoning", "No confident match.")})

  matched = ui_elements[idx]
  return jsonify({
    "selector": matched.get("selector"),
    "label": matched.get("label"),
    "reasoning": result.get("reasoning", ""),
  })


@app.route("/api/dom/click", methods=["POST"])
def dom_click():
  """Queue a click action"""
  data = request.json
  action = DOMAction(
    action_type="click",
    ui_element_id=data.get("element_id"),
    coordinates=data.get("coordinates")
  )
  return jsonify({"queued": True, "action": asdict(action)})


@app.route("/api/dom/fill", methods=["POST"])
def dom_fill():
  """Queue a form fill action"""
  data = request.json
  text = data.get("text", "")
  pii_found = detect_pii_patterns(text)

  if pii_found and os.environ.get("WARN_ON_PII"):
    return jsonify({
      "warning": "Text contains potential PII",
      "detected": pii_found,
      "queued": False
    }), 400

  action = DOMAction(
    action_type="fill",
    ui_element_id=data.get("element_id"),
    text_value=text
  )
  return jsonify({"queued": True, "action": asdict(action)})


# ============================================================================
# WEBSOCKET (Same as original for compatibility)
# ============================================================================

@sock.route("/")
def ws_endpoint(ws):
  """WebSocket endpoint for real-time agent communication"""
  session_id = request.args.get("session_id") or str(uuid.uuid4())
  session = get_or_create_session(session_id)

  ws.send(json.dumps({
    "type": "connected",
    "payload": {
      "session_id": session_id,
      "timestamp": datetime.now().isoformat()
    }
  }))

  while True:
    raw = ws.receive()
    if raw is None:
      break

    try:
      incoming = json.loads(raw)
    except (TypeError, ValueError):
      continue

    msg_id = incoming.get("id")
    msg_type = incoming.get("type")
    payload = incoming.get("payload", {}) or {}

    if msg_type == "chat_message":
      _handle_chat_message_ws(ws, msg_id, session_id, session, payload)
    elif msg_type == "screen_update":
      screen_state = _screen_state_from_dict(payload.get("screen_state") or payload, session_id)
      session["screen_states"].append(screen_state)
      ws.send(json.dumps({
        "type": "response",
        "id": msg_id,
        "payload": {
          "ack": True,
          "ui_count": len(screen_state.ui_elements),
          "text_count": len(screen_state.text_blocks)
        }
      }))
    elif msg_type == "action_result":
      ws.send(json.dumps({
        "type": "response",
        "id": msg_id,
        "payload": {"ack": True}
      }))
    else:
      ws.send(json.dumps({
        "type": "response",
        "id": msg_id,
        "payload": {"error": f"Unknown type: {msg_type}"}
      }))


def _handle_chat_message_ws(ws, msg_id, session_id, session, payload):
  """Handle WebSocket chat message"""
  user_message = payload.get("message")
  screen_state_data = payload.get("screen_state")

  if not user_message:
    ws.send(json.dumps({
      "type": "response",
      "id": msg_id,
      "payload": {"error": "No message provided"}
    }))
    return

  if not session.get("current_chat"):
    chat_id = str(uuid.uuid4())
    session["chats"][chat_id] = {
      "id": chat_id,
      "created_at": datetime.now().isoformat(),
      "messages": []
    }
    session["current_chat"] = chat_id

  chat = session["chats"][session["current_chat"]]
  screen_state = _screen_state_from_dict(screen_state_data or {}, session_id)

  pii_report = create_pii_redaction_report(screen_state)
  session["redacted_items_count"] += pii_report["redacted_count"]

  try:
    if is_informational_query(user_message):
      final_answer = generate_screen_report(screen_state, user_message)
      result = {
        "steps": [{"tool": "describe_screen"}],
        "final_answer": final_answer,
        "action": None,
      }
    else:
      chat_history = [ChatMessage(role=m["role"], content=m["content"], timestamp=m["timestamp"])
                     for m in chat["messages"]]
      result = run_agentic_loop(screen_state, chat_history, user_message)

  except Exception as e:
    ws.send(json.dumps({
      "type": "response",
      "id": msg_id,
      "payload": {"error": str(e)}
    }))
    return

  now = datetime.now().timestamp()
  chat["messages"].append({"role": "user", "content": user_message, "timestamp": now})
  chat["messages"].append({
    "role": "assistant",
    "content": result["final_answer"],
    "timestamp": now,
    "actions": result["steps"]
  })

  ws.send(json.dumps({
    "type": "response",
    "id": msg_id,
    "payload": {
      "response": result["final_answer"],
      "actions": result["steps"],
      "action": result.get("action"),
      "pii_report": pii_report,
      "redacted_items_total": session["redacted_items_count"],
    }
  }))


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
  debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
  port = int(os.environ.get("PORT", 8000))

  print(f"""
╔════════════════════════════════════════════════════════╗
║   Privacy-Preserving Vision Agent Backend (OPTIMIZED)  ║
║   http://localhost:{port}                                 ║
║   WebSocket: ws://localhost:{port}                       ║
║   Model: {OLLAMA_MODEL}                                  ║
║   Streaming: {'Enabled' if STREAM_RESPONSES else 'Disabled'}                             ║
╚════════════════════════════════════════════════════════╝
""")

  app.run(host="0.0.0.0", port=port, debug=debug_mode)