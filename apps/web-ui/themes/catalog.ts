import { validateThemeRecipe, type ThemeOption, type ThemeRecipe } from "./theme-definition";

export interface ThemeCatalog {
  readonly options: readonly ThemeOption[];
  find(id: string): ThemeRecipe | undefined;
  require(id: string): ThemeRecipe;
}

const recipeModules = import.meta.glob<unknown>("./recipes/*.json", {
  eager: true,
  import: "default",
});

export const themeCatalog = createThemeCatalog(Object.values(recipeModules));

function createThemeCatalog(input: readonly unknown[]): ThemeCatalog {
  const recipes = input.map(validateThemeRecipe).sort(compareRecipes);
  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  if (recipesById.size !== recipes.length) throw new Error("Theme recipe IDs must be unique");
  if (!recipesById.has("default")) throw new Error("Theme catalog requires the Default recipe");

  return {
    options: Object.freeze(recipes.map(({ id: value, name: label }) => ({ value, label }))),
    find: (id) => recipesById.get(id),
    require(id) {
      const recipe = recipesById.get(id);
      if (!recipe) throw new Error(`Unknown theme: ${id}`);
      return recipe;
    },
  };
}

function compareRecipes(left: ThemeRecipe, right: ThemeRecipe): number {
  if (left.id === "default") return -1;
  if (right.id === "default") return 1;
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
