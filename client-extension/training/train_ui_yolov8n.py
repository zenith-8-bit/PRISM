"""
Fine-tune YOLOv8n on a UI-component dataset for lib/visualLayer/uiElementDetector.js.

Run this on your own machine (needs a GPU for reasonable training time, and
internet access to pull the base weights + dataset) — this is not something
the browser extension itself does; it produces the .onnx file the extension
loads at runtime.

Usage:
    pip install ultralytics
    # Export a dataset from Roboflow in "YOLOv8" format and unzip it, or
    # point --data at your own dataset.yaml (see lib/visualLayer/README.md
    # for dataset sources: Roboflow Website Screenshots, RICO, CLAY, VINS,
    # WebUI).
    python train_ui_yolov8n.py --data ./ui-dataset/data.yaml --epochs 100
"""

import argparse

from ultralytics import YOLO


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data",
        required=True,
        help="Path to a YOLO-format dataset.yaml (Roboflow's export includes one).",
    )
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640, help="Must match INPUT_SIZE in uiElementDetector.js")
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument(
        "--base-weights",
        default="yolov8n.pt",
        help="Nano variant on purpose — this has to run client-side in-browser.",
    )
    args = parser.parse_args()

    model = YOLO(args.base_weights)
    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        project="ui-yolov8n-runs",
        name="ui-detector",
        # Browser inference is display-UI, not natural imagery — light on
        # geometric augmentation (no big rotations/perspective warps; UI
        # screenshots are always axis-aligned) but keep color-ish jitter for
        # dark-mode/theme robustness.
        degrees=0.0,
        shear=0.0,
        perspective=0.0,
        fliplr=0.0,  # a mirrored login form is a different (invalid) layout
        hsv_h=0.01,
        hsv_s=0.3,
        hsv_v=0.3,
    )

    metrics = model.val()
    print(metrics)
    print(
        "\nTraining done. Best weights: "
        "ui-yolov8n-runs/ui-detector/weights/best.pt\n"
        "Next: python export_to_onnx.py --weights ui-yolov8n-runs/ui-detector/weights/best.pt"
    )


if __name__ == "__main__":
    main()
