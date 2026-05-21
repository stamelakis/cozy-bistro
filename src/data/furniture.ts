import type { FurnitureDefinition } from "../components/types";

export const furnitureCatalog: FurnitureDefinition[] = [
  {
    id: "round-table",
    name: "Round Table",
    cost: 45,
    size: { width: 2, height: 2 },
    comfort: 2,
    style: 1,
    category: "table",
    functionality: "serving",
    color: 0xb8774f,
  },
  {
    id: "cafe-chair",
    name: "Cafe Chair",
    cost: 20,
    size: { width: 1, height: 1 },
    comfort: 3,
    style: 1,
    category: "chair",
    functionality: "seating",
    color: 0xf2b36d,
  },
  {
    id: "tiny-stove",
    name: "Tiny Stove",
    cost: 95,
    size: { width: 2, height: 1 },
    comfort: 0,
    style: 1,
    category: "stove",
    functionality: "cooking",
    color: 0x6f7d8c,
  },
  {
    id: "service-counter",
    name: "Service Counter",
    cost: 70,
    size: { width: 2, height: 1 },
    comfort: 0,
    style: 2,
    category: "counter",
    functionality: "serving",
    color: 0xd99b72,
  },
  {
    id: "potted-herbs",
    name: "Potted Herbs",
    cost: 30,
    size: { width: 1, height: 1 },
    comfort: 1,
    style: 4,
    category: "plant",
    functionality: "decor",
    color: 0x65a875,
  },
  {
    id: "soft-rug",
    name: "Soft Rug",
    cost: 35,
    size: { width: 2, height: 1 },
    comfort: 2,
    style: 3,
    category: "decoration",
    functionality: "decor",
    color: 0xc97082,
  },
  {
    id: "menu-board",
    name: "Menu Board",
    cost: 40,
    size: { width: 2, height: 1 },
    comfort: 0,
    style: 4,
    category: "wallDecoration",
    functionality: "wall",
    color: 0x40545c,
  },
];

export function getFurnitureDefinition(id: string): FurnitureDefinition {
  const definition = furnitureCatalog.find((item) => item.id === id);
  if (!definition) {
    throw new Error(`Unknown furniture id: ${id}`);
  }

  return definition;
}
