/**
 * Tip hearts — a small retention "reward for being at the controls" activity.
 *
 * Every so often a pulsing gold heart floats over a HAPPY seated guest (one who
 * has been served and is `eating`, not about to leave). Tap it for a bonus tip.
 * The credit + amount + rate-limit are all server-authoritative
 * (claim_tip_bonus: fixed $5, 2.5s cooldown) — this class is purely the
 * on-screen prompt. At most one heart at a time so it reads as a treat, not a
 * chore; it tracks its guest each frame (projected exactly like StatusBubbles),
 * respects the focused floor, and expires if untapped.
 */

import * as THREE from "three";
import type { AnimatedCharacter } from "../scene/CharacterAnimator";

/** Matches GuestSpawner.snapshotStatus() entries. */
export interface GuestStatusEntry {
  id: string;
  character: AnimatedCharacter;
  label: string;
  panic: boolean;
  eating: boolean;
}

const HEART_W = 40;
const HEART_H = 40;
const LIFETIME_MS = 6000;        // fades if untapped
const SPAWN_MIN_MS = 9000;       // gap between hearts...
const SPAWN_MAX_MS = 18000;      // ...randomised in this window
const SERVER_COOLDOWN_MS = 2500; // matches claim_tip_bonus MIN_INTERVAL

interface Heart {
  outer: HTMLDivElement;
  guestId: string;
  bornMs: number;
  gx: number;
  gz: number;
  floor: number;
}

export class TipHearts {
  private readonly host: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLElement;
  private readonly tmp = new THREE.Vector3();
  private heart: Heart | null = null;
  private nextSpawnMs = 0;
  private lastTapMs = 0;

  /** Wired by Engine so a heart never floats over a guest on a hidden storey. */
  getFocusedFloor: () => number | undefined = () => undefined;
  getStoreyHeight: () => number = () => 3;
  /** Fired on tap. (gx, gz) = guest world X/Z, floor = their storey. Engine
   * calls the server reducer + pops the "+$5". */
  onTap?: (gx: number, gz: number, floor: number) => void;

  constructor(host: HTMLElement, camera: THREE.Camera, canvas: HTMLElement) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
  }

  /** Per-frame: reposition/retire the active heart, and occasionally spawn a
   * new one over a happy guest. `statuses` = GuestSpawner.snapshotStatus(). */
  update(statuses: GuestStatusEntry[]): void {
    const now = performance.now();
    if (this.nextSpawnMs === 0) this.nextSpawnMs = now + this.randomGap();

    // Keep the active heart glued to its guest, or retire it.
    if (this.heart) {
      const g = statuses.find((s) => s.id === this.heart!.guestId && s.eating && !s.panic);
      if (!g || now - this.heart.bornMs > LIFETIME_MS) {
        this.remove();
      } else {
        this.position(this.heart, g);
      }
    }

    // Spawn a new one on a random happy guest, spaced out + past the server cd.
    if (!this.heart && now >= this.nextSpawnMs && now - this.lastTapMs >= SERVER_COOLDOWN_MS) {
      const happy = statuses.filter((s) => s.eating && !s.panic);
      if (happy.length > 0) {
        this.spawn(happy[Math.floor(Math.random() * happy.length)], now);
      }
      this.nextSpawnMs = now + this.randomGap();
    }
  }

  private randomGap(): number {
    return SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
  }

  private spawn(g: GuestStatusEntry, now: number): void {
    const outer = document.createElement("div");
    Object.assign(outer.style, {
      position: "absolute", left: "0", top: "0", width: `${HEART_W}px`, height: `${HEART_H}px`,
      display: "none", alignItems: "center", justifyContent: "center",
      cursor: "pointer", pointerEvents: "auto", zIndex: "6",
    } as Partial<CSSStyleDeclaration>);
    const inner = document.createElement("span");
    inner.textContent = "💛";
    Object.assign(inner.style, {
      fontSize: "24px", lineHeight: "1", userSelect: "none",
      filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
    } as Partial<CSSStyleDeclaration>);
    // Pulse on the INNER span (scale) so it never fights the outer's positioning
    // transform (translate).
    inner.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }],
      { duration: 900, iterations: Infinity, easing: "ease-in-out" },
    );
    outer.appendChild(inner);
    outer.onclick = (e) => {
      e.stopPropagation();
      if (!this.heart || this.heart.outer !== outer) return;
      this.lastTapMs = performance.now();
      this.onTap?.(this.heart.gx, this.heart.gz, this.heart.floor);
      this.remove();
      this.nextSpawnMs = performance.now() + this.randomGap();
    };
    this.host.appendChild(outer);
    this.heart = { outer, guestId: g.id, bornMs: now, gx: g.character.groundPos.x, gz: g.character.groundPos.y, floor: 0 };
    this.position(this.heart, g);
  }

  private position(h: Heart, g: GuestStatusEntry): void {
    const charY = g.character.root.position.y;
    const storeyH = this.getStoreyHeight();
    const guestFloor = Math.round(charY / storeyH);
    h.gx = g.character.groundPos.x;
    h.gz = g.character.groundPos.y;
    h.floor = guestFloor;
    const focused = this.getFocusedFloor();
    if (focused !== undefined && guestFloor !== focused) { h.outer.style.display = "none"; return; }
    // Project the point above the guest's head (mirror StatusBubbles).
    this.tmp.set(g.character.groundPos.x, charY + 1.7, g.character.groundPos.y);
    this.tmp.project(this.camera);
    if (this.tmp.z > 1) { h.outer.style.display = "none"; return; } // behind camera
    const rect = this.canvas.getBoundingClientRect();
    const x = (this.tmp.x * 0.5 + 0.5) * rect.width;
    const y = (-this.tmp.y * 0.5 + 0.5) * rect.height;
    h.outer.style.display = "flex";
    h.outer.style.transform = `translate(${x - HEART_W / 2}px, ${y - HEART_H}px)`;
  }

  private remove(): void {
    if (!this.heart) return;
    try { this.heart.outer.remove(); } catch { /* already gone */ }
    this.heart = null;
  }
}
