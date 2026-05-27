import * as THREE from "three";
import type { Game } from "./Game";

/**
 * Pedestrians occasionally drop litter on the sidewalk in front of
 * the bistro. Each piece sits there for ~30 seconds, then gets
 * "recycled" — Game earns $2 and the mesh disappears. Pure flavor
 * income, but it visually reinforces that the street is alive.
 *
 * Matches the 2D drawDroppedTrash / trashRecycleReward mechanic.
 */

const SPAWN_INTERVAL_SECONDS = 9;
/** How long a piece sits before being recycled off-screen. */
const TRASH_LIFETIME_SECONDS = 28;
/** Money earned per piece recycled. */
const RECYCLE_REWARD = 2;
/** Sidewalk z (matches PedestrianSpawner.PAVEMENT_Z). */
const PAVEMENT_Z = 7;
const PAVEMENT_X_RANGE = 14;
/** Cap to prevent infinite buildup. */
const MAX_PIECES = 12;

interface TrashPiece {
  mesh: THREE.Mesh;
  bornAt: number;
}

/** Shared geometry/material so each piece is cheap. */
let geo: THREE.BoxGeometry | undefined;
let mats: THREE.MeshStandardMaterial[] | undefined;
function lazyAssets(): { geo: THREE.BoxGeometry; mats: THREE.MeshStandardMaterial[] } {
  if (!geo) geo = new THREE.BoxGeometry(0.18, 0.1, 0.12);
  if (!mats) {
    mats = [
      new THREE.MeshStandardMaterial({ color: 0x6b4a30, roughness: 0.85 }), // crumpled paper
      new THREE.MeshStandardMaterial({ color: 0x395a3a, roughness: 0.5 }),  // bottle
      new THREE.MeshStandardMaterial({ color: 0xb8a368, roughness: 0.7 }),  // takeout box
      new THREE.MeshStandardMaterial({ color: 0x8e3a3a, roughness: 0.6 }),  // wrapper
    ];
  }
  return { geo, mats };
}

export class TrashSpawner {
  private readonly scene: THREE.Scene;
  private readonly game: Game;
  private readonly pieces: TrashPiece[] = [];
  private cooldown = 6; // initial delay before first drop
  private elapsed = 0;

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
  }

  update(dt: number): void {
    this.elapsed += dt;
    // Spawn a new piece on cooldown.
    this.cooldown -= dt;
    if (this.cooldown <= 0 && this.pieces.length < MAX_PIECES) {
      this.dropTrash();
      this.cooldown = SPAWN_INTERVAL_SECONDS + (Math.random() - 0.5) * 5;
    }
    // Recycle old pieces.
    for (let i = this.pieces.length - 1; i >= 0; i -= 1) {
      const p = this.pieces[i];
      if (this.elapsed - p.bornAt >= TRASH_LIFETIME_SECONDS) {
        this.scene.remove(p.mesh);
        this.pieces.splice(i, 1);
        this.game.economy.earnMoney(RECYCLE_REWARD, "refund");
      }
    }
  }

  private dropTrash(): void {
    const { geo, mats } = lazyAssets();
    const mat = mats[Math.floor(Math.random() * mats.length)];
    const mesh = new THREE.Mesh(geo, mat);
    const x = (Math.random() * 2 - 1) * PAVEMENT_X_RANGE;
    const z = PAVEMENT_Z + (Math.random() - 0.5) * 0.8;
    mesh.position.set(x, 0.05, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.pieces.push({ mesh, bornAt: this.elapsed });
  }
}
