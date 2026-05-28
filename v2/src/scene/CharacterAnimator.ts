import * as THREE from "three";

/**
 * Procedural pseudo-animation for static (un-rigged) character meshes.
 *
 * Our TripoSR-generated characters are unrigged statues — no bones, no
 * skeletal animation. So we fake "alive" with whole-body transforms:
 *   - Idle:  subtle breathing scale + tiny azimuthal sway
 *   - Walk:  vertical bob + facing the move direction + slight side lean
 *   - Sit:   rotated forward at the hip + lowered Y onto a chair seat
 *   - Carry: walk + small forward pitch
 *
 * This won't fool anyone up close but reads as "characters moving around
 * the restaurant" at iso distance, which is what we need for prototyping
 * gameplay. Real rigged animation is a polish-phase swap.
 */
export type CharacterAction = "idle" | "walk" | "sit" | "carry";

export interface AnimatedCharacter {
  root: THREE.Object3D;
  /** Where the character's feet should be on the floor (xz). */
  groundPos: THREE.Vector2;
  /** Current facing in radians around Y. Three.js convention with our
   * models: 0 = facing -Z, π/2 = facing +X, π = facing +Z, -π/2 = facing
   * -X. To face a motion vector (dx, dz) use Math.atan2(dx, -dz). */
  facingY: number;
  /** What it's doing right now. */
  action: CharacterAction;
  /** Phase offset (seconds) so multiple characters don't sync. */
  phase: number;
  /** Optional: seat Y offset when action = sit (chair seat above floor). */
  seatHeight?: number;
  // Internal: cached base scale so breathing oscillates around it.
  _baseScale?: number;
  // Internal: cached "feet at floor" Y offset captured when the character
  // was added to the animator — preserves CharacterLoader.liftFeetToOrigin
  // through the per-frame position reset.
  _baseY?: number;
}

export class CharacterAnimator {
  private readonly characters: AnimatedCharacter[] = [];
  private elapsed = 0;

  add(c: AnimatedCharacter): void {
    c._baseScale = c.root.scale.x; // assume uniform scale
    c.phase = c.phase ?? Math.random() * 100;
    // Capture the "feet at floor" Y offset that CharacterLoader.liftFeetToOrigin
    // set on the root. The per-frame position reset below restores this Y,
    // not 0 — otherwise characters end up sunk into the floor by half their
    // bbox height.
    c._baseY = c.root.position.y;
    this.characters.push(c);
  }

  remove(root: THREE.Object3D): void {
    const i = this.characters.findIndex((c) => c.root === root);
    if (i >= 0) this.characters.splice(i, 1);
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (const c of this.characters) {
      this.tickCharacter(c);
    }
  }

  private tickCharacter(c: AnimatedCharacter): void {
    const t = this.elapsed + (c.phase ?? 0);
    const base = c._baseScale ?? 1;

    // Always-on subtle "breathing" — slightly oscillate vertical scale.
    const breath = 1 + Math.sin(t * 1.6) * 0.012;
    c.root.scale.set(base, base * breath, base);

    // Reset to neutral pose, then apply the action's transforms. Use the
    // cached _baseY (feet-at-floor offset from CharacterLoader) so the
    // characters don't sink half-way into the ground.
    const baseY = c._baseY ?? 0;
    c.root.position.set(c.groundPos.x, baseY, c.groundPos.y);
    c.root.rotation.set(0, c.facingY, 0);

    switch (c.action) {
      case "idle": {
        // Tiny lateral sway so they don't look completely frozen.
        c.root.rotation.y += Math.sin(t * 0.9) * 0.04;
        break;
      }
      case "walk": {
        // Bigger bob + lean than before — kitchen walks are short and we
        // need them to read instantly. Reads as footstep cadence.
        const bob = Math.abs(Math.sin(t * 6.5)) * 0.16;
        c.root.position.y += bob;
        c.root.rotation.z = Math.sin(t * 6.5) * 0.11;
        // Slight forward lean so they look purposeful, not strolling.
        c.root.rotation.x = 0.05;
        break;
      }
      case "carry": {
        // Cooking / carrying pose. Subtle forward lean with slight
        // breathing-rate variation — reads as "leaning over the stove"
        // or "holding a tray with focus". No bob: feet stay planted on
        // the ground. Used to bob + sway heavily and looked like the
        // chef was riding a pogo stick.
        c.root.rotation.x = 0.09 + Math.sin(t * 1.4) * 0.02;
        c.root.rotation.z = Math.sin(t * 1.1) * 0.015;
        break;
      }
      case "sit": {
        // Drop to seat height and tilt forward slightly to suggest the
        // hip bend. Static — no oscillation while seated.
        c.root.position.y = (c.seatHeight ?? 0.45);
        c.root.rotation.x = 0.18;
        // Subtle hand/torso shift over time so they don't look completely
        // frozen (small azimuth wobble).
        c.root.rotation.y += Math.sin(t * 0.5) * 0.03;
        break;
      }
    }
  }
}
