
# PRISM
### Privacy-Preserving Vision Agent

> **On-device visual perception for lightweight browser agents**

PRISM is a privacy-focused browser agent that allows an AI system to understand and interact with complex webpages **without sending the user's raw screen to the reasoning backend**.

Instead, perception and privacy filtering happen locally in the browser. The backend receives only a sanitized, structured representation of the page.

---

## Why PRISM?

Browser agents need to understand what users see.

For example:

> "Fill out this banking application for me."

A conventional vision-based agent may need to send a screenshot to a remote AI model.

That screenshot could contain:

- Names and email addresses
- Phone numbers
- Financial information
- Password and PIN fields
- Internal dashboards
- Confidential documents

PRISM moves the privacy boundary **before AI reasoning**.

The browser locally analyzes the page, detects sensitive information, removes or tokenizes it, and sends only the information required for the AI to complete the task.

### Core principle

**The AI does not need to see everything the user sees.  
It only needs to see what is necessary to complete the task.**

---

# Architecture

```text
                   USER'S DEVICE
┌───────────────────────────────────────────────────┐
│                                                   │
│                  Chrome Extension                 │
│                                                   │
│   ┌─────────┐    ┌──────────┐    ┌────────────┐  │
│   │   DOM   │    │   Vision │    │    OCR     │  │
│   │ Scanner │    │  Layer   │    │            │  │
│   └────┬────┘    └────┬─────┘    └─────┬──────┘  │
│        │              │                │         │
│        └──────────────┼────────────────┘         │
│                       ▼                          │
│             Privacy / PII Detection              │
│                       │                          │
│                       ▼                          │
│              Redaction + Tokenization            │
│                       │                          │
│                       ▼                          │
│                  ScreenState                     │
│                                                   │
└───────────────────────┬───────────────────────────┘
                        │
                        │ Sanitized ScreenState
                        ▼
              ┌─────────────────────┐
              │   Reasoning Backend │
              │                     │
              │   Qwen 2.5 7B       │
              │   Structured Action │
              │      Planning       │
              └──────────┬──────────┘
                         │
                         ▼
                  Action returned
                         │
                         ▼
                 Chrome Extension
                         │
                         ▼
                    Browser UI
````

### What crosses the network?

**Sanitized ScreenState only.**

The architecture is designed so that raw screenshots and unredacted sensitive values do not need to be transmitted to the reasoning backend.

---

# Key Technical Ideas

## 1. Dual Perception

PRISM combines two sources of information:

### DOM perception

The browser DOM provides structural information such as:

* Buttons
* Links
* Input fields
* Labels
* Element types
* Element properties

### Visual perception

DOM information is not always enough.

Important UI can exist inside:

* Canvas elements
* Images
* PDFs
* Visually complex components
* Custom-rendered interfaces

PRISM therefore uses lightweight visual detection and OCR alongside DOM information.

---

## 2. Layered Privacy Detection

PRISM does not rely on a single detector.

Sensitive information can be identified through multiple signals:

```text
             ┌──────────────┐
             │     DOM      │
             └──────┬───────┘
                    │
┌──────────────┐    │    ┌──────────────┐
│     OCR      │────┼────│    Vision    │
└──────────────┘    │    └──────────────┘
                    │
             ┌──────▼───────┐
             │ PII /        │
             │ Sensitivity  │
             │ Detection    │
             └──────┬───────┘
                    ▼
             Redaction / Token
                    │
                    ▼
               ScreenState
