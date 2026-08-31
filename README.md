# Privacy-Preserving Vision Agent - Integrated Backend

Complete agentic AI backend + Chrome extension system for UI automation with local PII redaction.

## 🏗️ Architecture

```
┌─────────────────────────────────┐
│   Chrome Extension (Browser)    │
│  - Local UI/text detection      │
│  - ONNX model inference         │
│  - PII redaction & vault        │
│  - DOM action execution         │
└────────┬────────────────────────┘
         │ WebSocket + REST API
         ▼
┌─────────────────────────────────┐
│   Python Backend (FastAPI)      │
│  - Agentic AI with tool calling │
│  - Multi-step reasoning         │
│  - Image classification         │
│  - Session management           │
│  - Action orchestration         │
└─────────────────────────────────┘
```

### Data Flow

1. **User Message** → Side panel chat
2. **Screen Capture** → Background script captures visible tab
3. **Local Processing** → Visual layer (UI detection, OCR, PII redaction)
4. **Backend Analysis** → Agentic AI generates action plan
5. **Action Execution** → Content script performs clicks, fills, etc.
6. **Result Reporting** → Backend receives success/failure reports

**Key Security Principle**: Raw PII never leaves the browser. Only redacted IDs and metadata are sent to the backend.

---

## 🚀 Quick Start

### Prerequisites

