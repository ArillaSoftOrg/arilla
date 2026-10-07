import { describe, expect, it } from "vitest";
import { BLOG_HERO, BLOG_POSTS } from "../blog-posts.ts";
import { articleSlugs, getArticle } from "./index.ts";

const FORBIDDEN = /satın al|dupe|ucuz|\bcoin\b|\bkredi\b|\bjeton\b/i;

function textOf(slug: string): string {
  const article = getArticle(slug);
  if (!article) return "";
  const parts = [article.lead];
  for (const block of article.blocks) {
    if (block.type === "ul") parts.push(...block.items);
    else if (block.type === "callout") parts.push(block.title, block.text);
    else parts.push(block.text);
  }
  return parts.join("\n");
}

describe("blog yazıları (karar 0071)", () => {
  it("her kart ve hero için yazı var", () => {
    expect(getArticle(BLOG_HERO.slug)).toBeDefined();
    for (const post of BLOG_POSTS) expect(getArticle(post.slug), post.slug).toBeDefined();
    expect(articleSlugs()).toHaveLength(BLOG_POSTS.length + 1);
  });

  it("yazı metinlerinde yasak kelime ve dış link yok", () => {
    for (const slug of articleSlugs()) {
      const text = textOf(slug);
      expect(text, slug).not.toMatch(FORBIDDEN);
      expect(text, slug).not.toMatch(/https?:\/\//);
    }
  });

  it("ikinci kez kullanılan blok anahtarı çakışmaz: her yazı en az bir paragraf içerir", () => {
    for (const slug of articleSlugs()) {
      expect(getArticle(slug)?.blocks.some((b) => b.type === "p" || b.type === "ul")).toBe(true);
    }
  });
});
