import * as THREE from "three";
import type { IsoCamera } from "../scene/IsoCamera";
import type { WorldScene } from "../scene/WorldScene";

/** Metadata stamped on each city-building shell by
 * WorldScene.populateCityBuildings so a click raycast can identify
 * which plot the player clicked. */
export interface VisitablePlot {
  id: bigint;
  plotX: number;
  plotZ: number;
  ownerHex: string;
  ownerName: string;
}

/** Snapshot of the visited player's save, returned by
 * SpacetimeClient.getPlayerSave — VisitMode reads this to populate
 * the overlay with their day / money / rating / tier. Identity is
 * passed back in by the lookup function. */
export interface VisitedSaveStats {
  dayNumber: number;
  money: number;
  ratingAvg: number;
  luxuryTier: number;
}

/** Per-frame snapshot of camera state we restore on exit. */
interface CameraSnapshot {
  targetX: number;
  targetZ: number;
  targetY: number;
  zoom: number;
  azimuth: number;
}

/**
 * Visitor mode UI + state. Wires three things:
 *
 *  1. A canvas pointerup listener that raycasts against the city
 *     building shells. When a click lands on a shell, a small
 *     floating "Visit [Name]'s Restaurant" popup appears near the
 *     cursor.
 *  2. Clicking the popup enters visit mode — camera snaps to the
 *     visited plot's world position (after the worldRoot shift),
 *     drops zoom to a comfortable "look at this house" range, and
 *     resets azimuth so the visited plot is shown at the standard
 *     iso angle. A top-center "Visiting [name] · Exit" overlay
 *     stays visible until the player exits.
 *  3. Exit returns the camera to its pre-visit pose.
 *
 * Rendering the visited save's actual furniture is a separate
 * future commit (P4 task #66); this class handles the navigation
 * + presentation layer so the player can fly around the city and
 * land on any plot.
 */
export class VisitMode {
  private readonly camera: IsoCamera;
  private readonly scene: WorldScene;
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private snapshot: CameraSnapshot | null = null;
  private activePlot: VisitablePlot | null = null;
  private popup: HTMLDivElement | null = null;
  private overlay: HTMLDivElement | null = null;
  /** Optional hook so Engine can pause its own systems while a visit
   * is active (e.g. suppress build-menu placement, hide bubbles). */
  onEnter?: (plot: VisitablePlot) => void;
  onExit?: () => void;
  /** Engine wires this to SpacetimeClient.getPlayerSave so the
   * overlay can show the visited player's actual stats (day, money,
   * rating, tier) read from their published save. Returns null if
   * the visited player hasn't synced a save yet. */
  fetchVisitedStats?: (ownerHex: string) => VisitedSaveStats | null;

  constructor(container: HTMLElement, canvas: HTMLCanvasElement, camera: IsoCamera, scene: WorldScene) {
    this.container = container;
    this.canvas = canvas;
    this.camera = camera;
    this.scene = scene;
    this.attachClickHandler();
  }

  /** Currently in visit mode? Engine reads this to gate other systems. */
  isVisiting(): boolean {
    return this.activePlot !== null;
  }

  /** The plot the player is currently visiting (null when not). */
  getActivePlot(): VisitablePlot | null {
    return this.activePlot;
  }

  // ─── Click → popup → enter visit ─────────────────────────────────

  private attachClickHandler(): void {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    this.canvas.addEventListener("pointerup", (e) => {
      // Right-click is the camera rotate gesture — never a visit.
      if (e.button !== 0) return;
      // Suppress if the click was actually a drag (camera pan/rotate).
      if (this.camera.wasDragging()) return;
      // While visiting, clicks don't open new popups — player must
      // use Exit Visit button.
      if (this.activePlot) return;
      ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(ndc, this.camera.threeCamera);
      const hits = raycaster.intersectObjects(this.scene.cityBuildings ? this.scene.cityBuildings.children : [], true);
      for (const hit of hits) {
        const plot = this.findPlot(hit.object);
        if (plot) {
          this.showPopup(e.clientX, e.clientY, plot);
          return;
        }
      }
      // Click missed all shells — close any open popup.
      this.hidePopup();
    });
  }

