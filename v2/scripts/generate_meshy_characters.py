"""Generate 3D character GLBs from the existing 2D turnaround sheets using
the Meshy.ai Image-to-3D API.

Reads each turnaround sheet from ../art_input/, extracts the FRONT view
(Meshy's image-to-3D works with a single front-facing image), encodes it
as a base64 data URI, posts to Meshy, polls until the task completes,
and downloads the resulting GLB into v2/public/assets/characters/.

Setup:
    1. Get an API key from https://www.meshy.ai/settings/api
    2. Create v2/.env with:
         MESHY_API_KEY=your_key_here
    3. pip install requests pillow python-dotenv
    4. python v2/scripts/generate_meshy_characters.py

Costs: as of writing, image-to-3D is ~5-10 credits per task on Meshy's
paid tiers. 9 characters * ~10 credits = ~90 credits (~$4-9 depending on
plan). The script prints the credit cost from each response.

Re-running is safe: characters whose GLB already exists are skipped
unless you pass --force.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

try:
    import requests  # type: ignore
    from PIL import Image  # type: ignore
except ImportError:
    print("Install deps: pip install requests pillow python-dotenv", file=sys.stderr)
    sys.exit(1)

# Optional .env loader. If python-dotenv isn't installed, we just read os.environ.
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass


ROOT = Path(__file__).resolve().parent.parent.parent  # repo root
INPUT_DIR = ROOT / "art_input"
OUTPUT_DIR = ROOT / "v2" / "public" / "assets" / "characters"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

API_BASE = "https://api.meshy.ai/openapi/v1/image-to-3d"
POLL_INTERVAL_SECONDS = 10
TIMEOUT_SECONDS = 60 * 15  # 15 min per character

# Map: source turnaround sheet -> output character id.
# Each sheet's FRONT view (left-most or top-left panel) gets fed to Meshy.
CHARACTERS: list[tuple[str, str]] = [
    ("chef-turnaround.png", "chef"),
    ("Chef - 8 sides - turnaround.png", "chef"),  # newer sheet wins on second run
    ("waiter-turnaround.png", "waiter"),
    ("Errand Helper - turnaround.png", "errand"),
    ("Customer 1 - Young Professional Woman - turnaround.png", "guest-v0"),
    ("Customer 2 - Retired Gentleman - turnaround.png", "guest-v1"),
    ("Customer 3 - Casual Student - turnaround.png", "guest-v2"),
    ("Customer 4 - Stylish Bohemian Artist - turnaround.png", "guest-v3"),
    ("Customer 5 - Office Worker - turnaround.png", "guest-v4"),
    ("Customer 6 -Elderly Woman - turnaround.png", "guest-v5"),
    ("Customer 7 - female bohemian.png", "guest-v6"),
]


def extract_front_view(sheet_path: Path) -> bytes:
    """Crop the FRONT view from a turnaround sheet and return PNG bytes.

    The 8-side sheet has a 4x2 grid; FRONT is the top-left panel.
    The 5-view sheets have a single row of 5 views; FRONT is leftmost.
    Heuristic: assume FRONT occupies the left ~20-25% of the top row.
    """
    im = Image.open(sheet_path).convert("RGB")
    w, h = im.size
    # Top-left panel: 25% wide, ~50-60% tall (avoid labels at top and details
    # below the figure row). These bounds are intentionally generous — Meshy
    # tolerates extra background. We'll have the figure dominate the crop.
    # 8-side sheets are 4x2 grids (aspect ~1.33), 5-view sheets are single
    # rows of figures + side text panel (aspect ~1.50).
    is_8_side = "8 sides" in sheet_path.name.lower() or (w / h) <= 1.4
    if is_8_side:
        # 4x2 grid: crop top-left quarter, slightly inset.
        x1, y1, x2, y2 = int(w * 0.02), int(h * 0.05), int(w * 0.25), int(h * 0.50)
    else:
        # Linear 5-view sheet, figures across the top half.
        # Text panel takes the leftmost ~18%; FRONT figure is panel 1.
        x1, y1, x2, y2 = int(w * 0.18), int(h * 0.02), int(w * 0.36), int(h * 0.60)
    crop = im.crop((x1, y1, x2, y2))
    buf = io.BytesIO()
    crop.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def to_data_uri(png_bytes: bytes) -> str:
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return f"data:image/png;base64,{b64}"


def post_create_task(api_key: str, image_uri: str, character_id: str) -> str:
    """POST to Meshy. Returns the new task id."""
    body = {
        "image_url": image_uri,
        # Default to PBR textures + remeshed quad topology for cleaner
        # animation rigging downstream. Adjust if cost is a concern.
        "enable_pbr": True,
        "should_texture": True,
        "should_remesh": True,
        "topology": "quad",
        "target_polycount": 30000,
        "ai_model": "meshy-5",  # newest at time of writing; fall back if rejected
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    resp = requests.post(API_BASE, headers=headers, json=body, timeout=30)
    if resp.status_code == 400 and "ai_model" in resp.text:
        # Older account or model name change — retry without specifying.
        body.pop("ai_model", None)
        resp = requests.post(API_BASE, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    task_id = data.get("result") or data.get("id") or data.get("task_id")
    if not task_id:
        raise RuntimeError(f"No task id in response for {character_id}: {data}")
    return task_id


def poll_task(api_key: str, task_id: str, label: str) -> dict:
    """Poll until the task finishes. Returns the final task json."""
    headers = {"Authorization": f"Bearer {api_key}"}
    started = time.time()
    while True:
        if time.time() - started > TIMEOUT_SECONDS:
            raise TimeoutError(f"Task {task_id} ({label}) timed out")
        resp = requests.get(f"{API_BASE}/{task_id}", headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status")
        progress = data.get("progress")
        if status in ("SUCCEEDED", "FAILED", "CANCELED", "EXPIRED"):
            return data
        prog_s = f" ({progress}%)" if progress is not None else ""
        print(f"  [{label}] {status}{prog_s}…", flush=True)
        time.sleep(POLL_INTERVAL_SECONDS)


def download_glb(url: str, dest: Path) -> int:
    """Download the GLB, returning bytes written."""
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with dest.open("wb") as f:
            written = 0
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)
                    written += len(chunk)
            return written


def process_character(api_key: str, sheet: str, character_id: str, force: bool) -> Optional[Path]:
    sheet_path = INPUT_DIR / sheet
    out_path = OUTPUT_DIR / f"{character_id}.glb"
    if out_path.exists() and not force:
        print(f"[{character_id}] skip (already exists at {out_path.name})")
        return out_path
    if not sheet_path.exists():
        print(f"[{character_id}] skip (source sheet missing: {sheet})")
        return None

    print(f"[{character_id}] extracting FRONT from {sheet}")
    front_png = extract_front_view(sheet_path)

    print(f"[{character_id}] uploading to Meshy ({len(front_png) // 1024} kB)…")
    task_id = post_create_task(api_key, to_data_uri(front_png), character_id)
    print(f"[{character_id}] task created: {task_id}")

    data = poll_task(api_key, task_id, character_id)
    status = data.get("status")
    if status != "SUCCEEDED":
        err = data.get("task_error") or data.get("error") or "no error detail"
        print(f"[{character_id}] FAILED — {status}: {err}")
        return None

    glb_url = (data.get("model_urls") or {}).get("glb")
    if not glb_url:
        print(f"[{character_id}] FAILED — no model_urls.glb in response: {json.dumps(data)[:300]}")
        return None

    bytes_written = download_glb(glb_url, out_path)
    cost = data.get("credits_used") or data.get("credits")
    cost_s = f" — cost: {cost} credits" if cost else ""
    print(f"[{character_id}] saved {out_path.name} ({bytes_written // 1024} kB){cost_s}")
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate 3D character GLBs via Meshy.ai")
    parser.add_argument("--force", action="store_true", help="Regenerate even if the GLB already exists")
    parser.add_argument("--only", action="append", help="Only generate the listed character id(s). Repeatable.")
    args = parser.parse_args()

    api_key = os.environ.get("MESHY_API_KEY")
    if not api_key:
        print("ERROR: MESHY_API_KEY not set. Put it in v2/.env or export it.", file=sys.stderr)
        return 2

    seen_ids = set()
    deduped: list[tuple[str, str]] = []
    # If the same character_id appears twice (e.g. chef has two sheets),
    # the LAST entry wins so the newer sheet is used.
    for sheet, cid in reversed(CHARACTERS):
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        deduped.append((sheet, cid))
    deduped.reverse()

    if args.only:
        wanted = set(args.only)
        deduped = [(s, c) for s, c in deduped if c in wanted]

    print(f"Generating {len(deduped)} character(s) -> {OUTPUT_DIR}")
    successes = 0
    for sheet, cid in deduped:
        try:
            out = process_character(api_key, sheet, cid, args.force)
            if out:
                successes += 1
        except Exception as e:
            print(f"[{cid}] ERROR: {e}")
        print()  # blank line between characters

    print(f"\nDone. {successes}/{len(deduped)} characters generated.")
    return 0 if successes == len(deduped) else 1


if __name__ == "__main__":
    sys.exit(main())
