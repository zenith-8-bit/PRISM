"""
Export fine-tuned YOLOv8n weights (.pt) to the .onnx file
lib/visualLayer/uiElementDetector.js loads.

Usage:
    pip install ultralytics
    python export_to_onnx.py --weights ui-yolov8n-runs/ui-detector/weights/best.pt
    # then copy the resulting .onnx into the extension:
    cp ui-yolov8n-runs/ui-detector/weights/best.onnx \
       ../lib/visualLayer/models/ui-yolov8n.onnx
"""

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True, help="Path to best.pt from training")
    parser.add_argument("--imgsz", type=int, default=640, help="Must match INPUT_SIZE in uiElementDetector.js")
    parser.add_argument("--opset", type=int, default=17, help="onnxruntime-web's WebGPU EP wants >=17")
    parser.add_argument(
        "--copy-to",
        default="../lib/visualLayer/models/ui-yolov8n.onnx",
        help="Where to drop the exported file so the extension can load it",
    )
    args = parser.parse_args()

    model = YOLO(args.weights)
    # nms=False is deliberate: uiElementDetector.js does letterbox-decode +
    # NMS itself in JS so the score/IoU thresholds are tunable without
    # re-exporting. simplify=True runs onnx-simplifier to fold constants,
    # which noticeably helps onnxruntime-web's WebGPU EP load time.
    exported_path = model.export(format="onnx", imgsz=args.imgsz, opset=args.opset, simplify=True, nms=False)

    dest = Path(args.copy_to)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(exported_path, dest)
    print(f"\nExported and copied to {dest.resolve()}")
    print(
        "Sanity-check the class order matches ACTIVE_CLASSES in "
        "lib/visualLayer/uiComponentSchema.js — Ultralytics preserves your "
        "dataset.yaml's `names:` order, so mismatched class lists between "
        "training and the JS schema will silently mislabel every detection."
    )


if __name__ == "__main__":
    main()
