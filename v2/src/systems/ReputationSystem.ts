import type { PlacedFurniture, SaveGameState } from "../data/types";
import { getFurnitureDefinition } from "../data/furniture";

import { clamp } from "../data/util";
export const maxRatingHistory = 500;
const defaultUnratedAverage = 3;

export class ReputationSystem {
  private reputation: number;
  private satisfactionPercent: number;
  private ratingHistory: number[] = [];

  /** Phase I.5 (H.60) — cloud handle for mirroring the rating
   * history to Restaurant.cloud_rating_history_csv on every
   * recordRating call.  Engine wires this after connect; null in
   * tests / pre-cloud boot. */
  cloud?: import("../cloud/SpacetimeClient").SpacetimeClient;

  constructor(reputation = 1, satisfactionPercent = 100) {
    this.reputation = reputation;
    this.satisfactionPercent = satisfactionPercent;
  }

  getReputation(): number {
    return this.reputation;
  }

  getSatisfactionPercent(): number {
    return this.satisfactionPercent;
  }

  getDecorationScore(furniture: PlacedFurniture[]): number {
    const meaningfulFurniture = furniture.filter((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return definition.category !== "flooring" && definition.category !== "wallDecoration";
    });
    const rawScore = meaningfulFurniture.reduce((score, item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      const decorWeight =
        definition.category === "decoration" || definition.category === "plant" || definition.category === "lighting"
          ? 1.2
          : 0.55;
      return score + (definition.comfort + definition.style + (definition.attractionBonus ?? 0)) * decorWeight;
    }, 0);
    const clutterPenalty = Math.max(0, meaningfulFurniture.length - 26) * 0.05;
    const score = 1 + Math.min(1, rawScore / 95) * 4 - clutterPenalty;
    return Math.round(clamp(score, 0.5, 5) * 10) / 10;
  }

  getAttractiveness(furniture: PlacedFurniture[]): number {
    const decorScore = this.getDecorationScore(furniture);
    const reputationScore = clamp(this.reputation, 0.5, 5);
    const score = decorScore * 0.72 + reputationScore * 0.28;
    return Math.round(clamp(score, 0.5, 5) * 10) / 10;
  }

  setReputation(reputation: number): void {
    this.reputation = reputation;
  }

  /** Append a new 1–5 customer rating. Older entries past maxRatingHistory are dropped. */
  /** Admin / dev-tool: wipe rating history so the next customer's
   * rating fully determines the running average again. */
  adminReset(): void {
    this.ratingHistory = [];
  }

  recordRating(rating: number): void {
    this.ratingHistory.push(clamp(Math.round(rating), 1, 5));
    if (this.ratingHistory.length > maxRatingHistory) {
      this.ratingHistory = this.ratingHistory.slice(-maxRatingHistory);
    }
    // H.60 — mirror the full snapshot.  Server-side idempotency
    // skips writes when content unchanged; the value is small (~1KB
    // max) so push-every-time is cheaper than diffing.
    if (this.cloud) {
      this.cloud.setCloudRatingHistory(this.ratingHistory);
    }
  }

  /** Phase I.5 (H.60) — override the local rating list from a fresh
   * cloud snapshot (called by Engine on subscription ready, after
   * save.hydrate has restored stale values).  Clamps each entry to
   * [1, 5] for safety.  Does NOT re-fire the cloud mirror. */
  applyCloudRatingHistory(history: readonly number[]): void {
    this.ratingHistory = history
      .map((r) => clamp(Math.round(r), 1, 5))
      .slice(-maxRatingHistory);
  }

  getRatingHistory(): readonly number[] {
    return this.ratingHistory;
  }

  /** Returns a fresh array suitable for saving. */
  getRatingHistorySnapshot(): number[] {
    return this.ratingHistory.slice();
  }

  getRatingCount(): number {
    return this.ratingHistory.length;
  }

  getRatingTotal(): number {
    return this.ratingHistory.reduce((sum, rating) => sum + rating, 0);
  }

  /** Average of recorded ratings, or 3.0 when no ratings exist yet. */
  getAverageRating(): number {
    return this.ratingHistory.length === 0
      ? defaultUnratedAverage
      : this.getRatingTotal() / this.ratingHistory.length;
  }

  /** Re-clamp the in-memory history (e.g. after a save repair). */
  reconcileRatingHistory(): void {
    if (this.ratingHistory.length > maxRatingHistory) {
      this.ratingHistory = this.ratingHistory.slice(-maxRatingHistory);
    }
  }

  /** Replace in-memory rating + history from a save snapshot. The
   * `reputation` numeric score was previously not restored, so every
   * reload reset the player's reputation to 1.0. */
  hydrate(save: SaveGameState | null | undefined): void {
    if (typeof save?.reputation === "number" && Number.isFinite(save.reputation)) {
      this.reputation = save.reputation;
    }
    this.ratingHistory = hydrateRatingHistoryFromSave(save);
  }
}

/**
 * Reconstruct a rating history array from a save state, normalising entries and handling
 * legacy saves that stored only ratingTotal/ratingCount without per-vote history.
 *
 * Exported so the scene can preview ratings on alternate save slots without instantiating
 * a full ReputationSystem just for the format helper.
 */
export function hydrateRatingHistoryFromSave(save: SaveGameState | null | undefined): number[] {
  if (save?.ratingHistory?.length) {
    return save.ratingHistory
      .slice(-maxRatingHistory)
      .map((rating) => clamp(Math.round(rating), 1, 5));
  }

  const legacyVotes = Math.min(save?.ratingCount ?? 0, maxRatingHistory);
  if (legacyVotes <= 0) {
    return [];
  }

  const legacyAverage = clamp((save?.ratingTotal ?? legacyVotes * 3) / legacyVotes, 1, 5);
  return Array.from({ length: legacyVotes }, () => Math.round(legacyAverage));
}
