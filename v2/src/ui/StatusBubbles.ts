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
    for (const entry of entries) {
      if (!entry.label) continue;
      // Floor filter — derive the character's storey from their world Y
      // (root.position.y ≈ floor * storeyHeight + feet-lift). Hide the
      // bubble when the player is focused on a different storey so the
      // ground floor's "pickup" / "cooking" labels don't leak through
      // the upper slab.
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
