/**
 * Patch B — generic projected tap-badge layer. Small clickable emoji chips
 * anchored to world positions (TipHearts' projection), used for the three
 * hands-on service taps:
 *   👋 greet a seated guest   🧽 bus a dirty table   🍳 stir a cooking pot
 * and, since the guest wishes, ⚡ hurry / 🎂 birthday (per-target icon,
 * a countdown under the badge, and a "promise is running" badge that
 * shows but cannot be tapped).
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
  /** Optional, per target — the wish layer uses these; the other layers
   * leave them out and get the instance's icon/title. */
  icon?: string;
  title?: string;
  /** Small text under the badge (seconds left). Updated in place. */
  caption?: string;
  /** Shown but not tappable: clicks pass through to the scene. */
  passive?: boolean;
  /** Shift on screen, in pixels, so two badges over one head don't cover
   * each other (a guest can have 👋 and a wish at the same time). */
  offsetX?: number;
}

const BADGE_SIZE = 30;

export class TapBadges {
  private readonly host: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly canvas: HTMLElement;
  private readonly icon: string;
  private readonly title: string;
  private readonly onTap: (key: string) => void;
  private readonly accent: string | undefined;
  private readonly tmp = new THREE.Vector3();
  private readonly nodes = new Map<string, HTMLButtonElement>();
  /** Keys tapped this session — hidden immediately, no waiting on sync. */
  private readonly tapped = new Set<string>();
  getFocusedFloor: () => number | undefined = () => undefined;

  constructor(
    host: HTMLElement,
    camera: THREE.Camera,
    canvas: HTMLElement,
    opts: {
      icon: string; title: string; onTap: (key: string) => void;
      /** Border + glow colour for a layer that should stand out. */
      accent?: string;
    },
  ) {
    this.host = host;
    this.camera = camera;
    this.canvas = canvas;
    this.icon = opts.icon;
    this.title = opts.title;
    this.onTap = opts.onTap;
    this.accent = opts.accent;
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
      this.dress(el, t);
      if (focused !== undefined && t.floor !== focused) { el.style.display = "none"; continue; }
      this.tmp.set(t.x, t.y, t.z);
      this.tmp.project(this.camera);
      if (this.tmp.z > 1) { el.style.display = "none"; continue; } // behind camera
      const x = rect.left + (this.tmp.x * 0.5 + 0.5) * rect.width;
      const y = rect.top + (-this.tmp.y * 0.5 + 0.5) * rect.height;
      el.style.display = "flex";
      el.style.transform = `translate(${x - BADGE_SIZE / 2 + (t.offsetX ?? 0)}px, ${y - BADGE_SIZE}px)`;
    }
    // Drop badges whose targets vanished (guest left, pile bussed, dish done).
    for (const [key, el] of this.nodes) {
      if (!live.has(key)) {
        el.remove();
        this.nodes.delete(key);
      }
    }
  }

  /** Per-target icon / title / countdown / tappable. Writes to the DOM
   * only when a value CHANGED (this runs every frame; the button itself
   * is never rebuilt, so a tap in progress is not lost). */
  private dress(el: HTMLButtonElement, t: BadgeTarget): void {
    const icon = t.icon ?? this.icon;
    const iconEl = el.firstElementChild as HTMLElement;
    if (iconEl.textContent !== icon) iconEl.textContent = icon;
    const title = t.title ?? this.title;
    if (el.title !== title) el.title = title;
    const caption = t.caption ?? "";
    let capEl = el.children[1] as HTMLElement | undefined;
    if (caption && !capEl) {
      capEl = document.createElement("span");
      Object.assign(capEl.style, {
        position: "absolute",
        left: "50%",
        top: `${BADGE_SIZE - 3}px`,
        transform: "translateX(-50%)",
        padding: "1px 5px",
        font: "700 11px/1.2 system-ui, sans-serif",
        color: "#fff5dc",
        background: "rgba(20, 14, 10, 0.85)",
        borderRadius: "7px",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      } as Partial<CSSStyleDeclaration>);
      el.appendChild(capEl);
    }
    if (capEl && capEl.textContent !== caption) {
      capEl.textContent = caption;
      capEl.style.display = caption ? "block" : "none";
    }
    const passive = t.passive === true;
    if ((el.dataset.passive === "1") !== passive) {
      el.dataset.passive = passive ? "1" : "";
      el.style.pointerEvents = passive ? "none" : "auto";
      el.style.cursor = passive ? "default" : "pointer";
      // A running promise reads as "armed", not as "tap me".
      el.style.background = passive ? "rgba(36, 60, 96, 0.9)" : "rgba(20, 14, 10, 0.85)";
    }
  }

  private spawn(key: string): HTMLButtonElement {
    const el = document.createElement("button");
    const iconEl = document.createElement("span");
    iconEl.textContent = this.icon;
    iconEl.style.pointerEvents = "none";
    el.appendChild(iconEl);
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
      border: this.accent ? `2px solid ${this.accent}` : "1px solid rgba(255, 220, 150, 0.65)",
      borderRadius: "50%",
      boxShadow: this.accent
        ? `0 0 10px ${this.accent}, 0 2px 8px rgba(0, 0, 0, 0.45)`
        : "0 2px 8px rgba(0, 0, 0, 0.45)",
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
