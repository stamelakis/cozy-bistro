import type { PlacedFurniture } from "../components/types";

export class CustomerSystem {
  getAvailableSeatCount(furniture: PlacedFurniture[]): number {
    return furniture.filter((item) => item.furnitureId === "cafe-chair").length;
  }

  estimateSpawnRate(attractiveness: number, seatCount: number, menuQuality: number): number {
    if (seatCount === 0) {
      return 0;
    }

    return Math.round((attractiveness * 0.45 + seatCount * 8 + menuQuality * 6) / 10);
  }
}
