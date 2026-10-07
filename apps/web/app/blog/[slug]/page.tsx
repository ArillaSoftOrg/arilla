import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SITE_BRAND } from "../../site-config.ts";
import { articleSlugs, getArticle, HERO_SLUG } from "../articles/index.ts";
import type { ArticleBlock } from "../articles/types.ts";
import { BLOG_AUTHOR, BLOG_HERO, BLOG_POSTS } from "../blog-posts.ts";
import styles from "./article.module.css";

type Params = { slug: string };

interface Header {
  title: string;
  image: string;
  readMinutes: number;
}

function headerOf(slug: string): Header | undefined {
  if (slug === HERO_SLUG) return BLOG_HERO;
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function generateStaticParams(): Params[] {
  return articleSlugs().map((slug) => ({ slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const header = headerOf(slug);
  const article = getArticle(slug);
  if (!header || !article) return {};
  return {
    title: `${header.title} – ${SITE_BRAND}`,
    description: article.lead,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: { title: header.title, description: article.lead, type: "article" },
  };
}

function renderBlock(block: ArticleBlock, key: string): ReactNode {
  switch (block.type) {
    case "h2":
      return (
        <h2 key={key} className={styles.h2}>
          {block.text}
        </h2>
      );
    case "p":
      return (
        <p key={key} className={styles.p}>
          {block.text}
        </p>
      );
    case "ul":
      return (
        <ul key={key} className={styles.ul}>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "callout":
      return (
        <aside key={key} className={styles.callout}>
          <strong>{block.title}</strong>
          <p>{block.text}</p>
        </aside>
      );
  }
}

export default async function ArticlePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const header = headerOf(slug);
  const article = getArticle(slug);
  if (!header || !article) notFound();

  return (
    <article className={styles.page}>
      <div className={styles.column}>
        <a href="/blog" className={styles.back}>
          Blog
        </a>
        <h1 className={styles.title}>{header.title}</h1>
        <p className={styles.meta}>
          {BLOG_AUTHOR.name} · {header.readMinutes} dakikalık okuma süresi
        </p>
        {/* biome-ignore lint/performance/noImgElement: R2 medya alan adindan onceden optimize WebP; next/image gerekmez. */}
        <img src={header.image} alt="" className={styles.cover} />
        <p className={styles.lead}>{article.lead}</p>
        {article.blocks.map((block, index) => renderBlock(block, `${block.type}-${index}`))}
      </div>
    </article>
  );
}
