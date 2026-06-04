import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/**
 * Small HTML labels that float above characters showing what they're
 * doing right now ("🍳 Cooking", "🍽️ Serving", "📦 Fetching"). Engine
 * supplies a fresh list each frame; we re-project and re-style.
 *
 * Bubbles are pooled so we don't churn DOM nodes on every frame — the
 * pool grows on demand to whatever the caller needs.
 */

export interface StatusEntry {
  /** Stable key so the same character keeps the same bubble. */
  key: string;
  character: AnimatedCharacter;
  /** Text to display. Empty string = bubble hidden this frame. */
  label: string;
  /** Optional background tint (defaults to dark amber). */
  bg?: string;
}

interface PooledBubble {
  el: HTMLDivElement;
  inUse: boolean;
}

/** Walk an Object3D's parent chain; return false if any ancestor is
 * marked visible=false. Used as the primary floor-leak filter for the
 * status bubbles: when a character is parented to a storey group that
 * the focus / tier rules have hidden, their bubble shouldn't render
 * either. Stops at the first parentless node (the scene root, or a
 * detached object). */
function isAncestorChainVisible(node: THREE.Object3D | null): boolean {
  let cur: THREE.Object3D | null = node;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

export class StatusBubbles {
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.Camera;
  private readonly pool: PooledBubble[] = [];
  private readonly active = new Map<string, PooledBubble>();
  /** Temporary projection scratch. */
  private readonly tmp = new THREE.Vector3();
  /** Storey the player is focused on. When set, bubbles for characters on
   * a different storey are hidden — otherwise the ground floor's "cooking" /
   * "pickup" labels float up through the upper slab and read as belonging
   * to the floor the player is actually looking at. */
  getFocusedFloor?: () => number;
  /** Metres per storey, used both to derive which floor a character is
   * standing on (root.position.y / storeyHeight) and to offset the bubble
   * Y so it sits above the head instead of below the ceiling. */
  getStoreyHeight?: () => number;

  /** Phase I (UX) — optional accessor for the list of opaque wall
   * meshes the bubble should be hidden behind.  Engine wires this
   * to WorldScene.getSolidWallOccluders().  When set, every visible
   * bubble fires a single raycast from the character's head toward
   * the camera; if it hits a wall before reaching the camera, the
   * bubble is hidden this frame.  Without this hook the bubble
   * leaks through walls just like any HTML overlay.
   *
   * Walls in "ghost" (see-through) mode are intentionally omitted
   * from the returned list, so a bubble behind a ghosted wall
   * still renders — matching what the player can actually see. */
  getOccluders?: () => readonly THREE.Object3D[];
  // Reused raycast scratch — Three.js Raycaster + the two Vector3s
  // it needs to be configured each call.  Pre-allocated to avoid
  // per-frame GC churn.
  private readonly raycaster = new THREE.Raycaster();
  private readonly camWorld = new THREE.Vector3();
  private readonly headWorld = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();

  constructor(host: HTMLElement, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
  }

  /** Render the given list this frame. Anything not in the list gets hidden. */
  update(entries: readonly StatusEntry[]): void {
    const rect = this.canvas.getBoundingClientRect();
    const stillActive = new Set<string>();
    const focused = this.getFocusedFloor?.();
    const storeyH = this.getStoreyHeight?.() ?? 3;
    // Phase I (UX) — fetch the wall occluder list ONCE per frame.
    // Same list is reused for every bubble's raycast below.
    const occluders = this.getOccluders?.();
    const hasOccluders = !!occluders && occluders.length > 0;
    if (hasOccluders) this.camera.getWorldPosition(this.camWorld);
    for (const entry of entries) {
      if (!entry.label) continue;
      // Primary filter: walk the character's parent chain. If ANY
      // ancestor in the three.js graph is invisible, the character's
      // mesh isn't on screen — so the bubble shouldn't be either. This
      // catches every case where a staff/guest is parented to a hidden
      // storey group (upper floor not in focus, or storey not yet
      // unlocked by tier). Strictly more reliable than the Y-rounded
      // floor calc which gets fooled mid-stair, by non-zero feetLift,
      // or by characters whose model origin doesn't sit exactly on the
      // slab.
      if (!isAncestorChainVisible(entry.character.root)) continue;
      // Secondary filter: derive the character's storey from their
      // world Y as a defence in depth — if a future code path adds an
      // unparented character (root attached directly to the scene),
      // the Y check still keeps a Floor 1 bubble out of the Floor 0
      // view. Math.round picks the nearest slab; an actor mid-stair
      // rounds toward whichever floor is closer.
      const charY = entry.character.root.position.y;
      const charFloor = Math.round(charY / storeyH);
      if (focused !== undefined && charFloor !== focused) continue;
      stillActive.add(entry.key);
      const bubble = this.active.get(entry.key) ?? this.acquire(entry.key);
      // World pos = character.groundPos.x/z + character feet Y + ~1.4 m
      // above their head. Using root.position.y instead of the old hard-
      // coded 1.4 keeps the bubble above the character on upper floors
      // (Floor 1 ≈ y=4.4, Floor 2 ≈ y=7.4, etc.) instead of pinned to
      // the ground slab.
      this.tmp.set(entry.character.groundPos.x, charY + 1.4, entry.character.groundPos.y);
      this.tmp.project(this.camera);
      const x = (this.tmp.x * 0.5 + 0.5) * rect.width;
      const y = (-this.tmp.y * 0.5 + 0.5) * rect.height;
      // Hide if behind camera.
      if (this.tmp.z > 1) {
        bubble.el.style.display = "none";
        continue;
      }
      // Phase I (UX) — wall-occlusion raycast.  Cast from the
      // character's head (~0.9 m above feet, mid-torso) toward the
      // camera; if a solid wall sits between, hide the bubble so
      // it doesn't bleed through.  Far is shortened by 0.3 m so
      // the camera's own near plane (or a wall the camera is
      // pressed against) can't itself count as a blocker.
      if (hasOccluders) {
        this.headWorld.set(entry.character.groundPos.x, charY + 0.9, entry.character.groundPos.y);
        this.rayDir.subVectors(this.camWorld, this.headWorld);
        const dist = this.rayDir.length();
        if (dist > 0.4) {
          this.rayDir.multiplyScalar(1 / dist); // normalize without re-length
          this.raycaster.set(this.headWorld, this.rayDir);
          this.raycaster.near = 0.05;
          this.raycaster.far = dist - 0.3;
          // intersectObjects(non-recursive) — occluders is a flat
          // mesh list, so traversal into children is unnecessary
          // and would be wasteful.  Cast to mutable Object3D[] — the
          // three.js signature requires mutable but the method only
          // reads, so the readonly source list is safe.
          const hits = this.raycaster.intersectObjects(occluders as THREE.Object3D[], false);
          if (hits.length > 0) {
            bubble.el.style.display = "none";
            continue;
          }
        }
      }
      bubble.el.style.display = "block";
      bubble.el.style.transform = `translate(${x - bubble.el.offsetWidth / 2}px, ${y - bubble.el.offsetHeight}px)`;
      if (bubble.el.textContent !== entry.label) {
        bubble.el.textContent = entry.label;
      }
      const bg = entry.bg ?? "rgba(28, 20, 14, 0.85)";
      if (bubble.el.style.background !== bg) bubble.el.style.background = bg;
    }
    // Recycle anything not in this frame.
    for (const [key, bubble] of this.active) {
      if (!stillActive.has(key)) {
        bubble.el.style.display = "none";
        bubble.inUse = false;
        this.active.delete(key);
      }
    }
  }

  private acquire(key: string): PooledBubble {
    let bubble = this.pool.find((p) => !p.inUse);
    if (!bubble) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        top: "0",
        left: "0",
        padding: "2px 7px",
        borderRadius: "10px",
        background: "rgba(28, 20, 14, 0.85)",
        color: "#fff5dc",
        font: "11px/1.2 system-ui, sans-serif",
        fontWeight: "600",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        border: "1px solid rgba(255,245,220,0.25)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        zIndex: "50",
      } as Partial<CSSStyleDeclaration>);
      this.host.appendChild(el);
      bubble = { el, inUse: false };
      this.pool.push(bubble);
    }
    bubble.inUse = true;
    this.active.set(key, bubble);
    return bubble;
  }
}
