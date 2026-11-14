import type { Metadata } from "next";
import { PartnershipPlaceholder } from "../partnership-placeholder.tsx";
import { SITE_BRAND } from "../site-config.ts";

export const metadata: Metadata = {
  title: `Mağazalar İçin – ${SITE_BRAND}`,
  description: `${SITE_BRAND} mağaza iş ortaklığı sayfası hazırlanıyor.`,
  alternates: { canonical: "/ortakliklar" },
};

export default function OrtakliklarPage() {
  return <PartnershipPlaceholder title="Mağazalar İçin" />;
}
