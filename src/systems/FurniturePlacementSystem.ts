import Phaser from "phaser";
import type { FurnitureDefinition, GridPosition, PlacedFurniture } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";
import { EconomySystem } from "./EconomySystem";
import { RestaurantGridSystem } from "./RestaurantGridSystem";

export class FurniturePlacementSystem {
  private readonly grid: RestaurantGridSystem;
  private readonly economy: EconomySystem;
  private readonly costResolver: (definition: FurnitureDefinition) => number;
  private furniture: PlacedFurniture[];
  private selectedFurnitureId: string | null = null;
  private selectedPlacedUid: string | null = null;
  private selectedRotation = 0;

  constructor(
    grid: RestaurantGridSystem,
    economy: EconomySystem,
    initialFurniture: PlacedFurniture[] = [],
    costResolver: (definition: FurnitureDefinition) => number = (definition) => definition.cost,
  ) {
    this.grid = grid;
    this.economy = economy;
    this.furniture = initialFurniture;
    this.costResolver = costResolver;
  }

  selectCatalogItem(furnitureId: string): void {
    this.selectedFurnitureId = furnitureId;
    this.selectedPlacedUid = null;
    this.selectedRotation = 0;
  }

  clearSelection(): void {
    this.selectedFurnitureId = null;
    this.selectedPlacedUid = null;
  }

  getSelectedFurnitureId(): string | null {
    return this.selectedFurnitureId;
  }

  getSelectedPlacedUid(): string | null {
    return this.selectedPlacedUid;
  }

  getSelectedRotation(): number {
    return this.selectedRotation;
  }

  setSelectedRotation(rotation: number): void {
    this.selectedRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  }

  getSelectedPlacedFurniture(): PlacedFurniture | null {
    return this.furniture.find((item) => item.uid === this.selectedPlacedUid) ?? null;
  }

  selectPlacedFurniture(uid: string): { ok: boolean; message: string } {
    const placed = this.furniture.find((item) => item.uid === uid);
    if (!placed) {
      return { ok: false, message: "Selection no longer exists" };
    }

    this.selectedFurnitureId = null;
    this.selectedPlacedUid = placed.uid;
    this.selectedRotation = placed.rotation ?? 0;
    return { ok: true, message: `${getFurnitureDefinition(placed.furnitureId).name} selected` };
  }

  rotateSelectedCatalog(): number {
    this.selectedRotation = (this.selectedRotation + 90) % 360;
    return this.selectedRotation;
  }

  rotateSelectedPlaced(): { ok: boolean; message: string } {
    if (!this.selectedPlacedUid) {
      return { ok: false, message: "Select placed furniture first" };
    }

    const placed = this.getSelectedPlacedFurniture();
    if (!placed) {
      return { ok: false, message: "Selection no longer exists" };
    }

    const definition = getFurnitureDefinition(placed.furnitureId);
    this.selectedRotation = (this.selectedRotation + 90) % 360;
    return { ok: true, message: `${definition.name} rotation preview: ${this.selectedRotation} degrees` };
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
        this.selectedRotation = existing.rotation ?? 0;
        return { ok: true, message: `${getFurnitureDefinition(existing.furnitureId).name} selected` };
      }

