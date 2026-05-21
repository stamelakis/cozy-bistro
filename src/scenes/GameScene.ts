import Phaser from "phaser";
import type { FurnitureDefinition, GridPosition, PlacedFurniture, SaveGameState } from "../components/types";
import { furnitureCatalog, getFurnitureDefinition } from "../data/furniture";
import { recipes } from "../data/recipes";
import { CookingSystem } from "../systems/CookingSystem";
import { CustomerSystem } from "../systems/CustomerSystem";
import { DayCycleSystem } from "../systems/DayCycleSystem";
import { EconomySystem } from "../systems/EconomySystem";
import { FurniturePlacementSystem } from "../systems/FurniturePlacementSystem";
import { ReputationSystem } from "../systems/ReputationSystem";
import { RestaurantGridSystem } from "../systems/RestaurantGridSystem";
import { SaveSystem } from "../systems/SaveSystem";

type InteractionMode = "build" | "move" | "remove" | "cook";

export class GameScene extends Phaser.Scene {
  private grid!: RestaurantGridSystem;
  private economy!: EconomySystem;
  private reputation!: ReputationSystem;
  private placement!: FurniturePlacementSystem;
  private cooking!: CookingSystem;
  private customers!: CustomerSystem;
  private dayCycle!: DayCycleSystem;
  private saveSystem!: SaveSystem;
  private mode: InteractionMode = "build";
  private furnitureLayer!: Phaser.GameObjects.Container;
  private preview!: Phaser.GameObjects.Graphics;
  private messageText!: Phaser.GameObjects.Text;
  private statsText!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;
  private selectedText!: Phaser.GameObjects.Text;
  private cookText!: Phaser.GameObjects.Text;
  private unlockedRecipeIds: string[] = recipes.filter((recipe) => recipe.unlockedByDefault).map((recipe) => recipe.id);

  constructor() {
    super("GameScene");
  }

