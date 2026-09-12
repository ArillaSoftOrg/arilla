/**
 * docs/sitemap.md: sadece `loc` ve `lastmod` üretilir - Google `priority`/
 * `changefreq`'i uzun süredir dikkate almadığını belirtti, biz de yazmıyoruz.
 */

export interface SitemapUrlEntry {
  loc: string;
  lastModified?: Date;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildUrlSetXml(entries: readonly SitemapUrlEntry[]): string {
  const items = entries
    .map((entry) => {
      const lastmod = entry.lastModified
        ? `<lastmod>${entry.lastModified.toISOString()}</lastmod>`
        : "";
      return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;
}

export function buildSitemapIndexXml(locs: readonly string[]): string {
  const items = locs.map((loc) => `<sitemap><loc>${escapeXml(loc)}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}
