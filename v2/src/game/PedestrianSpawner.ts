import * as THREE from "three";
import type { CharacterLoader } from "../assets/CharacterLoader";
import { CharacterAnimator, type AnimatedCharacter } from "../scene/CharacterAnimator";
import { pick, between } from "../data/util";

/**
 * Outdoor pedestrians — characters that walk past the front of the
 * restaurant on the sidewalk. Pure ambience; they don't interact with
 * the gameplay loop. Adds "this is a real street" feel.
 *
 * Behaviour:
 *  - A new pedestrian spawns every PEDESTRIAN_INTERVAL seconds.
 *  - They walk along z=PAVEMENT_Z in one direction or the other at
 *    PEDESTRIAN_SPEED.
 *  - When they reach the far edge they despawn.
 *
 * Uses the same guest character variants so we don't need new assets.
 */

const PEDESTRIAN_INTERVAL = 7.5; // seconds between spawns
const PEDESTRIAN_SPEED = 1.0; // world units / second
const PAVEMENT_Z = 7;          // a couple units past the door
const PAVEMENT_X_RANGE = 14;   // walk from -14 to +14 (or reverse)

const VARIANT_IDS = ["guest-v0", "guest-v1", "guest-v2", "guest-v3", "guest-v4", "guest-v5", "guest-v6"];

interface Pedestrian {
  character: AnimatedCharacter;
  /** Direction of travel along x. -1 = leftward, +1 = rightward. */
  dir: number;
}

export class PedestrianSpawner {
  private readonly scene: THREE.Scene;
  private readonly loader: CharacterLoader;
  private readonly animator: CharacterAnimator;
  private readonly people: Pedestrian[] = [];
  private cooldown = 1.5;

  constructor(scene: THREE.Scene, loader: CharacterLoader, animator: CharacterAnimator) {
    this.scene = scene;
    this.loader = loader;
    this.animator = animator;
  }

  update(dt: number): void {
    this.cooldown -= dt;
    if (this.cooldown <= 0) {
      void this.spawn();
      this.cooldown = PEDESTRIAN_INTERVAL + (Math.random() - 0.5) * 4;
    }
    // Walk each pedestrian + despawn ones that left the strip.
    for (let i = this.people.length - 1; i >= 0; i -= 1) {
      const p = this.people[i];
      p.character.groundPos.x += p.dir * PEDESTRIAN_SPEED * dt;
      // Reverted to the post-"backward fix" values — east → -π/2,
      // west → π/2. Crab-walking is a known open issue but the various
      // "fix" attempts kept making it worse, so leaving as it was.
      p.character.facingY = p.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const x = p.character.groundPos.x;
      if (x > PAVEMENT_X_RANGE + 1 || x < -PAVEMENT_X_RANGE - 1) {
        this.scene.remove(p.character.root);
        this.animator.remove(p.character.root);
        this.people.splice(i, 1);
      }
    }
  }

  /** Snapshot for the PersonalSpace pass. Pedestrians are all movable. */
  snapshotMovable(): { character: AnimatedCharacter; pinned: boolean }[] {
    return this.people.map((p) => ({ character: p.character, pinned: false }));
  }

  private async spawn(): Promise<void> {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const startX = dir > 0 ? -PAVEMENT_X_RANGE : PAVEMENT_X_RANGE;
    // Tiny jitter on z so two passers-by don't stack exactly.
    const z = PAVEMENT_Z + (between(0, 4) - 2) * 0.15;
    const variant = pick(VARIANT_IDS);
    try {
      const model = await this.loader.load(variant);
      this.scene.add(model);
      const animated: AnimatedCharacter = {
        root: model,
        groundPos: new THREE.Vector2(startX, z),
        // Match update() — reverted to the post-backward-fix values.
        facingY: dir > 0 ? -Math.PI / 2 : Math.PI / 2,
        action: "walk",
        phase: Math.random() * 5,
      };
      this.animator.add(animated);
      this.people.push({ character: animated, dir });
    } catch (err) {
      console.warn(`Pedestrian spawn failed for ${variant}:`, err);
    }
  }
}
