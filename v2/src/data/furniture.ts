import type { FurnitureDefinition } from "./types";
import { furnitureCatalog } from "./furnitureCatalog";

/**
 * Adapter: ports the v2 furnitureCatalog (which is GLB-model-focused) into
 * the rich FurnitureDefinition shape the gameplay systems expect.
 *
 * The 2D version had hand-tuned numbers for comfort/style/ratingBonus per
 * piece. Here we apply sensible defaults derived from category + cost so
 * the systems get reasonable inputs. We'll fine-tune as the game balance
 * needs it.
 */

const CATEGORY_DEFAULTS: Record<string, Partial<FurnitureDefinition>> = {
  table:        { comfort: 0, style: 2, functionality: "serving", color: 0x8c6a4a, tableSeatCapacity: 4 },
  chair:        { comfort: 2, style: 1, functionality: "seating", color: 0xb38a5e, seatingCapacity: 1 },
  stove:        { comfort: 0, style: 1, functionality: "cooking", color: 0x556070, cookingSlots: 2 },
  counter:      { comfort: 0, style: 1, functionality: "serving", color: 0xa67c52, cookingSlots: 1 },
  decoration:   { comfort: 0, style: 3, functionality: "decor",   color: 0xcfa97c, attractionBonus: 1 },
  plant:        { comfort: 0, style: 2, functionality: "decor",   color: 0x5a7c4a, attractionBonus: 1 },
  lamp:         { comfort: 0, style: 2, functionality: "decor",   color: 0xd9b676, attractionBonus: 1 },
  door:         { comfort: 0, style: 1, functionality: "wall",    color: 0x6b4a32 },
};

// Build the catalog of FurnitureDefinitions lazily — adapter shape only.
const adaptedDefinitions = new Map<string, FurnitureDefinition>();

for (const def of furnitureCatalog) {
  const defaults = CATEGORY_DEFAULTS[def.category] ?? {};
  // Map newer categories to allowed legacy FurnitureCategory values
  // (the gameplay systems' type allows: table, chair, stove, counter,
  // decoration, plant, wallDecoration, lighting, flooring). The Phase-A
  // wash, Phase-D appliance, and Phase-D storage categories all read
  // as kitchen counters to the legacy rating systems; lamp -> lighting,
  // door -> wallDecoration.
  const remappedCategory =
    def.category === "lamp" ? "lighting" :
    def.category === "door" ? "wallDecoration" :
    def.category === "wash" ? "counter" :
    def.category === "appliance" ? "counter" :
    def.category === "storage" ? "counter" :
    def.category;
  adaptedDefinitions.set(def.id, {
    id: def.id,
    name: def.name,
    cost: def.cost,
    size: { width: def.size.width, height: def.size.depth },
    comfort: defaults.comfort ?? 0,
    style: defaults.style ?? 0,
    category: remappedCategory as FurnitureDefinition["category"],
    functionality: defaults.functionality ?? "decor",
    color: defaults.color ?? 0xcccccc,
    cookingSlots: defaults.cookingSlots,
    seatingCapacity: defaults.seatingCapacity,
    tableSeatCapacity: defaults.tableSeatCapacity,
    serviceSpeedBonus: defaults.serviceSpeedBonus,
    ratingBonus: defaults.ratingBonus,
    attractionBonus: defaults.attractionBonus,
  });
}

export function getFurnitureDefinition(id: string): FurnitureDefinition {
  const def = adaptedDefinitions.get(id);
  if (def) return def;
  // Fallback for unknown ids — keeps the gameplay systems from crashing
  // when they reference furniture we haven't catalogued yet.
  return {
    id,
    name: id,
    cost: 0,
    size: { width: 1, height: 1 },
    comfort: 0,
    style: 0,
    category: "decoration",
    functionality: "decor",
    color: 0xcccccc,
  };
}

export function getAllFurnitureDefinitions(): FurnitureDefinition[] {
  return Array.from(adaptedDefinitions.values());
}
