import { recipes } from "../data/recipes";

export class CookingSystem {
  getAvailableRecipes(unlockedRecipeIds: string[]): typeof recipes {
    return recipes.filter((recipe) => unlockedRecipeIds.includes(recipe.id));
  }
}
