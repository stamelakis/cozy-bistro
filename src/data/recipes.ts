import type { RecipeDefinition } from "../components/types";

export const recipes: RecipeDefinition[] = [
  {
    id: "toast",
    name: "Toast",
    ingredients: ["bread", "butter"],
    preparationTimeSeconds: 4,
    stationNeeded: "counter",
    sellPrice: 8,
    satisfactionEffect: 4,
    unlockedByDefault: true,
  },
  {
    id: "soup",
    name: "Soup",
    ingredients: ["stock", "vegetables", "herbs"],
    preparationTimeSeconds: 8,
    stationNeeded: "stove",
    sellPrice: 14,
    satisfactionEffect: 7,
    unlockedByDefault: true,
  },
  {
    id: "pasta",
    name: "Pasta",
    ingredients: ["pasta", "tomato", "cheese"],
    preparationTimeSeconds: 12,
    stationNeeded: "stove",
    sellPrice: 20,
    satisfactionEffect: 10,
    unlockedByDefault: false,
  },
];
