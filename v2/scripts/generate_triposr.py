"""Generate 3D character GLBs from the existing FRONT-view crops using the
free public TripoSR Hugging Face Space — no API key, no account required.

Quality is below paid services like Meshy (TripoSR is a 2024 academic model)
but it's truly free with no quotas, and the output is good enough to wire
up the 3D character system. We can re-generate with Meshy/Tripo3D later
once the rest of the game is built and a budget is approved.

Reads:  v2/meshy_fronts/{character_id}.png
Writes: v2/public/assets/characters/{character_id}.glb

Usage:
    cd v2
    pip install gradio_client
    python scripts/generate_triposr.py            # generates all missing
    python scripts/generate_triposr.py --force     # regenerates everything
    python scripts/generate_triposr.py --only chef # just one
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

try:
    from gradio_client import Client, handle_file  # type: ignore
except ImportError:
    print("Install with: pip install gradio_client", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent  # v2/
FRONTS_DIR = ROOT / "meshy_fronts"
OUT_DIR = ROOT / "public" / "assets" / "characters"
OUT_DIR.mkdir(parents=True, exist_ok=True)

SPACE = "stabilityai/TripoSR"
# Higher = more detailed mesh but slower; 256 is a good balance.
MARCHING_CUBES = 256
# Foreground crop: 0.85 zooms in slightly so the character fills the frame.
FOREGROUND_RATIO = 0.85

CHARACTERS = [
    "chef", "waiter", "errand",
    "guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6",
]


def generate_one(client: Client, char_id: str, force: bool) -> bool:
    src = FRONTS_DIR / f"{char_id}.png"
    dst = OUT_DIR / f"{char_id}.glb"
    if not src.exists():
        print(f"[{char_id}] SKIP — source not found: {src.name}")
        return False
    if dst.exists() and not force:
        print(f"[{char_id}] SKIP — already exists: {dst.name}")
        return True

    print(f"[{char_id}] preprocessing…")
    processed = client.predict(handle_file(str(src)), True, FOREGROUND_RATIO,
                                api_name="/preprocess")
    print(f"[{char_id}] generating 3D mesh (~30-60s)…")
    started = time.time()
    _obj, glb = client.predict(handle_file(processed), MARCHING_CUBES,
                                api_name="/generate")
    elapsed = time.time() - started
    shutil.copy(glb, dst)
    size_kb = dst.stat().st_size // 1024
    print(f"[{char_id}] wrote {dst.name} ({size_kb} KB) in {elapsed:.1f}s")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", action="append", default=[])
    args = parser.parse_args()

    targets = args.only if args.only else CHARACTERS
    print(f"Generating {len(targets)} character(s) via {SPACE}")
    print(f"Output: {OUT_DIR}\n")

    print("connecting to Hugging Face Space…")
    try:
        client = Client(SPACE, verbose=False)
    except Exception as e:
        print(f"FAILED to connect: {e}", file=sys.stderr)
        return 2

    ok = 0
    for cid in targets:
        try:
            if generate_one(client, cid, args.force):
                ok += 1
        except Exception as e:
            print(f"[{cid}] ERROR: {e}")
        print()
    print(f"\nDone. {ok}/{len(targets)} ok.")
    return 0 if ok == len(targets) else 1


if __name__ == "__main__":
    sys.exit(main())
