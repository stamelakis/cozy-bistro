import Phaser from "phaser";
import type { PlacedFurniture, SaveGameState } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";

export const maxRatingHistory = 500;
const defaultUnratedAverage = 3;

export class ReputationSystem {
  private reputation: number;
  private satisfactionPercent: number;
  private ratingHistory: number[] = [];

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
    return Math.round(Phaser.Math.Clamp(score, 0.5, 5) * 10) / 10;
  }

  getAttractiveness(furniture: PlacedFurniture[]): number {
    const decorScore = this.getDecorationScore(furniture);
    const reputationScore = Phaser.Math.Clamp(this.reputation, 0.5, 5);
    const score = decorScore * 0.72 + reputationScore * 0.28;
    return Math.round(Phaser.Math.Clamp(score, 0.5, 5) * 10) / 10;
  }

  setReputation(reputation: number): void {
    this.reputation = reputation;
  }

  /** Append a new 1–5 customer rating. Older entries past maxRatingHistory are dropped. */
  recordRating(rating: number): void {
    this.ratingHistory.push(Phaser.Math.Clamp(Math.round(rating), 1, 5));
    if (this.ratingHistory.length > maxRatingHistory) {
      this.ratingHistory = this.ratingHistory.slice(-maxRatingHistory);
    }
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

  /** Replace in-memory rating history from a save snapshot. */
  hydrate(save: SaveGameState | null | undefined): void {
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
      .map((rating) => Phaser.Math.Clamp(Math.round(rating), 1, 5));
  }

  const legacyVotes = Math.min(save?.ratingCount ?? 0, maxRatingHistory);
  if (legacyVotes <= 0) {
    return [];
  }

  const legacyAverage = Phaser.Math.Clamp((save?.ratingTotal ?? legacyVotes * 3) / legacyVotes, 1, 5);
  return Array.from({ length: legacyVotes }, () => Math.round(legacyAverage));
}
