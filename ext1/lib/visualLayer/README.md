# lib/visualLayer/ — screen structure detection, no DOM access

Everything in this folder answers "what's on screen and what kind of thing
is it" using **only pixels** — it never reads `document.*`. That's the
point: this is the signal you'd still have if the input were an arbitrary
screen recording/frame, not just this extension's own tab.

## Pieces

| File | Runs in | Job |
|---|---|---|
| `captureLayer.js` | background.js | `chrome.tabs.captureVisibleTab` + WebGPU availability probe |
| `visualLayerWorker.js` | Web Worker | orchestrates the two detectors below, off the main thread |
| `uiElementDetector.js` | Web Worker | YOLOv8n (ONNX Runtime Web) → UI component boxes |
| `textRegionDetector.js` | Web Worker | Tesseract.js (WASM) → text line/word boxes + OCR'd text |
| `uiComponentSchema.js` | anywhere | class taxonomy + which classes are *always* sensitive |
| `triggerBridge.js` | background.js | wires the two trigger sources below |
| `visualLayerController.js` | background.js | ties it all together, calls the PII vault, draws redactions |

## Two trigger sources (per spec)

1. **DOM interaction** — `content.js` listens for `click`/`focusin`/`input`
   (capture phase, values never read) and messages background.js on every
   one. `triggerBridge.js` debounces bursts (800ms) before firing.
2. **API signal** — background.js opens a WebSocket to
   `ws://localhost:2000` and treats `{"type":"trigger","task":"..."}`
   messages as a manual "run now" (this is the "specific signal comes to
   an api endpoint for now localhost 2000" requirement). Point any local
   process at this to trigger a capture on demand, e.g.:

   ```js
   // tiny Node example, ws package
   import { WebSocketServer } from "ws";
   const wss = new WebSocketServer({ port: 2000 });
   wss.on("connection", (ws) => {
     ws.send(JSON.stringify({ type: "trigger", task: "read the confirmation dialog" }));
   });
   ```

## Why ONNX Runtime Web + YOLOv8n, and not another Transformers.js pipeline

`lib/visionWorker.js` (existing) uses Transformers.js because
DETR/face-detection have ready-made pipelines there. YOLOv8n doesn't — the
standard path for a *custom-trained* detector is Ultralytics' own ONNX
export, run through `onnxruntime-web`. That's what `uiElementDetector.js`
does, including hand-rolled letterboxing + NMS (kept out of the ONNX graph
on purpose — see the comment at the top of that file for why).

## Fine-tuning the UI-element detector

**You need to actually train this** — there's no pretrained "detect a
password field" model lying around. Two tiers, matching
`uiComponentSchema.js`:

### Tier 1 — fast path, ready-to-train dataset, get a demo working today
[Roboflow "Website Screenshots" dataset](https://public.roboflow.com/object-detection/website-screenshots)
(also mirrored at
[universe.roboflow.com/roboflow-public/website-screenshots-ibe6t](https://universe.roboflow.com/roboflow-public/website-screenshots-ibe6t)) —
~1,200 screenshots from 1000+ real websites, already auto-annotated in
YOLO format with 8 classes: `button`, `field`, `heading`, `iframe`,
`image`, `label`, `link`, `text`. Export directly in "YOLOv8" format from
the Roboflow UI/API — zero labeling work required. This is what
`TIER_1_CLASSES` in `uiComponentSchema.js` matches.

### Tier 2 — fuller taxonomy (password/email/tel fields split out, etc.)
Combine these — none alone gives you fine-grained web *and* form-field-type
labels:
- **RICO** — [interactionmining.org/rico](http://interactionmining.org/rico) —
  ~66k mobile UI screens with view-hierarchy + 25 semantic component
  categories (button, input, checkbox, radio button, etc.) from *"Learning
  Design Semantics for Mobile Apps"*. Mobile, not web, but the component
  vocabulary is exactly the one `TIER_2_CLASSES` is modeled on.
- **CLAY** — [github.com/google-research-datasets/clay](https://github.com/google-research-datasets/clay) —
  Google's cleaned-up, re-annotated version of RICO's layouts; better label
  quality if you're going to actually train on it.
- **VINS** — "Object Detection for Graphical User Interface: Old Fashioned
  or Deep Learning or a Combination" (VINS dataset) — UI element detection
  across both web and mobile screenshots, closer to what you need class-wise.
- **WebUI** — [github.com/js0nwu/webui](https://github.com/js0nwu/webui) —
  400k+ real webpages with element labels extracted automatically from DOM
  metadata at crawl time (so it's free labels, at some noise cost) —
  the most web-native option for scale.
- Roboflow Universe also has smaller community web-UI sets if you search
  "UI elements", e.g.
  [universe.roboflow.com/webuiproject/ui-screenshots](https://universe.roboflow.com/webuiproject/ui-screenshots) —
  worth checking for something closer to your exact class list before
  committing to a big labeling pass.

See `../../training/` for the actual fine-tuning + ONNX export scripts
(run these on your own machine — this sandbox has no GPU/network).

## Trade-offs you're being scored on

- **Accuracy vs latency**: `INPUT_SIZE = 640` in `uiElementDetector.js` and
  Tesseract's default settings are both tunable. Dropping to 480 buys
  latency at some small-text-detection cost; that's your dial.
- **Resource utilization**: `CONFIG.MIN_INFERENCE_INTERVAL_MS` (shared with
  the existing DOM+face pipeline) and the 800ms DOM-interaction debounce in
  `triggerBridge.js` are the two levers that matter most here — don't
  remove either just to make the demo feel "snappier".