- Python 3.11+
- Chrome/Chromium browser
- ONNX model file (`ui-yolov8n.onnx`) - see [Training](#training) section

### 1. Backend Setup

```bash
# Clone and enter directory
cd /path/to/privacy-vision-agent

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Run server
python server.py
```

Server will start at `http://localhost:8000`

### 2. Extension Setup

```bash
# Copy extension to working directory (if not already there)
cp -r client-extension-updated/ my-extension

# In Chrome:
1. Open chrome://extensions/
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the extension directory
5. Grant required permissions
```

### 3. Test the System

1. **Open extension side panel** - Click extension icon, select "Open side panel"
2. **Navigate to any website** - Try Amazon, banking site, shopping cart, etc.
3. **Send a message** - "What's on this page?" or "Click the checkout button"
4. **Watch it work** - Extension detects UI elements, backend reasons about them, actions execute

---

## 📋 API Reference

### REST Endpoints

#### Create Session
```bash
POST /api/session/create
Response: { "session_id": "...", "created_at": "..." }
```

#### Start Chat
```bash
POST /api/chat/{session_id}/start
Response: { "chat_id": "..." }
```

#### Send Message
```bash
POST /api/chat/{session_id}/message
Body: {
  "message": "What color is the button?",
  "screen_state": {
    "ui_elements": [...],
    "text_blocks": [...],
    "images": [...],
    "redaction_manifest": [...]
  }
}
Response: {
  "response": "The button is blue...",
  "actions": [...],
  "pii_report": {...},
  "redacted_items_total": 3
}
```

#### Receive Screen Capture
```bash
POST /api/screen/capture
Body: {
  "session_id": "...",
  "ui_elements": [...],
  "text_blocks": [...],
  "redaction_manifest": [...]
}
```

#### Click Element
```bash
POST /api/dom/click
Body: {
  "element_id": "btn-checkout",
  "coordinates": {"x": 100, "y": 50}
}
```

#### Fill Form Field
```bash
POST /api/dom/fill
Body: {
  "element_id": "email-input",
  "text": "user@example.com"
}
```

#### Analyze Images
```bash
POST /api/analyze/images
Body: {
  "images": [
    {
      "src": "https://...",
      "base64": "...",
      "dimensions": {"width": 200, "height": 150}
    }
  ]
}
Response: {
  "analyzed": 1,
  "classifications": [
    {
      "src": "https://...",
      "description": "A shopping cart icon on a white background",
      "dimensions": {...}
    }
  ]
}
```

### WebSocket Events

#### Connect
```js
io = io("ws://localhost:8000")
io.on("connect", (data) => {
  console.log("Connected:", data.session_id)
})
```

#### Screen Update
```js
io.emit("screen_update", {
  session_id: "...",
  screen_state: {...}
})
```

#### Action Result
```js
io.emit("action_result", {
  session_id: "...",
  result: {
    success: true,
    message: "Button clicked successfully"
  }
})
```

---

## 🔒 Privacy & Security

### What Never Leaves the Browser

- Raw screenshots / image data
- Unredacted PII values (emails, phone numbers, SSNs, etc.)
- Unredacted passwords or tokens
- Raw text from password fields
- Credit card numbers
- Sensitive document images

### What Gets Sent (Safe to Share)

- Redacted element metadata (e.g., `input-email`, not the actual email)
- PII vault IDs (e.g., `a1b2c3d4` instead of `john@example.com`)
- UI element classes and bounding boxes
- Redaction reports (counts, categories, not values)
- Non-sensitive text content
- Domain and page metadata

### PII Redaction Patterns

The system detects and redacts:

- **Credit Cards**: `\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b`
- **Email**: `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}`
- **Phone**: US and international formats
- **SSN**: `\d{3}-\d{2}-\d{4}`
- **Aadhaar** (India): `\d{4}\s\d{4}\s\d{4}`
- **PAN** (India): `[A-Z]{5}[0-9]{4}[A-Z]{1}`
- **India Post Tracking**: `[A-Z]{2}\d{9}[A-Z]{2}`
- **Bank Accounts**: 9-18 digit sequences
- **Sensitive UI Classes**: password fields, token inputs, PIN fields

### PII Vault

The extension maintains a local vault of redacted PII:

```json
{
  "a1b2c3d4": {
    "category": "email",
    "fingerprint": "sha256:...",
    "first_seen": 1234567890,
    "redacted_count": 3
  }
}
```

When the backend needs to show a redacted value back to the user, it must:
1. Request a specific vault ID
2. Specify the reason/context for un-redaction
3. User is warned that PII will be displayed

---

## 🤖 Agentic AI Capabilities

The backend AI can:

### 1. Analyze Screen State
- Describe what's visible
- Identify UI patterns (forms, buttons, navigation)
- Locate specific elements by description
- Classify images using Claude Vision

### 2. Plan Multi-Step Actions
- Break complex tasks into sequential steps
- Verify each step succeeded before proceeding
- Adapt to screen changes
- Handle unexpected UI variations

### 3. Execute Actions
- Click buttons and links
- Fill text input fields with automatic typing simulation
- Submit forms
- Scroll pages
- Hover over elements
- Wait for page changes

### 4. Generate Reports
- Summarize page content
- Extract specific information
- Provide step-by-step instructions
- Create accessibility summaries

### Example Conversation Flow

**User**: "What's the total cost in the shopping cart?"

**AI**:
1. ✓ Get screen state (sees shopping cart page)
2. ✓ Analyze total element (text says "$99.99")
3. ✓ Generate response
4. **Response**: "Your shopping cart total is $99.99 for 3 items"

**User**: "Add a coupon code SAVE20"

**AI**:
1. ✓ Get screen state
2. ✓ Locate coupon input field (element_id: "coupon-input")
3. ✓ Locate apply button (element_id: "apply-btn")
4. ✓ Fill coupon field with "SAVE20"
5. ✓ Click apply button
6. ✓ Wait 1 second for page update
7. ✓ Get new screen state
8. ✓ Verify new total
9. **Response**: "Coupon applied! New total: $79.99 (saved $20.00)"

---

## 🎓 Training Your Own Model

### Using the Existing Training Scripts

```bash
cd training

# 1. Prepare your dataset (Roboflow format)
# Download from Roboflow to ./datasets/

# 2. Train YOLOv8n model
python train_ui_yolov8n.py

# 3. Export to ONNX
python export_to_onnx.py
```

The exported `ui-yolov8n.onnx` will be copied to `lib/visualLayer/models/`

### Dataset Requirements

- **Format**: YOLO (txt labels with normalized coordinates)
- **Classes**: UI components (button, input, link, heading, image, checkbox, etc.)
- **Minimum**: 500-1000 images
- **Source**: Roboflow, custom screenshots, or web UI datasets

### Model Configuration

Edit `uiComponentSchema.js` to update class taxonomy:

```js
const TIER_1_CLASSES = [
  "button",
  "input-text",
  "input-email",
  "input-password",
  "link",
  "heading",
  "image",
  "checkbox",
  "radio",
  "dropdown",
  "textarea",
  "submit-button"
];
```

**CRITICAL**: The class order must exactly match your `data.yaml` from training.

---

## 🛠️ Configuration

### Environment Variables

```bash
# .env

# Anthropic API
ANTHROPIC_API_KEY=sk-...

# Server
FLASK_DEBUG=true
PORT=8000
HOST=0.0.0.0

# Backend URLs
BACKEND_URL=http://localhost:8000
WS_URL=ws://localhost:8000

# Extension
CONFIG_DEBUG=true
MIN_INFERENCE_INTERVAL_MS=1000

# PII Redaction
WARN_ON_PII=true
ALWAYS_REDACT_EMAILS=true
```

### Extension Configuration (lib/config.js)

```js
export const CONFIG = {
  DEBUG: true,
  SERVER_URL: "http://localhost:8000",
  BACKEND_URL: "http://localhost:8000",
  WS_URL: "ws://localhost:8000",
  MIN_INFERENCE_INTERVAL_MS: 1000,
  REDACTION_STYLE: "blur", // "blur" | "black"
  REDACTION_PADDING_PX: 4
};
```

---

## 📦 Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# Server will be at http://localhost:8000
# WebSocket at ws://localhost:8000
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  backend:
    build: .
    ports:
      - "8000:8000"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - FLASK_DEBUG=false
      - PORT=8000
    volumes:
      - ./sessions:/app/sessions
    restart: unless-stopped

  frontend:
    # Extension runs in browser, not in Docker
    # Just listed for reference
    image: 'chrome:latest'
    depends_on:
      - backend
```

---

## 🐛 Debugging

### Enable Debug Logging

```js
// In extension manifest or config
CONFIG.DEBUG = true;
```

Check Chrome DevTools:
- **Background**: DevTools for extension (Right-click extension → Inspect → Service Workers)
- **Content**: DevTools on active tab (F12 → Console)
- **Side Panel**: Right-click side panel → Inspect

### Backend Logs

```bash
# Watch real-time logs
tail -f server.log

# See WebSocket traffic
# Enable in server.py: socketio.run(..., debug=True)
```

### Common Issues

**Issue**: "Extension can't reach backend"
- Ensure backend is running on `http://localhost:8000`
- Check manifest.json has `http://localhost:8000/*` in host_permissions

**Issue**: "WebSocket connection fails"
- Check WS_URL environment variable
- Verify socketio is running (should be running with Flask)
- Check browser console for connection errors

**Issue**: "Model not loading"
- Verify `ui-yolov8n.onnx` exists in `lib/visualLayer/models/`
- Check file permissions
- Ensure ONNX Runtime Web is properly imported

**Issue**: "No UI elements detected"
- Verify ONNX model is compatible (opset 17)
- Check confidence threshold in uiElementDetector.js (default 0.4)
- Ensure model was trained on similar UI styles

---

## 📊 Monitoring & Analytics

### Session Statistics

```bash
curl http://localhost:8000/api/session/{session_id}
```

Returns:
```json
{
  "session_id": "...",
  "created_at": "...",
  "total_messages": 5,
  "total_actions": 12,
  "redacted_items": 23,
  "error_count": 0
}
```

### Redaction Reports

Each chat message includes:
```json
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
```

---

## 🚀 Production Deployment

### Security Checklist

- [ ] Use HTTPS/WSS (not HTTP/WS)
- [ ] Set `ANTHROPIC_API_KEY` as secret
- [ ] Disable `DEBUG` mode
- [ ] Use authenticated WebSocket connections
- [ ] Rate limit API endpoints
- [ ] Enable CORS restrictions
- [ ] Store sessions securely (encrypted database, not memory)
- [ ] Set up log aggregation
- [ ] Monitor for PII leaks

### Deployment Options

**Option 1: Self-Hosted**
- Run `docker-compose up -d`
- Use nginx for HTTPS reverse proxy
- Use Redis for session storage

**Option 2: Cloud Platforms**
- Heroku, Railway, Render
- AWS ECS, Lambda + API Gateway
- GCP Cloud Run, App Engine
- Azure Container Instances

### Load Balancing

For multiple backend instances:

```nginx
upstream backend {
  server localhost:8000;
  server localhost:8001;
  server localhost:8002;
}

server {
  listen 443 ssl http2;
  server_name agent.example.com;

  location / {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

---

## 📚 Examples

### Example 1: Amazon Shopping

```
User: "Add the ACME widgets to cart and go to checkout"

AI:
1. Detect ACME product card
2. Click "Add to Cart" button
3. Wait 2 seconds
4. Detect updated cart icon (badge shows 1)
5. Locate cart button
6. Click cart button
7. Wait for cart page to load
8. Find "Proceed to Checkout" button
9. Click it
10. Wait for checkout page

Response: "Added ACME widgets to cart and navigated to checkout"
```

### Example 2: Bank Transfer

```
User: "Send $50 to John (john@example.com)"

AI:
1. Detect Transfer section
2. Click "New Transfer" button
3. Detect recipient email field
4. Fill with john@example.com (PII handled locally)
5. Detect amount field
6. Fill with "50"
7. Detect currency selector
8. Verify USD is selected
9. Detect "Preview" button
10. Click it
11. Detect and describe confirmation screen
12. Ask user "Ready to send $50 to john@example.com?"

Response: "Filled transfer form. Ready to proceed? (awaiting your confirmation)"
```

### Example 3: Form Analysis

```
User: "What fields are on this form?"

AI:
1. Detect form element
2. Extract all input fields and labels
3. Identify field types (text, email, password, etc.)
4. Note required indicators
5. Identify submit button

Response: "This form has 4 fields:
- Email (required)
- Password (required)
- Remember me (checkbox)
- Sign In (button)"
```

---

## 🤝 Contributing

Improvements welcome:

- [ ] Train Tier-2 model with expanded UI taxonomy
- [ ] Add support for multi-language OCR
- [ ] Implement PII un-redaction with user confirmation flow
- [ ] Add session persistence and recovery
- [ ] Build monitoring dashboard
- [ ] Create test suite
- [ ] Document MCP integration
- [ ] Add support for more action types (screenshot regions, etc.)

---

## 📄 License

This project combines:
- Original extension code (YOLOV8, Tesseract, Transformers.js)
- New backend and integration code (MIT)

See LICENSE files in respective directories.

---

## 🆘 Support

- **Issues**: GitHub Issues
- **Questions**: GitHub Discussions
- **Security**: security@example.com

---

## 📝 Changelog

### v0.3.0 (Current)
- ✅ Integrated Python agentic AI backend
- ✅ WebSocket real-time communication
- ✅ Chat interface in side panel
- ✅ Multi-step action planning
- ✅ Image classification with Claude Vision
- ✅ PII vault and redaction reporting
- ✅ Docker deployment support

### v0.2.0
- Visual layer + PII redaction pipeline
- ONNX model support
- Tesseract OCR integration

### v0.1.0
- Initial extension with DOM scanning
- Basic face detection
- Firebase authentication

---

**Happy automating! 🎉**
