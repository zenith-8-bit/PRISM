# PRISM: Privacy-Preserving Vision Agent with Agentic AI Backend

A complete, production-ready system combining a Chrome extension with a Python FastAPI backend for privacy-focused UI automation. The extension captures screen state and detects UI elements locally, while the backend uses agentic AI to plan and execute multi-step tasks.

## 🎯 Key Features

- **Privacy-First Architecture**: Raw PII never leaves the browser—only redacted IDs and metadata are sent to backend
- **Agentic AI**: Qwen 2.5 7B (via Ollama) performs multi-step reasoning with structured action planning
- **Local Visual Processing**: ONNX YOLOv8n detects UI elements in-browser without cloud calls
- **Real-Time Communication**: WebSocket + REST API for bidirectional extension-backend communication
- **Session Management**: Persistent session tracking with redaction reports
- **Docker Ready**: Complete docker-compose setup with Redis + Nginx support

## 🏗️ Architecture

┌─────────────────────────────────────┐ │ Chrome Extension (MV3) │ │ - DOM scanning & UI element detect │ │ - Local ONNX inference (YOLOv8n) │ │ - PII redaction & vault │ │ - Side panel chat UI │ │ - Action execution (click, fill) │ └────────┬────────────────────────────┘ │ WebSocket + REST API ▼ ┌─────────────────────────────────────┐ │ Python Backend (FastAPI) │ │ - Agentic AI loop (Qwen via Ollama)│ │ - Multi-step action planning │ │ - Session management │ │ - PII detection & reporting │ │ - Action orchestration │ └─────────────────────────────────────┘ │ ▼ Ollama Service (Qwen 2.5 7B)

Code

## 📋 Project Structure

PRISM/ ├── README.md # This file ├── SETUP.md # Detailed setup guide ├── server.py # FastAPI backend (Ollama + Qwen) ├── requirements.txt # Python dependencies ├── Dockerfile # Docker image for backend ├── docker-compose.yml # Multi-service deployment config ├── .env.example # Environment template ├── ext2/ # Chrome extension (MV3) │ ├── manifest.json │ ├── sidepanel.html # Main chat UI │ ├── sidepanel.js │ ├── background.js # Service worker │ ├── content.js # Content script (DOM access) │ ├── lib/ │ │ ├── config.js │ │ ├── domScanner.js │ │ ├── backendConnector.js │ │ ├── visualLayer/ # ONNX + UI detection │ │ │ ├── uiElementDetector.js │ │ │ ├── textRegionDetector.js │ │ │ ├── models/ │ │ │ │ └── ui-yolov8n.onnx (not in repo, train or download) │ │ │ └── ... │ │ └── ... │ └── ... └── training/ # Model training scripts (optional)

Code

## 🚀 Quick Start

### Prerequisites

- Python 3.11+
- Chrome/Chromium browser
- Ollama (for Qwen 2.5 7B) - https://ollama.ai
- Docker & Docker Compose (optional, for containerized setup)

### 1. Install Ollama & Pull Qwen

