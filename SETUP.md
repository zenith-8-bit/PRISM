# PRISM Setup Guide

Complete step-by-step instructions to get PRISM running locally.

## Prerequisites

Before starting, ensure you have:

- **Python 3.11+** - [Download](https://www.python.org/downloads/)
- **Chrome or Chromium browser** - Latest version
- **Ollama** - [Download](https://ollama.ai)
- **Docker & Docker Compose** (optional, for containerized setup)
- **Git** (optional, for cloning)

---

## Part 1: Install and Configure Ollama

### Step 1.1: Install Ollama

1. Visit https://ollama.ai
2. Download and install for your OS (macOS, Linux, Windows)
3. Follow installation wizard

### Step 1.2: Pull Qwen 2.5 7B Model

Open a terminal and run:

```bash
# Pull the Qwen model (first run downloads ~5GB)
ollama pull qwen2.5:7b

# This may take 5-15 minutes depending on internet speed
Step 1.3: Verify Ollama is Running
Start the Ollama server in a terminal:

bash
ollama serve
Expected output:

Code
time=2024-01-15T10:00:00.000Z level=INFO msg="Listening on 127.0.0.1:11434"
Keep this terminal open while using PRISM. It needs to run continuously.

Part 2: Backend Setup (Python)
Step 2.1: Clone or Extract Project
If you have a ZIP file:

bash
unzip PRISM.zip
cd PRISM
If cloning from Git:

bash
git clone https://github.com/zenith-8-bit/PRISM.git
cd PRISM
Step 2.2: Create Python Virtual Environment
On macOS/Linux:

bash
python3.11 -m venv venv
source venv/bin/activate
On Windows:

bash
python -m venv venv
venv\Scripts\activate
You should see (venv) in your terminal prompt.

Step 2.3: Install Python Dependencies
bash
# Upgrade pip first
pip install --upgrade pip

# Install from requirements.txt
pip install -r requirements.txt
This installs:

Flask & Flask-CORS (web framework)
Flask-Sock (WebSocket support)
python-dotenv (environment configuration)
Pillow (image processing)
Requests (HTTP client)
Step 2.4: Configure Environment
Create .env file from template:

bash
cp .env.example .env
Edit .env with your settings:

bash
# Ollama Configuration
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

# Server Configuration
FLASK_DEBUG=false
PORT=8000
HOST=0.0.0.0

# Backend URLs (for extension to connect)
BACKEND_URL=http://localhost:8000
WS_URL=ws://localhost:8000

# PII Redaction Settings
WARN_ON_PII=true
ALWAYS_REDACT_EMAILS=true

# Inference Tuning (lower temperature = more deterministic)
QWEN_TEMPERATURE=0.2
QWEN_TOP_P=0.9
QWEN_TOP_K=40
Step 2.5: Test Backend Startup
bash
python server.py
Expected output:

Code
╔════════════════════════════════════════════════════════╗
║   Privacy-Preserving Vision Agent Backend (OPTIMIZED)  ║
║   http://localhost:8000                                 ║
║   WebSocket: ws://localhost:8000                        ║
║   Model: qwen2.5:7b                                     ║
║   Streaming: Enabled                                    ║
╚════════════════════════════════════════════════════════╝
Keep this running! Open a new terminal for the next steps.

Part 3: Chrome Extension Setup
Step 3.1: Verify Extension Directory
The extension is in the ext2/ folder:

bash
ls ext2/manifest.json  # Should exist
ls ext2/sidepanel.html
ls ext2/background.js
Step 3.2: Load Extension in Chrome
Open Chrome

Code
chrome://extensions/
Enable Developer Mode

Toggle "Developer mode" switch in top-right corner
Load Unpacked Extension

Click "Load unpacked"
Navigate to project directory
Select the ext2/ folder
Click "Select Folder"
Grant Permissions

Extension will request permissions
Click "Allow" to approve
Verify Installation

Extension should appear in your extensions list
Click extension icon in toolbar
You should see the PRISM side panel icon
Step 3.3: Configure Extension (Optional)
Edit ext2/lib/config.js to customize:

js
export const CONFIG = {
  DEBUG: true,              // Enable console logging
  SERVER_URL: "http://localhost:8000",
  BACKEND_URL: "http://localhost:8000",
  WS_URL: "ws://localhost:8000",
  MIN_INFERENCE_INTERVAL_MS: 1000,
  REDACTION_STYLE: "blur",  // "blur" or "black"
};
Part 4: Test the System
Step 4.1: Verify All Services Are Running
Open 3 terminals:

Terminal 1 (Ollama):

bash
ollama serve
# Keep running
Terminal 2 (Backend):

bash
cd PRISM
source venv/bin/activate  # or venv\Scripts\activate on Windows
python server.py
# Keep running
Terminal 3 (For testing):

bash
# Use for curl commands or general tasks
cd PRISM
Step 4.2: Health Check
From Terminal 3, verify backend is responsive:

bash
curl http://localhost:8000/api/health
Expected response:

JSON
{
  "status": "ok",
  "model": "qwen2.5:7b",
  "timestamp": "2024-01-15T10:30:00.000000"
}
If this fails:

Verify Ollama is running: curl http://localhost:11434/api/tags
Verify port 8000 is available: lsof -i :8000
Check .env file has correct OLLAMA_URL
Step 4.3: Test Extension Connection
Open any website (Google, Wikipedia, Amazon, etc.)

Click extension icon in Chrome toolbar

You should see the PRISM side panel open on the right
Send a test message

Code
What's visible on this page?
Watch the response

Side panel shows: [Processing...]
Backend analyzes DOM
AI responds with description
Try an action query

Code
Click the search box
Extension finds search element
Backend plans action
Element gets clicked
Step 4.4: Check Logs
Backend logs (in Terminal 2 running python server.py):

Code
POST /api/chat
- session_id: user-session-123
- message: "What's visible on this page?"
- UI elements found: 24
- Response: "This page shows..."
Extension logs:

Right-click extension icon → "Inspect"
Go to "Application" tab → "Service Workers"
Look for console output
Part 5: Add ONNX Model (Optional)
The extension can detect UI elements using a YOLOv8n ONNX model. Without it, it still works but won't detect specific UI elements.

Option A: Use Dummy Model (Testing Only)
bash
# Create empty placeholder
mkdir -p ext2/lib/visualLayer/models
touch ext2/lib/visualLayer/models/ui-yolov8n.onnx
The system will gracefully handle missing model.

Option B: Train Your Own Model
bash
# From the training directory
cd training

# 1. Download dataset to datasets/ folder
#    Visit https://roboflow.com for UI element datasets
#    Download in YOLO format

# 2. Train the model
python train_ui_yolov8n.py

# 3. Export to ONNX
python export_to_onnx.py
# Automatically copies to: ../ext2/lib/visualLayer/models/ui-yolov8n.onnx

# 4. Reload extension in Chrome
# chrome://extensions → Reload button on PRISM
Option C: Use Pre-trained Model
Download a YOLOv8n model trained on UI elements
Place at: ext2/lib/visualLayer/models/ui-yolov8n.onnx
Verify file size (should be 20-50 MB)
Part 6: Docker Deployment (Optional)
For easier deployment without manual setup:

Step 6.1: Prerequisites
bash
# Verify Docker is installed
docker --version
docker-compose --version

# Should output version numbers, e.g., "Docker version 24.0.0"
Step 6.2: Configure Environment
Create .env file (if not already done):

bash
cp .env.example .env
# Edit .env with your settings
Step 6.3: Start Services
bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f backend

# To stop
docker-compose down
This starts:

Backend: http://localhost:8000
Redis: localhost:6379 (for session storage)
Nginx: localhost:80 (optional reverse proxy)
Step 6.4: Verify Docker Setup
bash
# Check if containers are running
docker-compose ps

# Test backend
curl http://localhost:8000/api/health

# View backend logs
docker-compose logs backend

# View all logs
docker-compose logs -f
Common Issues & Solutions
Issue 1: "OLLAMA_URL refused connection"
Symptom: Backend crashes on startup with connection refused error

Solution:

Verify Ollama is running: ollama serve in separate terminal
Check OLLAMA_URL in .env is http://localhost:11434
Verify port 11434 isn't blocked by firewall
Restart backend: python server.py
Issue 2: "Connection refused: http://localhost:8000"
Symptom: Extension says can't reach backend

Solution:

Verify backend is running: curl http://localhost:8000/api/health
Check manifest.json has http://localhost:8000/* in host_permissions
Reload extension: chrome://extensions → Reload button
Refresh the webpage
Issue 3: "Port 8000 already in use"
Symptom: Backend fails to start with "Address already in use"

Solution:

bash
# Find what's using port 8000
lsof -i :8000

# Either:
# 1. Kill the process: kill -9 <PID>
# 2. Or change PORT in .env to 8001, update extension config
Issue 4: "Model download stuck"
Symptom: ollama pull qwen2.5:7b hangs or is very slow

Solution:

Check internet connection
Try canceling (Ctrl+C) and retry
Model is ~5GB, may take 10-30 minutes on slower connections
Verify disk space: df -h (need at least 10GB free)
Issue 5: "No UI elements detected on page"
Symptom: Extension loads but can't find buttons/inputs

Solution:

This is normal without a trained ONNX model
Check browser console for ONNX loading errors
Verify model file exists: ls -lh ext2/lib/visualLayer/models/ui-yolov8n.onnx
Try with simple HTML pages first (not complex SPAs)
Train your own model (see Part 5)
Issue 6: "WebSocket connection failed"
Symptom: Red status indicator in side panel, messages don't send

Solution:

Verify backend is running
Check WS_URL in ext2/lib/config.js is ws://localhost:8000
Verify port 8000 is accessible: curl http://localhost:8000/api/health
Reload extension and refresh webpage
Check browser console for network errors
Issue 7: "Python version error"
Symptom: ModuleNotFoundError or Python version complaints

Solution:

bash
# Check Python version
python --version
# Should be 3.11 or higher

# Create venv with correct Python
python3.11 -m venv venv

# Activate and reinstall
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
Verification Checklist
Work through this to ensure everything is set up correctly:

 Python 3.11+ installed: python --version
 Ollama installed and running: ollama serve
 Qwen model pulled: ollama list
 Virtual environment created: source venv/bin/activate
 Dependencies installed: pip list | grep Flask
 .env file created with correct OLLAMA_URL
 Backend runs without errors: python server.py
 Backend responds to health check: curl http://localhost:8000/api/health
 Extension loads in Chrome: chrome://extensions
 Extension side panel opens: Click extension icon
 Test message sends and receives response
 Backend logs show incoming requests
Next Steps
For Testing
Try different websites (Google, Amazon, Wikipedia, banking sites)
Test various queries:
Informational: "What's on this page?"
Actionable: "Click the first link"
Complex: "Fill this form and submit"
Watch backend logs to understand flow
For Development
Enable DEBUG mode in ext2/lib/config.js
Inspect extension logs: Right-click → Inspect
Modify server.py for custom behavior
Experiment with Qwen prompt engineering
Train custom ONNX model on your UI styles
For Production
Set FLASK_DEBUG=false in .env
Use HTTPS with reverse proxy (Nginx)
Deploy backend to cloud platform (AWS, Railway, Render, etc.)
Use Redis for session persistence
Set up monitoring and error tracking
Implement rate limiting on API endpoints
Helpful Commands
bash
# Check if services are running
ps aux | grep "ollama\|python server"

# Check port availability
lsof -i :11434  # Ollama
lsof -i :8000   # Backend

# Test backend endpoints
curl http://localhost:8000/api/health
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test","message":"hi","screen_state":{}}'

# View backend logs
tail -f server.log

# Reload extension in Chrome (from terminal)
chrome-extension://[extension-id]/  # Copy from chrome://extensions

# Kill process on port
kill -9 $(lsof -t -i :8000)

# View Docker logs
docker-compose logs -f backend
docker-compose logs -f redis
docker-compose logs -f nginx
Getting Help
Check logs first:

Backend: Terminal output from python server.py
Extension: Right-click extension → Inspect → Console
Ollama: Terminal output from ollama serve
Read the docs:

README.md: Architecture and features
ext2/README.md: Extension details
ext2/lib/visualLayer/README.md: UI detection specifics
Debug systematically:

Verify Ollama is running
Verify backend responds: curl http://localhost:8000/api/health
Verify extension can reach backend
Check browser console for JavaScript errors
Restart all services if stuck
Performance Tips
Optimize Backend Speed
bash
# In .env
QWEN_TEMPERATURE=0.1          # Lower = faster, more deterministic
STREAM_RESPONSES=true          # Stream responses for perceived speed
MIN_INFERENCE_INTERVAL_MS=1000 # Debounce rapid requests
Optimize Extension Speed
js
// In ext2/lib/config.js
CONFIG.MIN_INFERENCE_INTERVAL_MS = 2000  // Reduce inference frequency
CONFIG.DEBUG = false                      // Disable logging overhead
Monitor Resource Usage
bash
# Watch Ollama memory usage
watch -n 1 'ps aux | grep ollama'

# Watch backend CPU/memory
watch -n 1 'ps aux | grep python'

# Check available memory
free -h  # Linux
vm_stat # macOS
Get-ComputerInfo | Select-Object CsPhyicallyInstalledMemory # Windows
You're all set! Start automating with PRISM. 🎉