  /** Walk up the parent chain looking for the visitPlot userData
   * stamp put on shell groups by populateCityBuildings. */
  private findPlot(obj: THREE.Object3D | null): VisitablePlot | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const plot = cur.userData?.visitPlot as VisitablePlot | undefined;
      if (plot) return plot;
      cur = cur.parent;
    }
    return null;
  }

  private showPopup(screenX: number, screenY: number, plot: VisitablePlot): void {
    this.hidePopup();
    const popup = document.createElement("div");
    Object.assign(popup.style, {
      position: "fixed",
      left: `${screenX + 10}px`,
      top: `${screenY + 10}px`,
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.45)",
      borderRadius: "8px",
      padding: "8px 12px",
      font: "13px/1.3 system-ui, sans-serif",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.4)",
      cursor: "default",
      zIndex: "20",
      pointerEvents: "auto",
      maxWidth: "240px",
    } as Partial<CSSStyleDeclaration>);
    const nameLine = document.createElement("div");
    nameLine.style.marginBottom = "6px";
    nameLine.style.fontWeight = "700";
    nameLine.textContent = plot.ownerName
      ? `${plot.ownerName}'s plot`
      : "Unclaimed plot";
    popup.appendChild(nameLine);
    if (plot.ownerName) {
      const btn = document.createElement("button");
      btn.textContent = `🏃 Visit Restaurant`;
      Object.assign(btn.style, {
        background: "rgba(220, 180, 130, 0.30)",
        color: "#fff5dc",
        border: "1px solid rgba(255, 220, 150, 0.55)",
        borderRadius: "6px",
        padding: "5px 10px",
        cursor: "pointer",
        font: "inherit",
        fontWeight: "600",
        width: "100%",
      } as Partial<CSSStyleDeclaration>);
      btn.onclick = () => {
        this.hidePopup();
        this.enter(plot);
      };
      popup.appendChild(btn);
    } else {
      const note = document.createElement("div");
      note.textContent = "No one's here yet.";
      note.style.opacity = "0.65";
      note.style.fontSize = "11px";
      popup.appendChild(note);
    }
    this.container.appendChild(popup);
    this.popup = popup;
  }

  private hidePopup(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }

  // ─── Enter / exit visit ──────────────────────────────────────────

  enter(plot: VisitablePlot): void {
    if (this.activePlot) return;
    const t = this.camera.getTargetXZ();
    this.snapshot = {
      targetX: t.x,
      targetZ: t.z,
      targetY: this.camera.getTargetY(),
      zoom: this.camera.getZoom(),
      azimuth: this.camera.getAzimuth(),
    };
    this.activePlot = plot;
    // Snap camera to the visited plot. The plot's world coordinates
    // (after the player's own worldRoot offset) tell us where the
    // shell visually sits in the player's view.
    const worldX = plot.plotX + this.scene.worldRoot.position.x;
    const worldZ = plot.plotZ + this.scene.worldRoot.position.z;
    this.camera.setTargetXZ(worldX, worldZ);
    this.camera.setZoom(18);
    // Reset to default iso azimuth so plots are always viewed from
    // the same angle — easier to compare layouts.
    this.camera.setAzimuth(Math.PI / 4);
    this.showOverlay(plot);
    this.onEnter?.(plot);
  }

  exit(): void {
    if (!this.activePlot || !this.snapshot) return;
    const s = this.snapshot;
    this.camera.setTargetXZ(s.targetX, s.targetZ);
    this.camera.setZoom(s.zoom);
    this.camera.setAzimuth(s.azimuth);
    this.snapshot = null;
    this.activePlot = null;
    this.hideOverlay();
    this.onExit?.();
  }

  // ─── Top-center "Visiting X · Exit" overlay ─────────────────────

  private showOverlay(plot: VisitablePlot): void {
    this.hideOverlay();
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "fixed",
      top: "70px", // below the camera-controls + floor-selector row
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(20, 14, 10, 0.92)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 220, 150, 0.55)",
      borderRadius: "10px",
      padding: "8px 14px",
      font: "14px/1.3 system-ui, sans-serif",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      boxShadow: "0 4px 18px rgba(0, 0, 0, 0.45)",
      zIndex: "15",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    const label = document.createElement("span");
    label.innerHTML = `🏃 Visiting <b>${escapeHtml(plot.ownerName)}'s</b> restaurant`;
    wrap.appendChild(label);
    // Read published save stats from the cloud, if Engine wired the
    // fetcher. Shows "Day 12 · $4,820 · 4.3⭐ · Tier 3" so the player
    // can see what state the visited restaurant is in even before the
    // full interior render (P4.3, future).
    const stats = this.fetchVisitedStats?.(plot.ownerHex) ?? null;
    if (stats) {
      const statsLine = document.createElement("span");
      Object.assign(statsLine.style, {
        fontSize: "12px",
        opacity: "0.85",
        borderLeft: "1px solid rgba(255, 220, 150, 0.3)",
        paddingLeft: "10px",
      } as Partial<CSSStyleDeclaration>);
      const money = `$${stats.money.toLocaleString("en-US")}`;
      const rating = stats.ratingAvg.toFixed(1);
      statsLine.textContent = `Day ${stats.dayNumber} · ${money} · ${rating}⭐ · Tier ${stats.luxuryTier}`;
      wrap.appendChild(statsLine);
    } else {
      const note = document.createElement("span");
      Object.assign(note.style, {
        fontSize: "12px",
        opacity: "0.55",
        fontStyle: "italic",
      } as Partial<CSSStyleDeclaration>);
      note.textContent = "(save not synced yet)";
      wrap.appendChild(note);
    }
    const exit = document.createElement("button");
    exit.textContent = "Exit Visit";
    Object.assign(exit.style, {
      background: "rgba(200, 100, 100, 0.30)",
      color: "#fff5dc",
      border: "1px solid rgba(255, 180, 180, 0.55)",
      borderRadius: "6px",
      padding: "4px 12px",
      cursor: "pointer",
      font: "inherit",
      fontWeight: "600",
    } as Partial<CSSStyleDeclaration>);
    exit.onclick = () => this.exit();
    wrap.appendChild(exit);
    this.container.appendChild(wrap);
    this.overlay = wrap;
  }

  private hideOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