```bash
# Install Ollama from https://ollama.ai

# Pull Qwen 2.5 7B
ollama pull qwen2.5:7b

# Verify it's running
ollama serve  # Runs on http://localhost:11434
2. Backend Setup (Python)
bash
# Clone/extract project
cd PRISM

# Create virtual environment
python3.11 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env - set ANTHROPIC_API_KEY if using Claude, or leave empty for Ollama-only

# Run backend
python server.py
# Expected: "Running on http://0.0.0.0:8000"
3. Chrome Extension Setup
Open chrome://extensions/
Enable "Developer mode" (top-right toggle)
Click "Load unpacked"
Select the ext2/ directory
Grant requested permissions
4. Test the System
Click extension icon → "Open side panel"
Navigate to any website
Type: What's on this page?
Watch the AI analyze the DOM and respond
📡 API Reference
REST Endpoints
Health Check
bash
GET /api/health
Response: {"status": "ok", "model": "qwen2.5:7b", "timestamp": "..."}
Chat Message
bash
POST /api/chat
Body: {
  "session_id": "user-123",
  "message": "Click the checkout button",
  "screen_state": {
    "ui_elements": [...],
    "text_blocks": [...],
    "redaction_manifest": [...]
  }
}
Response: {
  "response": "Clicked checkout button.",
  "actions": [{...}],
  "action": {
    "type": "click_element",
    "element_id": "checkout-btn",
    "selector": "#checkout-btn"
  },
  "pii_report": {...},
  "redacted_items_total": 3
}
Find Element (Demo)
bash
POST /api/find_element
Body: {
  "query": "the blue submit button",
  "ui_elements": [...]
}
Response: {
  "selector": "#submit-btn",
  "label": "Submit",
  "reasoning": "Blue button at bottom with 'Submit' text"
}
Receive Screen Capture
bash
POST /api/screen/capture
Body: {
  "session_id": "...",
  "ui_elements": [...],
  "text_blocks": [...]
}
Response: {"received": true, "screen_id": "..."}
WebSocket Events
Connect to ws://localhost:8000?session_id=user-123

Send chat message:

JSON
{
  "type": "chat_message",
  "id": "msg-1",
  "payload": {
    "message": "What's the page title?",
    "screen_state": {...}
  }
}
Response:

JSON
{
  "type": "response",
  "id": "msg-1",
  "payload": {
    "response": "The page title is...",
    "actions": [...],
    "action": null
  }
}
🔒 Privacy & Security
What Never Leaves the Browser
Raw screenshots / unredacted pixel data
Actual PII values (emails, phone numbers, SSNs, passwords, credit cards)
Unredacted text from sensitive fields
Full DOM tree with values
What Gets Sent (Safe)
Redacted element metadata (e.g., input-email instead of the actual email)
PII vault IDs (e.g., a1b2c3d4 instead of john@example.com)
UI element classes, tags, and bounding boxes
Redaction counts and categories (not values)
Non-sensitive text content
Domain and page metadata
PII Redaction
The backend detects:

Credit Cards: 4 groups of 4 digits
Email: Standard email format
Phone: US and international formats
SSN: XXX-XX-XXXX format
Sensitive UI Classes: password fields, token inputs, PIN fields, credit card fields
Example response includes:

JSON
{
  "pii_report": {
    "redacted_count": 3,
    "redacted_categories": {
      "email": 1,
      "phone": 1,
      "credit_card": 1
    }
  }
}
🤖 Agentic AI Capabilities
Query Classification
Informational (queries like "What's on this page?") → Generates descriptive response from screen state

Actionable (queries like "Click the checkout button") → Runs agentic loop to plan action and returns single action to execute

Action Types
click_element: Click a button, link, or interactive element
fill_form: Fill text input with value
scroll_page: Scroll up or down
done: Task complete or no action needed
Execution Flow
Extension captures DOM + runs ONNX detection
Sends to backend via REST/WebSocket
Backend classifies query type
If actionable: uses Qwen to plan ONE action
Returns action + reasoning to extension
Extension executes action on DOM
Extension captures new screen state
Loop continues until "done" is returned
Example: Adding to Shopping Cart
Code
User: "Add the red widget to cart"

Backend:
1. Analyzes screen state
2. Finds product cards with YOLO detection
3. Identifies "Add to Cart" button
4. Returns: action type="click_element", element_id="add-to-cart-1"

Extension:
5. Clicks the button
6. Waits 1-2 seconds
7. Captures new screen state
8. Sends to backend

Backend:
9. Detects cart icon with updated count
10. Returns: response="Added red widget to cart successfully"
🛠️ Configuration
Environment Variables (.env)
bash
# Ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# Server
FLASK_DEBUG=false
PORT=8000

# Extension
CONFIG_DEBUG=true
MIN_INFERENCE_INTERVAL_MS=1000

# PII Redaction
WARN_ON_PII=true
ALWAYS_REDACT_EMAILS=true

# Inference tuning
QWEN_TEMPERATURE=0.2
QWEN_TOP_P=0.9
QWEN_TOP_K=40
Extension Configuration (lib/config.js)
js
export const CONFIG = {
  DEBUG: true,
  SERVER_URL: "http://localhost:8000",
  BACKEND_URL: "http://localhost:8000",
  WS_URL: "ws://localhost:8000",
  MIN_INFERENCE_INTERVAL_MS: 1000,
};
🐳 Docker Deployment
bash
# Start all services (backend, Redis, Nginx)
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop services
docker-compose down
Includes:

Backend: FastAPI on port 8000
Redis: Session storage on port 6379
Nginx: Reverse proxy on ports 80/443 (optional)
🐛 Troubleshooting
Extension Can't Reach Backend
Symptom: Chat sends message but no response

Solution:

Verify backend: curl http://localhost:8000/api/health
Check manifest.json has http://localhost:8000/* in host_permissions
Reload extension in chrome://extensions
Ollama Not Found
Symptom: Connection refused: http://localhost:11434

Solution:

Install Ollama: https://ollama.ai
Run ollama serve in a separate terminal
Pull model: ollama pull qwen2.5:7b
No UI Elements Detected
Symptom: Extension loads but can't find buttons/inputs

Solution:

This is normal—YOLO model needs training on your UI styles
Check browser console for ONNX loading errors
Verify ext2/lib/visualLayer/models/ui-yolov8n.onnx exists (>20MB)
Try testing on simple HTML pages first
WebSocket Connection Failed
Symptom: Red status indicator in side panel

Solution:

Restart backend: python server.py
Check firewall allows localhost:8000
Verify WS_URL in config.js
Refresh extension in chrome://extensions
📊 Session Management
Get Session Stats
bash
curl http://localhost:8000/api/session/user-123
Returns:

JSON
{
  "session_id": "user-123",
  "created_at": "2024-01-15T10:30:00Z",
  "total_messages": 5,
  "total_actions": 3,
  "redacted_items": 12
}
🚀 Production Deployment
Recommended Setup
Code
Client (Chrome)
    ↓ HTTPS
Nginx (reverse proxy, rate limiting)
    ↓
FastAPI Backend (replicated instances)
    ↓
Ollama Service (shared GPU)
    ↓
Redis (session storage)
Security Checklist
 Use HTTPS/WSS (not HTTP/WS)
 Set FLASK_DEBUG=false
 Use environment secrets for API keys
 Enable CORS restrictions
 Implement rate limiting
 Set up log aggregation
 Monitor WebSocket connections
 Regular security audits
📚 Development
Enable Debug Logging
js
// In extension config
CONFIG.DEBUG = true;
Check logs in:

Extension: Right-click → Inspect → Console
Background Worker: chrome://extensions → Inspect service worker
Backend: Terminal output from python server.py
Train Your Own YOLO Model
bash
cd training

# Download dataset (e.g., from Roboflow)
# Place in datasets/ directory

# Train YOLOv8n
python train_ui_yolov8n.py

# Export to ONNX
python export_to_onnx.py
# Copies to: ../ext2/lib/visualLayer/models/ui-yolov8n.onnx
🤝 Contributing
Improvements welcome! Areas for contribution:

 Fine-tune UI detection model on custom datasets
 Add multi-language support
 Implement PII un-redaction flow
 Add more action types (scroll, hover, wait)
 Build analytics dashboard
 Add support for complex form filling
 Performance optimizations
📄 License
Multi-component project:

Extension: YOLOV8, Tesseract, Transformers.js (respective licenses)
Backend: MIT License
🆘 Support & Resources
Issues: GitHub Issues
Discussions: GitHub Discussions
Ollama: https://ollama.ai
Qwen: https://github.com/QwenLM/Qwen
📝 Changelog
v0.4.0 (Current)
✅ Ollama integration with Qwen 2.5 7B
✅ Streaming responses for perceived speed
✅ Single-action planning (no loop)
✅ Structured output forcing with JSON parsing
✅ Improved PII redaction patterns
✅ Session pooling optimization
v0.3.0
Integrated Python agentic backend
WebSocket real-time communication
Chat interface in side panel
Multi-step action planning
PII vault and redaction reporting
Docker deployment support
v0.2.0
Visual layer + PII redaction pipeline
ONNX model support
v0.1.0
Initial extension with DOM scanning