  create(): void {
    this.saveSystem = new SaveSystem();
    const save = this.saveSystem.load();

    this.grid = new RestaurantGridSystem();
    this.economy = new EconomySystem(save?.money ?? 280);
    this.reputation = new ReputationSystem(save?.reputation ?? 1);
    this.placement = new FurniturePlacementSystem(this.grid, this.economy, save?.furniture ?? this.getStarterFurniture());
    this.cooking = new CookingSystem();
    this.customers = new CustomerSystem();
    this.dayCycle = new DayCycleSystem(save?.dayNumber ?? 1);
    this.unlockedRecipeIds = save?.unlockedRecipeIds ?? this.unlockedRecipeIds;

    this.drawBackground();
    this.grid.draw(this);
    this.furnitureLayer = this.add.container(0, 0);
    this.preview = this.add.graphics();
    this.createUi();
    this.renderFurniture();
    this.updateStats();

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => this.updatePreview(pointer));
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.handlePointerDown(pointer));
    this.input.keyboard?.on("keydown-ESC", () => {
      this.placement.clearSelection();
      this.updateStats("Selection cleared");
    });
    this.input.keyboard?.on("keydown-S", () => this.saveGame());
  }

  update(_time: number, delta: number): void {
    this.dayCycle.update(delta / 1000);
    this.updateStats();
  }

  private drawBackground(): void {
    this.add.rectangle(640, 360, 1280, 720, 0xf5dcae);
    this.add.rectangle(640, 96, 1280, 120, 0xf0bd91);
    this.add.rectangle(640, 688, 1280, 64, 0xc58b67);
    this.add.text(34, 28, "Cozy Bistro", {
      color: "#3b2a21",
      fontFamily: "Georgia, serif",
      fontSize: "34px",
      fontStyle: "bold",
    });
    this.add.text(36, 70, "Stage 1 prototype: build, move, remove, and watch attractiveness change.", {
      color: "#5e473a",
      fontSize: "15px",
    });
  }

  private createUi(): void {
    this.statsText = this.add.text(36, 128, "", this.panelTextStyle(18)).setLineSpacing(8);
    this.modeText = this.add.text(36, 284, "", this.panelTextStyle(18));
    this.selectedText = this.add.text(36, 328, "", this.panelTextStyle(16)).setWordWrapWidth(235);
    this.messageText = this.add.text(36, 642, "Pick an item, then click the room grid.", this.panelTextStyle(16));

    this.add.text(36, 386, "Build Menu", this.headingStyle());
    furnitureCatalog.forEach((furniture, index) => this.createFurnitureButton(furniture, 36, 426 + index * 32));

    this.add.text(1038, 128, "Cooking Menu", this.headingStyle());
    this.cookText = this.add.text(1038, 170, "", this.panelTextStyle(16)).setWordWrapWidth(190);

    this.createModeButton("Build", 1038, 322, "build");
    this.createModeButton("Move", 1118, 322, "move");
    this.createModeButton("Remove", 1038, 362, "remove");
    this.createModeButton("Cook", 1138, 362, "cook");
    this.createModeButton("Save", 1038, 402, "build", () => this.saveGame());

    this.add.text(1038, 462, "Co-op Roles", this.headingStyle());
    this.add.text(
      1038,
      504,
      "Player 1: decor and budget\nPlayer 2: cooking and service\n\nNetworking is intentionally left out of this MVP.",
      this.panelTextStyle(15),
    ).setWordWrapWidth(210).setLineSpacing(7);
  }

  private createFurnitureButton(furniture: FurnitureDefinition, x: number, y: number): void {
    const label = `${furniture.name}  $${furniture.cost}`;
    const button = this.add.text(x, y, label, {
      color: "#38251d",
      backgroundColor: "#fff8e8",
      fixedWidth: 235,
      fixedHeight: 25,
      padding: { x: 8, y: 4 },
      fontSize: "14px",
    });

    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", () => {
      this.mode = "build";
      this.placement.selectCatalogItem(furniture.id);
      this.updateStats(`${furniture.name} selected`);
    });
  }

  private createModeButton(
    label: string,
    x: number,
    y: number,
    mode: InteractionMode,
    onClick?: () => void,
  ): void {
    const button = this.add.text(x, y, label, {
      color: "#fffaf0",
      backgroundColor: "#7e6a54",
      fixedWidth: 70,
      fixedHeight: 28,
      align: "center",
      padding: { x: 8, y: 5 },
      fontSize: "14px",
    });

    button.setInteractive({ useHandCursor: true });
    button.on("pointerdown", () => {
      this.mode = mode;
      if (mode !== "build") {
        this.placement.clearSelection();
      }
      onClick?.();
      this.updateStats(`${label} mode`);
    });
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    const gridPosition = this.grid.worldToGrid(pointer.worldX, pointer.worldY);
    if (!gridPosition) {
      return;
    }

    const result = this.applyGridAction(gridPosition);
    if (result.ok) {
      this.renderFurniture();
      this.persistQuietly();
    }

    this.updateStats(result.message);
  }

  private applyGridAction(position: GridPosition): { ok: boolean; message: string } {
    if (this.mode === "remove") {
      return this.placement.removeAt(position);
    }

    if (this.mode === "move") {
      const moveResult = this.placement.tryMoveSelected(position);
      if (moveResult.ok) {
        return moveResult;
      }

      return this.placement.tryPlaceSelected(position);
    }

    if (this.mode === "cook") {
      return { ok: false, message: "Cooking interactions arrive in Stage 3" };
    }

    return this.placement.tryPlaceSelected(position);
  }

  private renderFurniture(): void {
    this.furnitureLayer.removeAll(true);

    this.placement.getFurniture().forEach((item) => {
      const definition = getFurnitureDefinition(item.furnitureId);
      const world = this.grid.gridToWorld(item.position);
      const width = definition.size.width * this.grid.tileSize;
      const height = definition.size.height * this.grid.tileSize;

      const graphics = this.add.graphics();
      graphics.fillStyle(definition.color, 1);
      graphics.fillRoundedRect(world.x + 4, world.y + 4, width - 8, height - 8, 7);
      graphics.lineStyle(2, this.placement.isSelected(item.uid) ? 0xfff5a8 : 0x6b4d3a, 1);
      graphics.strokeRoundedRect(world.x + 4, world.y + 4, width - 8, height - 8, 7);

      const icon = this.iconFor(definition);
      const label = this.add
        .text(world.x + width / 2, world.y + height / 2, icon, {
          color: "#fffaf0",
          fontSize: definition.size.width > 1 ? "22px" : "18px",
          fontStyle: "bold",
        })
        .setOrigin(0.5);

      this.furnitureLayer.add([graphics, label]);
    });
  }

  private updatePreview(pointer: Phaser.Input.Pointer): void {
    this.preview.clear();
    const gridPosition = this.grid.worldToGrid(pointer.worldX, pointer.worldY);
    const selectedId = this.placement.getSelectedFurnitureId();
    if (!gridPosition || !selectedId || this.mode !== "build") {
      return;
    }

    const definition = getFurnitureDefinition(selectedId);
    const canPlace = this.grid.canPlace(definition, gridPosition, this.placement.getFurniture());
    const world = this.grid.gridToWorld(gridPosition);
    this.preview.fillStyle(canPlace ? 0x8fcf9b : 0xd66b6b, 0.35);
    this.preview.fillRect(
      world.x,
      world.y,
      definition.size.width * this.grid.tileSize,
      definition.size.height * this.grid.tileSize,
    );
  }

  private updateStats(message?: string): void {
    const furniture = this.placement.getFurniture();
    const decorationScore = this.reputation.getDecorationScore(furniture);
    const attractiveness = this.reputation.getAttractiveness(furniture);
    const seats = this.customers.getAvailableSeatCount(furniture);
    const spawnRate = this.customers.estimateSpawnRate(attractiveness, seats, this.unlockedRecipeIds.length);
    const selectedId = this.placement.getSelectedFurnitureId();
    const selected = selectedId ? getFurnitureDefinition(selectedId) : null;

    this.statsText.setText(
      [
        `Money: $${this.economy.getMoney()}`,
        `Reputation: ${this.reputation.getReputation().toFixed(1)}`,
        `Day: ${this.dayCycle.getDayNumber()}  Time: ${Math.ceil(this.dayCycle.getTimeRemainingSeconds())}s`,
        `Satisfaction: ${this.reputation.getSatisfactionPercent()}%`,
        `Decor Score: ${decorationScore}`,
        `Attractiveness: ${attractiveness}`,
        `Seats: ${seats}  Customer Flow: ${spawnRate}`,
      ].join("\n"),
    );
    this.modeText.setText(`Mode: ${this.mode.toUpperCase()}`);
    this.selectedText.setText(
      selected
        ? `Selected: ${selected.name}\nSize ${selected.size.width}x${selected.size.height}, comfort ${selected.comfort}, style ${selected.style}`
        : "Selected: none",
    );
    this.cookText.setText(
      this.cooking
        .getAvailableRecipes(this.unlockedRecipeIds)
        .map((recipe) => `${recipe.name}: ${recipe.preparationTimeSeconds}s, $${recipe.sellPrice}`)
        .join("\n"),
    );

    if (message) {
      this.messageText.setText(message);
    }
  }

  private saveGame(): void {
    this.persistQuietly();
    this.updateStats("Game saved locally");
  }

  private persistQuietly(): void {
    const state: SaveGameState = {
      money: this.economy.getMoney(),
      reputation: this.reputation.getReputation(),
      dayNumber: this.dayCycle.getDayNumber(),
      unlockedRecipeIds: this.unlockedRecipeIds,
      furniture: this.placement.getFurniture(),
    };

    this.saveSystem.save(state);
  }

  private getStarterFurniture(): PlacedFurniture[] {
    return [
      { uid: "starter-counter", furnitureId: "service-counter", position: { x: 1, y: 1 } },
      { uid: "starter-stove", furnitureId: "tiny-stove", position: { x: 4, y: 1 } },
    ];
  }

  private panelTextStyle(fontSize: number): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: "#3b2a21",
      fontSize: `${fontSize}px`,
      fontFamily: "Inter, Arial, sans-serif",
    };
  }

  private headingStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      color: "#3b2a21",
      fontSize: "20px",
      fontStyle: "bold",
      fontFamily: "Inter, Arial, sans-serif",
    };
  }

  private iconFor(definition: FurnitureDefinition): string {
    const icons: Record<FurnitureDefinition["category"], string> = {
      table: "T",
      chair: "C",
      stove: "S",
      counter: "B",
      decoration: "R",
      plant: "P",
      wallDecoration: "M",
    };

    return icons[definition.category];
  }
}
