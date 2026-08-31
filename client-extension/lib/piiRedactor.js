// piiRedactor.js
// Applies bounding-box-precise redaction to a captured screenshot, merging:
//   (a) visual detections from visionWorker.js (faces -> always redacted)
//   (b) DOM findings from domScanner.js, projected from page coordinates
//       into screenshot pixel coordinates.
//
// Nothing here ever sends the *unredacted* bitmap anywhere. The function
// returns only the redacted PNG (as a data URL) plus a manifest describing
// what was redacted (categories + boxes, no content) for auditing/telemetry.

import { CONFIG } from "./config.js";

/**
 * @param {ImageBitmap} rawBitmap - full-resolution screen capture
 * @param {Array} faceBoxes - [{box:{x,y,width,height}, score, kind:'face'}]
 * @param {Array} domFindings - [{category, rect:{x,y,width,height}}] (CSS px)
 * @param {number} devicePixelRatio - to project CSS px -> capture px
 * @returns {{ dataUrl: string, manifest: Array }}
 */
export function redactImage(rawBitmap, faceBoxes, domFindings, devicePixelRatio = 1) {
  const canvas = new OffscreenCanvas(rawBitmap.width, rawBitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(rawBitmap, 0, 0);

  const manifest = [];
  const pad = CONFIG.REDACTION_PADDING_PX;

  // Channel A: face detections are always sensitive.
  for (const f of faceBoxes) {
    const box = padBox(f.box, pad);
    applyRedaction(ctx, box, CONFIG.REDACTION_STYLE);
    manifest.push({ source: "vision", category: "face", box });
  }

  // Channel B: DOM findings, projected into capture-pixel space.
  for (const finding of domFindings) {
    const projected = {
      x: finding.rect.x * devicePixelRatio,
      y: finding.rect.y * devicePixelRatio,
      width: finding.rect.width * devicePixelRatio,
      height: finding.rect.height * devicePixelRatio,
    };
    const box = padBox(projected, pad);
    applyRedaction(ctx, box, CONFIG.REDACTION_STYLE);
    manifest.push({ source: "dom", category: finding.category, box });
  }

  return { canvas, manifest };
}

function padBox(box, pad) {
  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function applyRedaction(ctx, box, style) {
  const { x, y, width, height } = box;
  if (width <= 0 || height <= 0) return;

  switch (style) {
    case "pixelate": {
      // Downscale-then-upscale the region in place for a coarse mosaic.
      const blockSize = Math.max(6, Math.floor(Math.min(width, height) / 8));
      const imgData = ctx.getImageData(x, y, width, height);
      const tmp = new OffscreenCanvas(width, height);
      const tmpCtx = tmp.getContext("2d");
      tmpCtx.putImageData(imgData, 0, 0);
      const small = new OffscreenCanvas(Math.max(1, width / blockSize), Math.max(1, height / blockSize));
      const smallCtx = small.getContext("2d");
      smallCtx.drawImage(tmp, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, small.width, small.height, x, y, width, height);
      break;
    }
    case "blur": {
      ctx.save();
      ctx.filter = "blur(12px)";
      ctx.drawImage(ctx.canvas, x, y, width, height, x, y, width, height);
      ctx.restore();
      break;
    }
    case "blackout":
    default: {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, width, height);
      break;
    }
  }
}
