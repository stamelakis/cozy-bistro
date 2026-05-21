import type { PlacedFurniture } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";

export class ReputationSystem {
  private reputation: number;
  private satisfactionPercent: number;

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
    return furniture.reduce((score, item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      return score + definition.comfort + definition.style;
    }, 0);
  }

  getAttractiveness(furniture: PlacedFurniture[]): number {
    const score = this.getDecorationScore(furniture);
    return Math.min(100, Math.round(score * 4 + this.reputation * 6));
  }

  setReputation(reputation: number): void {
    this.reputation = reputation;
  }
}
