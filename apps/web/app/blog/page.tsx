import type { Metadata } from "next";
import Link from "next/link";
import { SITE_BRAND } from "../site-config.ts";
import { getArticle } from "./articles/index.ts";
import { BLOG_AUTHOR, BLOG_HERO, BLOG_POSTS } from "./blog-posts.ts";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: `Blog – ${SITE_BRAND}`,
  description: `${SITE_BRAND} blog: benzer ürün rehberleri ve fiyat karşılaştırma yazıları.`,
  alternates: { canonical: "/blog" },
};

/**
 * Statik liste (CMS yok). Yazisi yazilmis kartlar /blog/[slug]'a linklenir (karar 0071), digerleri linksiz.
 * Ilk kart ozel (hero) karttir.
 */
export default function BlogPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{`${SITE_BRAND} Blog`}</h1>
      <div className={styles.feed}>
        <article className={styles.hero}>
          {/* biome-ignore lint/performance/noImgElement: R2 medya alan adindan gelen onceden optimize WebP; next/image gerekmez. */}
          <img src={BLOG_HERO.image} alt="" className={styles.heroImage} />
          <div className={styles.heroScrim} aria-hidden="true" />
          <div className={styles.heroBody}>
            <h2 className={styles.heroTitle}>
              {getArticle(BLOG_HERO.slug) ? (
                <Link href={`/blog/${BLOG_HERO.slug}`}>{BLOG_HERO.title}</Link>
              ) : (
                BLOG_HERO.title
              )}
            </h2>
            <p className={styles.heroExcerpt}>{BLOG_HERO.excerpt}</p>
            <p className={styles.heroDate}>{BLOG_HERO.publishedLabel}</p>
            <span className={styles.heroPill}>{BLOG_HERO.readMinutes} dakika okuma süresi</span>
          </div>
        </article>

        {BLOG_POSTS.map((post) => (
          <article key={post.slug} className={styles.card}>
            {/* biome-ignore lint/performance/noImgElement: R2 medya alan adindan gelen onceden optimize WebP; next/image gerekmez. */}
            <img src={post.image} alt="" className={styles.cardImage} width={600} height={338} />
            <div className={styles.cardBody}>
              <h2 className={styles.cardTitle}>
                {getArticle(post.slug) ? (
                  <Link href={`/blog/${post.slug}`}>{post.title}</Link>
                ) : (
                  post.title
                )}
              </h2>
              <p className={styles.cardExcerpt}>{post.excerpt}</p>
              <div className={styles.meta}>
                <span className={styles.avatar} aria-hidden="true">
                  {BLOG_AUTHOR.initial}
                </span>
                <p className={styles.author}>
                  <span className={styles.authorName}>{BLOG_AUTHOR.name}</span>
                  <span className={styles.authorRole}>{BLOG_AUTHOR.role}</span>
                </p>
                <span className={styles.readTime}>{post.readMinutes} dakikalık okuma süresi</span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
