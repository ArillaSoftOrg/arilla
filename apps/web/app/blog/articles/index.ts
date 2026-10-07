import { EV_1 } from "./ev-1.ts";
import { EV_2 } from "./ev-2.ts";
import { EV_3 } from "./ev-3.ts";
import { EV_4 } from "./ev-4.ts";
import { HERO_ARTICLE } from "./hero.ts";
import type { Article } from "./types.ts";

export const HERO_SLUG = "rh-cloud-kanepe-muadilleri";

/** Yazisi yazilmis icerikler (docs/decisions/0071). Anahtar: URL slug'i. */
const ARTICLES: Readonly<Record<string, Article>> = {
  [HERO_SLUG]: HERO_ARTICLE,
  ...EV_1,
  ...EV_2,
  ...EV_3,
  ...EV_4,
};

export function getArticle(slug: string): Article | undefined {
  return Object.hasOwn(ARTICLES, slug) ? ARTICLES[slug] : undefined;
}

export function articleSlugs(): string[] {
  return Object.keys(ARTICLES);
}
