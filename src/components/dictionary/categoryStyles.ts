import type {
  DictionaryCategory,
  DictionaryCategorySource,
} from "../../utils/dictionaryCategories";

// The categories' look and names, shared by the list's pill, the word panel,
// the chips and "Sort into categories". The colors are the mockup's: people
// fuchsia, work terms sky, everyday words slate, unsorted dashed.

export type CategoryKey = DictionaryCategory | "unsorted";

export const CATEGORY_NAME_KEYS: Record<CategoryKey, string> = {
  people: "dictionary.categories.names.people",
  work: "dictionary.categories.names.work",
  everyday: "dictionary.categories.names.everyday",
  unsorted: "dictionary.categories.names.unsorted",
};

/** "auto", "you", "model": who decided a word's category. */
export const CATEGORY_SOURCE_KEYS: Record<DictionaryCategorySource, string> = {
  auto: "dictionary.categories.source.auto",
  user: "dictionary.categories.source.user",
  model: "dictionary.categories.source.model",
};

export const CATEGORY_DOT_CLASS: Record<CategoryKey, string> = {
  people: "bg-fuchsia-500",
  work: "bg-sky-500",
  everyday: "bg-slate-400",
  unsorted: "border border-dashed border-muted-foreground/60",
};

export const CATEGORY_PILL_CLASS: Record<CategoryKey, string> = {
  people:
    "border-fuchsia-500/40 bg-fuchsia-500/8 text-fuchsia-700 dark:text-fuchsia-300 dark:bg-fuchsia-500/12",
  work: "border-sky-500/40 bg-sky-500/8 text-sky-700 dark:text-sky-300 dark:bg-sky-500/12",
  everyday: "border-border text-foreground/75",
  unsorted: "border-dashed border-border text-muted-foreground",
};

export function categoryKey(category: DictionaryCategory | null | undefined): CategoryKey {
  return category ?? "unsorted";
}
