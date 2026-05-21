import Phaser from "phaser";
import type { FurnitureDefinition, GridPosition, PlacedFurniture } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";

export class RestaurantGridSystem {
  readonly columns: number;
  readonly rows: number;
  readonly tileSize: number;
  readonly origin: Phaser.Math.Vector2;

  constructor(columns = 14, rows = 9, tileSize = 48, origin = new Phaser.Math.Vector2(330, 150)) {
    this.columns = columns;
    this.rows = rows;
    this.tileSize = tileSize;
    this.origin = origin;
  }

  worldToGrid(worldX: number, worldY: number): GridPosition | null {
    const x = Math.floor((worldX - this.origin.x) / this.tileSize);
    const y = Math.floor((worldY - this.origin.y) / this.tileSize);

    if (!this.isInside({ x, y })) {
      return null;
    }

    return { x, y };
  }

  gridToWorld(position: GridPosition): Phaser.Math.Vector2 {
    return new Phaser.Math.Vector2(
      this.origin.x + position.x * this.tileSize,
      this.origin.y + position.y * this.tileSize,
    );
  }

  isInside(position: GridPosition): boolean {
    return position.x >= 0 && position.y >= 0 && position.x < this.columns && position.y < this.rows;
  }

  canPlace(
    furniture: FurnitureDefinition,
    position: GridPosition,
    placedFurniture: PlacedFurniture[],
    ignoreUid?: string,
  ): boolean {
    if (
      position.x < 0 ||
      position.y < 0 ||
      position.x + furniture.size.width > this.columns ||
      position.y + furniture.size.height > this.rows
    ) {
      return false;
    }

    const requestedCells = this.getOccupiedCells(furniture, position);
    const occupiedCells = placedFurniture
      .filter((item) => item.uid !== ignoreUid)
      .flatMap((item) => this.getOccupiedCells(getFurnitureDefinition(item.furnitureId), item.position));

    return requestedCells.every(
      (cell) => !occupiedCells.some((occupied) => occupied.x === cell.x && occupied.y === cell.y),
    );
  }

  getOccupiedCells(furniture: FurnitureDefinition, position: GridPosition): GridPosition[] {
    const cells: GridPosition[] = [];

    for (let y = 0; y < furniture.size.height; y += 1) {
      for (let x = 0; x < furniture.size.width; x += 1) {
        cells.push({ x: position.x + x, y: position.y + y });
      }
    }

    return cells;
  }

  draw(scene: Phaser.Scene): Phaser.GameObjects.Graphics {
    const graphics = scene.add.graphics();
    graphics.fillStyle(0xfff4dc, 1);
    graphics.fillRoundedRect(
      this.origin.x - 12,
      this.origin.y - 12,
      this.columns * this.tileSize + 24,
      this.rows * this.tileSize + 24,
      8,
    );
    graphics.lineStyle(1, 0xd8b98f, 0.9);

    for (let x = 0; x <= this.columns; x += 1) {
      const worldX = this.origin.x + x * this.tileSize;
      graphics.lineBetween(worldX, this.origin.y, worldX, this.origin.y + this.rows * this.tileSize);
    }

    for (let y = 0; y <= this.rows; y += 1) {
      const worldY = this.origin.y + y * this.tileSize;
      graphics.lineBetween(this.origin.x, worldY, this.origin.x + this.columns * this.tileSize, worldY);
    }

    return graphics;
  }
}
