import type { Metadata } from "next";
import { PartnershipPlaceholder } from "../partnership-placeholder.tsx";
import { SITE_BRAND } from "../site-config.ts";

export const metadata: Metadata = {
  title: `İçerik Üreticileri – ${SITE_BRAND}`,
  description: `${SITE_BRAND} içerik üreticisi iş ortaklığı sayfası hazırlanıyor.`,
  alternates: { canonical: "/icerik-ureticileri" },
};

export default function IcerikUreticileriPage() {
  return <PartnershipPlaceholder title="İçerik Üreticileri" />;
}
