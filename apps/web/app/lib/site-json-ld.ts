/**
 * Karar 0219: site geneli Organization + WebSite JSON-LD. Saf fonksiyon.
 * Yalnızca gerçek veri: adres yoksa hiçbir şey üretilmez; SearchAction yalnızca
 * site içi arama (`/sohbet?q=`) herkese açıkken. Ürün (Product) verisi ürün sayfasındadır.
 */
export interface SiteJsonLdInput {
  siteUrl: string | undefined;
  brand: string;
  description: string;
  sameAs: readonly string[];
  searchOpen: boolean;
}

export function siteJsonLd(input: SiteJsonLdInput): Record<string, unknown> | null {
  if (!input.siteUrl) return null;
  const url = input.siteUrl.replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organization`,
        name: input.brand,
        url,
        logo: `${url}/brand/manicepte-logo.png`,
        ...(input.sameAs.length > 0 ? { sameAs: [...input.sameAs] } : {}),
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        url,
        name: input.brand,
        description: input.description,
        inLanguage: "tr-TR",
        publisher: { "@id": `${url}/#organization` },
        ...(input.searchOpen
          ? {
              potentialAction: {
                "@type": "SearchAction",
                target: {
                  "@type": "EntryPoint",
                  urlTemplate: `${url}/sohbet?q={search_term_string}`,
                },
                "query-input": "required name=search_term_string",
              },
            }
          : {}),
      },
    ],
  };
}
