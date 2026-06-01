import * as THREE from "three";
import { mergeGeometries as mergeBufferGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CharacterLoader } from "../assets/CharacterLoader";
import { ModelLoader } from "../assets/ModelLoader";
import { getFurnitureDef } from "../data/furnitureCatalog";
import { CharacterAnimator, type AnimatedCharacter, type CharacterAction } from "./CharacterAnimator";
import { fitFurniture, snapToAdjacentWall } from "../assets/fitFurniture";
import { WeatherEffects, type WeatherKind } from "./WeatherEffects";

/** Plaque visual catalogs — each id is a small string the modal exposes
 * as a radio button. Picked to read as warm cosy bistro defaults but
 * give the player enough variety for a personal vibe. Exported for the
 * RestaurantSignModal so it can render matching swatches. */
export const FONT_FAMILIES: Record<string, string> = {
  serif:   `'Georgia', 'Times New Roman', serif`,
  sans:    `'Helvetica Neue', 'Arial', sans-serif`,
  script:  `'Brush Script MT', 'Lucida Handwriting', cursive`,
  display: `'Impact', 'Arial Black', sans-serif`,
};
export const FONT_LABELS: Record<string, string> = {
  serif:   "Classic Serif",
  sans:    "Modern Sans",
  script:  "Handwritten",
  display: "Bold Display",
};
/** Hex strings for canvas2d. */
export const TEXT_COLORS: Record<string, string> = {
  cream:    "#fff5dc",
  gold:     "#f5c14a",
  white:    "#ffffff",
  red:      "#e85a5a",
  mint:     "#a8e2c0",
  lavender: "#d2c5ec",
};
export const PLAQUE_BG: Record<string, string> = {
  dark:  "#1d1813",
  wood:  "#5a3a22",
  slate: "#384047",
  brass: "#3a2e1a",
};
/** Frame mesh colour as a 0xRRGGBB integer — pairs visually with the
 * matching plaque-background id. */
export const PLAQUE_FRAME: Record<string, number> = {
  dark:  0x2a1f17,
  wood:  0x3a2410,
  slate: 0x232a32,
  brass: 0xc8a050,
};
export const PLAQUE_LABELS: Record<string, string> = {
  dark:  "Dark Wood",
  wood:  "Walnut",
  slate: "Slate Blue",
  brass: "Brass Trim",
};

/** Linearly interpolate between two RGB integers by t in [0,1]. */
/** Tiny pseudo-RNG used for stable procedural city layout — same
 * seed → same town across reloads. Algorithm: mulberry32 (one of
 * the smallest decent 32-bit PRNGs). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixColors(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * The 3D world. A minimal demo restaurant: floor, walls, and a few pieces
 * of Kenney furniture placed at fixed positions so we can verify the GLTF
 * loader and confirm the overall scene reads as "restaurant".
 *
 * Phase 3+ will replace the hard-coded placements with a proper
 * grid-driven building system that mirrors the 2D game.
 */
/** Perimeter wall direction — picks which axis the wall runs along
 * (front / back are X-axis at z=±5.5; left / right are Z-axis at
 * x=±5.5 / -4.5) and which face of the box geometry is the outdoor
 * face when building the multi-material array. */
type WallDir = "front" | "back" | "left" | "right";

/** Live state for one perimeter wall. Walls are rebuilt as a stack of
 * segment + lintel + sill meshes around each door (full-height cut)
 * and window (sill + lintel partial cut). currentMat tracks whether
 * the wall is currently rendered solid (interior+exterior multi-mat)
 * or as the ghost see-through, so the camera-driven swap doesn't
 * thrash. */
interface PerimeterWallState {
  meshes: THREE.Mesh[];
  currentMat: "solid" | "ghost";
  doors: number[];
  windows: number[];
  /** World-space Y offset added to every wall segment's centre Y.
   * 0 for the ground floor (Y=1.5 centre, 0..3 bounds). For storey
   * idx≥1 this is idx * STOREY_HEIGHT, so floor 1 walls sit at Y=3..6
   * centred at 4.5 and the same window-cut maths still works. */
  yOffset?: number;
  /** Object3D each wall segment is parented to. Ground floor goes
   * straight into the scene; upper floors go into their storey group
   * so visibility + theming track the focused floor. */
  parent?: THREE.Object3D;
  /** The MeshStandardMaterial for solid segments on this floor.
   * Ground floor uses the shared wallMat; upper storeys use the
   * per-storey clone so DecorModal can theme each floor. */
  wallMatRef?: THREE.MeshStandardMaterial;
}

export class WorldScene {
  readonly threeScene = new THREE.Scene();
  readonly loader = new ModelLoader();
  readonly characterLoader = new CharacterLoader(this.loader);
  readonly animator = new CharacterAnimator();
  /** Exposed for StaffRouter to drive their state machines. Populated
   * asynchronously during populateCharacters — may be undefined for the
   * first frame or two while GLBs load. */
  chefChar?: AnimatedCharacter;
  waiterChar?: AnimatedCharacter;
  errandChar?: AnimatedCharacter;
  /** Per-station visual effects, keyed by furniture uid. Every cook
   * station gets a small group pinned to the top of its model;
   * Engine.update reconciles the map each frame via syncStationEffects,
   * then setActiveStations(uids) flips the per-station visibility based
   * on which chefs are actively working there. Each variant has its own
   * mesh / light layout and animation in update(dt):
   *  - gas stove   → orange flame + flicker
   *  - electric    → blue induction glow + flicker
   *  - toaster     → red coil glow on top, pulses while in use
   *  - coffee      → 3 white steam puffs rising in sequence
   *  - blender     → small wobble of the model's top accessory
   *  - microwave   → soft yellow inside-light glow (currently unused —
   *                  no recipe gates on microwave yet) */
  private stationEffects = new Map<string, {
    group: THREE.Group;
    variant: "gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave" | "hood";
    flameMesh?: THREE.Mesh;
    flameLight?: THREE.PointLight;
    // Steam puffs for coffee: each has a phase offset so they rise in
    // sequence rather than as a single blob.
    steamPuffs?: { mesh: THREE.Mesh; phase: number }[];
    // Wobble accessory for blender: a small disc that rotates + pulses.
    wobbleMesh?: THREE.Mesh;
  }>();
  private stationEffectPhase = 0;
  /** The hinged door panel (sub-object of the procedural front-door
   * group, exposed via userData.panel). Rotating this swings the door
   * around its hinge while the frame stays put. */
  private doorPanel?: THREE.Object3D;
  /** Door open amount [0,1] — lerps toward doorOpenTarget every frame. */
  private doorOpenAmount = 0;
  private doorOpenTarget = 0;
  /** World position of the stove and the plate-pickup spot. Used by the
   * StaffRouter to send chef/waiter to the right places. The chef stands
   * here (z=-3, one tile in front of the stove furniture) to "cook". */
  readonly stovePos = new THREE.Vector2(0, -3.0);
  readonly pickupPos = new THREE.Vector2(0.5, -2.8);
  /** The actual stove furniture's world position (z=-4, back wall). Used
   * to position the cooking flame ON the stove, not in front of where
   * the chef stands. */
  readonly stoveFurniturePos = new THREE.Vector2(0, -4);
  /** Where the errand helper drops off groceries when they return —
   * a small supply counter at the back-left of the room (see
   * buildSupplyCounter in addBuilding). */
  readonly supplyCounterPos = new THREE.Vector2(-3, -3.2);
  /** Front door world spot. Used both for the "anyone near door" check
   * (which swings the door open) and as the errand helper's entry/exit
   * waypoint — they walk through here on their way to the pavement
   * and again on the way back. */
  readonly doorPos = new THREE.Vector2(0, 5);
  /** Resolves once the staff characters are loaded — so Engine can build
   * the StaffRouter at the right moment. Created synchronously in the
   * constructor so any code that grabs the reference right after
   * `new WorldScene()` waits for the REAL load, not an already-resolved
   * sentinel. (We hit this exact bug — Engine's `.then(...)` was firing
   * on the resolved placeholder before chefChar/waiterChar even existed,
   * leaving the stub router active forever.) */
  staffReady!: Promise<void>;
  private resolveStaffReady!: () => void;
  /** Resolves once the demo restaurant furniture is in the scene — so
   * Engine can register every demo piece in the FurnitureRegistry and
   * therefore make them moveable / sellable like player-placed items.
   * Same constructor-init pattern as staffReady — see above. */
  demoReady!: Promise<void>;
  private resolveDemoReady!: () => void;
  /** Snapshot of the demo placements (id + cell + rotation + model)
   * filled in by populateDemoRestaurant. */
  readonly demoPlacements: { defId: string; x: number; z: number; rotY: number; model: THREE.Object3D }[] = [];

  /** Holds the placeholder shells for OTHER players' buildings on
   * the shared city map. Player's own restaurant continues to
   * render at world origin via the legacy code path; this group
   * adds visual markers for every other claimed/unclaimed plot
   * so the player sees the city around them. P2.4 stops here;
   * full per-other-player restaurant interiors come later. */
  cityBuildings = new THREE.Group();
  /** Parent group for all SHARED city content (grass, avenues,
   * scenery houses, other plots' shells, pedestrians). The player's
   * own restaurant + characters stay at the threeScene root in their
   * legacy origin-centred coordinates. setOwnedPlotOffset(x, z)
   * positions this group at (-x, 0, -z) so the player's plot lines
   * up with the local-origin restaurant — visually, the player IS
   * standing on the plot they claimed, with everyone else arrayed
   * around them at their absolute world coordinates. */
  worldRoot = new THREE.Group();
  /** Camera anchor for the player's own plot — used by IsoCamera
   * to point at the correct spot when the legacy hardcoded (0,0)
   * doesn't match the claimed building's coordinates. */
  ownedPlotAnchor: THREE.Vector2 = new THREE.Vector2(0, 0);

  constructor() {
    // Create the staff/demo "ready" promises SYNCHRONOUSLY here, before
    // any other code can grab a reference. The async populate functions
    // resolve them when their work is done. We used to lazily assign new
    // promises inside the async functions, which left any synchronous
    // consumer holding a permanently-resolved `Promise.resolve()` sentinel
    // — Engine then fired its staffReady.then(...) immediately, found no
    // chefChar/waiterChar yet, and pinned itself to the stub router.
    this.staffReady = new Promise((r) => { this.resolveStaffReady = r; });
    this.demoReady = new Promise((r) => { this.resolveDemoReady = r; });

    // Fog pushed out from 30..80 → 100..250 so the expanded city
    // doesn't disappear into the haze 80m from the camera. At the
    // current iso zoom the player can see ~150m around them; the
    // city ends at ±140 so the fog now starts beyond the buildings
    // and only kicks in for the void past the terrain edge.
    this.threeScene.fog = new THREE.Fog(0xd8c4a3, 100, 250);
    this.addLighting();
    // World root: shared city geometry parented here so a single
    // position assignment can shift the whole map relative to the
    // restaurant's local-origin coordinate system.
    this.threeScene.add(this.worldRoot);
    this.weatherEffects = new WeatherEffects(this.threeScene);
    this.addBuilding();
    // City buildings (other players' plots) live in their own group so
    // they can be re-populated when SpacetimeClient pushes updates
    // without disturbing the player's own restaurant. Parented to
    // worldRoot so they shift with the rest of the shared city.
    this.worldRoot.add(this.cityBuildings);
    // Per-station effects (flames, toaster glow, coffee steam, etc.)
    // are created lazily by syncStationEffects() once each station
    // is placed — no global state to set up here.
    void this.populateDemoRestaurant();
  }

  update(dt: number): void {
    this.animator.update(dt);
    // Per-station effect animation — dispatched by variant so a stove
    // flickers, a coffee machine puffs steam, a blender wobbles, etc.
    // Single phase drives them all so kitchen visuals feel synchronized.
    if (this.stationEffects.size > 0) {
      this.stationEffectPhase += dt;
      const flick = 0.85 + Math.sin(this.stationEffectPhase * 22) * 0.1 + Math.random() * 0.1;
      const flameLightInt = 1.6 + Math.sin(this.stationEffectPhase * 18) * 0.3;
      for (const e of this.stationEffects.values()) {
        if (!e.group.visible) continue;
        switch (e.variant) {
          case "gas":
          case "electric": {
            if (e.flameMesh) e.flameMesh.scale.setScalar(flick);
            if (e.flameLight) e.flameLight.intensity = flameLightInt;
            break;
          }
          case "toaster": {
            // Pulse the coil glow — slow breathing on top of the burner
            // colour so it reads as "heating" rather than just "on".
            if (e.flameMesh) {
              const mat = e.flameMesh.material as THREE.MeshStandardMaterial;
              if (mat && "emissiveIntensity" in mat) {
                mat.emissiveIntensity = 1.6 + Math.sin(this.stationEffectPhase * 7) * 0.6;
              }
            }
            if (e.flameLight) {
              e.flameLight.intensity = 0.6 + Math.sin(this.stationEffectPhase * 7) * 0.3;
            }
            break;
          }
          case "coffee": {
            // Steam puffs rise + fade + reset. Each puff has its own
            // phase offset so they leave the spout in sequence.
            if (e.steamPuffs) {
              for (const puff of e.steamPuffs) {
                puff.phase += dt * 0.8;
                if (puff.phase > 1) puff.phase -= 1;
                const p = puff.phase;
                puff.mesh.position.y = 0.1 + p * 0.45;
                puff.mesh.scale.setScalar(0.6 + p * 0.9);
                const mat = puff.mesh.material as THREE.MeshStandardMaterial;
                if (mat && "opacity" in mat) {
                  mat.opacity = Math.max(0, 0.55 * (1 - p));
                }
              }
            }
            break;
          }
          case "blender": {
            // Spin the accessory disc + a slight Y-bounce so the
            // model reads as actively blending.
            if (e.wobbleMesh) {
              e.wobbleMesh.rotation.y = this.stationEffectPhase * 14;
              e.wobbleMesh.position.y = 0.08 + Math.sin(this.stationEffectPhase * 24) * 0.015;
            }
            break;
          }
          case "microwave": {
            // Soft inside-light pulse — currently no recipe gates on
            // microwave but the effect is here so the system is
            // complete and players who pre-emptively buy one see it
            // light up if a chef ever uses it.
            if (e.flameLight) {
              e.flameLight.intensity = 0.5 + Math.sin(this.stationEffectPhase * 3) * 0.2;
            }
            break;
          }
        }
      }
    }
    // Lerp door open amount toward target and apply rotation to the
    // hinged panel only (the frame stays put).
    if (this.doorPanel) {
      const lerpSpeed = 3.0; // ~0.3s open/close
      const diff = this.doorOpenTarget - this.doorOpenAmount;
      const step = Math.sign(diff) * Math.min(Math.abs(diff), lerpSpeed * dt);
      this.doorOpenAmount += step;
      // Panel hinge swings -90° (opens inward). Negative because the hinge
      // is at the left edge and we want the right edge to swing into the room.
      this.doorPanel.rotation.y = -this.doorOpenAmount * Math.PI / 2;
    }
  }

  /** Tell the front door to open (true) or close (false). Engine calls
   * this every frame based on whether any character is near the door. */
  setDoorOpen(open: boolean): void {
    this.doorOpenTarget = open ? 1 : 0;
  }

  /** Re-capture the door panel reference from a freshly-loaded door
   * model. Needed when a save is restored: the demo's door (and its
   * panel) is removed from the scene, and the save's restored door
   * comes in without going through populateDemoRestaurant — so without
   * this call, setDoorOpen mutates an orphaned mesh and the door looks
   * stuck shut. */
  /** Per-doorway state for the placed `int-doorway` items — each one
   * is animated independently based on whether any character is
   * standing close to it. The panel ref is captured lazily from the
   * model's userData (same convention as the front door). */
  private internalDoorState = new Map<string, { panel: THREE.Object3D; openAmount: number }>();

  /** Reconcile the placed-interior-doorway list and animate each
   * panel toward the requested open / closed state. Engine calls
   * this once per frame after walking the registry — we don't poll
   * the registry from inside the scene because Engine already has a
   * cheap proximity test against guests + staff. */
  updateInternalDoors(doors: readonly { uid: string; model: THREE.Object3D; open: boolean }[], dt: number): void {
    const live = new Set<string>();
    for (const d of doors) {
      live.add(d.uid);
      let entry = this.internalDoorState.get(d.uid);
      if (!entry) {
        const panel = (d.model.userData as { panel?: THREE.Object3D }).panel;
        if (!panel) continue;
        entry = { panel, openAmount: 0 };
        this.internalDoorState.set(d.uid, entry);
      }
      const target = d.open ? 1 : 0;
      // Lerp toward the target. 6/sec means the door is open in ~0.17s
      // — feels snappy enough that the guest doesn't visibly clip it.
      const speed = 6;
      entry.openAmount += (target - entry.openAmount) * Math.min(1, dt * speed);
      entry.panel.rotation.y = -entry.openAmount * Math.PI / 2;
    }
    for (const uid of [...this.internalDoorState.keys()]) {
      if (!live.has(uid)) this.internalDoorState.delete(uid);
    }
  }

  attachDoorPanel(model: THREE.Object3D): void {
    const panel = model.userData?.panel as THREE.Object3D | undefined;
    if (panel) {
      this.doorPanel = panel;
      // Reset open state so the new panel doesn't snap to whatever
      // angle the previous one was at.
      this.doorOpenAmount = 0;
      this.doorOpenTarget = 0;
      panel.rotation.y = 0;
    }
  }

  /** Reconcile the per-station effect map with the registry's current
   * cook-station list. Engine calls this each frame; it builds the
   * right variant effect for every newly-placed station and removes
   * effects for stations that have been sold or moved. */
  syncStationEffects(stations: readonly { uid: string; defId: string; model: THREE.Object3D }[]): void {
    const live = new Set(stations.map((s) => s.uid));
    for (const uid of [...this.stationEffects.keys()]) {
      if (!live.has(uid)) {
        const f = this.stationEffects.get(uid)!;
        this.threeScene.remove(f.group);
        this.stationEffects.delete(uid);
      }
    }
    for (const s of stations) {
      if (this.stationEffects.has(s.uid)) {
        // Already have an effect for this station — but the model
        // might have been moved (move-mode) or its host repositioned
        // (surface placement). Refresh the world anchor.
        this.alignEffectToModel(this.stationEffects.get(s.uid)!.group, s.model);
        continue;
      }
      const effect = this.buildStationEffect(s.defId);
      if (!effect) continue;
      this.alignEffectToModel(effect.group, s.model);
      this.threeScene.add(effect.group);
      this.stationEffects.set(s.uid, effect);
    }
  }

  /** Flip per-station effect visibility. `uids` is the set of stations
   * with a chef ACTIVELY cooking (router.getCookingStoveUids()).
   * Stations outside the set go dark / idle. */
  setActiveStations(uids: ReadonlySet<string>): void {
    for (const [uid, f] of this.stationEffects) {
      f.group.visible = uids.has(uid);
    }
  }

  /** True if at least one station effect is currently visible — i.e.
   * a chef is cooking somewhere right now. Engine uses this to drive
   * the kitchen sizzle SFX loop. */
  isAnyStationActive(): boolean {
    for (const f of this.stationEffects.values()) if (f.group.visible) return true;
    return false;
  }

  /** The set of station variants currently active (visible flame /
   * glow / steam / wobble). Engine reads this each tick and toggles
   * the per-variant SFX loops (gas vs electric stove vs coffee vs
   * blender etc.) so the player hears whichever appliances are in
   * use, not a single generic "cooking" hiss. */
  getActiveStationVariants(): Set<"gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave" | "hood"> {
    const out = new Set<"gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave" | "hood">();
    for (const f of this.stationEffects.values()) {
      if (f.group.visible) out.add(f.variant);
    }
    return out;
  }

  /** Build the per-variant effect group for a given station defId.
   * Returns undefined for ids without a built-in visual (e.g. counter
   * — the chef just stands there chopping, no glow needed). */
  private buildStationEffect(defId: string): {
    group: THREE.Group;
    variant: "gas" | "electric" | "toaster" | "coffee" | "blender" | "microwave" | "hood";
    flameMesh?: THREE.Mesh;
    flameLight?: THREE.PointLight;
    steamPuffs?: { mesh: THREE.Mesh; phase: number }[];
    wobbleMesh?: THREE.Mesh;
  } | undefined {
    switch (defId) {
      case "stove": return this.buildStoveFlameEffect("gas");
      case "stove-electric": return this.buildStoveFlameEffect("electric");
      case "toaster": return this.buildToasterGlowEffect();
      case "coffee-machine": return this.buildCoffeeSteamEffect();
      case "blender": return this.buildBlenderWobbleEffect();
      case "microwave": return this.buildMicrowaveGlowEffect();
      case "kitchen-hood":
      case "kitchen-hood-l":
        return this.buildHoodLightEffect();
      default: return undefined;
    }
  }