      return { ok: false, message: "Choose furniture from the build menu" };
    }

    const definition = getFurnitureDefinition(this.selectedFurnitureId);
    if (!this.grid.canPlace(definition, position, this.furniture, undefined, {
      ignoreFlooring: definition.category !== "flooring",
      rotation: this.selectedRotation,
    })) {
      return { ok: false, message: "That spot is blocked" };
    }

    const requestedCells = this.grid.getOccupiedCells(definition, position, this.selectedRotation);
    if (definition.category === "flooring") {
      const matchingFloorAlreadyPlaced = requestedCells.every((requested) =>
        this.furniture.some((item) => {
          const existingDefinition = getFurnitureDefinition(item.furnitureId);
          if (existingDefinition.category !== "flooring" || item.furnitureId !== definition.id) {
            return false;
          }

          return this.grid
            .getOccupiedCells(existingDefinition, item.position, item.rotation ?? 0)
            .some((cell) => cell.x === requested.x && cell.y === requested.y);
        }),
      );
      if (matchingFloorAlreadyPlaced) {
        return { ok: true, message: `${definition.name} already there` };
      }
    }

    if (this.isWallFinishFurniture(definition)) {
      const selectedRotation = this.normalizeRotation(this.selectedRotation);
      const matchingWallFinishAlreadyPlaced = requestedCells.every((requested) =>
        this.furniture.some((item) => {
          const existingDefinition = getFurnitureDefinition(item.furnitureId);
          if (!this.isWallFinishFurniture(existingDefinition) || item.furnitureId !== definition.id) {
            return false;
          }
          if (this.normalizeRotation(item.rotation ?? 0) !== selectedRotation) {
            return false;
          }

          return this.grid
            .getOccupiedCells(existingDefinition, item.position, item.rotation ?? 0)
            .some((cell) => cell.x === requested.x && cell.y === requested.y);
        }),
      );
      if (matchingWallFinishAlreadyPlaced) {
        return { ok: true, message: `${definition.name} already there` };
      }
    }

    const cost = this.costResolver(definition);
    if (!this.economy.spend(cost)) {
      const shortfall = Math.max(0, cost - this.economy.getMoney());
      return { ok: false, message: `Not enough money: need $${shortfall} more for ${definition.name}` };
    }

    const furniture = definition.category === "flooring"
      ? this.furniture.filter((item) => {
        const existingDefinition = getFurnitureDefinition(item.furnitureId);
        if (existingDefinition.category !== "flooring") {
          return true;
        }

        const existingCells = this.grid.getOccupiedCells(existingDefinition, item.position, item.rotation ?? 0);
        return !existingCells.some((cell) => requestedCells.some((requested) => requested.x === cell.x && requested.y === cell.y));
      })
      : this.isWallFinishFurniture(definition)
        ? this.furniture.filter((item) => {
          const existingDefinition = getFurnitureDefinition(item.furnitureId);
          if (!this.isWallFinishFurniture(existingDefinition)) {
            return true;
          }
          if (this.normalizeRotation(item.rotation ?? 0) !== this.normalizeRotation(this.selectedRotation)) {
            return true;
          }

          const existingCells = this.grid.getOccupiedCells(existingDefinition, item.position, item.rotation ?? 0);
          return !existingCells.some((cell) => requestedCells.some((requested) => requested.x === cell.x && requested.y === cell.y));
        })
        : this.furniture;

    this.furniture = [
      ...furniture,
      {
        uid: Phaser.Math.RND.uuid(),
        furnitureId: definition.id,
        position,
        rotation: this.selectedRotation,
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
    if (!this.grid.canPlace(definition, position, this.furniture, placed.uid, {
      ignoreFlooring: definition.category !== "flooring",
      rotation: this.selectedRotation,
    })) {
      return { ok: false, message: "Cannot move there" };
    }

    const requestedCells = this.grid.getOccupiedCells(definition, position, this.selectedRotation);
    const furniture = this.isWallFinishFurniture(definition)
      ? this.furniture.filter((item) => {
        if (item.uid === placed.uid) {
          return true;
        }

        const existingDefinition = getFurnitureDefinition(item.furnitureId);
        if (!this.isWallFinishFurniture(existingDefinition)) {
          return true;
        }
        if (this.normalizeRotation(item.rotation ?? 0) !== this.normalizeRotation(this.selectedRotation)) {
          return true;
        }

        const existingCells = this.grid.getOccupiedCells(existingDefinition, item.position, item.rotation ?? 0);
        return !existingCells.some((cell) => requestedCells.some((requested) => requested.x === cell.x && requested.y === cell.y));
      })
      : this.furniture;

    this.furniture = furniture.map((item) =>
      item.uid === placed.uid ? { ...item, position, rotation: this.selectedRotation } : item,
    );

    return { ok: true, message: `${definition.name} moved` };
  }

  removeAt(position: GridPosition): { ok: boolean; message: string } {
    const existing = this.getFurnitureAt(position, { includeFlooring: false });
    if (!existing) {
      return { ok: false, message: "Nothing to sell" };
    }

    const definition = getFurnitureDefinition(existing.furnitureId);
    this.furniture = this.furniture.filter((item) => item.uid !== existing.uid);
    const saleValue = Math.floor(this.costResolver(definition) * 0.5);
    this.economy.earn(saleValue);
    this.selectedPlacedUid = null;

    return { ok: true, message: `${definition.name} sold for $${saleValue}` };
  }

  getFurnitureAt(position: GridPosition, options: { includeFlooring?: boolean } = {}): PlacedFurniture | null {
    const includeFlooring = options.includeFlooring ?? true;
    return (
      [...this.furniture]
        .filter((item) => includeFlooring || getFurnitureDefinition(item.furnitureId).category !== "flooring")
        .sort((a, b) => {
          const categoryA = getFurnitureDefinition(a.furnitureId).category;
          const categoryB = getFurnitureDefinition(b.furnitureId).category;
          if (categoryA === "flooring" && categoryB !== "flooring") {
            return 1;
          }
          if (categoryA !== "flooring" && categoryB === "flooring") {
            return -1;
          }
          return 0;
        })
        .find((item) => {
          const definition = getFurnitureDefinition(item.furnitureId);
          return this.grid
            .getOccupiedCells(definition, item.position, item.rotation ?? 0)
            .some((cell) => cell.x === position.x && cell.y === position.y);
        }) ?? null
    );
  }

  isSelected(uid: string): boolean {
    return this.selectedPlacedUid === uid;
  }

  private isWallFinishFurniture(definition: FurnitureDefinition): boolean {
    return definition.category === "wallDecoration" && /paint|wallpaper/.test(definition.id);
  }

  private normalizeRotation(rotation: number): number {
    return ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  }
}
