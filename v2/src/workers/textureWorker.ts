/// <reference lib="webworker" />
//
// Off-thread canvas drawing for procedural textures.
//
// At boot we paint ~100 unique shop-sign textures (Boulangerie, Café,
// Tabac, ...) — one per scenery shop. Each paint costs ~3 ms on the
// main thread (canvas fill + border stroke + serif italic glyph
// rendering); 100 × 3 ms = ~300 ms of boot freeze the player feels
// as a stall right after the login modal closes.
//
// This worker uses OffscreenCanvas to do the same paint off-thread,
// transfers back an ImageBitmap, and the main thread wraps it in a
// THREE.Texture without any of the cost. Other procedural textures
// (grass, blade, cloud) follow the same pattern but ship lazily —
// shop signs are the dominant cost so they're the first migration.
//
// Protocol — keep the response shape stable across kinds so the main
// side can route by `id` only:
//   request:  { id; kind: "shop-sign"; name }
//   response: { id; ok: true;  bitmap: ImageBitmap }
//          |  { id; ok: false; error: string }
//
// The response transfers the ImageBitmap (zero-copy) — main thread
// adopts ownership.

type ShopSignRequest = { id: number; kind: "shop-sign"; name: string };
type Request = ShopSignRequest;

type Ok = { id: number; ok: true; bitmap: ImageBitmap };
type Err = { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function paintShopSign(name: string): ImageBitmap {
  const w = 512, h = 128;
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
  // Background — warm cream, lightly aged.
  ctx.fillStyle = "#f4ead2";
  ctx.fillRect(0, 0, w, h);
  // Inner dark border for that traditional sign look.
  ctx.strokeStyle = "#3a261a";
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  // Lettering — deep maroon, serif, slightly italic to read as
  // hand-painted commerce. Size scales down for long names so the
  // text never spills off the sign.
  const targetFs = name.length > 9 ? 56 : 72;
  ctx.fillStyle = "#5a2018";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 italic ${targetFs}px "Georgia", "Times New Roman", serif`;
  ctx.fillText(name, w / 2, h / 2 + 4);
  return oc.transferToImageBitmap();
}

scope.addEventListener("message", (ev: MessageEvent<Request>) => {
  const req = ev.data;
  try {
    switch (req.kind) {
      case "shop-sign": {
        const bitmap = paintShopSign(req.name);
        const res: Ok = { id: req.id, ok: true, bitmap };
        scope.postMessage(res, { transfer: [bitmap] });
        break;
      }
      default: {
        const _exhaustive: never = req.kind;
        const err: Err = { id: (req as { id: number }).id, ok: false, error: `unknown kind: ${String(_exhaustive)}` };
        scope.postMessage(err);
      }
    }
  } catch (e) {
    const err: Err = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    scope.postMessage(err);
  }
});

// Force this file to be treated as a module so the top-level type
// aliases don't leak into the global script scope (where they'd
// collide with the identical names in saveWorker.ts).
export {};