  /** Range hood — a static warm-white downlight that switches on while
   * a chef cooks below. No flicker (user explicitly asked for "a static
   * one"). Engine.update walks the registry each frame, finds active
   * stoves, then turns on any hood that's positioned directly above an
   * active one (same X column, close Z).
   *
   * Uses a SpotLight (not PointLight) so the illumination is contained
   * BELOW the hood's bottom surface — a real range-hood bulb shines
   * down onto the burners, not up into the kitchen ceiling. The cone
   * is angled wide enough to cover the full stove tile underneath. */
  private buildHoodLightEffect() {
    const group = new THREE.Group();
    group.visible = false;
    // alignEffectToModel anchors the group at the model's TOP. We push
    // the spotlight source CLEARLY below the hood mesh — a position
    // overlapping the geometry is fine for a PointLight (it radiates
    // out anyway) but for a SpotLight whose cone direction depends on
    // the source-to-target vector it's safer to put the source in open
    // air. ~0.65 m below the top puts it just under a typical hood,
    // close to where a real range bulb hangs.
    const SRC_Y = -0.65;
    // Source-to-target distance of 1.5 m, cone half-angle ~70° so the
    // light pool fans out wide enough to cover the whole stove tile +
    // a bit of the chef in front of it. Penumbra softens the cone
    // edge so the floor doesn't get a sharp circle.
    const light = new THREE.SpotLight(0xfff0c8, 6.0, 3.0, Math.PI / 2.6, 0.55, 1.4);
    light.position.set(0, SRC_Y, 0);
    // SpotLight aims at light.target.position. Target lives directly
    // below the source so the cone points straight down; we add it to
    // the group so Three.js considers it part of the scene graph
    // (a SpotLight whose target isn't in the scene aims at the origin
    // and behaves erratically when the group itself moves).
    light.target.position.set(0, SRC_Y - 1.5, 0);
    group.add(light);
    group.add(light.target);
    // Small visible bulb so the player can see the source. Sits at
    // the same Y as the spotlight origin, but isn't itself a light —
    // just a self-lit sphere.
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0xfff8e0,
        emissive: 0xfff0c8,
        emissiveIntensity: 1.8,
      }),
    );
    bulb.position.set(0, SRC_Y, 0);
    group.add(bulb);
    // No flameLight reference — hood doesn't flicker, and the stored
    // type is THREE.PointLight (used by stove / toaster animation).
    // The group's visible flag is enough to switch the light on/off.
    return { group, variant: "hood" as const };
  }

  /** Gas / electric stove flame — sphere + point light. Gas reads
   * warm-orange, electric reads cool-blue induction so the player can
   * tell at a glance which appliance is which. */
  private buildStoveFlameEffect(variant: "gas" | "electric") {
    const palette = variant === "electric"
      ? { color: 0x4d8eff, emissive: 0x1d4fc8, light: 0x88aaff }
      : { color: 0xff7a3c, emissive: 0xff5500, light: 0xff8844 };
    const group = new THREE.Group();
    group.visible = false;
    const flameMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 12),
      new THREE.MeshStandardMaterial({
        color: palette.color,
        emissive: palette.emissive,
        emissiveIntensity: 1.8,
        transparent: true,
        opacity: 0.85,
      }),
    );
    group.add(flameMesh);
    const flameLight = new THREE.PointLight(palette.light, 1.2, 2.5, 2);
    flameLight.position.set(0, 0.05, 0);
    group.add(flameLight);
    return { group, variant, flameMesh, flameLight };
  }

  /** Toaster glow — a thin red plane on top of the slot, pulsing as
   * if the coils inside are heating up. Plus a small warm point light
   * so the surrounding counter top picks up the colour. */
  private buildToasterGlowEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const flameMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.08),
      new THREE.MeshStandardMaterial({
        color: 0xff5a30,
        emissive: 0xff3a10,
        emissiveIntensity: 2.0,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    // Lie flat looking up; sits a hair above the toaster's top.
    flameMesh.rotation.x = -Math.PI / 2;
    group.add(flameMesh);
    const flameLight = new THREE.PointLight(0xff8866, 0.7, 1.5, 2);
    flameLight.position.set(0, 0.05, 0);
    group.add(flameLight);
    return { group, variant: "toaster" as const, flameMesh, flameLight };
  }

  /** Coffee steam — three small white spheres that rise + fade in
   * sequence so the spout looks like it's continuously puffing. */
  private buildCoffeeSteamEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const geom = new THREE.SphereGeometry(0.05, 8, 8);
    const steamPuffs: { mesh: THREE.Mesh; phase: number }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.55,
          emissive: 0xf0f0f0,
          emissiveIntensity: 0.4,
        }),
      );
      // Initial vertical offset so puffs aren't stacked.
      mesh.position.set(0, 0.05 + i * 0.12, 0);
      group.add(mesh);
      steamPuffs.push({ mesh, phase: i / 3 });
    }
    return { group, variant: "coffee" as const, steamPuffs };
  }

  /** Blender wobble — a small dark accessory disc on top of the model
   * that spins while in use. */
  private buildBlenderWobbleEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const wobbleMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12),
      new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        emissive: 0x444444,
        emissiveIntensity: 0.3,
      }),
    );
    wobbleMesh.position.set(0, 0.08, 0);
    group.add(wobbleMesh);
    return { group, variant: "blender" as const, wobbleMesh };
  }

  /** Microwave inside-glow — a soft yellow point light just above the
   * model's top surface. Currently no recipe gates on microwave so
   * this rarely fires, but having it ready means the visual lights up
   * the moment we add a microwave recipe later. */
  private buildMicrowaveGlowEffect() {
    const group = new THREE.Group();
    group.visible = false;
    const flameLight = new THREE.PointLight(0xffcc66, 0.5, 1.2, 2);
    flameLight.position.set(0, 0.02, 0);
    group.add(flameLight);
    return { group, variant: "microwave" as const, flameLight };
  }

  /** Pin an effect group to a station model's measured top. Same
   * bounding-box maths as the previous per-stove flame anchoring;
   * works for stoves, toasters, coffee machines, etc. regardless of
   * how tall the model is. */
  private alignEffectToModel(group: THREE.Group, model: THREE.Object3D): void {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const topY = box.max.y + 0.03;
    group.position.set(cx, topY, cz);
  }

  /** Exposed for Engine to drive the day-night cycle each frame. */
  ambientLight!: THREE.AmbientLight;
  sunLight!: THREE.DirectionalLight;
  fillLight!: THREE.DirectionalLight;
  /** Inside-facing sky sphere — fills any pixel where the camera ray
   * exits world geometry (e.g., the bottom of the screen at low
   * elevation where rays escape past the ground). Color tracks the
   * day-night sky in Engine via setSkyColor(). Material is unlit and
   * fog-disabled so the dome reads as a continuous horizon haze
   * rather than a faceted sphere with shading. */
  skyDome!: THREE.Mesh;

  private addLighting(): void {
    this.ambientLight = new THREE.AmbientLight(0xfff1d6, 0.55);
    this.threeScene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffeac2, 1.1);
    this.sunLight.position.set(8, 14, 6);
    this.sunLight.castShadow = true;
    // 1024² (was 2048²) — quarters the per-frame shadow texel count.
    // At iso distance the visible shadow edges are still soft (we use
    // PCFSoftShadowMap which blurs them on top), so the difference
    // is hard to spot in practice. Cuts shadow-pass GPU cost ~3-4×.
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.left = -20;
    this.sunLight.shadow.camera.right = 20;
    this.sunLight.shadow.camera.top = 20;
    this.sunLight.shadow.camera.bottom = -20;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 60;
    this.sunLight.shadow.bias = -0.0005;
    this.threeScene.add(this.sunLight);

    this.fillLight = new THREE.DirectionalLight(0xb8c8e0, 0.25);
    this.fillLight.position.set(-6, 10, -4);
    this.threeScene.add(this.fillLight);

    // Sky dome — sphere radius 600 (well inside the camera's far
    // plane of 1000) with BackSide material so the camera sees its
    // inner surface, depthWrite false so it never occludes scene
    // geometry. MeshBasicMaterial is unlit + fog-disabled → renders
    // as a uniform colour matching the renderer's clear colour.
    // Engine.tick pins this.skyDome.position to the camera every
    // frame so wherever the player pans, the dome is always centred
    // on them — any ray that escapes the world geometry (e.g., the
    // bottom of the screen at low elevation rays that miss the
    // ground plane) hits the dome's inner surface and renders sky.
    const skyGeom = new THREE.SphereGeometry(600, 24, 12);
    const skyMat = new THREE.MeshBasicMaterial({
      color: 0xd8c4a3,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(skyGeom, skyMat);
    // Render the sky FIRST so other geometry overdraws it correctly.
    this.skyDome.renderOrder = -1000;
    this.threeScene.add(this.skyDome);
  }

  /** Engine calls this every frame as the day-night cycle changes the
   * sky tint. We update the dome material colour so the void matches
   * the fog haze at every time of day. */
  setSkyColor(hex: number): void {
    if (!this.skyDome) return;
    const mat = this.skyDome.material as THREE.MeshBasicMaterial;
    mat.color.setHex(hex);
  }

  // === Placed lamps (lighting items registered via registerLamp) ===
  // Each entry holds the placed model and the warm point-light child
  // we attach to it. updateLamps() walks the list every frame and
  // ramps the intensity with how dark the sky is. Cap is enforced
  // implicitly by the player's furniture budget.
  private placedLamps: { model: THREE.Object3D; light: THREE.PointLight; bulb: THREE.Mesh }[] = [];
  /** Footprints of every procedurally-placed scenery house in the city
   * (populated by addCityScenery). The scatter passes that follow
   * (grass blades, wildflowers, trees, rocks) consult this list via
   * isOnRoadOrBuildingForScatter so nothing spawns inside or on top of
   * a neighbour building. halfSize is the box half-extent on each
   * horizontal axis (scenery houses are square in footprint). */
  private placedSceneryHouses: { x: number; z: number; halfSize: number }[] = [];
  /** Most recently computed nightAmount in [0, 1] — used so a freshly
   * registered lamp picks up the current darkness immediately, not on
   * the next applyDayNight tick. */
  private currentNightAmount = 0;

  // === Street lamps (pavement lamp-posts symmetrically along every avenue) ===
  // ~140 lamp posts. The meshes are InstancedMesh (one draw call per
  // part type) so even at this count the cost is negligible. ACTUAL
  // lighting is a fixed pool of N point lights repositioned each tick
  // to the N closest lamps to the camera — three.js' shader compiles
  // with NUM_POINT_LIGHTS = N, so the pool size determines per-pixel
  // cost regardless of how many lamp POSTS exist on the map.
  /** XZ positions (in worldRoot-local space) of every placed street
   * lamp, in the same order as the InstancedMesh instance indices.
   * Consulted by updateStreetLamps to pick the N closest to camera. */
  private streetLampPositions: { x: number; z: number }[] = [];
  /** The lantern's emissive bulb mesh — one InstancedMesh shared by
   * all lamps. We mutate the SHARED material's emissiveIntensity /
   * opacity each tick to make all bulbs glow at night. */
  private streetLampBulbMat: THREE.MeshStandardMaterial | null = null;
  /** Pool of point lights that follow the camera. Sized small enough
   * to keep the shader cheap; the bulbs themselves give the visual
   * presence of light at distance. */
  private streetLampLightPool: THREE.PointLight[] = [];
  private static readonly STREET_LAMP_POOL_SIZE = 16;
  /** Cached camera position from the last light-pool reposition. Skip
   * the re-sort when the camera hasn't moved enough to change which
   * lamps are closest. */
  private streetLampLastCamX = Number.NEGATIVE_INFINITY;
  private streetLampLastCamZ = Number.NEGATIVE_INFINITY;
  /** Procedural rain / snow / confetti overlay + per-weather lighting
   * modifiers. Engine pushes the current weather id via setWeather and
   * ticks update() every frame so particles follow the camera. */
  private weatherEffects?: WeatherEffects;
  /** Most recent weather id passed from Engine. Default sunny so day 1
   * always renders the warm path even before Engine has wired the
   * weather callback. */
  private currentWeather: WeatherKind = "sunny";

  /** Attach a warm point light + small emissive bulb to a placed lamp
   * model so it actually illuminates the area at night. Returns silently
   * if the same model is already registered.
   *
   * Critical: the bulb + light are children of the model, which already
   * has fitFurniture's non-uniform scale baked in (often 3-8x for the
   * small Kenney lamp GLBs). A hardcoded local Y of 1.5 would get
   * multiplied by that scale and throw the bulb 5-12 units into the
   * sky. We instead anchor the bulb just below the model's measured
   * top in WORLD units and translate that back into the model's local
   * frame, and inverse-scale the bulb mesh so it stays the authored
   * 0.08 radius regardless of how stretched the parent model is. */
  registerLamp(model: THREE.Object3D): void {
    if (this.placedLamps.some((lp) => lp.model === model)) return;
    // Measure the lamp's world-space top so we know where "bulb height"
    // really is for THIS model. Wall sconces are mounted at y≈1.5
    // (BuildMenu pre-positions them), floor lamps have their feet at
    // y=0; either way the top of the model is the natural bulb anchor.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const worldTopY = Number.isFinite(box.max.y) ? box.max.y : 1.5;
    const bulbWorldY = Math.max(0.3, worldTopY - 0.12);
    // For wall sconces fitFurniture shifts the model so its +Z face
    // sits flush with the wall — that means the model origin is at
    // the WALL plane, and the candle / sconce body sticks out in -Z.
    // Anchoring the bulb at local (0, _, 0) parked it at the wall
    // plane, so the light pooled on the wall right behind the candle
    // instead of on the candle itself. Use the model's measured
    // bounding-box centre in world space, converted back to local,
    // so the bulb sits inside the sconce body for wall lamps and
    // stays at the model origin for floor / table / ceiling lamps
    // (whose centroid is already at the origin).
    const worldCentre = new THREE.Vector3(
      Number.isFinite(box.min.x) ? (box.min.x + box.max.x) / 2 : model.position.x,
      bulbWorldY,
      Number.isFinite(box.min.z) ? (box.min.z + box.max.z) / 2 : model.position.z,
    );
    const localCentre = model.worldToLocal(worldCentre.clone());

    const sx = model.scale.x || 1;
    const sy = model.scale.y || 1;
    const sz = model.scale.z || 1;

    const light = new THREE.PointLight(0xffd6a0, 0, 4.5, 1.7);
    light.position.copy(localCentre);
    light.castShadow = false; // shadow maps for many lamps tank perf
    model.add(light);
    // A tiny emissive sphere makes the bulb itself visibly "lit" at
    // night even when the player can't see the cone of illumination.
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 10, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfff4cc, emissive: 0xfff4cc, emissiveIntensity: 0,
        transparent: true, opacity: 0.0,
      }),
    );
    bulb.position.copy(localCentre);
    // Inverse-scale so the bulb's WORLD radius stays at 0.08 even when
    // the parent lamp is stretched 8x vertically by fitFurniture.
    bulb.scale.set(1 / sx, 1 / sy, 1 / sz);
    model.add(bulb);
    this.placedLamps.push({ model, light, bulb });
    // Apply current darkness immediately so newly placed lamps come on
    // at the right brightness instead of waiting a frame.
    this.applyLampIntensity(light, bulb, this.currentNightAmount);
  }

  /** Remove a lamp from the active list (sell mode, undo, etc.). The
   * point light is disposed; the bulb mesh is removed too. */
  unregisterLamp(model: THREE.Object3D): void {
    const i = this.placedLamps.findIndex((lp) => lp.model === model);
    if (i < 0) return;
    const lp = this.placedLamps[i];
    model.remove(lp.light);
    model.remove(lp.bulb);
    lp.bulb.geometry.dispose();
    (lp.bulb.material as THREE.Material).dispose();
    this.placedLamps.splice(i, 1);
  }

  /** Walk every registered lamp and ramp its intensity + bulb emissive
   * with the current darkness. */
  private updateLamps(nightAmount: number): void {
    this.currentNightAmount = nightAmount;
    for (const lp of this.placedLamps) {
      this.applyLampIntensity(lp.light, lp.bulb, nightAmount);
    }
  }
  private applyLampIntensity(light: THREE.PointLight, bulb: THREE.Mesh, nightAmount: number): void {
    // Up to 1.8 intensity at full night — bright enough to read the
    // floor under each lamp but not so bright that an indoor scene
    // turns into floodlit daylight when the player drops a dozen lamps.
    light.intensity = nightAmount * 1.8;
    const bulbMat = bulb.material as THREE.MeshStandardMaterial;
    bulbMat.emissiveIntensity = nightAmount * 1.4;
    bulbMat.opacity = Math.min(1, nightAmount * 1.5);
  }

  /** Build the city's street lamp grid — one Parisian cast-iron post
   * on each pavement of every avenue, symmetric across the road.
   * Posts + bulbs are InstancedMesh (shared geometry / material) so
   * even 140 lamps cost ~6 draw calls total. Real PointLights are
   * NOT placed per post — see updateStreetLamps for the camera-
   * following pool that does the actual illumination. */
  private addStreetLamps(): void {
    // Pavement extends ±PAVEMENT_HALF (5.5m) from each avenue centerline.
    // Place the lamp post at perp ±4m so it sits ON the pavement,
    // ~1.5m back from the curb edge — between pedestrians and the
    // scenery houses' front walls.
    const PAVEMENT_HALF = 5.5;
    const LAMP_PERP = 4.0;
    // ~18m spacing along the avenue reads as a planned city without
    // packing the pavement edge-to-edge. At ±130m walk per avenue
    // that gives ~14-15 lamps per side per avenue.
    const LAMP_STEP = 18;
    const LAMP_HALF = 130;
    // Skip a candidate that would sit on a perpendicular avenue's
    // pavement — at intersections both avenues claim the same patch,
    // so we'd otherwise drop a lamp post on the cross street. Only
    // perpendicular crossings can overlap; parallel avenues never do.
    const onPerpCrossing = (x: number, z: number, axis: "ew" | "ns"): boolean => {
      if (axis === "ew") {
        for (const ax of WorldScene.NS_AVENUES) {
          if (Math.abs(x - ax) < PAVEMENT_HALF + 0.5) return true;
        }
      } else {
        for (const az of WorldScene.EW_AVENUES) {
          if (Math.abs(z - az) < PAVEMENT_HALF + 0.5) return true;
        }
      }
      return false;
    };

    type LampPlacement = { x: number; z: number; rotY: number };
    const placements: LampPlacement[] = [];
    // EW avenues — lamps line up along the X axis on the south (-Z)
    // and north (+Z) pavements. rotY rotates the lantern arm to face
    // the road (so the post pole sits flush with the building side).
    for (const az of WorldScene.EW_AVENUES) {
      for (const side of [-1, +1] as const) {
        const z = az + side * LAMP_PERP;
        // side=+1 (south pavement, post is south of road) → face north (-Z)
        // side=-1 (north pavement, post is north of road) → face south (+Z)
        const rotY = side > 0 ? Math.PI : 0;
        for (let x = -LAMP_HALF; x <= LAMP_HALF + 0.001; x += LAMP_STEP) {
          if (onPerpCrossing(x, z, "ew")) continue;
          placements.push({ x, z, rotY });
        }
      }
    }
    // NS avenues — same idea, axes swapped. Lamp arm faces the road.
    for (const ax of WorldScene.NS_AVENUES) {
      for (const side of [-1, +1] as const) {
        const x = ax + side * LAMP_PERP;
        const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        for (let z = -LAMP_HALF; z <= LAMP_HALF + 0.001; z += LAMP_STEP) {
          if (onPerpCrossing(x, z, "ns")) continue;
          placements.push({ x, z, rotY });
        }
      }
    }
    if (placements.length === 0) return;

    // === Shared geometries + materials ===
    const ironMat = new THREE.MeshStandardMaterial({
      color: 0x18130f, roughness: 0.55, metalness: 0.45,
    });
    const lanternMat = new THREE.MeshStandardMaterial({
      color: 0x2a2218, roughness: 0.40, metalness: 0.55,
    });
    // Bulb material — shared across every lamp. updateStreetLamps
    // mutates emissiveIntensity + opacity once per tick to drive
    // every bulb's glow simultaneously.
    this.streetLampBulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff4cc, emissive: 0xffd99a, emissiveIntensity: 0,
      transparent: true, opacity: 0.0,
    });

    // Base disc (slight flare at ground level)
    const baseGeo = new THREE.CylinderGeometry(0.20, 0.24, 0.18, 10);
    baseGeo.translate(0, 0.09, 0);
    // Pole — tapered cylinder 3.0m tall
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.10, 3.0, 8);
    poleGeo.translate(0, 1.68, 0);
    // Decorative cap where pole meets lantern
    const capGeo = new THREE.CylinderGeometry(0.13, 0.10, 0.18, 8);
    capGeo.translate(0, 3.27, 0);
    // Lantern housing (square iron box, glass implied)
    const lanternGeo = new THREE.BoxGeometry(0.34, 0.40, 0.34);
    lanternGeo.translate(0, 3.60, 0);
    // Pyramidal roof on top of lantern
    const roofGeo = new THREE.ConeGeometry(0.26, 0.20, 4);
    roofGeo.translate(0, 3.92, 0);
    // Bulb sphere (inside the lantern housing)
    const bulbGeo = new THREE.SphereGeometry(0.13, 12, 10);
    bulbGeo.translate(0, 3.60, 0);

    const count = placements.length;
    const baseInst = new THREE.InstancedMesh(baseGeo, ironMat, count);
    const poleInst = new THREE.InstancedMesh(poleGeo, ironMat, count);
    const capInst = new THREE.InstancedMesh(capGeo, ironMat, count);
    const lanternInst = new THREE.InstancedMesh(lanternGeo, lanternMat, count);
    const roofInst = new THREE.InstancedMesh(roofGeo, ironMat, count);
    const bulbInst = new THREE.InstancedMesh(bulbGeo, this.streetLampBulbMat, count);
    // Street lamps do NOT cast shadows. The 140-lamp InstancedMesh
    // has a bounding box that spans ±130 m (the full street grid),
    // so three.js renders ALL 140 instances into the shadow pass
    // even though only ~6 near origin fall inside the sun's ±20 m
    // shadow frustum. Net effect was a lot of wasted shadow texels
    // for shadows that get clipped immediately. Tiny visual loss
    // (the streaks were short at iso angle anyway).
    poleInst.castShadow = false;
    lanternInst.castShadow = false;

    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      const p = placements[i];
      tmp.position.set(p.x, 0, p.z);
      tmp.rotation.set(0, p.rotY, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      baseInst.setMatrixAt(i, tmp.matrix);
      poleInst.setMatrixAt(i, tmp.matrix);
      capInst.setMatrixAt(i, tmp.matrix);
      lanternInst.setMatrixAt(i, tmp.matrix);
      roofInst.setMatrixAt(i, tmp.matrix);
      bulbInst.setMatrixAt(i, tmp.matrix);
      this.streetLampPositions.push({ x: p.x, z: p.z });
    }
    this.worldRoot.add(baseInst);
    this.worldRoot.add(poleInst);
    this.worldRoot.add(capInst);
    this.worldRoot.add(lanternInst);
    this.worldRoot.add(roofInst);
    this.worldRoot.add(bulbInst);

    // === Light pool — N point lights repositioned each tick ===
    for (let i = 0; i < WorldScene.STREET_LAMP_POOL_SIZE; i += 1) {
      // Warm sodium-vapour glow. Distance ~14m gives a clear pool
      // under each lit lamp without bleeding across the whole map.
      // Decay 1.5 keeps the centre bright while falloff still hits
      // zero at the distance edge.
      const light = new THREE.PointLight(0xffe1a0, 0, 14, 1.5);
      light.castShadow = false;
      light.position.set(0, 3.6, 0);
      this.worldRoot.add(light);
      this.streetLampLightPool.push(light);
    }
  }

  /** Build the city's street planters — square / round / long
   * concrete boxes scattered along every avenue's pavement, SLOTTED
   * BETWEEN the lamp posts so the two grids interlock instead of
   * overlapping. Three styles cycle in sequence (square → round →
   * long → square …) so a single pavement run reads as a curated
   * garden strip, not a copy-pasted row.
   *
   * All meshes use InstancedMesh keyed on style so the entire grid
   * (~50 planters per style) costs ~3-4 draw calls per style. None
   * cast shadows — same reasoning as the lamps (the InstancedMesh
   * union bounding box spans the whole map so per-instance frustum
   * culling can't kick in, and a small concrete-box shadow is
   * imperceptible at iso distance anyway). */
  private addStreetPlanters(): void {
    const PAVEMENT_HALF = 5.5;
    // Same perp position as the lamps (4 m off centerline = ~1 m
    // from curb, ~1.5 m from outer pavement edge). Stagger ALONG
    // the avenue: lamps step every 18 m starting at -130 → planters
    // step every 18 m starting at -121 (= -130 + 9). End result:
    // lamp · planter · lamp · planter · …
    const PERP = 4.0;
    const STEP = 18;
    const PHASE_OFFSET = 9;
    const HALF = 130;
    // Same intersection-aware skip the lamps use — otherwise a
    // planter would land on the cross-street's asphalt.
    const onPerpCrossing = (x: number, z: number, axis: "ew" | "ns"): boolean => {
      if (axis === "ew") {
        for (const ax of WorldScene.NS_AVENUES) {
          if (Math.abs(x - ax) < PAVEMENT_HALF + 0.5) return true;
        }
      } else {
        for (const az of WorldScene.EW_AVENUES) {
          if (Math.abs(z - az) < PAVEMENT_HALF + 0.5) return true;
        }
      }
      return false;
    };

    type PlanterStyle = "square" | "round" | "long";
    type Placement = { x: number; z: number; rotY: number };
    const placements: Record<PlanterStyle, Placement[]> = {
      square: [], round: [], long: [],
    };
    const cycleStyle = (i: number): PlanterStyle => ([
      "square", "round", "long",
    ] as const)[i % 3];

    // EW avenues — planters line up along X on both pavements.
    for (const az of WorldScene.EW_AVENUES) {
      for (const side of [-1, +1] as const) {
        const z = az + side * PERP;
        const rotY = side > 0 ? Math.PI : 0;
        let cycle = 0;
        for (let x = -HALF + PHASE_OFFSET; x <= HALF + 0.001; x += STEP) {
          if (onPerpCrossing(x, z, "ew")) continue;
          placements[cycleStyle(cycle)].push({ x, z, rotY });
          cycle += 1;
        }
      }
    }
    // NS avenues — same idea, axes swapped.
    for (const ax of WorldScene.NS_AVENUES) {
      for (const side of [-1, +1] as const) {
        const x = ax + side * PERP;
        const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        let cycle = 0;
        for (let z = -HALF + PHASE_OFFSET; z <= HALF + 0.001; z += STEP) {
          if (onPerpCrossing(x, z, "ns")) continue;
          placements[cycleStyle(cycle)].push({ x, z, rotY });
          cycle += 1;
        }
      }
    }

    // Shared materials — warm beige concrete to harmonize with the
    // pavement tone, dark soil that matches the player's own garden
    // patch east of the restaurant.
    const concrete = new THREE.MeshStandardMaterial({
      color: 0xb3a890, roughness: 0.85, metalness: 0.05,
    });
    const soil = new THREE.MeshStandardMaterial({
      color: 0x3a2818, roughness: 0.95,
    });

    if (placements.square.length > 0) this.buildSquarePlanters(placements.square, concrete, soil);
    if (placements.round.length > 0) this.buildRoundPlanters(placements.round, concrete, soil);
    if (placements.long.length > 0) this.buildLongPlanters(placements.long, concrete, soil);
  }

  /** Square concrete planter with a single bushy plant on top. ~0.9 m
   * box, 0.45 m tall. */
  private buildSquarePlanters(
    placements: { x: number; z: number; rotY: number }[],
    concrete: THREE.MeshStandardMaterial,
    soil: THREE.MeshStandardMaterial,
  ): void {
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0x4a8a4a, roughness: 0.85,
    });
    const boxGeo = new THREE.BoxGeometry(0.9, 0.45, 0.9);
    boxGeo.translate(0, 0.225, 0);
    const soilGeo = new THREE.BoxGeometry(0.78, 0.04, 0.78);
    soilGeo.translate(0, 0.46, 0);
    const bushGeo = new THREE.SphereGeometry(0.42, 10, 8);
    bushGeo.translate(0, 0.78, 0);

    const count = placements.length;
    const box = new THREE.InstancedMesh(boxGeo, concrete, count);
    const soilM = new THREE.InstancedMesh(soilGeo, soil, count);
    const bush = new THREE.InstancedMesh(bushGeo, bushMat, count);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      const p = placements[i];
      tmp.position.set(p.x, 0, p.z);
      tmp.rotation.set(0, p.rotY, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      box.setMatrixAt(i, tmp.matrix);
      soilM.setMatrixAt(i, tmp.matrix);
      bush.setMatrixAt(i, tmp.matrix);
    }
    this.worldRoot.add(box, soilM, bush);
  }

  /** Round concrete planter holding a small tree. ~0.55 m radius, 0.5 m
   * tall, with a trunk + cone canopy on top. */
  private buildRoundPlanters(
    placements: { x: number; z: number; rotY: number }[],
    concrete: THREE.MeshStandardMaterial,
    soil: THREE.MeshStandardMaterial,
  ): void {
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x5a3a22, roughness: 0.9,
    });
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0x3a7a3a, roughness: 0.85,
    });
    const tubGeo = new THREE.CylinderGeometry(0.55, 0.50, 0.50, 14);
    tubGeo.translate(0, 0.25, 0);
    const soilGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.04, 12);
    soilGeo.translate(0, 0.51, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.07, 0.10, 0.85, 8);
    trunkGeo.translate(0, 0.93, 0);
    const canopyGeo = new THREE.ConeGeometry(0.50, 1.10, 8);
    canopyGeo.translate(0, 1.92, 0);

    const count = placements.length;
    const tub = new THREE.InstancedMesh(tubGeo, concrete, count);
    const soilM = new THREE.InstancedMesh(soilGeo, soil, count);
    const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const canopy = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      const p = placements[i];
      tmp.position.set(p.x, 0, p.z);
      tmp.rotation.set(0, p.rotY, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      tub.setMatrixAt(i, tmp.matrix);
      soilM.setMatrixAt(i, tmp.matrix);
      trunk.setMatrixAt(i, tmp.matrix);
      canopy.setMatrixAt(i, tmp.matrix);
    }
    this.worldRoot.add(tub, soilM, trunk, canopy);
  }

  /** Long rectangular trough with a row of three flowers across the
   * top. Rotated to lie ALONG the avenue (not across it) so the
   * silhouette reads as a planter rather than a kerb obstacle. Flowers
   * cycle through three warm colours per planter so the city has a
   * little floral variety. */
  private buildLongPlanters(
    placements: { x: number; z: number; rotY: number }[],
    concrete: THREE.MeshStandardMaterial,
    soil: THREE.MeshStandardMaterial,
  ): void {
    // Long planters point ALONG the avenue. EW pavements: long axis
    // is X (rotY = 0 / π). NS pavements: long axis is Z (rotY = ±π/2).
    // The original placement loop already passes a rotY that points
    // toward the road for the lamps; we OVERRIDE here so the trough
    // sits parallel to the kerb instead of across it.
    const FLOWER_COLORS = [0xff6f8c, 0xffd06f, 0xa8e2a8] as const;
    const flowerMats = FLOWER_COLORS.map((c) => new THREE.MeshStandardMaterial({
      color: c, roughness: 0.6,
      emissive: c, emissiveIntensity: 0.10,
    }));

    const boxGeo = new THREE.BoxGeometry(1.7, 0.35, 0.5);
    boxGeo.translate(0, 0.175, 0);
    const soilGeo = new THREE.BoxGeometry(1.55, 0.04, 0.36);
    soilGeo.translate(0, 0.36, 0);
    // Flower = small sphere (poppy-style) at ~0.10 m radius. Three per
    // trough at x = -0.6, 0, +0.6. Stem omitted at this distance.
    const flowerGeo = new THREE.SphereGeometry(0.11, 10, 8);

    const count = placements.length;
    const box = new THREE.InstancedMesh(boxGeo, concrete, count);
    const soilM = new THREE.InstancedMesh(soilGeo, soil, count);
    // One flower-mesh per colour, holding all the flowers OF THAT
    // colour across every long planter (3 flowers per planter).
    const flowerCount = count * 3;
    const flowers = flowerMats.map((mat) => new THREE.InstancedMesh(flowerGeo, mat, Math.ceil(flowerCount / FLOWER_COLORS.length) + 1));
    const flowerCursors = [0, 0, 0]; // next free slot in each colour bucket
    const tmp = new THREE.Object3D();
    const flowerTmp = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      const p = placements[i];
      // Long axis runs along the avenue — for an EW-side row the
      // placement rotY is 0 or π (planter faces ±Z which means the
      // long box currently extends ±X, perfect). For NS-side rows
      // rotY is ±π/2 so the box's local X (length) rotates to be
      // along world Z — also along the avenue. Either way the
      // length-axis ends up parallel to the avenue, no override
      // needed.
      tmp.position.set(p.x, 0, p.z);
      tmp.rotation.set(0, p.rotY, 0);
      tmp.scale.set(1, 1, 1);
      tmp.updateMatrix();
      box.setMatrixAt(i, tmp.matrix);
      soilM.setMatrixAt(i, tmp.matrix);
      // Flowers — three per planter at x = -0.55, 0, +0.55 (local).
      // Pick a colour by planter index so neighbouring troughs alternate.
      const colourIdx = i % FLOWER_COLORS.length;
      for (const localX of [-0.55, 0, 0.55]) {
        // Position each flower in the planter's LOCAL frame then bake
        // through the planter's world transform.
        flowerTmp.position.set(localX, 0.49, 0);
        flowerTmp.rotation.set(0, 0, 0);
        flowerTmp.scale.set(1, 1, 1);
        flowerTmp.updateMatrix();
        const m = new THREE.Matrix4().multiplyMatrices(tmp.matrix, flowerTmp.matrix);
        const cursor = flowerCursors[colourIdx];
        flowers[colourIdx].setMatrixAt(cursor, m);
        flowerCursors[colourIdx] = cursor + 1;
      }
    }
    // Trim each flower InstancedMesh to its actual used count so the
    // renderer doesn't draw unset zero-matrix instances at origin.
    for (let k = 0; k < flowers.length; k += 1) flowers[k].count = flowerCursors[k];
    this.worldRoot.add(box, soilM, ...flowers);
  }

  /** Per-frame: ramp every lamp bulb's emissive with the current
   * night amount (cheap — one shared material), then reposition the
   * pool of point lights to the N closest lamps to the camera so the
   * player walks through pools of light wherever they go.
   *
   * Engine.update calls this AFTER applyDayNight so currentNightAmount
   * is fresh. Skips the full distance re-sort when the camera hasn't
   * moved enough to change the closest set. */
  updateStreetLamps(cameraPos: THREE.Vector3): void {
    if (this.streetLampPositions.length === 0 || !this.streetLampBulbMat) return;
    const nightAmount = this.currentNightAmount;
    // === Bulb glow (all bulbs share one material) ===
    this.streetLampBulbMat.emissiveIntensity = nightAmount * 2.2;
    this.streetLampBulbMat.opacity = Math.min(1, nightAmount * 1.6);
    // === Light pool ===
    if (nightAmount < 0.05) {
      // Pure daytime — kill the pool entirely so we don't waste
      // shader work computing zero-intensity contributions.
      for (const light of this.streetLampLightPool) light.intensity = 0;
      return;
    }
    // Convert camera position into worldRoot-local coords (worldRoot
    // is offset to keep the player's plot at local origin; lamps live
    // in worldRoot-local space, so we subtract the offset to compare
    // distances in the same frame).
    const cx = cameraPos.x - this.worldRoot.position.x;
    const cz = cameraPos.z - this.worldRoot.position.z;
    // Skip the resort if the camera hasn't moved enough. Threshold =
    // ½ the average lamp spacing — moving less than that can't flip
    // which lamps are nearest.
    const dx = cx - this.streetLampLastCamX;
    const dz = cz - this.streetLampLastCamZ;
    const moved = dx * dx + dz * dz > 6 * 6;
    if (!moved) {
      // Just refresh intensity (in case nightAmount changed) without
      // re-shuffling which lamps are lit.
      const peak = nightAmount * 1.7;
      for (const light of this.streetLampLightPool) {
        if (light.intensity > 0) light.intensity = peak;
      }
      return;
    }
    this.streetLampLastCamX = cx;
    this.streetLampLastCamZ = cz;
    // Find the POOL_SIZE closest lamps by squared distance. Maintain
    // a small heap-like array of [index, dSq] sorted by dSq ascending.
    const POOL = this.streetLampLightPool.length;
    const closestI: number[] = new Array(POOL).fill(-1);
    const closestD: number[] = new Array(POOL).fill(Infinity);
    let worstSlot = 0; // index in closest* arrays holding the largest dSq
    for (let i = 0; i < this.streetLampPositions.length; i += 1) {
      const l = this.streetLampPositions[i];
      const ddx = l.x - cx;
      const ddz = l.z - cz;
      const d = ddx * ddx + ddz * ddz;
      if (d < closestD[worstSlot]) {
        closestI[worstSlot] = i;
        closestD[worstSlot] = d;
        // Recompute the new worst slot.
        let w = 0;
        for (let k = 1; k < POOL; k += 1) {
          if (closestD[k] > closestD[w]) w = k;
        }
        worstSlot = w;
      }
    }
    // Hard distance gate — beyond ~80m the lamp would be off-screen
    // for most reasonable camera angles, so don't waste the slot.
    const MAX_RANGE_SQ = 80 * 80;
    const peakIntensity = nightAmount * 1.7;
    for (let p = 0; p < POOL; p += 1) {
      const light = this.streetLampLightPool[p];
      const idx = closestI[p];
      if (idx >= 0 && closestD[p] < MAX_RANGE_SQ) {
        const lamp = this.streetLampPositions[idx];
        light.position.set(lamp.x, 3.6, lamp.z);
        light.intensity = peakIntensity;
      } else {
        light.intensity = 0;
      }
    }
  }

  /** Drive lighting + sky tint by time of day. progress is 0..1 over a
   * 24h game-day, divided as 8h night + 4h dawn/dusk + 12h day:
   *   0.000 – 0.083  dawn  (2h, brightening)
   *   0.083 – 0.583  day   (12h, full sun)
   *   0.583 – 0.667  dusk  (2h, darkening)
   *   0.667 – 1.000  night (8h, dark)
   * Engine ticks this every frame. */
  applyDayNight(progress: number): { skyColor: number } {
    const DAWN_END = 0.083;
    const DAY_END = 0.583;
    const DUSK_END = 0.667;
    // "dayness" is 0 in deep night, 1 in full daylight, ramping on
    // dawn + ramping off dusk. Drives sun + ambient.
    let dayness: number;
    if (progress < DAWN_END) {
      dayness = progress / DAWN_END;            // 0 → 1
    } else if (progress < DAY_END) {
      dayness = 1;
    } else if (progress < DUSK_END) {
      dayness = 1 - (progress - DAY_END) / (DUSK_END - DAY_END); // 1 → 0
    } else {
      dayness = 0;
    }

    // Sun: bright during day, dim during dawn/dusk, near-black at
    // night. Floor dropped to 0.04 (was 0.12) so streetlamps actually
    // pop against the dark instead of fighting the residual sun.
    const sunIntensity = 0.04 + dayness * 1.78;
    this.sunLight.intensity = sunIntensity;
    this.sunLight.color.setHex(mixColors(0xaab8d6, 0xfff4d8, dayness));

    // Ambient: warm bright during day, cool blue at night. Floor
    // dropped to 0.14 (was 0.32) so the city genuinely feels dark
    // beyond the lamps' pools of light. The night ambient still has
    // SOME value so the player can navigate without lamps; we just
    // shouldn't paint the entire scene a flat bluish glow.
    this.ambientLight.color.setHex(mixColors(0x707a92, 0xfff1d6, dayness));
    this.ambientLight.intensity = 0.14 + dayness * 0.86;

    // Fill (sky bounce) — fades with daylight. Floor dropped to 0.06
    // so back-lit surfaces don't read as "the sun's still up a bit."
    this.fillLight.intensity = 0.06 + dayness * 0.44;

    // Sky color — sunrise/sunset orange during the transitions, deep
    // navy at night, cream during the day.
    let skyColor: number;
    if (progress < DAWN_END) {
      // night → orange dawn → day
      const t = progress / DAWN_END;
      skyColor = t < 0.5
        ? mixColors(0x12162a, 0xb27a52, t / 0.5)
        : mixColors(0xb27a52, 0xd8c4a3, (t - 0.5) / 0.5);
    } else if (progress < DAY_END) {
      skyColor = 0xd8c4a3;
    } else if (progress < DUSK_END) {
      // day → orange dusk → night
      const t = (progress - DAY_END) / (DUSK_END - DAY_END);
      skyColor = t < 0.5
        ? mixColors(0xd8c4a3, 0xb27a52, t / 0.5)
        : mixColors(0xb27a52, 0x12162a, (t - 0.5) / 0.5);
    } else {
      skyColor = 0x12162a; // darker than the old 0x1f2a48
    }

    // Weather tints — layered on top of the day/night base. Rainy and
    // cold tint everything cooler regardless of time of day (they're
    // "all-time" weathers per the user spec). Cloudy and sunny only
    // bite during the day window — at night they're invisible anyway
    // because dayness == 0 collapses their effect to nothing.
    skyColor = this.applyWeatherTints(skyColor, dayness);

    // Lamp intensity tracks `1 - dayness` so bulbs warm up over the
    // dusk window, stay lit through deep night, then dim out across
    // the dawn window. Bad weather bumps the lamp glow a little so the
    // interior reads as the cozy refuge from the storm.
    let lampBoost = 0;
    if (this.currentWeather === "heavy-rain") lampBoost = 0.30;
    else if (this.currentWeather === "rainy") lampBoost = 0.18;
    else if (this.currentWeather === "snowy") lampBoost = 0.20;
    else if (this.currentWeather === "cold") lampBoost = 0.10;
    else if (this.currentWeather === "cloudy") lampBoost = 0.05;
    this.updateLamps(Math.min(1, (1 - dayness) + lampBoost));
    // Floor wetness — drives the rainy / heavy-rain "wet pavement"
    // look. Driven by WeatherEffects so the renderer + the particles
    // share one source of truth.
    this.applyFloorWetness();
    return { skyColor };
  }

  /** Apply the WeatherEffects wetness value to the floor material.
   * Higher wetness = glossier + slightly darker = wet asphalt look.
   * The slight darkening comes from a lerp toward a cool damp brown so
   * heavy rain visibly soaks the floor compared to a light shower. */
  private applyFloorWetness(): void {
    if (!this.floorMat) return;
    const wetness = this.weatherEffects?.getWetness() ?? 0;
    // Cache the dry roughness + colour on first call so we can lerp
    // toward it whenever wetness returns to zero without re-deriving
    // it from theme state.
    if (!this.floorDryState) {
      this.floorDryState = {
        roughness: this.floorMat.roughness,
        color: this.floorMat.color.getHex(),
      };
    }
    const dry = this.floorDryState;
    // Wet floor: roughness 0.85 → 0.30 = strongly reflective. Colour
    // mixes toward a cool damp slate so the wetness reads even without
    // strong specular highlights.
    const wetRoughness = 0.30;
    const wetColor = 0x4a4238;
    this.floorMat.roughness = dry.roughness + (wetRoughness - dry.roughness) * wetness;
    this.floorMat.color.setHex(mixColors(dry.color, wetColor, wetness * 0.55));
  }
  private floorDryState?: { roughness: number; color: number };

  /** Layer weather-specific tints on top of the day/night ambient.
   * Rainy + cold cool the sun + ambient and shift the sky grey/blue.
   * Cloudy dulls the sun and tints the sky greyer (daytime only).
   * Festival warms ambient slightly + brightens lamps for a party
   * mood. Sunny passes through untouched — it IS the default.
   *
   * Returns the (possibly modified) sky colour so the renderer's
   * background also picks up the storm-grey / overcast / festive tint. */
  private applyWeatherTints(skyColor: number, dayness: number): number {
    switch (this.currentWeather) {
      case "rainy": {
        // Cool grey-blue overcast. Strong all the time — rainy nights
        // also feel storm-darkened. Sun dimmed to ~30%, ambient gets a
        // chilly tint.
        skyColor = mixColors(skyColor, 0x4a5868, 0.55);
        this.sunLight.intensity *= 0.40;
        this.sunLight.color.setHex(mixColors(this.sunLight.color.getHex(), 0x8aa0c0, 0.55));
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0x7a8aa0, 0.5));
        this.ambientLight.intensity *= 0.80;
        break;
      }
      case "heavy-rain": {
        // Dramatic storm — much darker sky + cooler tint, sun nearly
        // gone behind the cloudbank. Reads as "you really don't want
        // to be outside right now".
        skyColor = mixColors(skyColor, 0x2c343e, 0.80);
        this.sunLight.intensity *= 0.18;
        this.sunLight.color.setHex(mixColors(this.sunLight.color.getHex(), 0x6680a0, 0.75));
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0x5a6878, 0.7));
        this.ambientLight.intensity *= 0.65;
        break;
      }
      case "cold": {
        // Pale cool-white snowstorm tint. Snow reflects so it's not as
        // dark as rain — sun keeps ~60% intensity but its colour goes
        // toward white-blue and the sky pales.
        skyColor = mixColors(skyColor, 0xc8d4e0, 0.45);
        this.sunLight.intensity *= 0.70;
        this.sunLight.color.setHex(mixColors(this.sunLight.color.getHex(), 0xe0e8f4, 0.5));
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0xcdd5e2, 0.4));
        break;
      }
      case "snowy": {
        // Heavy snowfall — pale silver-grey overcast, sun much weaker,
        // ambient gets a cooler white. Visibility through the falling
        // snow stays high because the flakes themselves reflect light.
        skyColor = mixColors(skyColor, 0xbcc4d0, 0.65);
        this.sunLight.intensity *= 0.50;
        this.sunLight.color.setHex(mixColors(this.sunLight.color.getHex(), 0xd8e0ec, 0.65));
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0xc0c8d4, 0.55));
        this.ambientLight.intensity *= 0.95;
        break;
      }
      case "cloudy": {
        // Overcast — only meaningful during the day. The mix amount
        // tracks dayness so dusk + night stay night-blue, not a
        // washed-out grey.
        const t = dayness * 0.5;
        skyColor = mixColors(skyColor, 0x9aa2ad, t);
        this.sunLight.intensity *= (1 - dayness * 0.45);
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0xa8aebc, t));
        break;
      }
      case "festival": {
        // Warmer ambient + a pop of pink in the sky. Subtle — confetti
        // particles carry most of the visual signature.
        skyColor = mixColors(skyColor, 0xf4b8c8, 0.20);
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0xffd0b8, 0.30));
        this.ambientLight.intensity *= 1.1;
        break;
      }
      case "sunny": {
        // Bright sunshine boost — only meaningful during the day
        // window (multiplied by dayness so dusk + night stay quiet).
        // Sun gets up to +60%, ambient +35%, fill +30%, and the sky
        // mixes toward a near-white warm cream so the lit world reads
        // as "perfect summer afternoon" instead of just "the default".
        const boost = dayness;
        this.sunLight.intensity *= 1 + 0.6 * boost;
        this.sunLight.color.setHex(mixColors(this.sunLight.color.getHex(), 0xfff6e0, 0.35 * boost));
        this.ambientLight.intensity *= 1 + 0.35 * boost;
        this.ambientLight.color.setHex(mixColors(this.ambientLight.color.getHex(), 0xfff4e0, 0.30 * boost));
        this.fillLight.intensity *= 1 + 0.30 * boost;
        skyColor = mixColors(skyColor, 0xf2e1c0, 0.30 * boost);
        break;
      }
      default:
        // Unknown weather id — leave the dayness ramp alone.
        break;
    }
    return skyColor;
  }

  /** Engine pushes the active weather id each tick (cheap; idempotent).
   * Triggers a particle-system swap inside WeatherEffects and updates
   * the cached weather so the next applyDayNight call uses the new
   * tint. */
  setWeather(id: string): void {
    if (this.currentWeather === id) return;
    this.currentWeather = id;
    this.weatherEffects?.setWeather(id);
  }

  /** Tick weather particles. cameraPos is consumed so the volume
   * tracks the player's view across long sessions. */
  updateWeather(dt: number, cameraPos: THREE.Vector3): void {
    this.weatherEffects?.update(dt, cameraPos);
  }

  /** Exposed so the DecorPanel can swap colors when the player picks a
   * different theme. */
  floorMat!: THREE.MeshStandardMaterial;
  wallMat!: THREE.MeshStandardMaterial;
  /** Transparent "glass" version of wallMat used for walls between the
   * camera and the room interior. Color is intentionally not themed —
   * the peach tint reads as a CSS-cutaway hint rather than an actual
   * wall colour. */
  private wallGhostMat!: THREE.MeshStandardMaterial;
  // wallBack / wallLeft / wallRight removed — every perimeter wall
  // is now stored in the perimeterWalls map below.
  /** Exterior-facing wall material. Each wall segment uses a 6-material
   * array so the inside face is wallMat and the outside face is this.
   * Lets a window cut through and show the interior cream on the room
   * side and the building beige on the outside. */
  private wallExteriorMat!: THREE.MeshStandardMaterial;
  /** Per-direction state for the four perimeter walls — all dynamic
   * now so windows + doors can cut them. Single-mesh back/left/right
   * walls were replaced with a segmented system identical to the
   * front wall. */
  /** Per-floor perimeter wall state. Floor 0 is the ground floor (parent =
   * scene, yOffset = 0, wallMatRef defaults to the shared wallMat). Upper
   * storeys add entries at storey-build time with parent = storey group,
   * yOffset = idx * STOREY_HEIGHT, and wallMatRef = the per-storey clone
   * so theme switching from DecorModal lands on the right floor. */
  private readonly perimeterWalls: Map<number, Map<WallDir, PerimeterWallState>> = new Map([
    [0, new Map<WallDir, PerimeterWallState>([
      ["front", { meshes: [], currentMat: "ghost", doors: [] as number[], windows: [] as number[] }],
      ["back",  { meshes: [], currentMat: "solid", doors: [] as number[], windows: [] as number[] }],
      ["left",  { meshes: [], currentMat: "solid", doors: [] as number[], windows: [] as number[] }],
      ["right", { meshes: [], currentMat: "ghost", doors: [] as number[], windows: [] as number[] }],
    ])],
  ]);

  // === Multi-storey building ===========================================
  // The original building was a single ground floor. The tier-expansion
  // system extends it upward: every luxury-tier purchase past T1 unlocks
  // one more storey above the ground floor (T2 → storey 1, T3 → storey
  // 2, … T5 → storey 4). Each storey is STOREY_HEIGHT (3 m) tall and
  // sits on the same 10×10 m footprint as the ground floor.
  //
  // Phase 1 ships the geometry only — hidden by default, no per-floor
  // furniture, no camera focus, no walking between floors. Subsequent
  // phases will layer those on top.
  private static readonly STOREY_HEIGHT = 3;
  private static readonly NUM_STOREYS = 5;
  /** Per-storey geometry references keyed by storey index (1..NUM_STOREYS-1).
   * Holds the group (for visibility toggle), the floor slab (toggled
   * solid vs ghost so the player can see down through it), and the
   * four perimeter walls keyed by direction (toggled by the same
   * camera-relative ghost rule the ground floor uses). */
  private upperStoreys = new Map<number, {
    group: THREE.Group;
    slab: THREE.Mesh;
    walls: Map<WallDir, THREE.Mesh>;
    /** Per-storey material instances so DecorModal can theme each
     * upper floor independently from the ground floor. Cloned from
     * `slabMatSolid` / `wallMat` at construction. */
    slabMat: THREE.MeshStandardMaterial;
    wallMat: THREE.MeshStandardMaterial;
  }>();
  /** Staircase flights keyed by the storey index they LEAD UP TO
   * (1..NUM_STOREYS-1). Each flight is parented to the LOWER storey it
   * leaves from so it visually belongs to that floor — focusing on the
   * lower floor reveals the stair going up. For idx === 1 the parent is
   * the main scene (the ground floor has no group). Visibility is
   * gated independently by tier (only show a flight if its destination
   * storey is unlocked). */
  private stairFlights = new Map<number, THREE.Group>();
  /** Roof cap at y = NUM_STOREYS * STOREY_HEIGHT. Visible whenever any
   * upper storey is — gives the building a finished top instead of an
   * open box. Also ghost-able so the iso camera can see down through it
   * when focused on a lower storey. */
  private buildingRoof?: THREE.Mesh;
  /** Material for upper-storey floor slabs. Only one variant needed
   * now that storeys above the focused floor are hidden outright;
   * the ghost-when-above variant we used previously is gone. */
  private slabMatSolid!: THREE.MeshStandardMaterial;
  private roofMatSolid!: THREE.MeshStandardMaterial;
  /** Which storey the camera is currently focused on (0 = ground).
   * Everything above this storey gets the ghost treatment so the player
   * can see down into the focused floor. Phase 4 will let the player
   * change this from the HUD; for now it stays at 0. */
  private focusedStorey = 0;
  /** Exterior mode — when true (player has zoomed out past 40%), the
   * building reads as a closed structure: every wall solid, every
   * unlocked storey + roof visible regardless of focus, and the
   * camera-relative ghost rule in updateWallVisibility is bypassed.
   * Engine.tick toggles this based on the camera's zoom percent. */
  private exteriorMode = false;

  private addBuilding(): void {
    // === Exterior ground + props ===
    // addGrassyExterior() owns the lawn, pavement, road, lane lines,
    // and curb. The legacy pavement/road/curb that used to live inline
    // here was a STALE COPY left over from an old refactor — it kept
    // rendering at the old z=7.5 alongside the new geometry, so every
    // attempt to move the sidewalk further from the building was
    // masked by the duplicate still sitting on the original spot.
    this.addGrassyExterior();

    // === Interior floor ===
    // Default starter colors are intentionally bare white — the warm
    // tones moved into purchasable themes the player picks in the Decor
    // menu. See data/themes.ts.
    //
    // Floor + walls + grid are all shifted by (+0.5, +0.5) so they
    // enclose the same area as the grid (which has lines at half-integer
    // coords so items placed at integer coords appear inside tiles).
    // Before this shift the floor extended 0.5 past the grid on the
    // back/left, which the player saw as "floor leaking outside the
    // restaurant".
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.95, metalness: 0 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0.5, 0.0, 0.5); // sits above grass; +0.5 shift to align with tile-center convention
    floor.receiveShadow = true;
    this.threeScene.add(floor);

    // Grid overlay removed by player request — the floor reads cleanly
    // without the half-integer tile guides. Build / move modes still
    // snap to the same grid; the SeatMarkers + ghost previews provide
    // enough visual feedback during placement that the grid lines were
    // adding noise without information.

    // === Walls ===
    // Three materials:
    //   wallMat       — interior cream colour, room-facing face
    //   wallExtMat    — exterior beige, outside-facing face
    //   wallGhostMat  — see-through used when the camera is on this
    //                   wall's outdoor side so it doesn't block the
    //                   view of the dining room
    // updateWallVisibility picks solid vs ghost per wall every frame.
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.85 });
    this.wallExteriorMat = new THREE.MeshStandardMaterial({ color: 0xc8a878, roughness: 0.78 });
    this.wallGhostMat = new THREE.MeshStandardMaterial({
      color: 0xe8a98a, roughness: 0.6,
      transparent: true, opacity: 0.15, depthWrite: false,
    });
    // All 4 perimeter walls are dynamic segmented meshes now —
    // doors cut a full-height gap (+ lintel), windows cut a sill +
    // lintel partial gap so the player can see in / out through them
    // from either side. Default door list is empty; the engine
    // refills both lists from the registry as the player builds.
    this.rebuildPerimeterWall(0, "front", [], []);
    this.rebuildPerimeterWall(0, "back",  [], []);
    this.rebuildPerimeterWall(0, "left",  [], []);
    this.rebuildPerimeterWall(0, "right", [], []);
    // Restaurant rating sign mounted on the lintel — a small marquee
    // that shows the current ★ rating, just like a real bistro
    // entrance. Hooked up by updateRatingSign() from Engine.
    this.buildRatingSign();

    // Supply / receiving counter at the back-left wall — the errand
    // helper reports here with each delivery instead of walking out
    // the front door (which got in the customers' way and didn't read
    // as the back-of-house workflow it actually is). Procedural so it
    // shows for both new and existing saves regardless of registry state.
    this.buildSupplyCounter();

    // Upper storeys (tier expansions). Hidden by default; setLuxuryTier
    // toggles them as the player buys each expansion.
    this.addUpperStoreys();
    // Paris-style exterior decoration — cornice bands between floors,
    // iron balconies on upper storeys, mansard roof on top. Matches the
    // city's other Paris shells so the player's building reads as part
    // of the same neighbourhood. Per-storey decor parents into each
    // upper-storey group so it inherits the existing tier / focus
    // visibility (no extra wiring needed). The mansard is managed
    // separately because its Y depends on the current luxury tier.
    this.addParisExteriorDecor();
  }

  /** Build the 10×10 slab geometry with a rectangular stairwell hole
   * cut at the back-left corner — the spot where the staircase coming
   * up from the storey below emerges. The hole matches the stair
   * footprint (X∈[−4.4,−3.4], Z∈[−4.4,−1.4], a 1 × 3 m opening) and is
   * expressed in the slab's *local* coordinates (slab is then rotated
   * −π/2 around X and translated to (0.5, baseY, 0.5), exactly like
   * the original PlaneGeometry slab). */
  private makeSlabWithStairHole(W: number): THREE.ShapeGeometry {
    const half = W / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-half, -half);
    shape.lineTo( half, -half);
    shape.lineTo( half,  half);
    shape.lineTo(-half,  half);
    shape.lineTo(-half, -half);
    // Hole in local coords. Slab origin sits at (0.5, baseY, 0.5) in
    // world; after the −π/2 rotation around X, shape-Y maps to world
    // −Z. So a world hole at X∈[−4.4,−3.4], Z∈[−4.4,−1.4] becomes:
    //   local X = world X − 0.5  → [−4.9, −3.9]
    //   local Y = 0.5 − world Z  → [4.9, 1.9]
    const hole = new THREE.Path();
    hole.moveTo(-4.9, 1.9);
    hole.lineTo(-4.9, 4.9);
    hole.lineTo(-3.9, 4.9);
    hole.lineTo(-3.9, 1.9);
    hole.lineTo(-4.9, 1.9);
    shape.holes.push(hole);
    return new THREE.ShapeGeometry(shape);
  }

  /** Build the empty white shell for each storey above the ground floor.
   * Each storey gets a floor plane (with a stairwell cut at the back-
   * left corner), four solid perimeter walls (tracked by direction so
   * the ghost pass can flip them), and the top of the stack carries a
   * separate roof cap. All hidden by default; the setLuxuryTier pass
   * toggles the appropriate ones on per tier. Staircases live in a
   * SECOND pass (further down) and are parented to the storey they
   * LEAVE FROM, so the player sees a flight going up when focused on
   * the floor below — matching how stairs read visually in real
   * architecture. */
  private addUpperStoreys(): void {
    const W = 10;                                          // footprint, same as ground floor
    const H = WorldScene.STOREY_HEIGHT;
    // T (wall thickness) and wallSpecs are no longer needed here — the
    // wall geometry comes from rebuildPerimeterWall / wallBoxFor /
    // wallSegmentPosition now, with this storey's parent + yOffset
    // wired through the per-floor PerimeterWallState entries below.
    // Slab materials — solid (blank-canvas off-white) and ghost (see-
    // through pale). Stored on the instance so applyUpperStoreyVisibility
    // can flip per-mesh references between them.
    this.slabMatSolid = new THREE.MeshStandardMaterial({
      color: 0xf6f4ef, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    });
    this.roofMatSolid = new THREE.MeshStandardMaterial({
      color: 0xe8d8b8, roughness: 0.9, side: THREE.DoubleSide,
    });
    // First pass: build every storey's slab + walls. Slabs use
    // ShapeGeometry so we can cut a stairwell opening at the back-left
    // corner where the flight below emerges.
    for (let idx = 1; idx < WorldScene.NUM_STOREYS; idx += 1) {
      const group = new THREE.Group();
      group.visible = false;
      const baseY = idx * H;
      // Per-storey material clones so DecorModal can theme each upper
      // floor independently. Without this every floor would share the
      // ground floor's wall + slab colours.
      const slabMat = this.slabMatSolid.clone();
      const wallMatStorey = this.wallMat.clone();
      // Floor of this storey == ceiling of the storey below, with a
      // 1 × 3 m rectangular opening at the back-left corner so the
      // staircase rising from below can emerge through it.
      const slab = new THREE.Mesh(this.makeSlabWithStairHole(W), slabMat);
      slab.rotation.x = -Math.PI / 2;
      slab.position.set(0.5, baseY, 0.5);
      slab.receiveShadow = true;
      group.add(slab);
      // 4 perimeter walls — registered into the per-floor perimeterWalls
      // map so they get the same dynamic cut/lintel pipeline as the
      // ground floor. Without this, windows placed on Floor 1+ left no
      // hole in the wall (the player saw the window mesh from outside
      // but the inside view was a solid wall). yOffset = baseY shifts
      // every segment up to this storey's slab; parent = group means
      // they hide with the storey when it's out of focus; wallMatRef =
      // wallMatStorey ties them into the per-floor theme clone.
      const floorMap = new Map<WallDir, PerimeterWallState>([
        ["front", { meshes: [], currentMat: "ghost", doors: [], windows: [], yOffset: baseY, parent: group, wallMatRef: wallMatStorey }],
        ["back",  { meshes: [], currentMat: "solid", doors: [], windows: [], yOffset: baseY, parent: group, wallMatRef: wallMatStorey }],
        ["left",  { meshes: [], currentMat: "solid", doors: [], windows: [], yOffset: baseY, parent: group, wallMatRef: wallMatStorey }],
        ["right", { meshes: [], currentMat: "ghost", doors: [], windows: [], yOffset: baseY, parent: group, wallMatRef: wallMatStorey }],
      ]);
      this.perimeterWalls.set(idx, floorMap);
      // walls map is now populated lazily by the first rebuild call —
      // keep an empty placeholder so the upperStoreys interface stays
      // stable for callers (updateWallVisibility, etc.).
      const walls = new Map<WallDir, THREE.Mesh>();
      this.upperStoreys.set(idx, { group, slab, walls, slabMat, wallMat: wallMatStorey });
      this.threeScene.add(group);
      // Build the initial (no-opening) wall segments for this storey
      // right away — Engine will call rebuildAllPerimeterWalls later
      // when furniture is restored, but until then the slab needs walls
      // around it or the storey reads as a floating plate.
      this.rebuildPerimeterWall(idx, "front", [], []);
      this.rebuildPerimeterWall(idx, "back",  [], []);
      this.rebuildPerimeterWall(idx, "left",  [], []);
      this.rebuildPerimeterWall(idx, "right", [], []);
    }
    // Second pass: each flight is parented to the storey it LEAVES
    // FROM (idx-1), so revealing the lower floor reveals the stair
    // going up. For idx === 1 the parent is the main scene because
    // the ground floor lives directly in the scene, not in a group.
    for (let idx = 1; idx < WorldScene.NUM_STOREYS; idx += 1) {
      const baseY = idx * H;
      const stairGroup = new THREE.Group();
      this.addStaircaseSegment(stairGroup, baseY);
      this.stairFlights.set(idx, stairGroup);
      if (idx === 1) {
        // Ground → Floor 1: parent is the main scene. Always visible
        // when Floor 1 is unlocked, regardless of focus.
        stairGroup.visible = false;
        this.threeScene.add(stairGroup);
      } else {
        // Floor N → Floor N+1: parent is the lower storey's group.
        const lowerGroup = this.upperStoreys.get(idx - 1)!.group;
        lowerGroup.add(stairGroup);
      }
    }
    // Roof at the top of the topmost storey. Replaced in
    // addParisExteriorDecor by a mansard whose Y tracks the player's
    // current luxury tier. This flat plane is kept invisible as a
    // legacy fallback; the mansard takes over visually.
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, W), this.roofMatSolid);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(0.5, WorldScene.NUM_STOREYS * H, 0.5);
    roof.receiveShadow = true;
    roof.visible = false;
    this.threeScene.add(roof);
    this.buildingRoof = roof;
  }

  /** Slate-grey mansard roof that replaces the legacy flat cap.
   * Re-positioned in applyStoreyVisibility so it always sits on top
   * of the topmost UNLOCKED storey (tier 1 → on top of ground,
   * tier 5 → on top of floor 4). Visible only in exterior mode so
   * interior views can still look down through an open top. */
  private parisMansard?: THREE.Mesh;
  private parisMansardCap?: THREE.Mesh;
  private parisMansardChimney?: THREE.Mesh;
  /** Iron-balcony meshes (rails + balusters) per upper storey. Tracked
   * so applyStoreyVisibility can hide them in interior mode — when
   * the player has zoomed in for inside work, the spiky black rails
   * floating outside the wall just clutter the view. */
  private parisBalconies: THREE.Mesh[] = [];

  /** Add cornice bands between floors + iron balconies on upper
   * storeys + a tier-tracking mansard roof. Mirrors the makeBuildingShell
   * vocabulary so the player's restaurant reads as the same Paris
   * Haussmann style as the city's other plot shells. */
  private addParisExteriorDecor(): void {
    const W = 10;
    const H = WorldScene.STOREY_HEIGHT;
    // Building footprint: walls run from -4.5 to +5.5 (W=10 wide,
    // centred on x = 0.5). The +Z (south) face is the front.
    const cornerOffsetCx = 0.5;
    const cornerOffsetCz = 0.5;
    const corniceMat = new THREE.MeshStandardMaterial({
      color: 0xc8b888, roughness: 0.8,
    });
    const balconyMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a, roughness: 0.4, metalness: 0.7,
    });

    // ── Cornice bands ─────────────────────────────────────────────
    // Four thin perimeter strips per floor (not a full square plate —
    // a square would form an indoor ceiling and hide the upper-floor
    // interior from below). One band at the top of each storey
    // (y = (idx+1)*H). Ground-floor cornice lives at threeScene
    // root; upper-floor cornices parent into each storey's group so
    // they inherit the existing tier + focus visibility.
    const cBandH = 0.14;
    const cBandThick = 0.3;
    const cExtra = 0.3; // how far beyond the wall the band sticks out
    const cLong = W + cExtra * 2;
    for (let idx = 0; idx < WorldScene.NUM_STOREYS; idx += 1) {
      const y = (idx + 1) * H - cBandH / 2;
      const halfW = W / 2;
      // Four sides — south (+Z), north (-Z), east (+X), west (-X).
      const southZ = cornerOffsetCz + halfW + cBandThick / 2;
      const northZ = cornerOffsetCz - halfW - cBandThick / 2;
      const eastX = cornerOffsetCx + halfW + cBandThick / 2;
      const westX = cornerOffsetCx - halfW - cBandThick / 2;
      const sideGeo = new THREE.BoxGeometry(cLong, cBandH, cBandThick);
      const endGeo = new THREE.BoxGeometry(cBandThick, cBandH, cLong);
      const mkSide = (g: THREE.BufferGeometry, x: number, z: number) => {
        const m = new THREE.Mesh(g, corniceMat);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.receiveShadow = true;
        return m;
      };
      const pieces = [
        mkSide(sideGeo, cornerOffsetCx, southZ),
        mkSide(sideGeo, cornerOffsetCx, northZ),
        mkSide(endGeo,  eastX, cornerOffsetCz),
        mkSide(endGeo,  westX, cornerOffsetCz),
      ];
      const parent: THREE.Object3D = idx === 0
        ? this.threeScene
        : (this.upperStoreys.get(idx)?.group ?? this.threeScene);
      for (const p of pieces) parent.add(p);
    }

    // ── Iron balconies on upper storey south walls ───────────────
    // For each upper storey, drop one balcony rail + balusters on
    // the +Z (front) face just below the mid-floor window line.
    // Mirrors makeBuildingShell's balcony for the city shells.
    for (let idx = 1; idx < WorldScene.NUM_STOREYS; idx += 1) {
      const storey = this.upperStoreys.get(idx);
      if (!storey) continue;
      const winY = idx * H + 1.5;             // window centre on upper floor
      const railY = winY - 0.85;              // rail sits ~85 cm below window
      const balusterTopY = winY - 0.4;        // baluster top reaches mid-window
      const southZ = cornerOffsetCz + W / 2 + 0.12; // outside front face
      // Horizontal rail.
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(W - 0.3, 0.06, 0.10),
        balconyMat,
      );
      rail.position.set(cornerOffsetCx, railY, southZ);
      storey.group.add(rail);
      this.parisBalconies.push(rail);
      // Balusters reduced to a SECOND horizontal bar instead of ~22
      // individual vertical posts per floor. The original loop was
      // 88 baluster meshes on the player's tower alone — at iso
      // distance the verticals were barely visible anyway. Single
      // extra rail gives the visual two-band fence look at 1/22nd
      // the draw-call cost.
      void balusterTopY; // kept for future detail-mode rendering
      const lowerRail = new THREE.Mesh(
        new THREE.BoxGeometry(W - 0.3, 0.04, 0.08),
        balconyMat,
      );
      lowerRail.position.set(cornerOffsetCx, railY - 0.35, southZ);
      storey.group.add(lowerRail);
      this.parisBalconies.push(lowerRail);
    }

    // ── Mansard roof ──────────────────────────────────────────────
    // Two pieces — slate-grey body + slightly inset darker cap — same
    // recipe as makeBuildingShell. Position.y is recomputed every
    // time setLuxuryTier / setExteriorMode runs so it always sits on
    // the topmost unlocked storey. Visibility is exterior-only.
    const mansardH = 1.2;
    const mansard = new THREE.Mesh(
      new THREE.BoxGeometry(W + 0.2, mansardH, W + 0.2),
      new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.05 }),
    );
    mansard.position.set(cornerOffsetCx, H + mansardH / 2, cornerOffsetCz);
    mansard.castShadow = true;
    mansard.visible = false;
    this.threeScene.add(mansard);
    this.parisMansard = mansard;
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(W - 0.6, 0.1, W - 0.6),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.55 }),
    );
    cap.position.set(cornerOffsetCx, H + mansardH + 0.05, cornerOffsetCz);
    cap.visible = false;
    this.threeScene.add(cap);
    this.parisMansardCap = cap;
    // Brick chimney on the back-right corner.
    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1.1, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x9a6850, roughness: 0.9 }),
    );
    chimney.position.set(
      cornerOffsetCx + W / 2 - 0.8,
      H + mansardH + 0.55,
      cornerOffsetCz - W / 2 + 0.8,
    );
    chimney.castShadow = true;
    chimney.visible = false;
    this.threeScene.add(chimney);
    this.parisMansardChimney = chimney;

    // Also paint the wall material more limestone-cream so it matches
    // the shells' wallColors palette. Per-floor theming clones the
    // material so existing themed saves are unaffected; this only
    // updates the base default.
    if (this.wallMat) {
      this.wallMat.color.setHex(0xe6d5b5);
    }
    if (this.wallExteriorMat) {
      this.wallExteriorMat.color.setHex(0xe6d5b5);
    }
  }

  /** Build a single flight of stairs running from one storey UP TO the
   * next. Procedural box steps with a thin banister on the open
   * (interior-facing) side. Fixed position in the back-right corner
   * of the building so the flights stack cleanly on the same column
   * floor after floor.
   *
   * Phase 2 — visual only, no walking logic. Phase 6 will mark the
   * footprint cells as a traversable transit corridor for the
   * pathfinder. */
  private addStaircaseSegment(parent: THREE.Group, baseY: number): void {
    const STEP_COUNT = 10;
    const STEP_WIDTH = 1.0;                                // X span
    const STEP_DEPTH = 0.3;                                // Z span per step → 3 m total run, 45° slope
    const STEP_RISE  = WorldScene.STOREY_HEIGHT / STEP_COUNT;  // 0.3 m (matches depth for a 1:1 ratio)
    const X_CENTER   = -3.9;                               // flush against the left interior wall (X=-4.4)
    // The TOP of the flight sits at the back-left corner so the player
    // walks INTO the corner as they climb. With STEP_DEPTH=0.3 and 10
    // steps, the top step's centre lands at Z=-4.3 — right against the
    // back wall (interior face at Z=-4.4). The bottom of the flight
    // extends 3 m south into the open floor (down to Z≈-1.5).
    const Z_BOTTOM   = -1.45;                              // low end, ~3 m south of back wall
    const runLen     = STEP_COUNT * STEP_DEPTH;            // 3 m total run
    const lowerY     = baseY - WorldScene.STOREY_HEIGHT;
    const stepMat = new THREE.MeshStandardMaterial({
      color: 0xb0967a, roughness: 0.78, metalness: 0,
    });
    // Steps rise as Z decreases (south → north), so step 0 sits 3 m
    // out from the back wall and step N-1 sits tucked into the back-
    // left corner where the flight meets the upper slab.
    for (let i = 0; i < STEP_COUNT; i += 1) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(STEP_WIDTH, STEP_RISE, STEP_DEPTH),
        stepMat,
      );
      step.position.set(
        X_CENTER,
        lowerY + STEP_RISE * (i + 0.5),
        Z_BOTTOM - STEP_DEPTH * (i + 0.5),
      );
      step.castShadow = true;
      step.receiveShadow = true;
      parent.add(step);
    }
    // Slim banister along the interior-facing edge so the stairs read
    // as a staircase from the iso angle, not just a stack of slabs.
    // The staircase hugs the LEFT wall, so the open side faces EAST —
    // banister sits just inside the staircase's east edge.
    const banisterMat = new THREE.MeshStandardMaterial({
      color: 0x8a6e54, roughness: 0.7,
    });
    const railX = X_CENTER + STEP_WIDTH / 2 - 0.04;        // just inside the right edge
    const railLen = Math.sqrt(runLen * runLen + WorldScene.STOREY_HEIGHT * WorldScene.STOREY_HEIGHT);
    const railThickness = 0.04;
    // Rail: a thin box rotated to match the step slope. Center sits at
    // the midpoint of the run (1 m north of Z_BOTTOM).
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(railThickness, railThickness, railLen),
      banisterMat,
    );
    rail.position.set(
      railX,
      lowerY + WorldScene.STOREY_HEIGHT / 2 + 0.85,        // ~hand height above the steps
      Z_BOTTOM - runLen / 2,
    );
    // Positive rotation so the rail's high end sits at the TOP of the
    // flight (Z=-4.4, near the back wall) and the low end at the BOTTOM
    // (Z=-2.4, out in the open). Without this sign the rail tilts
    // backwards — high at the south end, low at the corner — which
    // reads as a misaligned support bar against the steps.
    rail.rotation.x = Math.atan2(WorldScene.STOREY_HEIGHT, runLen);
    rail.castShadow = true;
    parent.add(rail);
    // Two short posts: one at the bottom (Z_BOTTOM, ground level) and
    // one at the top (Z_BOTTOM − runLen, upper slab level / corner).
    for (const t of [0, 1]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(railThickness, 0.95, railThickness),
        banisterMat,
      );
      post.position.set(
        railX,
        lowerY + t * WorldScene.STOREY_HEIGHT + 0.45,
        Z_BOTTOM - t * runLen,
      );
      post.castShadow = true;
      parent.add(post);
    }
  }

  // === Dynamic perimeter walls ===============================================
  // All four perimeter walls are segmented now. Doors cut a full-height
  // gap with a lintel above; windows cut a sill + lintel partial gap so
  // the player can see through them from either side. Each wall has a
  // multi-material box geometry so the inside face wears the interior
  // colour and the outside face wears the building's exterior colour —
  // until the camera lands on the wall's outdoor side, at which point
  // the whole wall (every segment) flips to the ghost see-through.

  /** Outdoor-axis end coordinates for each wall (along the wall's main
   * axis). Together these give the building a 10×10 interior. */
  private static readonly WALL_AXIS_MIN = -4.5;
  private static readonly WALL_AXIS_MAX = 5.5;
  /** Half-tile gap each opening punches in the wall. */
  private static readonly OPENING_HALF = 0.5;
  /** Sill / lintel heights for a window opening. Sill = 0 → 0.9 m,
   * window itself runs 0.9 → 2.2 m, lintel = 2.2 → 3.0 m. */
  private static readonly WINDOW_SILL_TOP = 0.9;
  private static readonly WINDOW_LINTEL_BOTTOM = 2.2;

  /** Rebuild one perimeter wall from scratch around the supplied
   * openings. Door positions are along the wall's main axis (X for
   * front/back, Z for left/right) and produce a full-height gap with
   * a 1 m lintel above. Window positions produce a sill + window
   * opening + lintel, leaving the middle band see-through so the
   * actual window mesh placed on top is what the player looks
   * through. */
  rebuildPerimeterWall(floor: number, dir: WallDir, doorEdges: number[], windowEdges: number[]): void {
    const floorMap = this.perimeterWalls.get(floor);
    if (!floorMap) return;
    const state = floorMap.get(dir);
    if (!state) return;
    state.doors = [...doorEdges];
    state.windows = [...windowEdges];
    const parent = state.parent ?? this.threeScene;
    const yOffset = state.yOffset ?? 0;
    const wallMat = state.wallMatRef ?? this.wallMat;
    // Tear down every existing mesh + free its geometry. Remove from
    // whichever parent the segments live under (scene for floor 0,
    // storey group for upper floors).
    for (const m of state.meshes) {
      parent.remove(m);
      m.geometry.dispose();
    }
    state.meshes.length = 0;

    const axisMin = WorldScene.WALL_AXIS_MIN;
    const axisMax = WorldScene.WALL_AXIS_MAX;
    const halfGap = WorldScene.OPENING_HALF;
    const sillTop = WorldScene.WINDOW_SILL_TOP;
    const lintelBottom = WorldScene.WINDOW_LINTEL_BOTTOM;

    // Build a sorted list of openings (mixed door + window) so the
    // segment loop walks them left-to-right exactly once.
    const openings: { center: number; type: "door" | "window" }[] = [
      ...doorEdges.filter((c) => c > axisMin && c < axisMax).map((c) => ({ center: c, type: "door" as const })),
      ...windowEdges.filter((c) => c > axisMin && c < axisMax).map((c) => ({ center: c, type: "window" as const })),
    ].sort((a, b) => a.center - b.center);

    const mats = this.materialsFor(dir, state.currentMat, wallMat);
    const addBox = (
      axisFrom: number, axisTo: number,
      yCenter: number, yHeight: number,
    ): void => {
      const span = axisTo - axisFrom;
      if (span < 0.04 || yHeight < 0.04) return;
      const center = (axisFrom + axisTo) / 2;
      const geom = this.wallBoxFor(dir, span, yHeight);
      const mesh = new THREE.Mesh(geom, mats);
      // yOffset lifts every segment up to its storey's slab so the same
      // 1.5 / 2.5 / sillTop centres still produce a wall that hugs the
      // floor and ceiling on storey > 0.
      const pos = this.wallSegmentPosition(dir, center, yCenter + yOffset);
      mesh.position.copy(pos);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      state.meshes.push(mesh);
    };

    let segStart = axisMin;
    for (const op of openings) {
      const gapStart = op.center - halfGap;
      const gapEnd = op.center + halfGap;
      // Continuous wall segment up to this opening.
      addBox(segStart, gapStart, 1.5, 3.0);
      if (op.type === "door") {
        // Full-height gap with a 1 m lintel sitting at the top.
        addBox(gapStart, gapEnd, 2.5, 1.0);
      } else {
        // Window: 0..sillTop is the sill, lintelBottom..3 is the lintel,
        // the middle band stays open so the placed window mesh shows.
        addBox(gapStart, gapEnd, sillTop / 2, sillTop);
        const lintelH = 3 - lintelBottom;
        addBox(gapStart, gapEnd, lintelBottom + lintelH / 2, lintelH);
      }
      segStart = gapEnd;
    }
    addBox(segStart, axisMax, 1.5, 3.0);
  }

  /** Geometry for a single wall box. Direction picks which axis the
   * width sits along — front/back stretch along X, left/right along
   * Z — keeping the 0.2 m thickness on the perpendicular axis. */
  private wallBoxFor(dir: WallDir, span: number, yHeight: number): THREE.BoxGeometry {
    if (dir === "front" || dir === "back") {
      return new THREE.BoxGeometry(span, yHeight, 0.2);
    }
    return new THREE.BoxGeometry(0.2, yHeight, span);
  }

  /** World position of a wall segment given its centre along the wall
   * axis and its centre Y. Building interior is shifted by (0.5, 0.5)
   * to match the tile grid, but the perimeter coords are absolute. */
  private wallSegmentPosition(dir: WallDir, axisCentre: number, yCentre: number): THREE.Vector3 {
    switch (dir) {
      case "front": return new THREE.Vector3(axisCentre, yCentre,  5.5);
      case "back":  return new THREE.Vector3(axisCentre, yCentre, -4.5);
      case "left":  return new THREE.Vector3(-4.5, yCentre, axisCentre);
      case "right": return new THREE.Vector3( 5.5, yCentre, axisCentre);
    }
  }

  /** Per-face material array for a wall box. Inside face uses
   * wallMat, outside face uses wallExteriorMat, top / bottom / end-
   * caps fall back to wallMat. Returns six copies of wallGhostMat
   * when the wall is currently ghost-faded (camera on its outside). */
  private materialsFor(dir: WallDir, kind: "solid" | "ghost", wallMat?: THREE.MeshStandardMaterial): THREE.Material[] {
    if (kind === "ghost") {
      return [
        this.wallGhostMat, this.wallGhostMat, this.wallGhostMat,
        this.wallGhostMat, this.wallGhostMat, this.wallGhostMat,
      ];
    }
    // Per-storey clone if supplied (upper floors), shared wallMat otherwise.
    const int = wallMat ?? this.wallMat;
    const ext = this.wallExteriorMat;
    // BoxGeometry face order: [+X, -X, +Y, -Y, +Z, -Z].
    switch (dir) {
      case "front": return [int, int, int, int, ext, int];
      case "back":  return [int, int, int, int, int, ext];
      case "left":  return [int, ext, int, int, int, int];
      case "right": return [ext, int, int, int, int, int];
    }
  }

  /** Legacy entry-point — Engine still calls this when only doors
   * changed. Forwards into the new system with the wall's current
   * window list preserved. */
  rebuildFrontWall(doorXs: readonly number[]): void {
    const state = this.perimeterWalls.get(0)?.get("front");
    if (!state) return;
    this.rebuildPerimeterWall(0, "front", [...doorXs], state.windows);
  }

  /** Re-render every perimeter wall on EVERY floor from the supplied
   * openings. Engine groups openings by floor + direction so a window
   * placed on Floor 1 only rebuilds Floor 1's walls. Floors with no
   * matching state (storey not built yet) are silently skipped. */
  rebuildAllPerimeterWalls(openingsByFloor: Map<number, Record<WallDir, { doors: number[]; windows: number[] }>>): void {
    for (const [floor, byDir] of openingsByFloor) {
      if (!this.perimeterWalls.has(floor)) continue;
      this.rebuildPerimeterWall(floor, "front", byDir.front.doors, byDir.front.windows);
      this.rebuildPerimeterWall(floor, "back",  byDir.back.doors,  byDir.back.windows);
      this.rebuildPerimeterWall(floor, "left",  byDir.left.doors,  byDir.left.windows);
      this.rebuildPerimeterWall(floor, "right", byDir.right.doors, byDir.right.windows);
    }
    // Floors with state but no entry in the openings map need a rebuild
    // too — that's what fires when the last window on a storey is sold
    // (the floor drops out of the openings map entirely). Reset them to
    // empty so the cut is filled back in.
    for (const [floor] of this.perimeterWalls) {
      if (openingsByFloor.has(floor)) continue;
      this.rebuildPerimeterWall(floor, "front", [], []);
      this.rebuildPerimeterWall(floor, "back",  [], []);
      this.rebuildPerimeterWall(floor, "left",  [], []);
      this.rebuildPerimeterWall(floor, "right", [], []);
    }
  }

  /** Swap wall materials so the two walls closest to the camera become
   * the transparent ghost and the two far walls stay solid. Driven by
   * the dot product of each wall's outward normal with the camera's
   * world position relative to the building centre — positive means the
   * camera is on the wall's outer face. */
  updateWallVisibility(cameraPos: THREE.Vector3): void {
    if (!this.wallMat || !this.wallGhostMat) return;
    // In exterior mode (player zoomed out past 40%), every wall is
    // solid — the building reads as a closed box, no see-through to
    // the interior. Skip the camera-relative ghost calculation.
    const kindFor = (normalX: number, normalZ: number): "solid" | "ghost" => {
      if (this.exteriorMode) return "solid";
      const dot = normalX * cameraPos.x + normalZ * cameraPos.z;
      return dot > 0 ? "ghost" : "solid";
    };
    const backKind  = kindFor(0, -1);
    const leftKind  = kindFor(-1, 0);
    const rightKind = kindFor(1, 0);
    const frontKind = kindFor(0, 1);
    this.applyWallKind("back",  backKind);
    this.applyWallKind("left",  leftKind);
    this.applyWallKind("right", rightKind);
    this.applyWallKind("front", frontKind);
    // Visible upper-storey walls follow the same 2-camera-side-ghost /
    // 2-back-solid rule as the ground floor. Storeys ABOVE the focused
    // storey are already entirely hidden by applyStoreyVisibility, so
    // there's no slab/roof ghost work to do here — only the visible
    // storeys (focused + below) walk through this loop.
    const dirKinds: Record<WallDir, "solid" | "ghost"> = {
      back: backKind, left: leftKind, right: rightKind, front: frontKind,
    };
    void dirKinds; // applyWallKind already updates each storey's wall
                   // segments via the per-floor perimeterWalls map.
    for (const [, storey] of this.upperStoreys) {
      if (!storey.group.visible) continue;
      // Slab is solid (it's the floor of THIS storey, the ceiling of
      // the one below). Always solid because we only render at-or-
      // below focus. Use the STOREY's cloned material so the per-floor
      // theme picked in DecorModal sticks — without this we used to
      // reassign back to the shared slabMatSolid every frame and the
      // upper floors stayed off-white regardless of theme selection.
      storey.slab.material = storey.slabMat;
      // Walls used to be single static meshes managed here; now they're
      // the segmented per-floor perimeterWalls system rebuilt on the
      // floor's openings and ghosted by applyWallKind. The storey.walls
      // map stays present (empty) for interface compatibility but is no
      // longer the source of truth.
    }
    // Roof similarly: only renders when focused on the top storey;
    // always solid in that case.
    if (this.buildingRoof && this.buildingRoof.visible) {
      this.buildingRoof.material = this.roofMatSolid;
    }
  }

  /** Switch one wall's segments between solid (multi-mat) and ghost on
   * every floor. The same camera-relative dir → kind mapping applies to
   * every storey, so all floors get flipped together (e.g. when the
   * camera ends up on the +Z side of the building, the front wall on
   * the ground floor AND every upper floor goes ghost). */
  private applyWallKind(dir: WallDir, kind: "solid" | "ghost"): void {
    for (const [, floorMap] of this.perimeterWalls) {
      const state = floorMap.get(dir);
      if (!state || state.currentMat === kind) continue;
      state.currentMat = kind;
      const mats = this.materialsFor(dir, kind, state.wallMatRef);
      for (const m of state.meshes) m.material = mats;
    }
  }

  // === Exterior — grass, wildflowers, trees, rocks ============================
  //
  // Replaces the old "noisy vertex-coloured plane + 400 dark cones"
  // exterior with a richer system:
  //
  //   1. Ground plane uses a procedurally-painted canvas texture
  //      (multiple soft Perlin-style blobs across cool green tones)
  //      so the lawn reads as organic patches of varying density
  //      instead of pixelated noise.
  //   2. ~2500 instanced grass-blade "tufts" built from two
  //      perpendicular planes (so the blade is visible from any
  //      angle), each plane painted with a gradient blade.
  //   3. ~150 wildflowers — tiny brightly-coloured discs scattered
  //      sparsely to add pops of colour.
  //   4. ~22 low-poly trees (cone canopy + cylinder trunk) for
  //      vertical interest.
  //   5. ~30 small grey rocks for ground texture.
  //
  // Every prop skips the building interior + the sidewalk / road
  // strip in front so the player's view of the door stays clean.

  private addGrassyExterior(): void {
    this.addGroundPlane();
    this.addGrassBlades();
    this.addWildflowers();
    this.addLawnTrees();
    this.addRocks();
    // Legacy local pavement (addPavementAndRoad) is intentionally NOT
    // called — its z=13.5 road duplicates the SHARED city avenue at
    // the same position for plots in the middle row and Z-fights with
    // every other plot's nearest avenue. The world avenues now serve
    // as the player's main street regardless of plot row, with the
    // street-follow scenery dropping houses + shops along each one.
    this.addGardenArea();
  }

  /** Bounds of the future tier-6 garden — east of the building, mirror
   * dimensions of the building footprint along z. Exposed as a static
   * so the exclusion-zone check and the fence builder share one source
   * of truth. */
  private static readonly GARDEN_BOUNDS = {
    minX: 6.5, maxX: 14.5,
    minZ: -4.5, maxZ: 5.5,
  };

  /** Wooden picket fence + "Coming Soon" sign marking the area
   * reserved for the future tier-6 garden expansion. Pure decor for
   * now — when tier 6 unlocks, the east perimeter wall will accept
   * one door cut into it (similar to the windows pipeline) and a
   * gameplay garden will replace the placeholder. */
  private addGardenArea(): void {
    const b = WorldScene.GARDEN_BOUNDS;
    const fence = new THREE.Group();
    // Light cosy wood for the rails + posts, slightly darker for the
    // post caps so the silhouette reads as separate pieces.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xa07042, roughness: 0.9 });
    const capMat  = new THREE.MeshStandardMaterial({ color: 0x6a4220, roughness: 0.85 });
    const postH = 1.05, postW = 0.10;
    const railH = 0.06, railD = 0.06;
    const upperY = 0.78, lowerY = 0.30;
    const postSpacing = 1.0;  // one post per metre — reads as a real picket fence
    // Helper to drop a single post at (x, z).
    const addPost = (x: number, z: number): void => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(postW, postH, postW), postMat);
      post.position.set(x, postH / 2, z);
      post.castShadow = true;
      post.receiveShadow = true;
      fence.add(post);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(postW * 1.4, 0.07, postW * 1.4), capMat);
      cap.position.set(x, postH + 0.04, z);
      cap.castShadow = true;
      fence.add(cap);
    };
    // Posts along the four sides.
    for (let x = b.minX; x <= b.maxX; x += postSpacing) {
      addPost(x, b.minZ);
      addPost(x, b.maxZ);
    }
    for (let z = b.minZ + postSpacing; z < b.maxZ; z += postSpacing) {
      addPost(b.minX, z);
      addPost(b.maxX, z);
    }
    // Horizontal rails spanning each side at upper + lower heights.
    const addRail = (x: number, z: number, length: number, axis: "x" | "z", y: number): void => {
      const geom = axis === "x"
        ? new THREE.BoxGeometry(length, railH, railD)
        : new THREE.BoxGeometry(railD, railH, length);
      const rail = new THREE.Mesh(geom, railMat);
      rail.position.set(x, y, z);
      rail.castShadow = true;
      rail.receiveShadow = true;
      fence.add(rail);
    };
    const width = b.maxX - b.minX;
    const depth = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    // North + south rails (along X). Leave a 1.2 m gap in the middle
    // of the WEST side (facing the building) — a future gate position
    // so the player can see it'll connect to the east wall.
    addRail(cx, b.minZ, width, "x", upperY);
    addRail(cx, b.minZ, width, "x", lowerY);
    addRail(cx, b.maxZ, width, "x", upperY);
    addRail(cx, b.maxZ, width, "x", lowerY);
    // East rail (along Z).
    addRail(b.maxX, cz, depth, "z", upperY);
    addRail(b.maxX, cz, depth, "z", lowerY);
    // West rail (along Z) — split with a 1.2 m centred gap for the
    // future door opening. Each side spans (depth - gap) / 2.
    const gateGap = 1.2;
    const halfSide = (depth - gateGap) / 2;
    const northHalfCz = b.minZ + halfSide / 2;
    const southHalfCz = b.maxZ - halfSide / 2;
    addRail(b.minX, northHalfCz, halfSide, "z", upperY);
    addRail(b.minX, northHalfCz, halfSide, "z", lowerY);
    addRail(b.minX, southHalfCz, halfSide, "z", upperY);
    addRail(b.minX, southHalfCz, halfSide, "z", lowerY);
    this.threeScene.add(fence);
    // === Coming Soon sign in the centre ===
    const signPostH = 1.4;
    const signPost = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, signPostH, 0.10),
      new THREE.MeshStandardMaterial({ color: 0x5a3e1e, roughness: 0.9 }),
    );
    signPost.position.set(cx, signPostH / 2, cz);
    signPost.castShadow = true;
    this.threeScene.add(signPost);
    // Sign board — canvas-painted "COMING SOON / GARDEN EXPANSION".
    const signTex = WorldScene.makeComingSoonTexture();
    const signMat = new THREE.MeshStandardMaterial({
      map: signTex, transparent: false, roughness: 0.7,
      side: THREE.DoubleSide,
    });
    const signBoard = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), signMat);
    signBoard.position.set(cx, 1.7, cz);
    // Face north (toward the building) so the player sees the writing
    // from inside the restaurant.
    signBoard.rotation.y = Math.PI;
    signBoard.castShadow = true;
    this.threeScene.add(signBoard);
    // Frame around the sign for some depth.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3e2810, roughness: 0.85 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.1, 0.06), frameMat);
    frame.position.set(cx, 1.7, cz + 0.02);
    frame.castShadow = true;
    this.threeScene.add(frame);
  }

  /** Procedural "COMING SOON" sign texture — warm cream background
   * with bold dark lettering. Read from across the restaurant. */
  private static makeComingSoonTexture(): THREE.CanvasTexture {
    const w = 512, h = 256;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#f4e8c8";
    ctx.fillRect(0, 0, w, h);
    // Inner border accent
    ctx.strokeStyle = "#7a4a20";
    ctx.lineWidth = 6;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = "#3a1f08";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "900 70px Georgia, serif";
    ctx.fillText("COMING SOON", w / 2, h / 2 - 38);
    ctx.font = "700 36px Georgia, serif";
    ctx.fillStyle = "#5e3a10";
    ctx.fillText("Garden Expansion", w / 2, h / 2 + 38);
    // Small leaf accent — two little arcs to suggest greenery.
    ctx.fillStyle = "#3a7a3a";
    ctx.beginPath();
    ctx.ellipse(80, h - 50, 24, 12, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(w - 80, h - 50, 24, 12, 0.4, 0, Math.PI * 2);
    ctx.fill();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  /** Big ground plane painted with a canvas texture of soft green
   * patches. The texture repeats so the lawn fills the whole 90×90 m
   * area without revealing the seam. (Bumped from 70 to 90 so the
   * full-map-width road + pavements don't poke past the lawn edge.) */
  private addGroundPlane(): void {
    const tex = WorldScene.makeGrassTexture();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Tile density matches what 360 m looked good at (22 tiles).
    // Scale to the bigger plane so each tile is still ~16 m square.
    tex.repeat.set(96, 96);
    // 1500×1500 grass — big enough that the camera's max zoom-out
    // (half-view 200, so a 16:9 viewport is ~712×400 m) PLUS any
    // pan + rotation can't see a hard plane edge. Visually the city
    // still ends around ±110 m (no scenery beyond that) and fog
    // takes over by ~250 m from the camera, so the player just sees
    // warm haze where the lawn would otherwise show its boundary.
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(1500, 1500),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, metalness: 0 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.01;
    grass.receiveShadow = true;
    this.worldRoot.add(grass);
    // City roads + scenery houses. Streets come first so the
    // building placement pass can avoid sitting on top of them.
    this.addCityStreets();
    // Pedestrian zebra crossings at every intersection — drawn on
    // top of the spots where one street's pavement currently
    // crosses the other street's road (which would otherwise
    // render as a confusing beige-on-asphalt patch). Placed
    // BEFORE scenery so any scenery overlap rule based on
    // visible elements is computed against the painted layer.
    this.addPedestrianCrossings();
    this.addCityScenery();
    // Pavement lamp posts run along every avenue, on BOTH pavements,
    // symmetrically spaced so the city reads as a planned grid at
    // night. Lights themselves are a small pool that follows the
    // camera — see updateStreetLamps for how the pool gets routed.
    this.addStreetLamps();
    // Street planters — concrete boxes / cylinders / troughs scattered
    // along the same pavements, slotted BETWEEN lamps. Three styles
    // cycled so the pavement reads as a curated little garden strip
    // instead of an empty grey slab.
    this.addStreetPlanters();
  }

  /** City avenue grid laid out so every plot row lines a street:
   *   - east-west at z=-36  (north service — z=-48 plots line it from north)
   *   - east-west at z=+13.5 (legacy main — player's restaurant lines it)
   *   - east-west at z=+62  (south service — z=+48 plots line it from north)
   *   - north-south at x=-70 (outer-ring west boundary)
   *   - north-south at x=+70 (outer-ring east boundary)
   * Three east-west "boulevards" feed the three plot rows; two
   * outer-ring N-S avenues bracket the city. Scenery houses line
   * the remaining street frontage on both sides of every avenue
   * (see addCityScenery — street-following placement, not a random
   * grid scan). */
  private addCityStreets(): void {
    // THREE EW avenues, one DIRECTLY in front of each plot row.
    // Plot rows centered at z=-48, 0, +48; plot height 12 m so the
    // south wall of each row sits at row_z + 6.  Pavement outer
    // edge is 8 m from the avenue centerline (5 m strip starting at
    // perp ±3), so placing the avenue at `row_z + 6 + 8 = row_z + 14`
    // makes the north pavement edge land EXACTLY on the plot's
    // south wall — restaurants step straight onto the curb instead
    // of crossing a 24 m grass strip first.
    //
    //   z=-34 — front curb of row 1 (north pavement at z=-42 = row1 south wall)
    //   z=+14 — front curb of row 2 (north pavement at z=+6  = row2 south wall)
    //   z=+62 — front curb of row 3 (north pavement at z=+54 = row3 south wall)
    //
    // Scenery is auto-suppressed on the NORTH side of each avenue
    // by the overlapsClaim check (it would land inside the plot
    // there), and placed normally on the SOUTH side facing the
    // next row's gardens.
    this.makeCityAvenue("ew", -34);
    this.makeCityAvenue("ew",  14);
    this.makeCityAvenue("ew",  62);
    // NS outer ring — keeps the city visually bounded on the east /
    // west edges and gives the corner / NS-aligned scenery houses
    // a road to follow.
    this.makeCityAvenue("ns", -70);
    this.makeCityAvenue("ns",  70);
  }

  /** Centerlines of every avenue in the city — kept in one place so
   * the scenery street-follow loop, the exclusion check, and any
   * future road-aware system (pedestrian spawner, sign placement)
   * all agree on what counts as a street. Public so PedestrianSpawner
   * can route walkers down them. */
  static readonly EW_AVENUES: readonly number[] = [-34, 14, 62];
  static readonly NS_AVENUES: readonly number[] = [-70, 70];
  /** Half-length of each avenue strip the pedestrian spawner is
   * allowed to walk on. The avenues themselves are drawn 260 m long
   * but the visible city only fills ±110 m before fog takes over —
   * walking outside that range just burns CPU on invisible peds. */
  static readonly AVENUE_WALK_HALF_LEN = 110;

  /** Static reference layout of the 12 seeded plots — kept in one
   * place so the scenery loop, the avenue exclusion check, and the
   * garden generator all agree on where the plots sit. The 13th
   * entry is the legacy player block (centered on the origin) +
   * its existing east-side garden, which is added separately. */
  private static readonly CITY_PLOTS: { x: number; z: number; w: number; h: number }[] = [
    { x: -48, z: -48, w: 8,  h: 8  }, { x: -24, z: -48, w: 10, h: 10 },
    { x:   0, z: -48, w: 12, h: 12 }, { x:  24, z: -48, w: 10, h: 10 },
    { x:  48, z: -48, w: 8,  h: 8  },
    { x: -48, z:   0, w: 10, h: 10 }, { x: -24, z:   0, w: 12, h: 12 },
    { x:  24, z:   0, w: 12, h: 12 }, { x:  48, z:   0, w: 10, h: 10 },
    { x: -24, z:  48, w: 8,  h: 8  }, { x:   0, z:  48, w: 10, h: 10 },
    { x:  24, z:  48, w: 8,  h: 8  },
  ];

  /** Compute the garden bounds for a plot. By default, the garden
   * sits to the EAST of the building (mirrors the legacy player's
   * fenced garden). For plots where the east-side garden would
   * overlap an avenue, the garden is moved to the WEST instead.
   * Garden footprint is 8×10 m (matches the legacy GARDEN_BOUNDS). */
  private static gardenBoundsForPlot(p: { x: number; z: number; w: number; h: number }): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const GW = 8, GD = 10;
    const GAP = 1;
    // Default: east of the building.
    let minX = p.x + p.w / 2 + GAP;
    let maxX = minX + GW;
    let minZ = p.z - GD / 2;
    let maxZ = p.z + GD / 2;
    // If the east garden would hit the east outer-ring avenue (x=+70 ±5.5)
    // OR overlap the next plot to the east, mirror to the west side.
    const eastAvenueZone = minX < 75.5 && maxX > 64.5;
    if (eastAvenueZone) {
      const wMinX = p.x - p.w / 2 - GAP - GW;
      const wMaxX = p.x - p.w / 2 - GAP;
      minX = wMinX;
      maxX = wMaxX;
    }
    return { minX, maxX, minZ, maxZ };
  }

  /** Build one full asphalt avenue at the given axis offset. The
   * avenue runs the full 260 m city span and includes pavements +
   * curbs + lane dashes, matching the legacy main road. `orientation`
   * = "ew" means the strip runs along X (constant Z); "ns" means
   * along Z (constant X). */
  private makeCityAvenue(orientation: "ew" | "ns", offset: number, length = 260, alongCenter = 0): void {
    const STRIP_LEN = length;
    const pavementMat = new THREE.MeshStandardMaterial({ color: 0xb2a692, roughness: 0.9 });
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x807468, roughness: 0.9 });
    const laneMat = new THREE.MeshStandardMaterial({
      color: 0xe6e0c4, roughness: 0.85,
      emissive: 0xe6e0c4, emissiveIntensity: 0.05,
    });
    // Z layout when orientation === "ew" (X axis when "ns"):
    //   inner pavements at ±4.5 from the centre line
    //   curbs at ±3
    //   asphalt road spans ±3 (6 m wide, same as legacy)
    // For "ns" we just swap which axis is which. alongCenter shifts
    // the strip along its long axis so shorter avenues (e.g. a
    // middle-block NS link) can sit between two plot clusters.
    const place = (mesh: THREE.Mesh, perp: number): void => {
      mesh.rotation.x = -Math.PI / 2;
      if (orientation === "ew") mesh.position.set(alongCenter, 0, offset + perp);
      else                       mesh.position.set(offset + perp, 0, alongCenter);
    };

    const makePavement = (perp: number): void => {
      const geo = orientation === "ew"
        ? new THREE.PlaneGeometry(STRIP_LEN, 5)
        : new THREE.PlaneGeometry(5, STRIP_LEN);
      const p = new THREE.Mesh(geo, pavementMat);
      place(p, perp);
      p.receiveShadow = true;
      this.worldRoot.add(p);
    };
    const makeCurb = (perp: number): void => {
      const geo = orientation === "ew"
        ? new THREE.BoxGeometry(STRIP_LEN, 0.12, 0.18)
        : new THREE.BoxGeometry(0.18, 0.12, STRIP_LEN);
      const c = new THREE.Mesh(geo, curbMat);
      if (orientation === "ew") c.position.set(alongCenter, 0.06, offset + perp);
      else                       c.position.set(offset + perp, 0.06, alongCenter);
      c.castShadow = true;
      c.receiveShadow = true;
      this.worldRoot.add(c);
    };

    makePavement(-5.5);
    makeCurb(-3);
    const roadGeo = orientation === "ew"
      ? new THREE.PlaneGeometry(STRIP_LEN, 6)
      : new THREE.PlaneGeometry(6, STRIP_LEN);
    const road = new THREE.Mesh(roadGeo, roadMat);
    place(road, 0);
    road.receiveShadow = true;
    this.worldRoot.add(road);
    makeCurb(3);
    makePavement(5.5);

    // Lane dashes down the middle — t walks along the strip's free
    // axis, shifted by alongCenter so a short segment's dashes are
    // anchored at the same centre as its road / pavements.
    for (let t = -STRIP_LEN / 2 + 2; t <= STRIP_LEN / 2 - 2; t += 4) {
      const dashGeo = orientation === "ew"
        ? new THREE.PlaneGeometry(1.2, 0.18)
        : new THREE.PlaneGeometry(0.18, 1.2);
      const dash = new THREE.Mesh(dashGeo, laneMat);
      dash.rotation.x = -Math.PI / 2;
      if (orientation === "ew") dash.position.set(alongCenter + t, 0.005, offset);
      else                       dash.position.set(offset, 0.005, alongCenter + t);
      this.worldRoot.add(dash);
    }
  }

  /** Paint zebra-stripe pedestrian crossings at every EW × NS
   * intersection. Each intersection has FOUR arms — one for each
   * cardinal direction — where the pavement of one avenue currently
   * extends across the road of the other, creating a confusing
   * beige-on-asphalt patch. We hide that patch behind a proper
   * crosswalk: stripes painted ON the asphalt, running parallel to
   * the road being crossed (which is the standard real-world layout).
   *
   * Geometry strategy: all stripes for all crossings are baked into
   * ONE merged BufferGeometry → ONE Mesh → ONE draw call. With
   * 3 EW × 2 NS = 6 intersections × 4 arms × 5 stripes = 120 stripe
   * planes total — without the merge that'd be 120 draw calls just
   * for crosswalk paint. */
  private addPedestrianCrossings(): void {
    const STRIPE_COUNT = 5;
    const STRIPE_WIDTH = 0.50;   // dimension PERPENDICULAR to walking direction
    const STRIPE_LENGTH = 4.6;   // dimension PARALLEL to walking direction (<5m pavement depth so it doesn't bleed into grass)
    const STRIPE_PITCH = 1.00;   // center-to-center spacing between stripes
    // Lift the stripes a hair above the road plane so they don't
    // z-fight with the asphalt below. 0.025 is below the curb top
    // (0.12), so the stripes still tuck under the visible curbing.
    const STRIPE_Y = 0.025;

    const geos: THREE.BufferGeometry[] = [];

    /** Build STRIPE_COUNT stripe geometries for one arm of one
     * intersection. `stripeAxis` says which axis the stripe is LONG
     * along — that's parallel to the road being crossed.
     *
     * Centered at (centerX, centerZ): for the north arm of an
     * intersection, that's (ax, az + 5.5); the stripes are then
     * laid out symmetrically across the road they're painted on. */
    const buildArmGeometries = (
      centerX: number, centerZ: number,
      stripeAxis: "alongX" | "alongZ",
    ): void => {
      for (let i = 0; i < STRIPE_COUNT; i += 1) {
        const offset = (i - (STRIPE_COUNT - 1) / 2) * STRIPE_PITCH;
        let geo: THREE.PlaneGeometry;
        let px: number, pz: number;
        if (stripeAxis === "alongX") {
          // Stripe long in X (parallel to EW road), thin in Z.
          // East/west arm of an EW×NS intersection.
          geo = new THREE.PlaneGeometry(STRIPE_LENGTH, STRIPE_WIDTH);
          px = centerX;
          pz = centerZ + offset;
        } else {
          // Stripe long in Z (parallel to NS road), thin in X.
          // North/south arm of an EW×NS intersection.
          geo = new THREE.PlaneGeometry(STRIPE_WIDTH, STRIPE_LENGTH);
          px = centerX + offset;
          pz = centerZ;
        }
        geo.rotateX(-Math.PI / 2);           // lay flat on XZ plane
        geo.translate(px, STRIPE_Y, pz);     // anchor in world coords
        geos.push(geo);
      }
    };

    for (const az of WorldScene.EW_AVENUES) {
      for (const ax of WorldScene.NS_AVENUES) {
        // The four arms of this intersection. Pavement-center perp
        // offset from each avenue's centerline is 5.5 m (matches the
        // pavement plane in makeCityAvenue).
        //
        // North arm: EW pavement crosses NS road. Pedestrians cross
        // east-west, so stripes are parallel to the NS road (long in Z).
        buildArmGeometries(ax, az + 5.5, "alongZ");
        buildArmGeometries(ax, az - 5.5, "alongZ");
        // East/west arm: NS pavement crosses EW road. Pedestrians
        // cross north-south, so stripes are parallel to the EW road
        // (long in X).
        buildArmGeometries(ax + 5.5, az, "alongX");
        buildArmGeometries(ax - 5.5, az, "alongX");
      }
    }

    if (geos.length === 0) return;
    const merged = mergeBufferGeometries(geos, false);
    // mergeBufferGeometries duplicates the vertex data into a new
    // buffer; the source geometries are safe to dispose immediately.
    for (const g of geos) g.dispose();
    if (!merged) {
      console.warn("[WorldScene] failed to merge pedestrian-crossing stripes");
      return;
    }
    // MeshBasicMaterial — crosswalk paint is unlit (it'd look weird
    // for stripes to shade based on the sun angle). Slight off-white
    // so they read as weathered paint instead of clinical pure white.
    const mat = new THREE.MeshBasicMaterial({ color: 0xf2ead6 });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = false;
    // High render order so the stripes draw on top of both the road
    // and the overlapping pavement patches without z-fighting.
    mesh.renderOrder = 1;
    this.worldRoot.add(mesh);
  }

  /** Procedural NPC scenery — ~60 background houses + shops
   * filling the empty grass between the 12 claim plots. Each
   * piece is a small Greek-Island cube with the same vocabulary
   * as the claim-plot shells (whitewashed walls, terra-cotta or
   * blue-domed roofs, a coloured door) but smaller, randomised
   * colours, and never on a street.
   *
   * Stable pseudo-RNG (mulberry32 seeded from a fixed constant)
   * so the city layout is identical across reloads — players can
   * use neighbouring houses as landmarks. */
  private addCityScenery(): void {
    const sceneryGroup = new THREE.Group();
    this.worldRoot.add(sceneryGroup);

    // Plots + garden zones the scenery must NOT overlap. Same data
    // the populateCityBuildings + fence code uses, so the keep-outs
    // exactly match what the player will see on the ground.
    const claimPlots: { x: number; z: number; w: number; h: number }[] = WorldScene.CITY_PLOTS.slice();
    const gardenZones = claimPlots.map((p) => WorldScene.gardenBoundsForPlot(p));
    // Legacy player block keep-out — covers restaurant + east-side
    // garden. The old main avenue at z=+13.5 is gone (replaced by
    // the plot-driven grid z=-66, -24, +24, +66), so the keep-out
    // no longer needs to swallow a pavement strip. Tightened to
    // span only the restaurant footprint (~12×12 m centered on
    // origin) plus a 1 m buffer all around. This lets scenery
    // houses hug the new z=-24 and z=+24 roads' centerlines
    // without false overlap on the player's plot.
    claimPlots.push({ x: 0, z: 0, w: 14, h: 14 });

    const overlapsClaim = (x: number, z: number, size: number): boolean => {
      const halfS = size / 2 + 1.5;
      for (const c of claimPlots) {
        if (Math.abs(x - c.x) < (c.w / 2 + halfS) && Math.abs(z - c.z) < (c.h / 2 + halfS)) {
          return true;
        }
      }
      return false;
    };
    const overlapsGarden = (x: number, z: number, size: number): boolean => {
      const halfS = size / 2 + 0.8;
      for (const g of gardenZones) {
        if (x > g.minX - halfS && x < g.maxX + halfS &&
            z > g.minZ - halfS && z < g.maxZ + halfS) return true;
      }
      return false;
    };
    // Avenue keep-out — rejects house centres that would overlap
    // the pavement plane. Pavement extends ±5.5 m from each avenue
    // centerline; a house of width `size` has half-width `size/2`,
    // so a house whose CENTER is closer than 5.5 + size/2 would
    // partially overlap the pavement. The filter rejects that.
    //
    // OLD (buggy): buf = size/2 + 6.5 with a "safety margin" of 1 m
    // on top of the pavement half-width. That bug rejected EVERY
    // scenery house the EW/NS placement loops tried to create:
    // the loops position houses with their street-facing edge
    // exactly AT the curb (centre at PAVEMENT_HALF + size/2 from
    // the avenue), so distance == 5.5 + size/2, which was strictly
    // < 6.5 + size/2 → rejected. Result: every avenue stayed bare.
    //
    // FIXED: drop the unneeded safety margin so a house placed
    // flush against the curb (centre at exactly PAVEMENT_HALF +
    // size/2) passes the strict-less-than test by sitting at the
    // boundary. The size-aware placement above is the actual source
    // of truth for the position; this filter just stops candidates
    // that would land ON the asphalt.
    const onAvenue = (x: number, z: number, size: number): boolean => {
      const buf = size / 2 + 5.5;
      for (const az of WorldScene.EW_AVENUES) {
        if (Math.abs(z - az) < buf) return true;
      }
      for (const ax of WorldScene.NS_AVENUES) {
        if (Math.abs(x - ax) < buf) return true;
      }
      return false;
    };

    // Seeded RNG so the city layout is reproducible.
    const rng = mulberry32(0xC02FB157);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

    // Paris palette — warm cream-limestone walls (subtle hue shifts so
    // the rue doesn't read as a uniform paint store), slate-grey
    // mansard roofs (3 variants for visual rhythm), dark wood doors.
    const wallColors = [0xe6d5b5, 0xddc9a8, 0xe8d8b8, 0xd6c2a0, 0xefe0c0, 0xddc9b0];
    const roofColors = [0x3a4048, 0x2e343c, 0x444a52, 0x363c44];
    const doorColors = [0x3a261a, 0x4a3020, 0x2a1a10, 0x5a4030, 0x301c0e];

    // Shop names — small fraction of buildings on the street get a
    // storefront sign. Mixed traditional Paris commerce vocabulary.
    const shopNames = [
      "Boulangerie", "Café", "Tabac", "Pâtisserie", "Épicerie",
      "Brasserie", "Fleuriste", "Librairie", "Pharmacie", "Charcuterie",
      "Fromagerie", "Boucherie", "Chocolaterie", "Bar",
    ];

    // ── Street-following placement ────────────────────────────────
    // Walk along each avenue and drop houses on BOTH sides, packed
    // tight against the pavement curb. Per-house setback is computed
    // from the house's own width so the street-facing edge always
    // sits exactly at the curb edge regardless of how wide the
    // randomly-rolled house is — see the size-aware perpendicular
    // offset inside the loop. Owner spec: "buildings must touch the
    // pavement, no grass strip between."
    //
    // Pavement extends ±PAVEMENT_HALF m from the avenue centerline.
    // House's street-facing edge sits at exactly PAVEMENT_HALF +
    // CURB_EPSILON (a hair off the curb so the polygon doesn't z-
    // fight with the pavement plane). House centre = PAVEMENT_HALF
    // + CURB_EPSILON + size/2 from centerline.
    const PAVEMENT_HALF = 5.5;
    const CURB_EPSILON = 0.05;
    const HOUSE_STEP = 7;          // dense spacing → houses fill every street
    const STREET_EXTENT = 130;     // walk ±this along each avenue
    let placed = 0;
    // Lifted cap from 180 → 300 to populate all three EW avenues +
    // both NS edges without running out of slots. Each scenery
    // house is ~15 meshes; 300 * 15 = ~4500 draw calls — within
    // the GPU budget on mid-range machines (was 320 originally,
    // 180 was a perf-reaction overshoot).
    const HARD_CAP = 300;

    // Track placed shops so the "every plot has a shop within 30 m"
    // post-pass can decide whether to force-convert a nearby house.
    const placedShops: { x: number; z: number }[] = [];
    const placedHouses: { x: number; z: number; group: THREE.Group; isShop: boolean }[] = [];

    const tryPlace = (x: number, z: number, size: number, storeys: number, rotY: number, shopName?: string): boolean => {
      if (overlapsClaim(x, z, size)) return false;
      if (overlapsGarden(x, z, size)) return false;
      if (onAvenue(x, z, size)) return false;
      const house = this.makeSceneryHouse(
        x, z, size, storeys,
        pick(wallColors), pick(roofColors), pick(doorColors),
        rotY, shopName,
      );
      sceneryGroup.add(house);
      placedHouses.push({ x, z, group: house, isShop: !!shopName });
      // Track footprint so the grass / wildflower / tree / rock scatter
      // passes know to skip this tile. halfSize = size/2 + small skin
      // so a tree right against a wall doesn't poke through the eaves.
      this.placedSceneryHouses.push({ x, z, halfSize: size / 2 + 0.4 });
      if (shopName) placedShops.push({ x, z });
      placed += 1;
      return true;
    };

    // House front (door + windows) sits on +Z by default. To face an
    // avenue you rotate so that the +Z local axis ends up pointing
    // toward the avenue's centreline.
    //
    // East-west avenues — north-side houses face south (rotY=0, +Z=+Z),
    // south-side houses face north (rotY=π, +Z→-Z).
    for (const az of WorldScene.EW_AVENUES) {
      for (const side of [-1, +1] as const) {
        const rotY = side > 0 ? Math.PI : 0;
        for (let x = -STREET_EXTENT; x <= STREET_EXTENT; x += HOUSE_STEP) {
          if (placed >= HARD_CAP) break;
          // Light random skip so the row isn't a perfectly uniform
          // wall (~10 % gaps).
          if (rng() < 0.10) continue;
          const size = 4 + Math.floor(rng() * 3); // 4..6 tiles wide
          const storeys = 1 + Math.floor(rng() * 2); // 1..2
          // Size-aware perpendicular offset: house's street-facing
          // edge sits exactly at the curb (PAVEMENT_HALF + small
          // epsilon to avoid z-fighting). NO perpendicular jitter
          // — that's what was leaving inconsistent grass strips.
          const baseZ = az + side * (PAVEMENT_HALF + CURB_EPSILON + size / 2);
          // Mild ALONG-street jitter only — keeps the row from
          // reading as a barcode without ever pulling a house off
          // the curb line.
          const jx = x + (rng() - 0.5) * 1.4;
          const isShop = rng() < 0.32;
          const shopName = isShop ? pick(shopNames) : undefined;
          tryPlace(jx, baseZ, size, storeys, rotY, shopName);
        }
      }
    }
    // North-south avenues — west-side houses (x < ax) should face
    // east (+X). Right-hand rule for Y-rotation: rotY=+π/2 rotates
    // +Z (default front) → +X. Mirror for east side.
    for (const ax of WorldScene.NS_AVENUES) {
      for (const side of [-1, +1] as const) {
        // side > 0 = EAST of avenue → face WEST → rotate +Z to -X → rotY=-π/2
        // side < 0 = WEST of avenue → face EAST → rotate +Z to +X → rotY=+π/2
        const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        for (let z = -STREET_EXTENT; z <= STREET_EXTENT; z += HOUSE_STEP) {
          if (placed >= HARD_CAP) break;
          if (rng() < 0.10) continue;
          const size = 4 + Math.floor(rng() * 3);
          const storeys = 1 + Math.floor(rng() * 2);
          // Same size-aware perpendicular offset as the EW loop —
          // street-facing edge of the house sits exactly at the
          // curb regardless of rolled house width.
          const baseX = ax + side * (PAVEMENT_HALF + CURB_EPSILON + size / 2);
          const jz = z + (rng() - 0.5) * 1.4;
          const isShop = rng() < 0.32;
          const shopName = isShop ? pick(shopNames) : undefined;
          tryPlace(baseX, jz, size, storeys, rotY, shopName);
        }
      }
    }

    // ── Post-pass: ensure every plot has a shop nearby ─────────────
    // For each claim plot (skipping the legacy player block), pick the
    // nearest scenery house within 30 m. If none of the houses in
    // that radius are shops, convert the closest house to one.
    const SHOP_NEAR_RADIUS = 30;
    for (const plot of WorldScene.CITY_PLOTS) {
      let hasShop = false;
      let closest: { house: typeof placedHouses[number]; dSq: number } | undefined;
      for (const h of placedHouses) {
        const dx = h.x - plot.x, dz = h.z - plot.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > SHOP_NEAR_RADIUS * SHOP_NEAR_RADIUS) continue;
        if (h.isShop) { hasShop = true; break; }
        if (!closest || dSq < closest.dSq) closest = { house: h, dSq };
      }
      if (hasShop || !closest) continue;
      // Rebuild the closest house as a shop. Cheaper than mutating
      // the existing group's children — the original size/storeys
      // aren't stored, so we re-pick a small variant.
      sceneryGroup.remove(closest.house.group);
      const size = 5;
      const storeys = 2;
      // Re-derive a rotation that still faces the nearest avenue so
      // the shop's sign points at the street, not into the plot.
      let bestAv = WorldScene.EW_AVENUES[0];
      let bestAxis: "ew" | "ns" = "ew";
      let bestDist = Infinity;
      for (const az of WorldScene.EW_AVENUES) {
        if (Math.abs(closest.house.z - az) < bestDist) { bestDist = Math.abs(closest.house.z - az); bestAv = az; bestAxis = "ew"; }
      }
      for (const ax of WorldScene.NS_AVENUES) {
        if (Math.abs(closest.house.x - ax) < bestDist) { bestDist = Math.abs(closest.house.x - ax); bestAv = ax; bestAxis = "ns"; }
      }
      let rotY = 0;
      if (bestAxis === "ew") {
        rotY = closest.house.z > bestAv ? Math.PI : 0;
      } else {
        rotY = closest.house.x > bestAv ? -Math.PI / 2 : Math.PI / 2;
      }
      const shopName = pick(shopNames);
      const newHouse = this.makeSceneryHouse(
        closest.house.x, closest.house.z, size, storeys,
        pick(wallColors), pick(roofColors), pick(doorColors),
        rotY, shopName,
      );
      sceneryGroup.add(newHouse);
      closest.house.group = newHouse;
      closest.house.isShop = true;
      placedShops.push({ x: closest.house.x, z: closest.house.z });
    }
  }

  /** Build one small Parisian scenery house. Cream limestone walls,
   * tall narrow windows, slate mansard roof, dark-wood door. Variants
   * in size, height, wall/roof/door colour, and orientation give the
   * street visual variety without authoring per-house meshes. If
   * `shopName` is provided, a small storefront sign hangs above the
   * door — turns ~22% of scenery into named shops (boulangerie,
   * café, etc.) so the player can read the city as a real
   * neighbourhood instead of an undifferentiated row of houses. */
  private makeSceneryHouse(x: number, z: number, size: number, storeys: number,
                           wallColor: number, roofColor: number, doorColor: number,
                           rotY: number, shopName?: string): THREE.Group {
    const g = new THREE.Group();
    const wallH = storeys * 2.8;
    // ── Walls (cream limestone) ─────────────────────────────────────
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(size, wallH, size),
      new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 }),
    );
    walls.position.y = wallH / 2;
    // NOTE: scenery houses do NOT cast shadows. The sun's shadow
    // camera covers ±20 m around world origin (the player's plot);
    // every scenery house sits at z=±50+ along an avenue, which is
    // already outside that frustum. Casting shadows here was pure
    // GPU waste — three.js still iterated each scenery mesh into
    // the shadow render pass even though the result was clipped.
    walls.receiveShadow = true;
    g.add(walls);
    // ── Horizontal cornices between floors (subtle warm band) ──────
    const corniceMat = new THREE.MeshStandardMaterial({ color: 0xc8b888, roughness: 0.8 });
    for (let s = 1; s < storeys; s += 1) {
      const cornice = new THREE.Mesh(
        new THREE.BoxGeometry(size + 0.15, 0.12, size + 0.15),
        corniceMat,
      );
      cornice.position.y = s * 2.8;
      g.add(cornice);
    }
    // ── Tall narrow windows on the FRONT face (+Z) ─────────────────
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x223040, roughness: 0.35, metalness: 0.3,
      emissive: 0x1a2538, emissiveIntensity: 0.05,
    });
    const numWin = Math.max(2, Math.floor(size / 1.4));
    const winSpacing = size / (numWin + 1);
    for (let s = 0; s < storeys; s += 1) {
      const winY = s * 2.8 + 1.55;
      for (let i = 0; i < numWin; i += 1) {
        const wx = -size / 2 + (i + 1) * winSpacing;
        // Skip the centre window on the ground floor — that's where the door goes.
        if (s === 0 && Math.abs(wx) < 0.5) continue;
        const win = new THREE.Mesh(
          new THREE.BoxGeometry(0.55, 1.25, 0.04),
          windowMat,
        );
        win.position.set(wx, winY, size / 2 + 0.025);
        g.add(win);
      }
      // ── Thin iron balcony rail on upper floors ───────────────────
      if (s > 0) {
        const balconyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.7 });
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(size - 0.2, 0.05, 0.08),
          balconyMat,
        );
        rail.position.set(0, winY - 0.7, size / 2 + 0.10);
        g.add(rail);
      }
    }
    // ── Mansard roof (slate grey) ──────────────────────────────────
    // Two-piece silhouette: thin warm cornice band right at the top
    // of the wall, then a slate-grey body that's slightly bigger than
    // the wall (so it overhangs like a real mansard).
    const topCornice = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.25, 0.12, size + 0.25),
      corniceMat,
    );
    topCornice.position.y = wallH + 0.06;
    g.add(topCornice);
    const mansard = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.15, 0.7, size + 0.15),
      new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.5, metalness: 0.05 }),
    );
    mansard.position.y = wallH + 0.12 + 0.35;
    g.add(mansard);
    // Flat slate cap on top, slightly inset (suggests the roof's
    // upper "deck" without authoring real slopes).
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(size - 0.4, 0.08, size - 0.4),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.55 }),
    );
    cap.position.y = wallH + 0.12 + 0.7 + 0.04;
    g.add(cap);
    // ── Chimney(s) ────────────────────────────────────────────────
    const chimneyMat = new THREE.MeshStandardMaterial({ color: 0x9a6850, roughness: 0.9 });
    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.8, 0.32),
      chimneyMat,
    );
    chimney.position.set(size / 2 - 0.6, wallH + 0.12 + 0.7 + 0.4, -size / 2 + 0.6);
    g.add(chimney);
    // ── Door ──────────────────────────────────────────────────────
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 1.95, 0.05),
      new THREE.MeshStandardMaterial({ color: doorColor, roughness: 0.55 }),
    );
    door.position.set(0, 0.975, size / 2 + 0.03);
    g.add(door);
    // ── Shop sign over the door ───────────────────────────────────
    if (shopName) {
      const tex = WorldScene.makeShopSignTexture(shopName);
      const signMat = new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.55, transparent: false,
        emissive: 0x222018, emissiveMap: tex, emissiveIntensity: 0.18,
      });
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.min(size - 0.4, 2.4), 0.55),
        signMat,
      );
      sign.position.set(0, 2.25, size / 2 + 0.04);
      g.add(sign);
      // Tiny iron frame under the sign for a hint of street-level depth.
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.5 });
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(size - 0.3, 2.5), 0.06, 0.04),
        frameMat,
      );
      frame.position.set(0, 2.55, size / 2 + 0.05);
      g.add(frame);
    }
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    return g;
  }

  /** Canvas-painted storefront sign. Cream background with a thin
   * dark border + deep red script-style hand-painted name centered
   * inside. Compact enough to read at iso distance. */
  private static makeShopSignTexture(name: string): THREE.CanvasTexture {
    const w = 512, h = 128;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
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
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    return tex;
  }

  /** Procedural grass texture — high-resolution layered noise in a
   * green palette so the lawn has natural-looking patches with fine
   * detail at the texture's tile size. */
  private static makeGrassTexture(): THREE.CanvasTexture {
    const sz = 512;
    const canvas = document.createElement("canvas");
    canvas.width = sz;
    canvas.height = sz;
    const ctx = canvas.getContext("2d")!;
    // Base fill — mid green.
    ctx.fillStyle = "#4f7836";
    ctx.fillRect(0, 0, sz, sz);
    // Layer 1: 60 large overlapping soft blobs (big colour patches).
    const bigPalette = [
      "rgba(95, 135, 70, 0.45)",    // lighter spring green
      "rgba(55, 92, 42, 0.40)",     // mid forest green
      "rgba(38, 72, 32, 0.40)",     // deep shadow green
      "rgba(120, 145, 60, 0.30)",   // dry yellow-grass
      "rgba(45, 88, 40, 0.30)",     // moss
    ];
    for (let i = 0; i < 60; i += 1) {
      const cx = Math.random() * sz;
      const cy = Math.random() * sz;
      const r = 40 + Math.random() * 90;
      const colour = bigPalette[Math.floor(Math.random() * bigPalette.length)];
      for (const dx of [-sz, 0, sz]) {
        for (const dy of [-sz, 0, sz]) {
          const grad = ctx.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, r);
          grad.addColorStop(0, colour);
          grad.addColorStop(1, colour.replace(/0\.\d+\)$/, "0)"));
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, sz, sz);
        }
      }
    }
    // Layer 2: ~600 tiny dark and light flecks for fine-scale texture —
    // gives the lawn a "blades viewed from above" stippled feel instead
    // of one uniform gradient. Each fleck is a 1-3px filled circle.
    const fleckColours = [
      "rgba(32, 64, 28, 0.55)",
      "rgba(28, 56, 22, 0.55)",
      "rgba(110, 140, 70, 0.45)",
      "rgba(82, 115, 50, 0.45)",
      "rgba(140, 160, 75, 0.35)",
    ];
    for (let i = 0; i < 600; i += 1) {
      const cx = Math.random() * sz;
      const cy = Math.random() * sz;
      const r = 0.6 + Math.random() * 2.4;
      ctx.fillStyle = fleckColours[Math.floor(Math.random() * fleckColours.length)];
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Layer 3: 40 fine short dashes that suggest individual blades
    // viewed from above. Random orientation + length.
    ctx.lineCap = "round";
    for (let i = 0; i < 280; i += 1) {
      const cx = Math.random() * sz;
      const cy = Math.random() * sz;
      const len = 4 + Math.random() * 8;
      const angle = Math.random() * Math.PI * 2;
      ctx.strokeStyle = Math.random() < 0.5 ? "rgba(35, 70, 30, 0.55)" : "rgba(100, 135, 60, 0.45)";
      ctx.lineWidth = 0.8 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    return tex;
  }

  /** Instanced grass clumps — each instance carries a multi-blade
   * billboard quad cluster so the lawn reads as dense bushy turf
   * instead of lonely sticks. */
  private addGrassBlades(): void {
    const bladeTex = WorldScene.makeBladeTexture();
    const bladeMat = new THREE.MeshStandardMaterial({
      map: bladeTex, transparent: true, alphaTest: 0.25,
      side: THREE.DoubleSide, roughness: 0.95, metalness: 0,
    });
    // Each instance is a CROSS of 3 perpendicular planes (0°, 60°,
    // 120°) so the bush reads from any iso angle without obvious gaps.
    // Width bumped to 0.34 m so each clump covers more ground; height
    // 0.36 m keeps blades short enough that the camera path stays
    // readable.
    const w = 0.34, h = 0.36;
    const planes: THREE.PlaneGeometry[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = new THREE.PlaneGeometry(w, h);
      p.rotateY((i / 3) * Math.PI);
      planes.push(p);
    }
    const geom = mergeBufferGeometries(planes);
    geom.translate(0, h / 2, 0);
    // Big density bump + map-wide spread — 25000 instances scattered
    // across ±180m (360×360 = 130,000 m²) gives ~0.19 clumps/m². Sparse
    // enough that the GPU's happy with a single InstancedMesh draw,
    // dense enough that the player sees grass tufts anywhere they walk
    // (including the back streets and the empty corners of the city,
    // not just within 40m of their plot like before).
    const count = 25000;
    const blades = new THREE.InstancedMesh(geom, bladeMat, count);
    const tmp = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    const maxAttempts = count * 4;
    while (placed < count && attempts < maxAttempts) {
      attempts += 1;
      const x = (Math.random() - 0.5) * 360;
      const z = (Math.random() - 0.5) * 360;
      if (this.isOnRoadOrBuildingForScatter(x, z, /* margin */ 0.4)) continue;
      tmp.position.set(x, 0, z);
      tmp.rotation.y = Math.random() * Math.PI * 2;
      // Per-instance scale jitter — some short, some tall, some wider.
      const sx = 0.75 + Math.random() * 0.55;
      const sy = 0.7 + Math.random() * 0.7;
      tmp.scale.set(sx, sy, sx);
      tmp.updateMatrix();
      blades.setMatrixAt(placed, tmp.matrix);
      placed += 1;
    }
    blades.count = placed;
    blades.castShadow = false;
    blades.receiveShadow = true;
    this.threeScene.add(blades);
  }

  /** Multi-blade billboard texture. Draws ~9 tapered grass blades
   * across the quad with varying heights and slight lean — each quad
   * already looks like a small bushy clump, so a single instance reads
   * as turf rather than one lonely stalk. */
  private static makeBladeTexture(): THREE.CanvasTexture {
    const w = 256, h = 256;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    // 11 blades distributed across the quad, each with its own height,
    // lean angle, and shade. Together they fill most of the quad with
    // visible grass silhouette.
    const palette = [
      ["rgba(36, 78, 30, 1.00)", "rgba(62, 112, 48, 1.00)", "rgba(110, 155, 70, 0.95)"],
      ["rgba(42, 88, 36, 1.00)", "rgba(72, 124, 56, 1.00)", "rgba(120, 165, 75, 0.95)"],
      ["rgba(30, 70, 28, 1.00)", "rgba(54, 100, 44, 1.00)", "rgba(95, 140, 60, 0.95)"],
      ["rgba(48, 95, 38, 1.00)", "rgba(80, 130, 60, 1.00)", "rgba(135, 175, 85, 0.95)"],
    ];
    const blades = 11;
    for (let i = 0; i < blades; i += 1) {
      const baseX = w * (0.05 + 0.90 * (i / (blades - 1)) + (Math.random() - 0.5) * 0.06);
      const top = h * (0.05 + Math.random() * 0.35);       // top of blade (lower = taller)
      const base = h;
      const baseHalf = 2 + Math.random() * 3;              // base width
      const tipOffset = (Math.random() - 0.5) * w * 0.10;  // horizontal lean
      const tipHalf = 0.5 + Math.random() * 1.0;
      const colours = palette[Math.floor(Math.random() * palette.length)];
      const grad = ctx.createLinearGradient(0, base, 0, top);
      grad.addColorStop(0,    colours[0]);
      grad.addColorStop(0.55, colours[1]);
      grad.addColorStop(1.0,  colours[2].replace(/0\.\d+\)$/, "0)"));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(baseX - baseHalf, base);
      ctx.lineTo(baseX + baseHalf, base);
      ctx.lineTo(baseX + tipOffset + tipHalf, top);
      ctx.lineTo(baseX + tipOffset - tipHalf, top);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  /** Sparse wildflowers — tiny coloured discs lying flat on the lawn.
   * Just a pop of colour, not a full bloom system. Spread map-wide
   * (±150m) so flowers show up even in the far corners of the city. */
  private addWildflowers(): void {
    const palette = [0xffe066, 0xff8aa6, 0xffffff, 0xf0b0e8, 0xffc46e];
    const flowers = new THREE.Group();
    let placed = 0;
    let attempts = 0;
    while (placed < 400 && attempts < 2000) {
      attempts += 1;
      const x = (Math.random() - 0.5) * 300;
      const z = (Math.random() - 0.5) * 300;
      if (this.isOnRoadOrBuildingForScatter(x, z, 0.6)) continue;
      const color = palette[Math.floor(Math.random() * palette.length)];
      const flower = new THREE.Mesh(
        new THREE.CircleGeometry(0.08 + Math.random() * 0.04, 8),
        new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
      );
      flower.rotation.x = -Math.PI / 2;
      flower.position.set(x, 0.02, z);
      flowers.add(flower);
      placed += 1;
    }
    this.threeScene.add(flowers);
  }

  /** Low-poly trees scattered map-wide — cone canopy on a cylinder
   * trunk. Used to be 22 trees in a 40m radius of the player plot;
   * now ~250 trees across ±180m so the back streets and city outskirts
   * read as parkland too. Performance: trees share one trunk geometry
   * + one canopy geometry per palette colour via InstancedMesh, so
   * the full forest is 4 draw calls (1 trunks + 3 canopies). */
  private addLawnTrees(): void {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 });
    const canopyMats = [
      new THREE.MeshStandardMaterial({ color: 0x3a7a3a, roughness: 0.85 }),
      new THREE.MeshStandardMaterial({ color: 0x4a8a4a, roughness: 0.85 }),
      new THREE.MeshStandardMaterial({ color: 0x2e6a2e, roughness: 0.85 }),
    ];

    // Roll positions first so we know the final count per canopy
    // palette before sizing the InstancedMeshes.
    type Plan = { x: number; z: number; rotY: number; trunkH: number; canopyH: number; canopyR: number; palette: number };
    const plans: Plan[] = [];
    let attempts = 0;
    const TARGET = 250;
    while (plans.length < TARGET && attempts < TARGET * 8) {
      attempts += 1;
      const x = (Math.random() - 0.5) * 360;
      const z = (Math.random() - 0.5) * 360;
      // Wider margin than grass — a tree canopy is ~1m across, so we
      // need a couple of metres of clearance to keep branches from
      // intersecting walls / cars / customers walking the pavement.
      if (this.isOnRoadOrBuildingForScatter(x, z, 1.8)) continue;
      // Keep the path between the player's front door and the legacy
      // main street clear so the camera always has a clean view of
      // the door from default zoom.
      if (Math.abs(x) < 6 && z > 5.5 && z < 12) continue;
      plans.push({
        x, z,
        rotY: Math.random() * Math.PI * 2,
        trunkH: 0.8 + Math.random() * 0.5,
        canopyH: 1.6 + Math.random() * 1.0,
        canopyR: 0.65 + Math.random() * 0.4,
        palette: Math.floor(Math.random() * canopyMats.length),
      });
    }

    // Shared geometries — sized for unit scale, per-instance matrix
    // applies the actual height + radius via non-uniform Y scale.
    const trunkGeo = new THREE.CylinderGeometry(0.10, 0.14, 1, 8);
    trunkGeo.translate(0, 0.5, 0); // base at y=0, top at y=1
    const canopyGeo = new THREE.ConeGeometry(1, 1, 8);
    canopyGeo.translate(0, 0.5, 0); // base at y=0, tip at y=1

    // One trunk InstancedMesh for everything — trunk colour is uniform.
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, plans.length);
    // Trees span ±180 m (way beyond the sun's ±20 m shadow frustum)
    // so the InstancedMesh's union bounding box drags ALL 250 trees
    // into the shadow render pass even though almost none of them
    // sit inside the frustum. Disabling castShadow keeps the trunks
    // out of the shadow pass entirely — they're decorative scenery,
    // a tiny shadow streak at iso angle is a fine trade for the GPU
    // time saved.
    trunks.castShadow = false;
    // One canopy InstancedMesh per palette colour. Build buckets first.
    const buckets: Plan[][] = canopyMats.map(() => []);
    plans.forEach((p) => buckets[p.palette].push(p));
    const tmp = new THREE.Object3D();
    plans.forEach((p, i) => {
      tmp.position.set(p.x, 0, p.z);
      tmp.rotation.set(0, p.rotY, 0);
      tmp.scale.set(1, p.trunkH, 1);
      tmp.updateMatrix();
      trunks.setMatrixAt(i, tmp.matrix);
    });
    this.threeScene.add(trunks);
    for (let pi = 0; pi < canopyMats.length; pi += 1) {
      const bucket = buckets[pi];
      if (bucket.length === 0) continue;
      const canopies = new THREE.InstancedMesh(canopyGeo, canopyMats[pi], bucket.length);
      // Same reasoning as trunks above — all 250 canopies span the
      // map and would otherwise enter the shadow pass for nothing.
      canopies.castShadow = false;
      bucket.forEach((p, i) => {
        // Canopy sits ON TOP of trunk with a slight overlap so trunk
        // disappears into the canopy base instead of poking through.
        tmp.position.set(p.x, p.trunkH - 0.15, p.z);
        tmp.rotation.set(0, p.rotY, 0);
        tmp.scale.set(p.canopyR, p.canopyH, p.canopyR);
        tmp.updateMatrix();
        canopies.setMatrixAt(i, tmp.matrix);
      });
      this.threeScene.add(canopies);
    }
  }

  /** Small instanced grey rocks scattered around to break up the
   * uniform green. Map-wide spread (±150m) to match the grass and
   * tree coverage. */
  private addRocks(): void {
    const rockGeo = new THREE.IcosahedronGeometry(0.18, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7e7672, roughness: 0.95 });
    const TARGET = 120;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, TARGET);
    const tmp = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < TARGET && attempts < TARGET * 8) {
      attempts += 1;
      const x = (Math.random() - 0.5) * 300;
      const z = (Math.random() - 0.5) * 300;
      if (this.isOnRoadOrBuildingForScatter(x, z, 0.4)) continue;
      tmp.position.set(x, 0.06, z);
      tmp.rotation.set(Math.random() * 0.6, Math.random() * Math.PI * 2, Math.random() * 0.4);
      const sc = 0.6 + Math.random() * 0.9;
      tmp.scale.set(sc, sc * (0.5 + Math.random() * 0.4), sc);
      tmp.updateMatrix();
      rocks.setMatrixAt(placed, tmp.matrix);
      placed += 1;
    }
    rocks.count = placed;
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    this.threeScene.add(rocks);
  }

  // @ts-expect-error — addPavementAndRoad kept on the class as a
  // reference implementation but no longer wired up (see addBuilding;
  // the world avenues handle the player's main street now).
  private addPavementAndRoad(): void {
    // The strip spans the full map width (lawn plane is 70×70 m, so
    // 80 m of strip overshoots into the grass margin and disappears
    // into the fog horizon without visible end caps). Z layout (north
    // to south):
    //   z = 5.5..10.5   near pavement (against the building's south wall)
    //   z = 10.5         near curb
    //   z = 10.5..16.5   road
    //   z = 16.5         far curb
    //   z = 16.5..21.5   far pavement (across the road)
    // Bumped 80 → 260 so the legacy main road actually spans the
    // expanded city instead of being abruptly chopped off east + west
    // of the player's plot.
    const STRIP_WIDTH = 260;
    const pavementMat = new THREE.MeshStandardMaterial({ color: 0xb2a692, roughness: 0.9 });
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.95 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x807468, roughness: 0.9 });
    const laneMat = new THREE.MeshStandardMaterial({
      color: 0xe6e0c4, roughness: 0.85,
      emissive: 0xe6e0c4, emissiveIntensity: 0.05,
    });

    const makePavement = (z: number): void => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(STRIP_WIDTH, 5), pavementMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set(0, 0, z);
      p.receiveShadow = true;
      this.threeScene.add(p);
    };
    const makeCurb = (z: number): void => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(STRIP_WIDTH, 0.12, 0.18), curbMat);
      c.position.set(0, 0.06, z);
      c.castShadow = true;
      c.receiveShadow = true;
      this.threeScene.add(c);
    };
    makePavement(8);              // near pavement centre, spans 5.5..10.5
    makeCurb(10.5);                // near curb
    const road = new THREE.Mesh(new THREE.PlaneGeometry(STRIP_WIDTH, 6), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, 13.5);  // spans 10.5..16.5
    road.receiveShadow = true;
    this.threeScene.add(road);
    makeCurb(16.5);                // far curb
    makePavement(19);              // far pavement, spans 16.5..21.5
    // Lane dashes down the middle of the road, spaced every 4 m
    // across the full road width.
    for (let x = -STRIP_WIDTH / 2 + 2; x <= STRIP_WIDTH / 2 - 2; x += 4) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.18), laneMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.005, 13.5);
      this.threeScene.add(dash);
    }
  }

  /** True when (x, z) sits on a road, pavement, plot building, garden,
   * or scenery house — the four scatter passes (grass blades,
   * wildflowers, trees, rocks) consult this so nothing spawns on
   * asphalt or inside a building. Margin is added outward from each
   * obstacle so e.g. a tree's 1m canopy doesn't poke through a wall.
   *
   * Replaces the old static isExclusionZone, which only knew about
   * the legacy player block + pavement strip and was useless once
   * the city grew to 12 plots + 5 avenues + ~300 scenery houses. */
  private isOnRoadOrBuildingForScatter(x: number, z: number, margin: number): boolean {
    // Avenue pavements — pavement strip extends PAVEMENT_HALF (5.5m)
    // out from each centerline on both sides. Reject anything within
    // (5.5 + margin) of any avenue line. Checking the 5 avenues first
    // (3 EW + 2 NS) culls the asphalt strips fastest.
    const PAVEMENT_HALF = 5.5;
    for (const az of WorldScene.EW_AVENUES) {
      if (Math.abs(z - az) < PAVEMENT_HALF + margin) return true;
    }
    for (const ax of WorldScene.NS_AVENUES) {
      if (Math.abs(x - ax) < PAVEMENT_HALF + margin) return true;
    }
    // City plots — exact building footprint + 1m + margin. Same data
    // the populateCityBuildings code uses, so the keep-out matches
    // what the player sees on the ground.
    for (const p of WorldScene.CITY_PLOTS) {
      if (Math.abs(x - p.x) < p.w / 2 + 1 + margin &&
          Math.abs(z - p.z) < p.h / 2 + 1 + margin) return true;
    }
    // Per-plot gardens (east-or-west of each plot).
    for (const p of WorldScene.CITY_PLOTS) {
      const g = WorldScene.gardenBoundsForPlot(p);
      if (x > g.minX - margin && x < g.maxX + margin &&
          z > g.minZ - margin && z < g.maxZ + margin) return true;
    }
    // Legacy player block (centered on origin, ~12×12 footprint) +
    // its east-side legacy garden.
    if (Math.abs(x) < 7 + margin && Math.abs(z) < 7 + margin) return true;
    const lg = WorldScene.GARDEN_BOUNDS;
    if (x > lg.minX - margin && x < lg.maxX + margin &&
        z > lg.minZ - margin && z < lg.maxZ + margin) return true;
    // Scenery houses placed by addCityScenery — must be last because
    // there can be ~300 of them, and most candidates are already culled
    // by the cheaper checks above. Each entry already includes a small
    // skin in halfSize, so a tight margin here is fine.
    for (const h of this.placedSceneryHouses) {
      if (Math.abs(x - h.x) < h.halfSize + margin &&
          Math.abs(z - h.z) < h.halfSize + margin) return true;
    }
    return false;
  }

  /** Wood-and-metal "back of house" counter where the errand helper
   * drops off groceries. Static — not registered, not sellable. */
  private buildSupplyCounter(): void {
    const counter = new THREE.Group();
    // Position relative to the back wall (z = -4.5 after the (+0.5, +0.5)
    // shift). Counter back face hugs the wall; the helper's drop-off
    // standing spot (supplyCounterPos) sits one tile to the south.
    counter.position.set(this.stoveFurniturePos.x - 3, 0, this.stoveFurniturePos.y - 0.05);
    // Cabinet body — 1 unit wide, ~0.85 tall, 0.7 deep, hugging the back wall.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.85, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x9a7a55, roughness: 0.85 }),
    );
    body.position.set(0, 0.425, 0.15); // back face against wall (wall at z=-5)
    body.castShadow = true;
    body.receiveShadow = true;
    counter.add(body);
    // Lighter top — looks like a worn worktop where bags get dropped.
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 0.06, 0.75),
      new THREE.MeshStandardMaterial({ color: 0xcfb48a, roughness: 0.6 }),
    );
    top.position.set(0, 0.88, 0.15);
    top.castShadow = true;
    counter.add(top);
    // A couple of small crates on top so the player can tell at a
    // glance "this is the supply counter".
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x8c6a40, roughness: 0.9 });
    const crate1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.28), crateMat);
    crate1.position.set(-0.25, 1.02, 0.10);
    crate1.castShadow = true;
    counter.add(crate1);
    const crate2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.22), crateMat);
    crate2.position.set(0.20, 1.00, 0.20);
    crate2.castShadow = true;
    counter.add(crate2);
    this.threeScene.add(counter);
  }

  // === Door plaque (restaurant name + rating stars below) ===

  /** The plaque face mesh — clickable target for the edit modal.
   * Engine raycasts against this to open the editor. */
  signPlaqueMesh?: THREE.Mesh;
  /** Canvas + texture used for the painted-on name. Re-drawn whenever
   * the player saves a new name or style. */
  private signCanvas?: HTMLCanvasElement;
  private signTexture?: THREE.CanvasTexture;
  private signFaceMat?: THREE.MeshStandardMaterial;
  /** Border frame mesh — recoloured per plaque-style choice. */
  private signFrameMesh?: THREE.Mesh;
  /** The 5 mounted star mini-meshes — each is "lit" (gold + emissive) or
   * "off" (slate). updateRatingSign sets which are lit based on the
   * current average rating. */
  private ratingStars: { mesh: THREE.Mesh; litMat: THREE.MeshStandardMaterial; offMat: THREE.MeshStandardMaterial }[] = [];

  /** Cached state passed in by Engine via setRestaurantSign; used so the
   * first applyDayNight tick has data even before the player edits. */
  private currentSignName = "Cozy Bistro";
  private currentSignStyle = { font: "serif", textColor: "cream", plaqueStyle: "dark" };

  private buildRatingSign(): void {
    // Frame: a slightly larger dark backplate that reads as the plaque
    // border. Coloured per the player's plaqueStyle in
    // applyRestaurantSign. Mounted just behind the face so it shows as
    // a thin trim around the painted name.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a1f17, roughness: 0.7 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.70, 0.04), frameMat);
    frame.position.set(0, 2.55, 5.625);
    frame.castShadow = true;
    this.threeScene.add(frame);
    this.signFrameMesh = frame;
    // Face: the canvas texture lives here. Slightly proud of the frame
    // so the painted name appears to sit on top of the plaque.
    this.signCanvas = document.createElement("canvas");
    this.signCanvas.width = 768;
    this.signCanvas.height = 320;
    this.signTexture = new THREE.CanvasTexture(this.signCanvas);
    this.signTexture.minFilter = THREE.LinearFilter;
    this.signTexture.magFilter = THREE.LinearFilter;
    this.signFaceMat = new THREE.MeshStandardMaterial({
      map: this.signTexture,
      roughness: 0.65,
    });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.60), this.signFaceMat);
    face.position.set(0, 2.55, 5.65);
    face.castShadow = false;
    this.threeScene.add(face);
    this.signPlaqueMesh = face;
    // Initial paint with defaults so the plaque renders something even
    // before the player saves a new name.
    this.repaintSignCanvas();
    // 5 small rating stars BELOW the plaque on the lintel.
    const litMatTemplate = new THREE.MeshStandardMaterial({
      color: 0xf5c14a, roughness: 0.4, metalness: 0.4,
      emissive: 0xf5c14a, emissiveIntensity: 0.5,
    });
    const offMatTemplate = new THREE.MeshStandardMaterial({
      color: 0x474039, roughness: 0.85,
    });
    for (let i = 0; i < 5; i += 1) {
      const litMat = litMatTemplate.clone();
      const offMat = offMatTemplate.clone();
      const star = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), offMat);
      star.position.set(-0.24 + i * 0.12, 2.16, 5.66);
      this.threeScene.add(star);
      this.ratingStars.push({ mesh: star, litMat, offMat });
    }
  }

  /** Update the rating-sign lit-count from a 1-5 average. Called by
   * Engine on every HUD tick — cheap enough (5 ref swaps max). */
  updateRatingSign(rating: number): void {
    // A 4.3 rating lights 4 full stars + the 5th stays off (we treat
    // half-stars as off so the sign reads cleanly). Cap at 1..5.
    const litCount = Math.max(0, Math.min(5, Math.round(rating)));
    for (let i = 0; i < this.ratingStars.length; i += 1) {
      const s = this.ratingStars[i];
      const wantLit = i < litCount;
      const cur = s.mesh.material as THREE.Material;
      const want = wantLit ? s.litMat : s.offMat;
      if (cur !== want) s.mesh.material = want;
    }
  }

  /** Engine calls this when the player saves a new name / style. Caches
   * the state + re-renders the canvas texture + recolours the frame. */
  setRestaurantSign(name: string, style: { font: string; textColor: string; plaqueStyle: string }): void {
    this.currentSignName = name;
    this.currentSignStyle = { ...style };
    this.repaintSignCanvas();
    this.applyPlaqueFrameStyle();
  }

  /** Re-draw the plaque's canvas with the current name + style and
   * push it to the texture. Cheap — runs only on save, not per frame. */
  private repaintSignCanvas(): void {
    if (!this.signCanvas || !this.signTexture) return;
    const ctx = this.signCanvas.getContext("2d");
    if (!ctx) return;
    const w = this.signCanvas.width;
    const h = this.signCanvas.height;
    // Background painted to match the plaque-style id so the texture
    // tint reads consistently with the frame around it.
    const bg = PLAQUE_BG[this.currentSignStyle.plaqueStyle] ?? PLAQUE_BG.dark;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // Thin inner border for a "framed plate" feel — same colour as the
    // text accent so the trim reads as gold-on-dark / etc.
    const accent = TEXT_COLORS[this.currentSignStyle.textColor] ?? TEXT_COLORS.cream;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(20, 20, w - 40, h - 40);
    // Restaurant name. Auto-fit font size so a long name still reads.
    ctx.fillStyle = accent;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontFamily = FONT_FAMILIES[this.currentSignStyle.font] ?? FONT_FAMILIES.serif;
    const fontWeight = this.currentSignStyle.font === "display" ? "900" : "700";
    let size = 140;
    do {
      ctx.font = `${fontWeight} ${size}px ${fontFamily}`;
      if (ctx.measureText(this.currentSignName).width < w - 100) break;
      size -= 6;
    } while (size > 40);
    ctx.fillText(this.currentSignName, w / 2, h / 2 + 8);
    this.signTexture.needsUpdate = true;
  }

  private applyPlaqueFrameStyle(): void {
    if (!this.signFrameMesh) return;
    const mat = this.signFrameMesh.material as THREE.MeshStandardMaterial;
    const frame = PLAQUE_FRAME[this.currentSignStyle.plaqueStyle] ?? PLAQUE_FRAME.dark;
    mat.color.setHex(frame);
  }

  /** Apply a theme color set to the GROUND floor's wall + floor
   * materials. Used as the default / legacy entry point — Engine
   * calls this on startup with the player's saved Floor 0 theme. */
  setTheme(theme: { wallColor: number; floorColor: number }): void {
    if (this.wallMat) this.wallMat.color.setHex(theme.wallColor);
    if (this.floorMat) this.floorMat.color.setHex(theme.floorColor);
  }

  /** Apply a theme to a specific storey. Floor 0 → ground floor's
   * shared materials (same as `setTheme`). Floor 1..N → that storey's
   * cloned wall + slab materials so the other floors are unaffected. */
  setStoreyTheme(floor: number, theme: { wallColor: number; floorColor: number }): void {
    if (floor <= 0) {
      this.setTheme(theme);
      return;
    }
    const storey = this.upperStoreys.get(floor);
    if (!storey) return;
    storey.wallMat.color.setHex(theme.wallColor);
    storey.slabMat.color.setHex(theme.floorColor);
  }

  /** Map demo placements → their tier section so we can show / hide as
   * the player expands. Tier 0 = always visible (kitchen, door, decor).
   * Tier 1 = the starter dining (tables 1 + 2). Tier 2..4 = the
   * progressively-unlocked dining tables. */
  private readonly tierGroups = new Map<number, THREE.Object3D[]>();
  private currentTierVisible = 5;

  /** Render placeholder shells for the OTHER players' plots on the
   * shared city map. The player's own restaurant continues to use
   * the legacy origin-centered render path; this just adds visual
   * "other people's plots exist" feedback so the world reads as
   * a city rather than a single isolated building.
   *
   * Shells are simple Greek-Island-styled cubes (whitewashed walls,
   * terracotta roof, stone foundation) sized to match plot
   * dimensions. Each is positioned at the building's (plot_x,
   * plot_z) on the world grid. Player's own plot is skipped here
   * — the actual restaurant goes there via the existing pipeline.
   *
   * Called by Engine once the SpacetimeDB cache lands. Safe to
   * call again on cache updates (e.g. another player claims a
   * plot) — fully rebuilds the group. */
  populateCityBuildings(
    buildings: readonly { id: bigint; kind: string; plotX: number; plotZ: number; plotW: number; plotH: number; isMine: boolean; ownerIdentity?: { toHexString(): string }; ownerName?: string }[],
    skipMine: boolean = true,
  ): void {
    // Wipe + rebuild — buildings change rarely so the cost is fine.
    while (this.cityBuildings.children.length > 0) {
      const c = this.cityBuildings.children[0];
      this.cityBuildings.remove(c);
    }
    for (const b of buildings) {
      // Always add the garden fence, even for the player's own plot
      // (the legacy player block at origin has its own fence built
      // by addGardenArea(); this group adds fences for the OTHER 11
      // plots regardless of ownership).
      if (skipMine && b.isMine) continue;
      const shell = this.makeBuildingShell(b);
      // Stamp the visit-mode metadata on the shell + every descendant
      // mesh so Engine's click raycast can identify which player owns
      // the plot the click landed on. Walking up the parent chain in
      // Engine yields the building info regardless of which mesh the
      // raycaster topped out on.
      shell.userData.visitPlot = {
        id: b.id,
        plotX: b.plotX,
        plotZ: b.plotZ,
        ownerHex: b.ownerIdentity?.toHexString?.() ?? "",
        ownerName: b.ownerName ?? "",
      };
      this.cityBuildings.add(shell);
      this.cityBuildings.add(this.makePlotGardenFence({
        x: b.plotX, z: b.plotZ, w: b.plotW, h: b.plotH,
      }));
    }
  }

  /** Build one Parisian Haussmann-style placeholder shell — cream
   * limestone walls with horizontal cornices between floors, tall
   * narrow shuttered windows on the street face, slim iron balconies
   * on upper storeys, a slate-grey mansard roof + chimney, and a
   * heavy dark-wood door. Same procedural box-and-band toolkit as
   * makeSceneryHouse just at plot scale. */
  private makeBuildingShell(b: { id?: bigint; kind: string; plotX: number; plotZ: number; plotW: number; plotH: number }): THREE.Group {
    const g = new THREE.Group();
    // Heights derived from kind — small = 1 storey, medium = 2,
    // large = 3. Each "storey" is 3 m (matches the player's own
    // building's STOREY_HEIGHT) so other plots read at the same
    // scale as the player's house when they visit later.
    const storeys = b.kind === "small" ? 1 : b.kind === "medium" ? 2 : 3;
    const wallH = storeys * 3.0;
    const w = b.plotW;
    const h = b.plotH;
    // Deterministic per-plot colour variation — use the plot id as
    // a seed so the same building always wears the same coat across
    // reloads / clients.
    const seed = Number((b.id ?? BigInt(Math.floor(b.plotX * 73 + b.plotZ * 41))) & BigInt(0xFFFFFFFF));
    const r = mulberry32(seed || 1);
    const wallShades = [0xe6d5b5, 0xddc9a8, 0xe8d8b8, 0xd6c2a0, 0xefe0c0, 0xddc9b0];
    const roofShades = [0x3a4048, 0x2e343c, 0x444a52, 0x363c44];
    const doorShades = [0x3a261a, 0x4a3020, 0x2a1a10, 0x5a4030];
    const pickFrom = <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
    const wallColor = pickFrom(wallShades);
    const roofColor = pickFrom(roofShades);
    const doorColor = pickFrom(doorShades);
    // ── Cobblestone foundation (slightly larger than the building) ──
    const foundation = new THREE.Mesh(
      new THREE.BoxGeometry(w + 1, 0.2, h + 1),
      new THREE.MeshStandardMaterial({ color: 0x9a9088, roughness: 0.95, metalness: 0 }),
    );
    foundation.position.y = 0.1;
    foundation.receiveShadow = true;
    g.add(foundation);
    // ── Cream limestone walls ───────────────────────────────────────
    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(w, wallH, h),
      new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85, metalness: 0 }),
    );
    walls.position.y = 0.2 + wallH / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    g.add(walls);
    // ── Horizontal cornices between floors ─────────────────────────
    const corniceMat = new THREE.MeshStandardMaterial({ color: 0xc8b888, roughness: 0.8 });
    for (let s = 1; s < storeys; s += 1) {
      const cornice = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.2, 0.14, h + 0.2),
        corniceMat,
      );
      cornice.position.y = 0.2 + s * 3.0;
      cornice.castShadow = true;
      g.add(cornice);
    }
    // ── Windows on the +Z (street) face ────────────────────────────
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x223040, roughness: 0.35, metalness: 0.3,
      emissive: 0x1a2538, emissiveIntensity: 0.05,
    });
    const numWin = Math.max(3, Math.floor(w / 1.6));
    const winSpacing = w / (numWin + 1);
    for (let s = 0; s < storeys; s += 1) {
      const winY = 0.2 + s * 3.0 + 1.7;
      for (let i = 0; i < numWin; i += 1) {
        const wx = -w / 2 + (i + 1) * winSpacing;
        // Centre window on the ground floor is the door slot.
        if (s === 0 && Math.abs(wx) < 0.55) continue;
        const win = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, 1.45, 0.05),
          windowMat,
        );
        win.position.set(wx, winY, h / 2 + 0.028);
        g.add(win);
      }
      // ── Wrought-iron balcony rail on upper floors ────────────────
      // Single horizontal bar — was originally rail + ~6 individual
      // balusters per house. With 180 scenery houses that's >1000
      // baluster meshes for the whole city. At iso distance the
      // balusters were almost invisible anyway; dropping them is a
      // free perf win.
      if (s > 0) {
        const balconyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4, metalness: 0.7 });
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(w - 0.3, 0.06, 0.10),
          balconyMat,
        );
        rail.position.set(0, winY - 0.85, h / 2 + 0.12);
        g.add(rail);
      }
    }
    // ── Heavy dark-wood double door, centre-bottom of +Z face ──────
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.05, 2.25, 0.06),
      new THREE.MeshStandardMaterial({ color: doorColor, roughness: 0.55, metalness: 0.05 }),
    );
    door.position.set(0, 0.2 + 1.125, h / 2 + 0.035);
    g.add(door);
    // Two small brass knockers (just decor cylinders) — a Parisian
    // signature on doors of this size.
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc8a248, roughness: 0.4, metalness: 0.75 });
    for (const dx of [-0.2, 0.2]) {
      const knocker = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 8), brassMat);
      knocker.position.set(dx, 0.2 + 1.4, h / 2 + 0.07);
      knocker.rotation.x = Math.PI / 2;
      g.add(knocker);
    }
    // ── Top cornice + mansard roof ─────────────────────────────────
    const topCornice = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, 0.14, h + 0.3),
      corniceMat,
    );
    topCornice.position.y = 0.2 + wallH + 0.07;
    topCornice.castShadow = true;
    g.add(topCornice);
    const mansardH = 1.1;
    const mansard = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.2, mansardH, h + 0.2),
      new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.5, metalness: 0.05 }),
    );
    mansard.position.y = 0.2 + wallH + 0.14 + mansardH / 2;
    mansard.castShadow = true;
    g.add(mansard);
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.6, 0.1, h - 0.6),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.55 }),
    );
    cap.position.y = 0.2 + wallH + 0.14 + mansardH + 0.05;
    g.add(cap);
    // ── Chimney (terracotta brick) ─────────────────────────────────
    const chimneyMat = new THREE.MeshStandardMaterial({ color: 0x9a6850, roughness: 0.9 });
    const chimney = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1.1, 0.4),
      chimneyMat,
    );
    chimney.position.set(w / 2 - 0.8, 0.2 + wallH + 0.14 + mansardH + 0.55, -h / 2 + 0.8);
    chimney.castShadow = true;
    g.add(chimney);
    // ── Tiny "address number" plate just left of the door ──────────
    g.position.set(b.plotX, 0, b.plotZ);
    return g;
  }

  /** Build a wooden picket fence around the plot's adjacent garden
   * (computed by gardenBoundsForPlot). Mirrors the player's legacy
   * garden style so every plot in the city reads as "house + fenced
   * garden" rather than the player being uniquely privileged. Pure
   * decor — no gameplay interaction yet. */
  private makePlotGardenFence(plot: { x: number; z: number; w: number; h: number }): THREE.Group {
    const g = new THREE.Group();
    const b = WorldScene.gardenBoundsForPlot(plot);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.9 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xa07042, roughness: 0.9 });
    const capMat  = new THREE.MeshStandardMaterial({ color: 0x6a4220, roughness: 0.85 });
    const postH = 1.0, postW = 0.09;
    const railH = 0.05, railD = 0.05;
    const upperY = 0.74, lowerY = 0.28;
    const spacing = 1.0;
    const addPost = (x: number, z: number): void => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(postW, postH, postW), postMat);
      post.position.set(x, postH / 2, z);
      post.castShadow = true;
      g.add(post);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(postW * 1.4, 0.06, postW * 1.4), capMat);
      cap.position.set(x, postH + 0.03, z);
      g.add(cap);
    };
    for (let x = b.minX; x <= b.maxX; x += spacing) {
      addPost(x, b.minZ);
      addPost(x, b.maxZ);
    }
    for (let z = b.minZ + spacing; z < b.maxZ; z += spacing) {
      addPost(b.minX, z);
      addPost(b.maxX, z);
    }
    const addRail = (x: number, z: number, length: number, axis: "x" | "z", y: number): void => {
      const geom = axis === "x"
        ? new THREE.BoxGeometry(length, railH, railD)
        : new THREE.BoxGeometry(railD, railH, length);
      const rail = new THREE.Mesh(geom, railMat);
      rail.position.set(x, y, z);
      rail.castShadow = true;
      g.add(rail);
    };
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const width = b.maxX - b.minX;
    const depth = b.maxZ - b.minZ;
    addRail(cx, b.minZ, width, "x", upperY);
    addRail(cx, b.minZ, width, "x", lowerY);
    addRail(cx, b.maxZ, width, "x", upperY);
    addRail(cx, b.maxZ, width, "x", lowerY);
    addRail(b.minX, cz, depth, "z", upperY);
    addRail(b.minX, cz, depth, "z", lowerY);
    addRail(b.maxX, cz, depth, "z", upperY);
    addRail(b.maxX, cz, depth, "z", lowerY);
    // A subtle grass-only patch sits inside the fence — the lawn plane
    // already provides the green, so no need to overlay another plane.
    return g;
  }

  private async populateDemoRestaurant(): Promise<void> {
    // NOTE: demoReady/staffReady promises are created in the constructor
    // — see the field declarations. We only RESOLVE them here, never
    // re-create them, so the engine's `.then(...)` references stay live.
    // Bare-minimum starter restaurant: front door, one cooking station,
    // one sink (so dishwashing has a baseline), one 4-top dining table.
    // Everything else — extra tables, fridge / microwave / counters,
    // plants, lamps, decor, sidewalk props — is something the player
    // earns and chooses from the build menu. This keeps a fresh save's
    // canvas clean instead of pre-populating it with an entire bistro.
    const placements: { id: string; x: number; z: number; rotY?: number; tier?: number }[] = [
      // Front door (entrance — guests spawn outside and walk through it).
      // z=5.5 lines up with the (+0.5, +0.5)-shifted front wall.
      // Anchored at half-integer here because the door mesh's frame is
      // centered at its local origin and needs to sit ON the wall plane
      // rather than half a tile inside the building.
      { id: "door",         x:  0, z:  5.5, rotY: Math.PI },
      // Essential appliances — stove + sink along the back wall.
      { id: "stove",        x:  0, z: -4 },
      { id: "sink",         x: -1, z: -4 },
      // Starter bar counter — 2-wide on the back wall to the right
      // of the kitchen line. Half-integer anchor (x=2.5) spans tiles
      // 2 and 3. No stools yet — the player buys them when they're
      // ready to hire a barman (tier 2 unlock). The counter alone
      // gives the kitchen visual presence without prematurely
      // surfacing the bar role.
      { id: "bar-counter",  x:  2.5, z: -4, rotY: 0, tier: 1 },
      // Starter 4-top: 2×2 table anchored at (0.5, 1.5). Chairs go
      // in the four corner-adjacent cells (pinwheel pattern) so each
      // chair sits AT a tile center rather than straddling tile
      // borders. Each chair gets its own corner of the table top for
      // the plate, so there's no plate conflict between adjacent seats.
      { id: "small-table",  x:  0.5, z:  1.5, tier: 1 },
      // Bench-style chairs around the 2×2 table — 2 on the north side
      // (z=0) and 2 on the south side (z=3). Matches the bench layout
      // shown in the player's reference. Kenney chair GLB has its back
      // at -Z by default; for the back to point AWAY from the table,
      // north chairs use rotY = 0 (back at -Z, customer facing south),
      // south chairs use rotY = π (back at +Z, customer facing north).
      { id: "wooden-chair", x:  0,   z:  0,   rotY: 0,        tier: 1 },
      { id: "wooden-chair", x:  1,   z:  0,   rotY: 0,        tier: 1 },
      { id: "wooden-chair", x:  0,   z:  3,   rotY: Math.PI,  tier: 1 },
      { id: "wooden-chair", x:  1,   z:  3,   rotY: Math.PI,  tier: 1 },
    ];

    // Boot diagnostic — list every starter placement id the build is
    // actually running with. Player can grep DevTools for this to
    // confirm whether a missing piece (e.g. bar-counter) is because
    // they're on an old cached bundle vs. a load failure.
    console.log(`[WorldScene] starter placements: ${placements.map((p) => p.id).join(", ")}`);
    await Promise.all(placements.map(async (p) => {
      const def = getFurnitureDef(p.id);
      if (!def) {
        console.warn(`Unknown furniture id: ${p.id}`);
        return;
      }
      try {
        const model = await this.loader.load(def.modelPath);
        fitFurniture(model, def);
        model.position.set(p.x, model.position.y, p.z);
        if (p.rotY != null) model.rotation.y = p.rotY;
        // Wall-hug pass — same one BuildMenu + FurnitureRegistry.restore
        // use, so the demo placements match player + load behaviour.
        snapToAdjacentWall(model, def);
        this.threeScene.add(model);
        this.demoPlacements.push({ defId: p.id, x: p.x, z: p.z, rotY: p.rotY ?? 0, model });
        // Group by tier so we can hide locked sections.
        const tier = p.tier ?? 0;
        if (!this.tierGroups.has(tier)) this.tierGroups.set(tier, []);
        this.tierGroups.get(tier)!.push(model);
        // Capture the front-door's hinge sub-object for open/close animation.
        // The procedural front-door exposes the panel hinge via userData.panel.
        if (p.id === "door" && p.x === 0 && p.z === 5.5) {
          const panel = model.userData?.panel as THREE.Object3D | undefined;
          if (panel) this.doorPanel = panel;
        }
        // Per-stove flames are reconciled every frame by the Engine via
        // syncStoveFlames(registry.getCookingStoves()) — no need to pin
        // one here. Demo-stove placements show up in the registry just
        // like player placements and are picked up on the next frame.
      } catch (err) {
        console.error(`Failed to load ${def.id} (${def.modelPath})`, err);
      }
    }));

    this.buildTierMarkers();
    this.resolveDemoReady();
    await this.populateCharacters();
  }

  /** Tier-lock markers (the colored discs + glowing pillars) were removed
   * in the starter-restaurant revamp — they only made sense alongside
   * the pre-placed demo dining sections, which no longer exist. The
   * field is kept (empty) for save-time backwards compatibility, but
   * nothing is rendered. */
  private buildTierMarkers(): void {
    // Intentionally empty.
  }

  /** Show/hide tier-locked dining sections based on the player's current
   * expansion. Called by Engine on init and after Game.buyExpansion.
   * Also drives the multi-storey reveal — each tier past 1 unlocks one
   * upper storey (T2 → storey 1, T3 → storey 2, T4 → storey 3,
   * T5 → storey 4). The roof shows as long as ANY upper storey is up. */
  setLuxuryTier(tier: number): void {
    this.currentTierVisible = tier;
    for (const [tierKey, items] of this.tierGroups) {
      if (tierKey === 0) continue;
      const visible = tierKey <= tier;
      for (const obj of items) obj.visible = visible;
    }
    this.applyStoreyVisibility();
  }

  /** Switch the camera-focus floor. Triggers a visibility re-pass so
   * the storeys ABOVE the new focus disappear (guarantees zero
   * obstruction of the focused floor) and at-or-below ones show. */
  setFocusedStorey(idx: number): void {
    const clamped = Math.max(0, Math.min(WorldScene.NUM_STOREYS - 1, idx));
    if (clamped === this.focusedStorey) return;
    this.focusedStorey = clamped;
    this.applyStoreyVisibility();
  }

  /** Recompute which upper storeys + roof render based on the current
   * tier (which ones are UNLOCKED), the focused storey (anything
   * above is HIDDEN so it can't obscure the focused floor), and
   * whether the player is in exterior mode (zoomed out past 40%,
   * in which case we show every UNLOCKED storey + the roof so the
   * building reads as a closed structure). Called from
   * setLuxuryTier, setFocusedStorey, and setExteriorMode. */
  private applyStoreyVisibility(): void {
    const tier = this.currentTierVisible;
    for (const [storeyIdx, storey] of this.upperStoreys) {
      const unlocked = tier >= storeyIdx + 1;
      const atOrBelow = storeyIdx <= this.focusedStorey;
      // Exterior: every unlocked storey visible.
      // Interior: only at-or-below the focused storey.
      storey.group.visible = unlocked && (this.exteriorMode || atOrBelow);
    }
    // Staircases: each flight is parented to the storey it LEAVES
    // FROM, so the lower storey's group visibility already gates focus
    // for flights 2..N. We just need to gate by tier here — a flight
    // only makes sense if its destination storey exists. For flight 1
    // (ground → Floor 1) the parent is the main scene, so this is the
    // only visibility control it gets.
    for (const [stairIdx, stairGroup] of this.stairFlights) {
      stairGroup.visible = tier >= stairIdx + 1;
    }
    // Legacy flat roof — kept hidden; the Paris mansard below takes
    // over the visual role.
    if (this.buildingRoof) {
      this.buildingRoof.visible = false;
    }
    // Mansard roof + cap + chimney sit on top of the topmost UNLOCKED
    // storey so the building visibly grows as the player buys
    // expansions. Exterior-only — in interior view the camera looks
    // down into the focused floor, so no roof should occlude it.
    const mansardBaseY = tier * WorldScene.STOREY_HEIGHT;
    const mansardH = 1.2;
    const showMansard = this.exteriorMode && tier > 0;
    if (this.parisMansard) {
      this.parisMansard.visible = showMansard;
      this.parisMansard.position.y = mansardBaseY + mansardH / 2;
    }
    if (this.parisMansardCap) {
      this.parisMansardCap.visible = showMansard;
      this.parisMansardCap.position.y = mansardBaseY + mansardH + 0.05;
    }
    if (this.parisMansardChimney) {
      this.parisMansardChimney.visible = showMansard;
      this.parisMansardChimney.position.y = mansardBaseY + mansardH + 0.55;
    }
    // Iron balconies — only show in exterior mode. In interior view
    // they read as spiky black noise outside the wall ghost (no value
    // when the player is doing close-up build work). Each balcony's
    // OWN storey-group visibility still gates them additionally, so
    // they only render when the storey they belong to is on-screen.
    for (const b of this.parisBalconies) {
      b.visible = this.exteriorMode;
    }
  }

  /** Toggle the sun's shadow casting wholesale. Cheaper than keeping
   * shadows on with no casters — three.js still pays render-target
   * setup costs even when no objects opt in to castShadow. Engine
   * calls this from the quality preset AND every frame based on
   * camera zoom (no shadows when zoomed out past the exterior
   * threshold; the player can't see them at that scale anyway). */
  setSunShadowsEnabled(enabled: boolean): void {
    if (!this.sunLight) return;
    if (this.sunLight.castShadow === enabled) return;
    this.sunLight.castShadow = enabled;
  }

  /** Walk a single model + its descendants and toggle every mesh's
   * castShadow flag. Used by Engine.applyGraphicsQuality to flip
   * furniture (loaded via ModelLoader, which defaults castShadow
   * to true on every mesh) without disturbing the hand-built
   * scene geometry whose shadow policies were tuned in their
   * own factory functions. */
  setShadowCastingOnSubtree(root: THREE.Object3D, enabled: boolean): void {
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        (obj as THREE.Mesh).castShadow = enabled;
      }
    });
  }

  /** Force Three.js to compile shader programs for every material in
   * the scene RIGHT NOW, including objects that are currently hidden
   * (upper storeys, the mansard roof, balconies, etc).
   *
   * Three.js compiles a fragment+vertex program lazily the first time
   * a given material/geometry combo is actually rendered. Upper
   * storeys start with `.visible = false`, so their materials never
   * get compiled at startup — and the first time the player clicks
   * a floor button to reveal Floor 1+, the renderer stalls for
   * ~50-300 ms compiling every fresh program. That's the "laggy"
   * feel when clicking floor buttons.
   *
   * Workaround: briefly flip every storey + balcony + roof visible,
   * call `renderer.compile`, then restore the original visibility.
   * The compile call is synchronous and traverses all visible objects,
   * compiling each material's program against the camera's current
   * settings. After this, every storey reveal is instant. Cheap to
   * call once at startup; safe to call again later if new materials
   * are added (re-compiling already-compiled programs is a no-op). */
  precompileShaders(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    // Snapshot current visibility of everything we'll flip.
    type Snap = { obj: THREE.Object3D; visible: boolean };
    const snaps: Snap[] = [];
    const flip = (obj: THREE.Object3D | undefined | null): void => {
      if (!obj) return;
      snaps.push({ obj, visible: obj.visible });
      obj.visible = true;
    };
    for (const [, storey] of this.upperStoreys) flip(storey.group);
    for (const [, stair] of this.stairFlights) flip(stair);
    flip(this.parisMansard);
    flip(this.parisMansardCap);
    flip(this.parisMansardChimney);
    flip(this.buildingRoof);
    for (const b of this.parisBalconies) flip(b);
    try {
      renderer.compile(this.threeScene, camera);
    } catch (e) {
      // Hard to imagine compile failing, but a partial compile leaves
      // valid programs in the cache so the next render still works.
      console.warn("[WorldScene] precompile failed:", e);
    }
    // Restore exactly what was visible before.
    for (const s of snaps) s.obj.visible = s.visible;
  }

  /** Switch the world between interior view (default; see-through walls,
   * focus-only storey visibility, hidden roof) and exterior view
   * (closed walls on every side, all unlocked storeys + roof visible
   * regardless of focus). Engine.tick toggles this based on the
   * camera's current zoom percentage. */
  setExteriorMode(on: boolean): void {
    if (this.exteriorMode === on) return;
    this.exteriorMode = on;
    // Re-apply storey/roof visibility immediately. Walls update on the
    // next frame via updateWallVisibility, which already reads the
    // mode flag.
    this.applyStoreyVisibility();
  }

  /** Whether the world is currently in exterior-only view (see
   * setExteriorMode). Used by Engine to keep the SFX bus in sync —
   * interior sounds are muted while exterior mode is active. */
  isExteriorMode(): boolean {
    return this.exteriorMode;
  }

  /** Position the shared city so the player's claimed plot lines up
   * with the restaurant's local origin. The player's tower stays at
   * (0, 0) in local coordinates; worldRoot is offset by (-plotX,
   * -plotZ) so neighbouring plot shells, avenues, and scenery sit at
   * their correct positions RELATIVE to the player. From a shared-
   * map perspective each player IS at their claimed coordinates;
   * each client renders the same absolute layout with a different
   * origin under the camera. */
  setOwnedPlotOffset(plotX: number, plotZ: number): void {
    this.worldRoot.position.set(-plotX, 0, -plotZ);
    this.ownedPlotAnchor.set(plotX, plotZ);
  }

  /** Current applied tier (used by the door animator). */
  getLuxuryTier(): number {
    return this.currentTierVisible;
  }

  /** Currently-focused storey (0 = ground). Used by FloorSelector to
   * know which button is "active". */
  getFocusedStorey(): number {
    return this.focusedStorey;
  }

  /** Constant — meters between adjacent floor slabs. The floor selector
   * uses this to compute the camera look-at lift per storey. */
  static getStoreyHeight(): number {
    return WorldScene.STOREY_HEIGHT;
  }

  /** Constant — how many storeys the building can grow to (ground + 4
   * upper). FloorSelector renders one button per storey index in
   * [0, NUM_STOREYS). */
  static getNumStoreys(): number {
    return WorldScene.NUM_STOREYS;
  }

  /** Return the THREE container a furniture item placed on `floor`
   * should be parented to. Ground floor (0) lives in the main scene
   * and is always visible; upper floors live in their storey group so
   * focus + tier visibility apply automatically. Used by the registry
   * + BuildMenu to mount per-floor placements into the right subtree. */
  getStoreyMount(floor: number): THREE.Object3D {
    if (floor <= 0) return this.threeScene;
    return this.upperStoreys.get(floor)?.group ?? this.threeScene;
  }

  /** Spawn an extra staff character at runtime (when player hires another).
   * Slots them in just to the right of the existing crew so they don't
   * overlap. `homeFloor` (default 0) parents the model into that
   * storey's mount so visibility tracks the focused floor. Returns the
   * AnimatedCharacter, or null if the GLB failed to load. */
  async spawnExtraStaff(role: "chef" | "waiter" | "errand" | "barman", offsetSlot: number, homeFloor = 0): Promise<AnimatedCharacter | null> {
    // Matches the new starter homes in populateCharacters — further south
    // so the walking distance to the kitchen line is large enough to read.
    // Barman spawns alongside the waiter line on the kitchen side; the
    // router immediately routes them to their bar counter via the idle
    // picker, so this is just a temporary "landing pad" pose.
    const homeByRole: Record<"chef" | "waiter" | "errand" | "barman", { x: number; z: number; facingY: number; action: CharacterAction }> = {
      // Reverted to original facingY values — the formula tweaks made
      // crab walking worse instead of better.
      chef:   { x: -1.5, z: -1.0, facingY: 0,            action: "idle" },
      waiter: { x:  1.5, z: -1.0, facingY: 0,            action: "idle" },
      barman: { x:  2.5, z: -1.0, facingY: 0,            action: "idle" },
      errand: { x:  3.5, z: -1.0, facingY: -Math.PI / 2, action: "idle" },
    };
    const base = homeByRole[role];
    // Stagger each new hire 0.6 units further along the kitchen line.
    const x = base.x + offsetSlot * 0.6;
    try {
      const model = await this.characterLoader.load(role);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(x, base.z),
        facingY: base.facingY,
        action: base.action,
        phase: Math.random() * 5,
        seatHeight: 0.5,
      };
      // Lift the model's Y by the home-floor's slab so an upper-floor
      // chef stands ON Floor 1+ instead of floating at y=0. Parent it
      // into the storey mount so the storey-visibility rules apply.
      model.position.y += homeFloor * WorldScene.STOREY_HEIGHT;
      this.getStoreyMount(homeFloor).add(model);
      this.animator.add(animated);
      return animated;
    } catch (err) {
      console.warn(`Failed to spawn extra ${role}:`, err);
      return null;
    }
  }

  /** Re-parent a previously spawned staff character to a different
   * floor. Adjusts the model's Y by the storey-height delta and moves
   * it under the new storey's mount. Called by Engine when the player
   * changes a member's homeFloor in StaffPanel. */
  relocateStaff(character: AnimatedCharacter, fromFloor: number, toFloor: number): void {
    if (fromFloor === toFloor) return;
    const dy = (toFloor - fromFloor) * WorldScene.STOREY_HEIGHT;
    character.root.position.y += dy;
    // ALSO bump _baseY by the same delta so the CharacterAnimator's
    // per-frame "reset position.y = _baseY" doesn't snap the body back
    // to the storey we just moved them off of. For IDLE staff (mover
    // isn't running, so it can't keep _baseY in sync via the multi-
    // floor walk logic) this is the only place _baseY gets updated
    // for a floor change.
    if (character._baseY != null) character._baseY += dy;
    const newMount = this.getStoreyMount(toFloor);
    if (character.root.parent !== newMount) newMount.add(character.root);
  }

  /** Re-parent a character to a different storey's mount without
   * touching its Y. Used by StaffRouter / GuestSpawner when an actor
   * crosses the staircase: the mover has already set the body's world Y
   * to the new slab via the multi-floor path's stair interpolation, we
   * just need the model to live under the new floor's group so storey
   * focus visibility shows it on the right floor. */
  reparentCharacterToFloor(character: AnimatedCharacter, toFloor: number): void {
    const newMount = this.getStoreyMount(toFloor);
    if (character.root.parent !== newMount) {
      // THREE.Object3D.add preserves local position, which is what we
      // want — caller has already set world Y via the move interp.
      newMount.add(character.root);
    }
  }

  /** Place the static staff models (chef + waiter + errand) at the kitchen
   * line. Guests are spawned dynamically by GuestSpawner — they're not
   * placed here. */
  private async populateCharacters(): Promise<void> {
    // Spread the kitchen crew further apart and out into the dining-side
    // of the room. With everyone clustered at z=-2.6 (one row away from
    // the stove at z=-3) the chef's working walks were ~0.6 units, easy
    // to miss. New home positions put the chef ~2 units south of the
    // stove and the waiter ~2.5 from the pickup point — every ticket now
    // forces a clearly visible cross-kitchen trip.
    const staff: { id: string; x: number; z: number; facingY: number; action: CharacterAction }[] = [
      // Reverted to original facingY values — see spawnExtraStaff above.
      { id: "chef",   x: -1.5, z: -1.0, facingY: 0,            action: "idle"  },
      { id: "waiter", x:  1.5, z: -1.0, facingY: 0,            action: "idle"  },
      { id: "errand", x:  3.5, z: -1.0, facingY: -Math.PI / 2, action: "idle"  },
    ];

    // staffReady promise is created in the constructor (above) so any
    // synchronous consumer that grabbed the reference up-front waits for
    // this resolution rather than the initial sentinel. We only resolve
    // it here.

    await Promise.all(staff.map(async (c) => {
      try {
        const model = await this.characterLoader.load(c.id);
        const animated: AnimatedCharacter = {
          root: model,
          groundPos: new THREE.Vector2(c.x, c.z),
          facingY: c.facingY,
          action: c.action,
          phase: Math.random() * 5,
          seatHeight: 0.5,
        };
        this.threeScene.add(model);
        this.animator.add(animated);
        if (c.id === "chef") this.chefChar = animated;
        if (c.id === "waiter") this.waiterChar = animated;
        if (c.id === "errand") this.errandChar = animated;
      } catch (err) {
        console.warn(`Character ${c.id} unavailable:`, err);
      }
    }));
    console.log(`[WorldScene] populateCharacters done: chef=${this.chefChar ? "OK" : "MISSING"} waiter=${this.waiterChar ? "OK" : "MISSING"} errand=${this.errandChar ? "OK" : "MISSING"} — resolving staffReady`);
    this.resolveStaffReady();
  }
}