```

For example:

* OCR can identify an email address.
* Regex can recognize a phone number.
* DOM structure can identify a password field even when OCR sees only `••••••`.
* Visual detection can identify UI elements that are not represented adequately by the DOM.

This layered approach is intended to reduce the risk of sensitive information escaping the privacy boundary.

---

# Technology Stack

### Browser

* Chrome Extension
* Manifest V3
* JavaScript
* Content Scripts
* Service Worker
* Side Panel
* Web Workers

### Local AI

* YOLOv8n
* ONNX Runtime Web
* WebGPU
* WASM fallback
* OCR pipeline

### Privacy

* Regex-based PII detection
* Structural sensitivity checks
* Local redaction/token handling

### Backend

* Python
* REST API
* WebSocket communication
* Qwen 2.5 7B
* Ollama
* Constrained JSON actions

---

# Project Structure

```text
PRISM/
│
├── README.md
├── SETUP.md
├── requirements.txt
│
├── server.py
├── Dockerfile
├── docker-compose.yml
│
├── ext2/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── sidepanel.html
│   ├── sidepanel.js
│   ├── sidepanel.css
│   │
│   └── lib/
│       ├── config.js
│       ├── domScanner.js
│       ├── backendConnector.js
│       │
│       └── visualLayer/
│           ├── uiElementDetector.js
│           ├── textRegionDetector.js
│           └── models/
│
└── training/
    ├── train_ui_yolov8n.py
    └── export_to_onnx.py
```

> Model weights and local development environments are intentionally not included in the repository.

---

# Getting Started

## Requirements

Before running PRISM, install:

* Python 3.11+
* Google Chrome / Chromium
* Ollama
* Git

Docker is optional.

---

## 1. Clone the repository

```bash
git clone https://github.com/zenith-8-bit/PRISM.git
cd PRISM
```

---

## 2. Install the backend

Create a virtual environment:

### Windows

```powershell
python -m venv venv
venv\Scripts\activate
```

### Linux / macOS

```bash
python3 -m venv venv
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

---

## 3. Start Ollama

Install Ollama from:

[https://ollama.com/](https://ollama.com/)

Pull the reasoning model:

```bash
ollama pull qwen2.5:7b
```

Start Ollama if it is not already running:

```bash
ollama serve
```

The default Ollama endpoint is:

```text
http://localhost:11434
```

---

## 4. Start the backend

From the project root:

```bash
python server.py
```

Verify the backend is running:

```bash
curl http://localhost:8000/api/health
```

---

# 5. Load the Chrome Extension

Open:

```text
chrome://extensions/
```

Then:

1. Enable **Developer mode**
2. Click **Load unpacked**
3. Select the `ext2/` directory
4. Reload the extension if necessary
5. Open the PRISM side panel

---

# How It Works

A typical interaction follows this pipeline:

```text
User Request
     │
     ▼
Browser Page
     │
     ▼
Local DOM + Vision + OCR
     │
     ▼
PII / Sensitive Field Detection
     │
     ▼
Redaction + Tokenization
     │
     ▼
Sanitized ScreenState
     │
     ▼
Backend
     │
     ▼
Qwen Reasoning
     │
     ▼
Constrained Action
     │
     ▼
Browser Executes Action
     │
     ▼
New ScreenState
```

The process can repeat as the agent progresses through a workflow.

---

# Example

User:

```text
Add the red product to my cart.
```

PRISM:

1. Reads the webpage locally.
2. Detects relevant UI elements.
3. Identifies the product and associated action.
4. Removes sensitive information before transmission.
5. Creates a sanitized `ScreenState`.
6. Sends the `ScreenState` to the reasoning backend.
7. The backend returns a constrained action.
8. The extension executes the action.
9. The browser is observed again.

The agent can then determine whether the task is complete or whether another action is required.

---

# Privacy Model

## Data intended to stay on the device

PRISM is designed not to transmit:

* Raw screenshots
* Unredacted PII values
* Password values
* PIN values
* Sensitive field contents
* Raw sensitive DOM values

## Data that may be transmitted

The backend receives the sanitized representation required for reasoning, such as:

* UI element metadata
* Element types
* Bounding boxes
* Sanitized text
* Redaction metadata
* Non-sensitive page information
* Local token identifiers

### Important

PRISM is a privacy-preserving architecture, **not a claim of perfect privacy**.

A critical engineering goal is measuring and minimizing false negatives in PII detection.

---

# Agent Safety

The reasoning model does not receive unrestricted browser control.

Actions are represented using a constrained structure such as:

```json
{
  "type": "click_element",
  "element_id": "submit-button"
}
```

Supported action categories can include:

```text
click_element
fill_form
scroll_page
done
```

The extension validates the returned action before execution.

This limits the ability of the reasoning model to generate arbitrary browser instructions.

---

# Performance

Running AI directly inside a browser introduces resource constraints.

PRISM therefore uses:

* Lightweight models
* Web Workers
* WebGPU acceleration when available
* WASM fallback
* Inference throttling
* Caching
* Reduced-resolution processing where necessary

The goal is to avoid continuously running expensive perception while the user is browsing normally.

---

# Current Limitations

PRISM is a research/prototype system and has several limitations.

### UI detection

Visual detection performance depends on:

* Website layout
* Fonts
* Themes
* Resolution
* UI components
* Training data

### PII detection

No detector can guarantee perfect recall.

False negatives are therefore a major security concern.

### Browser compatibility

WebGPU availability varies between devices and browsers.

PRISM therefore maintains a fallback path using WASM and lighter processing.

### Agent reliability

The reasoning model can still make incorrect decisions.

Constrained actions and validation reduce this risk but do not eliminate it.

---

# Evaluation

PRISM should be evaluated using four primary metrics:

| Metric                    | What it measures                                      |
| ------------------------- | ----------------------------------------------------- |
| **Privacy Recall**        | How reliably sensitive information is detected        |
| **UI Detection Accuracy** | How accurately interface elements are detected        |
| **Inference Latency**     | Time required for local perception                    |
| **Task Success Rate**     | How often the agent successfully completes a workflow |

The most important privacy metric is **recall**:

> How much sensitive information did PRISM successfully prevent from reaching the reasoning layer?

---

# Development

## Train the UI Detection Model

Training scripts are located in:

```text
training/
```

Example:

```bash
cd training
python train_ui_yolov8n.py
```

Export the trained model:

```bash
python export_to_onnx.py
```

The exported model can then be placed in:

```text
ext2/lib/visualLayer/models/
```

---

# Troubleshooting

## Extension cannot connect to backend

Check that the backend is running:

```bash
curl http://localhost:8000/api/health
```

Then:

1. Check the extension's backend URL.
2. Reload the extension from `chrome://extensions/`.
3. Inspect the extension console for errors.

---

## Ollama connection failed

Check:

```bash
ollama list
```

Make sure the model exists:

```text
qwen2.5:7b
```

If not:

```bash
ollama pull qwen2.5:7b
```

---

## No visual elements detected

Check that the ONNX model exists in:

```text
ext2/lib/visualLayer/models/
```

Also inspect the extension console for model-loading errors.

---

# Research Foundation

PRISM builds on existing work in:

* Browser-based machine learning
* ONNX Runtime Web
* YOLO-based UI detection
* OCR
* GUI understanding
* Browser automation

Research inspiration includes Microsoft's OmniParser approach to converting screenshots into structured UI representations.

Datasets considered for UI understanding include:

* RICO
* WebUI
* VINS
* CLAY
* Website screenshot datasets

---

# Roadmap

### Current

* [x] Browser extension architecture
* [x] Local DOM perception
* [x] Local visual perception
* [x] OCR pipeline
* [x] PII detection
* [x] Local redaction/tokenization
* [x] Sanitized ScreenState
* [x] Backend reasoning
* [x] Structured actions

### Next

* [ ] Improve UI detection accuracy
* [ ] Expand PII detection coverage
* [ ] Robust multi-step browser workflows
* [ ] Better action validation
* [ ] Performance benchmarking
* [ ] Privacy recall benchmarking
* [ ] Broader website evaluation

---

# Security Philosophy

PRISM follows one central architectural principle:

```text
              RAW USER DATA
                    │
                    ▼
          ┌──────────────────┐
          │  LOCAL PRIVACY   │
          │     BOUNDARY     │
          └────────┬─────────┘
                   │
                   ▼
           SANITIZED STATE
                   │
                   ▼
            AI REASONING

---

**Privacy is enforced before reasoning begins.**

---

# License

This project contains multiple components with their own dependencies and licenses.
Check the license terms of:
* YOLO / Ultralytics components
* Tesseract / OCR components
* ONNX Runtime
* Transformers.js
* Qwen
* Ollama
* Other third-party dependencies
---

# Team

**Team CAKY**

Built for:

**Smart India Hackathon 2026**

Problem Statement:

**SIH171 — On Device Visual Perception for Light-weight Browser Agents**

---

## PRISM

> **See less. Understand enough. Act safely.**
