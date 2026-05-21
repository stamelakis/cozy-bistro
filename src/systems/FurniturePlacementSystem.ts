import Phaser from "phaser";
import type { FurnitureDefinition, GridPosition, PlacedFurniture } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";
import { EconomySystem } from "./EconomySystem";
import { RestaurantGridSystem } from "./RestaurantGridSystem";

export class FurniturePlacementSystem {
  private readonly grid: RestaurantGridSystem;
  private readonly economy: EconomySystem;
  private furniture: PlacedFurniture[];
  private selectedFurnitureId: string | null = null;
  private selectedPlacedUid: string | null = null;

  constructor(grid: RestaurantGridSystem, economy: EconomySystem, initialFurniture: PlacedFurniture[] = []) {
    this.grid = grid;
    this.economy = economy;
    this.furniture = initialFurniture;
  }

  selectCatalogItem(furnitureId: string): void {
    this.selectedFurnitureId = furnitureId;
    this.selectedPlacedUid = null;
  }

  clearSelection(): void {
    this.selectedFurnitureId = null;
    this.selectedPlacedUid = null;
  }

  getSelectedFurnitureId(): string | null {
    return this.selectedFurnitureId;
  }

  getFurniture(): PlacedFurniture[] {
    return this.furniture;
  }

  setFurniture(furniture: PlacedFurniture[]): void {
    this.furniture = furniture;
  }

  tryPlaceSelected(position: GridPosition): { ok: boolean; message: string } {
    if (!this.selectedFurnitureId) {
      const existing = this.getFurnitureAt(position);
      if (existing) {
        this.selectedPlacedUid = existing.uid;
        return { ok: true, message: `${getFurnitureDefinition(existing.furnitureId).name} selected` };
      }

      return { ok: false, message: "Choose furniture from the build menu" };
    }

    const definition = getFurnitureDefinition(this.selectedFurnitureId);
    if (!this.grid.canPlace(definition, position, this.furniture)) {
      return { ok: false, message: "That spot is blocked" };
    }

    if (!this.economy.spend(definition.cost)) {
      return { ok: false, message: `Need $${definition.cost}` };
    }

    this.furniture = [
      ...this.furniture,
      {
        uid: Phaser.Math.RND.uuid(),
        furnitureId: definition.id,
        position,
      },
    ];

    return { ok: true, message: `${definition.name} placed` };
  }

  tryMoveSelected(position: GridPosition): { ok: boolean; message: string } {
    if (!this.selectedPlacedUid) {
      return { ok: false, message: "Select placed furniture first" };
    }

    const placed = this.furniture.find((item) => item.uid === this.selectedPlacedUid);
    if (!placed) {
      return { ok: false, message: "Selection no longer exists" };
    }

    const definition = getFurnitureDefinition(placed.furnitureId);
    if (!this.grid.canPlace(definition, position, this.furniture, placed.uid)) {
      return { ok: false, message: "Cannot move there" };
    }

    this.furniture = this.furniture.map((item) =>
      item.uid === placed.uid ? { ...item, position } : item,
    );

    return { ok: true, message: `${definition.name} moved` };
  }

  removeAt(position: GridPosition): { ok: boolean; message: string } {
    const existing = this.getFurnitureAt(position);
    if (!existing) {
      return { ok: false, message: "Nothing to remove" };
    }

    const definition = getFurnitureDefinition(existing.furnitureId);
    this.furniture = this.furniture.filter((item) => item.uid !== existing.uid);
    this.economy.earn(Math.floor(definition.cost * 0.5));
    this.selectedPlacedUid = null;

    return { ok: true, message: `${definition.name} removed, refunded $${Math.floor(definition.cost * 0.5)}` };
  }

  getFurnitureAt(position: GridPosition): PlacedFurniture | null {
    return (
      this.furniture.find((item) => {
        const definition = getFurnitureDefinition(item.furnitureId);
        return this.grid
          .getOccupiedCells(definition, item.position)
          .some((cell) => cell.x === position.x && cell.y === position.y);
      }) ?? null
    );
  }

  isSelected(uid: string): boolean {
    return this.selectedPlacedUid === uid;
  }
}
