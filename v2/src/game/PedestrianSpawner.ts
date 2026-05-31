import * as THREE from "three";
import type { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import { pick } from "../data/util";
import { WorldScene } from "../scene/WorldScene";

/**
 * Outdoor pedestrians — characters that walk along every street in
 * the city, in either direction, with no gameplay interaction.
 * Pure ambience: the city stops feeling like a deserted set when
 * 8-12 people are crossing the road at any moment.
 *
 * Each pedestrian is born at one end of a randomly-chosen pavement
 * (one of the avenue centerline offsets ±AVENUE_PAVEMENT_OFFSET on
 * either side of every EW/NS avenue), walks to the other end at
 * PEDESTRIAN_SPEED, and despawns. Direction is randomised so the
 * sidewalk traffic looks two-way.
 *
 * Uses the same guest character variants as the customer spawner
 * so we don't need extra assets.
 */

/** Seconds between spawn attempts at the lower end of the jitter
 * window. With ACTIVE_TARGET pedestrians active, this is the upper
 * bound on how often we add another body. Bumped way down from the
 * single-pavement era (7.5 s) so the wider sidewalk network is
 * actually populated. */
const PEDESTRIAN_SPAWN_BASE = 1.4;
const PEDESTRIAN_SPAWN_JITTER = 1.4;
/** Cap on simultaneous pedestrians — keeps the character animator's
 * pose-update cost bounded on slower machines. */
const PEDESTRIAN_CAP = 14;
/** Speed (world units / second). Slow enough to read as a casual
 * stroll, fast enough that the street feels alive. */
const PEDESTRIAN_SPEED = 1.0;
/** Sidewalk centre offset from an avenue's centreline. The avenue
 * has 6 m of asphalt + 0.18 m curb + 5 m of pavement on each side
 * → pavement centre sits at ±8.09 m. Round to 8 for cleaner numbers. */
const AVENUE_PAVEMENT_OFFSET = 8;
/** Pedestrians despawn when they walk this far past either end of
 * the avenue's visible span. Matches WorldScene.AVENUE_WALK_HALF_LEN. */
const STREET_BOUNDARY = WorldScene.AVENUE_WALK_HALF_LEN + 2;

const VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

/** Where a pedestrian is allowed to walk. EW = east-west pavement
 * (constant z, x is the travel axis). NS = north-south pavement
 * (constant x, z is the travel axis). */
interface PavementRoute {
  kind: "ew" | "ns";
  /** Constant axis (z for EW, x for NS). */
  fixedAxis: number;
}

interface Pedestrian {
  character: AnimatedCharacter;
  route: PavementRoute;
  /** Direction of travel along the route's free axis. -1 / +1. */
  dir: number;
}

export class PedestrianSpawner {
  private readonly scene: THREE.Scene;
  private readonly loader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly people: Pedestrian[] = [];
  private cooldown = 1.0;
  /** Cached list of every pavement on the city map — one entry per
   * (avenue × side), built once at construction time. */
  private readonly routes: PavementRoute[];

  constructor(scene: THREE.Scene, loader: CharacterLoader, animator: CharacterAnimator) {
    this.scene = scene;
    this.loader = loader;
    this.animator = animator;
    // Two pavements per avenue (north + south for EW, east + west
    // for NS). The fixedAxis is the pavement's constant coordinate;
    // the avenue's perpendicular axis is the walk direction.
    const routes: PavementRoute[] = [];
    for (const az of WorldScene.EW_AVENUES) {
      routes.push({ kind: "ew", fixedAxis: az - AVENUE_PAVEMENT_OFFSET });
      routes.push({ kind: "ew", fixedAxis: az + AVENUE_PAVEMENT_OFFSET });
    }
    for (const ax of WorldScene.NS_AVENUES) {
      routes.push({ kind: "ns", fixedAxis: ax - AVENUE_PAVEMENT_OFFSET });
      routes.push({ kind: "ns", fixedAxis: ax + AVENUE_PAVEMENT_OFFSET });
    }
    this.routes = routes;
  }

  update(dt: number): void {
    this.cooldown -= dt;
    if (this.cooldown <= 0 && this.people.length < PEDESTRIAN_CAP) {
      void this.spawn();
      this.cooldown = PEDESTRIAN_SPAWN_BASE + Math.random() * PEDESTRIAN_SPAWN_JITTER;
    }
    // Walk each pedestrian along their route's free axis + despawn
    // ones that walked past the visible boundary.
    for (let i = this.people.length - 1; i >= 0; i -= 1) {
      const p = this.people[i];
      const step = p.dir * PEDESTRIAN_SPEED * dt;
      if (p.route.kind === "ew") {
        p.character.groundPos.x += step;
        // East = +X. Facing convention from the original spawner:
        // east → -π/2 facing, west → π/2 facing.
        p.character.facingY = p.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
        if (p.character.groundPos.x > STREET_BOUNDARY ||
            p.character.groundPos.x < -STREET_BOUNDARY) {
          this.despawn(i);
        }
      } else {
        p.character.groundPos.y += step;
        // Walking +Z (south) faces 0, -Z (north) faces π.
        p.character.facingY = p.dir > 0 ? 0 : Math.PI;
        if (p.character.groundPos.y > STREET_BOUNDARY ||
            p.character.groundPos.y < -STREET_BOUNDARY) {
          this.despawn(i);
        }
      }
    }
  }

  private despawn(idx: number): void {
    const p = this.people[idx];
    this.scene.remove(p.character.root);
    this.animator.remove(p.character.root);
    this.people.splice(idx, 1);
  }

  /** Snapshot for the PersonalSpace pass. Pedestrians are all movable. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    return this.people.map((p) => ({ character: p.character, pinned: false }));
  }

  private async spawn(): Promise<void> {
    if (this.routes.length === 0) return;
    const route = pick(this.routes);
    const dir = Math.random() < 0.5 ? 1 : -1;
    // Tiny perpendicular jitter so adjacent pedestrians don't render
    // exactly stacked on each other.
    const sideJitter = (Math.random() - 0.5) * 0.6;
    let startX: number, startZ: number, facing: number;
    if (route.kind === "ew") {
      startX = dir > 0 ? -STREET_BOUNDARY : STREET_BOUNDARY;
      startZ = route.fixedAxis + sideJitter;
      facing = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    } else {
      startX = route.fixedAxis + sideJitter;
      startZ = dir > 0 ? -STREET_BOUNDARY : STREET_BOUNDARY;
      facing = dir > 0 ? 0 : Math.PI;
    }
    const variant = pick(VARIANT_IDS);
    try {
      const model = await this.loader.load(variant);
      this.scene.add(model);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(startX, startZ),
        facingY: facing,
        action: "walk",
        phase: Math.random() * 5,
      };
      this.animator.add(animated);
      this.people.push({ character: animated, route, dir });
    } catch (err) {
      console.warn(`Pedestrian spawn failed for ${variant}:`, err);
    }
  }
}
