import Phaser from "phaser";
import type { FurnitureDefinition, GridPosition, PlacedFurniture, Size } from "../components/types";
import { getFurnitureDefinition } from "../data/furniture";

export class RestaurantGridSystem {
  readonly columns: number;
  readonly rows: number;
  readonly tileSize: number;
  readonly tileHeight: number;
  readonly origin: Phaser.Math.Vector2;
  readonly minX: number;
  readonly minY: number;
  private viewRotationStep = 0;

  constructor(
    columns = 14,
    rows = 9,
    tileSize = 48,
    origin = new Phaser.Math.Vector2(330, 150),
    minX = 0,
    minY = 0,
  ) {
    this.columns = columns;
    this.rows = rows;
    this.tileSize = tileSize;
    this.tileHeight = Math.round(tileSize * 0.52);
    this.origin = origin;
    this.minX = minX;
    this.minY = minY;
  }

  setViewRotationStep(step: number): void {
    this.viewRotationStep = ((Math.round(step) % 4) + 4) % 4;
  }

  getViewRotationStep(): number {
    return this.viewRotationStep;
  }

  get maxX(): number {
    return this.minX + this.columns - 1;
  }

  get maxY(): number {
    return this.minY + this.rows - 1;
  }

  worldToGrid(worldX: number, worldY: number): GridPosition | null {
    const localX = (worldX - this.origin.x) / (this.tileSize / 2);
    const localY = (worldY - this.origin.y) / (this.tileHeight / 2);
    const viewX = (localY + localX) / 2;
    const viewY = (localY - localX) / 2;
    const logical = this.viewToLogical({ x: viewX, y: viewY });
    const x = Math.floor(logical.x);
    const y = Math.floor(logical.y);

    if (!this.isInside({ x, y })) {
      return null;
    }

    return { x, y };
  }

  gridToWorld(position: GridPosition): Phaser.Math.Vector2 {
    const viewPosition = this.logicalToView(position);
    return new Phaser.Math.Vector2(
      this.origin.x + (viewPosition.x - viewPosition.y) * (this.tileSize / 2),
      this.origin.y + (viewPosition.x + viewPosition.y) * (this.tileHeight / 2),
    );
  }

  getCellCenter(position: GridPosition): Phaser.Math.Vector2 {
    const points = this.getCellDiamond(position);
    return new Phaser.Math.Vector2(
      points.reduce((sum, point) => sum + point.x, 0) / points.length,
      points.reduce((sum, point) => sum + point.y, 0) / points.length,
    );
  }

  getCellDiamond(position: GridPosition): Phaser.Math.Vector2[] {
    return [
      this.gridToWorld(position),
      this.gridToWorld({ x: position.x + 1, y: position.y }),
      this.gridToWorld({ x: position.x + 1, y: position.y + 1 }),
      this.gridToWorld({ x: position.x, y: position.y + 1 }),
    ];
  }

  getAreaDiamond(position: GridPosition, size: Size): Phaser.Math.Vector2[] {
    return [
      this.gridToWorld(position),
      this.gridToWorld({ x: position.x + size.width, y: position.y }),
      this.gridToWorld({ x: position.x + size.width, y: position.y + size.height }),
      this.gridToWorld({ x: position.x, y: position.y + size.height }),
    ];
  }

  isInside(position: GridPosition): boolean {
    return position.x >= this.minX && position.y >= this.minY && position.x <= this.maxX && position.y <= this.maxY;
  }

  canPlace(
    furniture: FurnitureDefinition,
    position: GridPosition,
    placedFurniture: PlacedFurniture[],
    ignoreUid?: string,
    options: { ignoreFlooring?: boolean; rotation?: number } = {},
  ): boolean {
    const size = this.getRotatedSize(furniture, options.rotation ?? 0);
    if (
      position.y < this.minY ||
      position.x < this.minX ||
      position.x + size.width - 1 > this.maxX ||
      position.y + size.height - 1 > this.maxY
    ) {
      return false;
    }

    if (furniture.category === "flooring") {
      return true;
    }

    const requestedCells = this.getOccupiedCells(furniture, position, options.rotation ?? 0);
    const occupiedCells = placedFurniture
      .filter((item) => item.uid !== ignoreUid)
      .filter((item) => {
        const definition = getFurnitureDefinition(item.furnitureId);
        if (options.ignoreFlooring && definition.category === "flooring") {
          return false;
        }

        if (furniture.category === "wallDecoration") {
          if (this.isWallFinishFurniture(furniture)) {
            return false;
          }

          return definition.category === "wallDecoration" && !this.isWallFinishFurniture(definition);
        }

        return definition.category !== "wallDecoration";
      })
      .flatMap((item) => this.getOccupiedCells(getFurnitureDefinition(item.furnitureId), item.position, item.rotation ?? 0));

    return requestedCells.every(
      (cell) => !occupiedCells.some((occupied) => occupied.x === cell.x && occupied.y === cell.y),
    );
  }

