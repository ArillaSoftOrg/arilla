/** Yazi govdesi bloklari (docs/decisions/0071). Ham HTML ve dis link yok. */
export type ArticleBlock =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: readonly string[] }
  | { type: "callout"; title: string; text: string };

export interface Article {
  /** Meta aciklama ve sayfa girisi. */
  lead: string;
  blocks: readonly ArticleBlock[];
}
