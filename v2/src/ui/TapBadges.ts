/**
 * Patch B — generic projected tap-badge layer. Small clickable emoji chips
 * anchored to world positions (TipHearts' projection), used for the three
 * hands-on service taps:
 *   👋 greet a seated guest   🧽 bus a dirty table   🍳 stir a cooking pot
 *
 * The Engine feeds each instance a target list per frame (cheap providers);
 * this class pools DOM nodes, projects, floor-gates, and fires onTap(key).
 * Every tap's EFFECT is a server reducer — a badge is just an invitation.
 */

import * as THREE from "three";

export interface BadgeTarget {
  /** Stable key (guest id / seat uid / ticket id as string). */
  key: string;
  /** World-space anchor (x, y incl. storey offset, z). */
  x: number;
  y: number;
  z: number;
  /** Storey the target sits on (for the focused-floor gate). */
  floor: number;
}

const BADGE_SIZE = 30;

export class TapBadges {
  private readonly host: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLElement;
  private readonly icon: string;
  private readonly title: string;
  private readonly onTap: (key: string) => void;
  private readonly tmp = new THREE.Vector3();
  private readonly nodes = new Map<string, HTMLButtonElement>();
  /** Keys tapped this session — hidden immediately, no waiting on sync. */
  private readonly tapped = new Set<string>();
  getFocusedFloor: () => number | undefined = () => undefined;

  constructor(
    host: HTMLElement,
    camera: THREE.Camera,
    canvas: HTMLElement,
    opts: { icon: string; title: string; onTap: (key: string) => void },
  ) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
    this.icon = opts.icon;
    this.title = opts.title;
    this.onTap = opts.onTap;
  }

  /** Reconcile + reproject. Call per frame with the current target list
   * (pass [] while visiting another restaurant to hide everything). */
  update(targets: BadgeTarget[]): void {
    const live = new Set<string>();
    const focused = this.getFocusedFloor();
    const rect = this.canvas.getBoundingClientRect();
    for (const t of targets) {
      if (this.tapped.has(t.key)) continue;
      live.add(t.key);
      let el = this.nodes.get(t.key);
      if (!el) {
        el = this.spawn(t.key);
        this.nodes.set(t.key, el);
      }
      if (focused !== undefined && t.floor !== focused) { el.style.display = "none"; continue; }
      this.tmp.set(t.x, t.y, t.z);
      this.tmp.project(this.camera);
      if (this.tmp.z > 1) { el.style.display = "none"; continue; } // behind camera
      const x = rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height;
      el.style.display = "flex";
      el.style.transform = `translate(${x - BADGE_SIZE / 2}px, ${y - BADGE_SIZE}px)`;
    }
    // Drop badges whose targets vanished (guest left, pile bussed, dish done).
    for (const [key, el] of this.nodes) {
      if (!live.has(key)) {
        el.remove();
        this.nodes.delete(key);
      }
    }
  }

  private spawn(key: string): HTMLButtonElement {
    const el = document.createElement("button");
    el.textContent = this.icon;
    el.title = this.title;
    Object.assign(el.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${BADGE_SIZE}px`,
      height: `${BADGE_SIZE}px`,
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "0",
      fontSize: "17px",
      lineHeight: "1",
      background: "rgba(20, 14, 10, 0.85)",
      border: "1px solid rgba(255, 220, 150, 0.65)",
      borderRadius: "50%",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.45)",
      cursor: "pointer",
      zIndex: "7", // above bubbles (6), below panels
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    el.onclick = (e) => {
      e.stopPropagation();
      this.tapped.add(key);
      el.remove();
      this.nodes.delete(key);
      this.onTap(key);
    };
    this.host.appendChild(el);
    return el;
  }
}