  private isWallFinishFurniture(furniture: FurnitureDefinition): boolean {
    return furniture.category === "wallDecoration" && /paint|wallpaper/.test(furniture.id);
  }

  getOccupiedCells(furniture: FurnitureDefinition, position: GridPosition, rotation = 0): GridPosition[] {
    const cells: GridPosition[] = [];
    const size = this.getRotatedSize(furniture, rotation);

    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        cells.push({ x: position.x + x, y: position.y + y });
      }
    }

    return cells;
  }

  getRotatedSize(furniture: FurnitureDefinition, rotation = 0): { width: number; height: number } {
    const normalizedRotation = ((rotation % 360) + 360) % 360;
    if (normalizedRotation === 90 || normalizedRotation === 270) {
      return { width: furniture.size.height, height: furniture.size.width };
    }

    return furniture.size;
  }

  private logicalToView(position: { x: number; y: number }): { x: number; y: number } {
    const centerX = this.minX + this.columns / 2;
    const centerY = this.minY + this.rows / 2;
    const dx = position.x - centerX;
    const dy = position.y - centerY;

    if (this.viewRotationStep === 1) {
      return { x: centerX - dy, y: centerY + dx };
    }
    if (this.viewRotationStep === 2) {
      return { x: centerX - dx, y: centerY - dy };
    }
    if (this.viewRotationStep === 3) {
      return { x: centerX + dy, y: centerY - dx };
    }

    return { x: position.x, y: position.y };
  }

  private viewToLogical(position: { x: number; y: number }): { x: number; y: number } {
    const centerX = this.minX + this.columns / 2;
    const centerY = this.minY + this.rows / 2;
    const dx = position.x - centerX;
    const dy = position.y - centerY;

    if (this.viewRotationStep === 1) {
      return { x: centerX + dy, y: centerY - dx };
    }
    if (this.viewRotationStep === 2) {
      return { x: centerX - dx, y: centerY - dy };
    }
    if (this.viewRotationStep === 3) {
      return { x: centerX - dy, y: centerY + dx };
    }

    return { x: position.x, y: position.y };
  }

  draw(
    scene: Phaser.Scene,
    isVisibleCell?: (position: GridPosition) => boolean,
    getCellFill?: (position: GridPosition) => number,
  ): Phaser.GameObjects.Graphics {
    const graphics = scene.add.graphics();
    graphics.fillStyle(0xfff4dc, 1);
    for (let y = this.minY; y <= this.maxY; y += 1) {
      for (let x = this.minX; x <= this.maxX; x += 1) {
        if (isVisibleCell && !isVisibleCell({ x, y })) {
          continue;
        }

        const points = this.getCellDiamond({ x, y });
        graphics.fillStyle(getCellFill?.({ x, y }) ?? 0xfff4dc, 1);
        graphics.fillPoints(points, true);
        graphics.fillStyle(0xffffff, 0.08);
        graphics.lineStyle(1, 0xffffff, 0.1);
        graphics.lineBetween(points[3].x + 4, points[3].y, points[0].x, points[0].y + 3);
        graphics.fillStyle(0x6f4d3d, 0.06);
        graphics.lineStyle(1, 0x6f4d3d, 0.06);
        graphics.lineBetween(points[2].x - 4, points[2].y - 2, points[1].x - 2, points[1].y);
        graphics.lineStyle(1, 0xd8b98f, 0.28);
        graphics.strokePoints(points, true);
      }
    }

    return graphics;
  }
}
