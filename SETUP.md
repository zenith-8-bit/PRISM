# Installation & Setup Guide

Complete step-by-step guide to get the Privacy-Preserving Vision Agent running.

## Prerequisites

- **Python 3.11+**
- **Chrome or Chromium browser**
- **ONNX model file** (`ui-yolov8n.onnx`)
- **Anthropic API key** (get at https://console.anthropic.com)
- **Git** (optional, for cloning)

## Step 1: Backend Setup (Python Server)

### 1.1 Clone or Extract Project

```bash
# If you have the project as a zip
unzip privacy-vision-agent.zip
cd privacy-vision-agent

# Or clone from git (if available)
# git clone https://github.com/user/privacy-vision-agent.git
```

### 1.2 Create Python Virtual Environment

**On macOS/Linux:**
```bash
python3.11 -m venv venv
source venv/bin/activate
```

**On Windows:**
```bash
python -m venv venv
venv\Scripts\activate
```

### 1.3 Install Dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

This installs:
- Flask + Flask-CORS + Flask-SocketIO (web server)
- Anthropic SDK (AI/Claude API)
- Pillow (image processing)
- python-dotenv (configuration)

### 1.4 Configure Environment

```bash
# Copy the example to create your config
cp .env.example .env

# Edit .env with your settings
nano .env  # or use your preferred editor
```

**Required settings in .env:**
```
ANTHROPIC_API_KEY=sk-...your-key-here...
FLASK_DEBUG=false
PORT=8000
```

Get your API key:
1. Visit https://console.anthropic.com
2. Create an account or login
3. Go to API keys
4. Click "Create API key"
5. Copy and paste into .env

### 1.5 Verify Installation

```bash
# Test Python installation
python --version  # Should be 3.11+

# Test imports
python -c "import flask, anthropic; print('✓ Dependencies OK')"

# Test backend startup (will run until you Ctrl+C)
python server.py
```

Expected output:
```
╔════════════════════════════════════════════════════════╗
║   Privacy-Preserving Vision Agent Backend              ║
║   http://localhost:8000                                 ║
║   WebSocket: ws://localhost:8000                        ║
╚════════════════════════════════════════════════════════╝
```

If successful, keep the server running and proceed to Step 2.

---

## Step 2: Chrome Extension Setup

### 2.1 Prepare Extension Files

Extension files should be in `client-extension-updated/`:
```
client-extension-updated/
├── manifest.json
├── background.js
├── content.js
├── sidepanel.js
├── sidepanel.html
├── theme.css
├── lib/
│   ├── backendConnector.js
│   ├── config.js
│   ├── domScanner.js
│   ├── visualLayer/
│   │   ├── models/
│   │   │   └── ui-yolov8n.onnx  ← CRITICAL: Add your ONNX model here
│   │   ├── uiElementDetector.js
│   │   └── ... (other visual layer files)
│   └── ... (other lib files)
└── ... (other files)
```

### 2.2 Add ONNX Model

**Important**: The extension won't work without the ONNX model.

If you trained your own model:
```bash
# From the training directory
python export_to_onnx.py

# This outputs: ui-yolov8n.onnx
# Copy to: client-extension-updated/lib/visualLayer/models/
```

If using a pre-trained model, place it at:
```
client-extension-updated/lib/visualLayer/models/ui-yolov8n.onnx
```

Verify the file exists and is ~25-40 MB:
```bash
ls -lh client-extension-updated/lib/visualLayer/models/ui-yolov8n.onnx
```

### 2.3 Load Extension in Chrome

1. **Open Chrome Extensions Page**
   ```
   chrome://extensions/
   ```

2. **Enable Developer Mode**
   - Toggle the switch in top-right corner

3. **Load Unpacked Extension**
   - Click "Load unpacked"
   - Navigate to `client-extension-updated/` directory
   - Click "Select Folder"

4. **Grant Permissions**
   - Extension will ask for permissions
   - Click "Allow" for all requested permissions

5. **Verify Installation**
   - Extension should appear in your extensions list
   - Click extension icon in toolbar to verify

### 2.4 Configure Extension (Optional)

Edit `client-extension-updated/lib/config.js`:
```js
export const CONFIG = {
  DEBUG: true,  // Set to true to see console logs
  SERVER_URL: "http://localhost:8000",
  BACKEND_URL: "http://localhost:8000",
  WS_URL: "ws://localhost:8000",
  MIN_INFERENCE_INTERVAL_MS: 1000,
};
```

---

## Step 3: Test the System

### 3.1 Start Backend (if not already running)

**Terminal 1:**
```bash
source venv/bin/activate  # On Windows: venv\Scripts\activate
python server.py
```

Expected:
```
 * Running on http://0.0.0.0:8000
```

### 3.2 Open Extension Side Panel

1. Click extension icon in Chrome toolbar
2. Select "Open side panel" (or it opens automatically)
3. You should see the chat interface

### 3.3 Test Basic Functionality

1. **Navigate to any website** (e.g., Google, Amazon, Wikipedia)

2. **Send a test message**:
   ```
   What's visible on this page?
   ```

3. **Expected response**:
   - Extension captures the page
   - Backend analyzes it
   - AI responds with description of visible content

4. **Try an action**:
   ```
   What color is the background?
   ```
   or
   ```
   Click the first link
   ```

### 3.4 Check Logs

**Browser Console** (for extension logs):
1. Right-click extension icon → "Inspect"
2. Go to "Application" tab → "Service Workers"
3. Look for console logs

**Terminal Output** (for backend logs):
1. Watch the terminal where you ran `python server.py`
2. You should see WebSocket connections and API requests

---

## Step 4: Add Your ONNX Model (Important)

### Option A: Train Your Own Model

```bash
cd training

# 1. Download dataset to datasets/
# Visit https://roboflow.com for UI element datasets
# Download in YOLO format

# 2. Train the model
python train_ui_yolov8n.py

# 3. Export to ONNX
python export_to_onnx.py
# Output: ../lib/visualLayer/models/ui-yolov8n.onnx
```

### Option B: Use Pre-trained Model

1. Download a YOLOv8n ONNX model trained on UI elements
2. Place at: `client-extension-updated/lib/visualLayer/models/ui-yolov8n.onnx`
3. Verify file size (should be 20-50 MB)

### Option C: Dummy Model (Testing Only)

For testing without real detection:
```bash
# Create empty placeholder (will fail gracefully)
touch client-extension-updated/lib/visualLayer/models/ui-yolov8n.onnx
```

---

## Step 5: Docker Deployment (Optional)

For easier deployment without manual setup:

### 5.1 Build and Run with Docker Compose

```bash
# Make sure Docker and Docker Compose are installed
docker --version
docker-compose --version

# Start all services
docker-compose up -d

# View logs
docker-compose logs -f backend

# Stop services
docker-compose down
```

### 5.2 Verify Docker Setup

```bash
# Check if backend is running
curl http://localhost:8000/api/health

# Should respond:
# {"status":"ok","timestamp":"..."}
```

---

## Common Issues & Troubleshooting

### Issue 1: "Extension can't reach backend"

**Symptom**: Chat sends message but no response

**Solution**:
1. Verify backend is running: `curl http://localhost:8000/api/health`
2. Check manifest.json has `http://localhost:8000/*` in host_permissions
3. Restart extension: Right-click extension → "Reload"

### Issue 2: "ANTHROPIC_API_KEY not found"

**Symptom**: Backend crashes with API key error

**Solution**:
1. Verify .env file exists: `ls -la .env`
2. Check it contains: `ANTHROPIC_API_KEY=sk-...`
3. Restart backend: `python server.py`

### Issue 3: "Model not loading"

**Symptom**: No UI elements detected, console errors about ONNX

**Solution**:
1. Verify ONNX file exists:
   ```bash
   ls -lh client-extension-updated/lib/visualLayer/models/ui-yolov8n.onnx
   ```
2. File should be >10 MB
3. If not present, add it (see Step 4)
4. Check browser console for detailed error

### Issue 4: "WebSocket connection failed"

**Symptom**: Red status indicator in side panel

**Solution**:
1. Restart backend
2. Check firewall allows localhost:8000
3. Verify WS_URL in config.js
4. Try refreshing extension

### Issue 5: "Permission denied" when starting backend

**Symptom**: `OSError: [Errno 13] Permission denied: ':8000'`

**Solution**:
1. Port 8000 might be in use: `lsof -i :8000`
2. Change PORT in .env to available port (e.g., 8001)
3. Update extension config to match

### Issue 6: "No UI elements detected" on web pages

**Symptom**: Extension loads but can't find buttons/inputs

**Solution**:
1. This is normal until model is trained
2. Check browser console for ONNX loading errors
3. Verify model file and format
4. Try with a simple test page (not complex SPAs)

---

## Verification Checklist

- [ ] Python 3.11+ installed
- [ ] Virtual environment created and activated
- [ ] Dependencies installed (`pip list` shows flask, anthropic, etc.)
- [ ] .env file created with ANTHROPIC_API_KEY
- [ ] Backend runs without errors: `python server.py`
- [ ] Extension loads in Chrome (visible in extensions page)
- [ ] ONNX model file exists at correct path
- [ ] Side panel opens when clicking extension icon
- [ ] Test message sends and receives response
- [ ] Action execution works (clicking, filling forms)

---

## Next Steps

### For Development

- Modify `lib/config.js` to enable debug logging
- Check `server.py` for backend customization
- Train your own ONNX model on your UI patterns (see `training/train_ui_yolov8n.py`)
- Extend action types in `content.js` for more complex automation

### For Deployment

- Set `FLASK_DEBUG=false` in .env
- Use HTTPS (set up with Nginx reverse proxy or cloud platform)
- Store sessions in Redis or database (update SESSION_STORAGE in .env)
- Set up monitoring and alerts
- Use environment secrets for API keys (not in .env)

### For Production

- Deploy backend to cloud (Render, Railway, AWS, etc.)
- Use domain name instead of localhost
- Implement rate limiting and authentication
- Set up logs and error tracking
- Monitor WebSocket connections

---

## Getting Help

1. **Check logs**:
   - Backend: Terminal output where you ran `python server.py`
   - Extension: Right-click extension → Inspect → Console tab
   - Side Panel: Right-click → Inspect

2. **Read documentation**:
   - README.md: Architecture and features
   - API Reference section in README
   - Code comments in key files

3. **Debug step by step**:
   - Verify each step completed successfully
   - Use curl to test backend endpoints
   - Use browser DevTools to inspect network requests

---

**Congratulations! Your Privacy-Preserving Vision Agent is ready to use!** 🎉

For detailed usage and examples, see the README.md file.
