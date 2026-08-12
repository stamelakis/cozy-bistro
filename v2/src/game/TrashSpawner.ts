import * as THREE from "three";
import type { Game } from "./Game";

/**
 * Pedestrians occasionally drop litter on the sidewalk in front of the
 * bistro. 2026-08-12 REWORK — pickup is a MANUAL player action now:
 * pieces no longer auto-recycle for passive income; they lie there (and
 * pile up, capped) until the player taps the ♻ badge over each one for
 * the $2 recycling reward. Engine's litter TapBadges layer reads
 * listPieces() and calls collect(id) on tap.
 *
 * Rewards drip out one claim per ~2.6 s (matching the server's
 * claim_recycle cooldown) so a rapid cleanup spree still pays for every
 * piece instead of losing taps to the rate limit.
 *
 * Visuals: recognizable litter "decals" — emoji drawn onto small canvas
 * textures, lying flat on the pavement with random spin — instead of the
 * old anonymous brown boxes.
 */

const SPAWN_INTERVAL_SECONDS = 9;
/** Money earned per piece recycled — matches server RECYCLE_REWARD_CENTS. */
const RECYCLE_REWARD = 2;
/** Server claim_recycle cooldown is 2.5 s; drip a hair slower. */
const REWARD_DRIP_SECONDS = 2.6;
/** Sidewalk z (matches PedestrianSpawner.PAVEMENT_Z). */
const PAVEMENT_Z = 7;
const PAVEMENT_X_RANGE = 14;
/** Cap to prevent infinite buildup — at the cap the street just stays
 * messy until the player cleans, which is the point. */
const MAX_PIECES = 12;

/** Litter looks — emoji rendered to a canvas texture each. */
const LITTER_EMOJI = ["🗞️", "🥤", "🍌", "🍾", "🥡", "🍕"] as const;

interface TrashPiece {
  id: number;
  mesh: THREE.Mesh;
}

let litterMats: THREE.MeshBasicMaterial[] | undefined;
let litterGeo: THREE.PlaneGeometry | undefined;
function lazyAssets(): { geo: THREE.PlaneGeometry; mats: THREE.MeshBasicMaterial[] } {
  if (!litterGeo) litterGeo = new THREE.PlaneGeometry(0.42, 0.42);
  if (!litterMats) {
    litterMats = LITTER_EMOJI.map((emoji) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.font = "52px system-ui, 'Segoe UI Emoji', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(emoji, 32, 36);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
    });
  }
  return { geo: litterGeo, mats: litterMats };
}

export class TrashSpawner {
  private readonly scene: THREE.Scene;
  private readonly game: Game;
  private readonly pieces: TrashPiece[] = [];
  private cooldown = 6; // initial delay before first drop
  private nextId = 1;
  /** Rewards owed by cleanup taps, paid out one per drip interval. */
  private pendingRewards = 0;
  private rewardCooldown = 0;

  constructor(scene: THREE.Scene, game: Game) {
    this.scene = scene;
    this.game = game;
  }

  update(dt: number): void {
    // Spawn a new piece on cooldown (paused at the cap — the mess waits).
    this.cooldown -= dt;
    if (this.cooldown <= 0 && this.pieces.length < MAX_PIECES) {
      this.dropTrash();
      this.cooldown = SPAWN_INTERVAL_SECONDS + (Math.random() - 0.5) * 5;
    }
    // Drip out owed rewards at the server's claim cadence.
    this.rewardCooldown -= dt;
    if (this.pendingRewards > 0 && this.rewardCooldown <= 0) {
      this.pendingRewards -= 1;
      this.rewardCooldown = REWARD_DRIP_SECONDS;
      this.game.economy.rewardRecycle(RECYCLE_REWARD);
    }
  }

  /** Live pieces for the ♻ tap-badge layer (world coords, ground floor). */
  listPieces(): Array<{ id: string; x: number; z: number }> {
    return this.pieces.map((p) => ({
      id: String(p.id),
      x: p.mesh.position.x,
      z: p.mesh.position.z,
    }));
  }

  /** Player tapped a piece's ♻ badge — remove it and queue the reward. */
  collect(id: string): boolean {
    const idx = this.pieces.findIndex((p) => String(p.id) === id);
    if (idx < 0) return false;
    const [p] = this.pieces.splice(idx, 1);
    this.scene.remove(p.mesh);
    this.pendingRewards += 1;
    return true;
  }

  private dropTrash(): void {
    const { geo, mats } = lazyAssets();
    const mat = mats[Math.floor(Math.random() * mats.length)];
    const mesh = new THREE.Mesh(geo, mat);
    const x = (Math.random() * 2 - 1) * PAVEMENT_X_RANGE;
    const z = PAVEMENT_Z + (Math.random() - 0.5) * 0.8;
    // Lie flat on the pavement like a dropped item, random spin.
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI * 2;
    mesh.position.set(x, 0.02, z);
    this.scene.add(mesh);
    this.pieces.push({ id: this.nextId++, mesh });
  }
}
