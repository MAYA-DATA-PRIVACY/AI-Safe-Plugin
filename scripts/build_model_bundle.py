#!/usr/bin/env python3
"""Download GLiNER2 fp16 ONNX model from HuggingFace and package as a release asset.

Run during CI/release to produce dist/ai-safe-plugin-model-fp16.tar.gz.
The install script downloads this tarball from the GitHub Release instead of
pulling directly from HuggingFace Hub (which is slower and has no bandwidth SLA).

Usage:
    uv run --no-sync python scripts/build_model_bundle.py
"""

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
MODEL_ARCHIVE = DIST / "ai-safe-plugin-model-fp16.tar.gz"

HF_REPO = "lmo3/gliner2-large-v1-onnx"
PRECISION = "fp16"


def main() -> None:
    from huggingface_hub import hf_hub_download, snapshot_download

    # First get the config to know which fp16 files to include
    config_path = hf_hub_download(repo_id=HF_REPO, filename="gliner2_config.json")
    with open(config_path) as f:
        config = json.load(f)

    onnx_files = config["onnx_files"][PRECISION]
    onnx_patterns = [
        onnx_files["encoder"],
        onnx_files["classifier"],
        onnx_files["span_rep"],
        onnx_files["count_embed"],
    ]
    onnx_data_patterns = [f"{p}.data" for p in onnx_patterns]

    allow_patterns = [
        "*.json",
        *onnx_patterns,
        *onnx_data_patterns,
    ]

    print(f"Downloading {HF_REPO} ({PRECISION}) from HuggingFace Hub...")
    model_path = Path(snapshot_download(
        repo_id=HF_REPO,
        allow_patterns=allow_patterns,
    ))
    print(f"Model downloaded to: {model_path}")

    # Package into tarball. The archive layout mirrors the HF cache snapshot structure:
    #   model/ ← top-level dir
    #     config.json
    #     gliner2_config.json
    #     tokenizer.json
    #     tokenizer_config.json
    #     onnx/
    #       encoder_fp16.onnx
    #       encoder_fp16.onnx.data
    #       ...
    DIST.mkdir(parents=True, exist_ok=True)

    included = 0
    with tarfile.open(MODEL_ARCHIVE, "w:gz", dereference=True) as archive:
        for path in sorted(model_path.rglob("*")):
            # Resolve symlinks (HF cache uses symlinks to blobs)
            real_path = path.resolve()
            if not real_path.is_file():
                continue
            rel = path.relative_to(model_path)
            # Skip non-fp16 ONNX files (fp32 variants)
            if rel.parts[0] == "onnx" and "fp16" not in rel.name and rel.suffix in (".onnx", ".data"):
                continue
            # Skip HF metadata files
            if rel.name.startswith("."):
                continue
            arcname = f"model/{rel}"
            archive.add(str(real_path), arcname=arcname)
            size_mb = real_path.stat().st_size / 1e6
            print(f"  + {arcname} ({size_mb:.1f} MB)")
            included += 1

    size_gb = MODEL_ARCHIVE.stat().st_size / 1e9
    print(f"\nBuilt {MODEL_ARCHIVE} ({size_gb:.2f} GB, {included} files)")


if __name__ == "__main__":
    main()
