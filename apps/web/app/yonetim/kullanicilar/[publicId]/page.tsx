import {
  type Capability,
  getUserActivity,
  getUserAffiliate,
  getUserAudit,
  getUserConsents,
  getUserProfile,
  getUserSearches,
  getUserSessions,
  hasCapability,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireCapability } from "../../../lib/dal.ts";
import styles from "../../admin.module.css";
import { PageHeader } from "../../admin-ui.tsx";
import { hrefWith, positiveInt, roleLabel } from "../../format.ts";
import { ActivityTab, AffiliateTab, SearchesTab, SessionsTab } from "./activity-tabs.tsx";
import { AuditTab } from "./audit-tab.tsx";
import { ConsentsTab } from "./consents-tab.tsx";
import { ProfileTab } from "./profile-tab.tsx";

const TABS = [
  { slug: "profil", label: "Profil", capability: "users.read" },
  { slug: "aktivite", label: "Aktivite", capability: "users.activity.read" },
  { slug: "izinler", label: "İzinler", capability: "users.read" },
  { slug: "oturumlar", label: "Oturumlar", capability: "users.activity.read" },
  { slug: "aramalar", label: "Aramalar", capability: "users.activity.read" },
  { slug: "affiliate", label: "Affiliate", capability: "users.activity.read" },
  { slug: "denetim", label: "Denetim", capability: "audit.read" },
] as const satisfies readonly { slug: string; label: string; capability: Capability }[];

type TabSlug = (typeof TABS)[number]["slug"];

interface DetailSearchParams {
  sekme?: string | string[];
  imlec?: string | string[];
  once?: string | string[];
}

const single = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

/**
 * Hesap ayrıntısı (karar 0049 §3), SALT OKUNUR. Sekmeler sunucuda `?sekme=`
 * ile seçilir; her görüntüleme tam olarak BİR core sekme fonksiyonu çağırır
 * ve `users.view` bir kez yazılır (hassas sekmede ek `users.view_tab`).
 * Yalnızca yetkisi olan sekmeler listelenir; doğrudan adresle açılan
 * yetkisiz sekme 404 olur.
 *
 * İletişim bilgisi maskelidir; tam değer ayrı yetenek ve taze girişle
 * (`RevealContactClient`). Oturum token'ı, sağlayıcı `subject`'i, IP ve
 * ham user agent hiçbir sekmede yok. Rol, hak, davet ve rıza burada
 * düzenlenmez.
 */
export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicId: string }>;
  searchParams?: Promise<DetailSearchParams>;
}) {
  const { actor } = await requireCapability("users.read");
  const { publicId } = await params;
  const query = (await searchParams) ?? {};
  const active = TABS.find((tab) => tab.slug === single(query.sekme)) ?? TABS[0];
  if (active.capability !== "users.read") await requireCapability(active.capability);

  const db = getDatabase();
  const base = `/yonetim/kullanicilar/${publicId}`;
  const tabHref = (slug: TabSlug) =>
    hrefWith(base, { sekme: slug === "profil" ? undefined : slug });
  const cursor = single(query.imlec);
  const paging = {
    first: cursor ? tabHref(active.slug) : null,
    next: (next: string | null) =>
      next ? hrefWith(base, { sekme: active.slug, imlec: next }) : null,
  };

  let header: { publicId: string; displayName: string | null; role: string };
  let body: ReactNode;
  switch (active.slug) {
    case "profil": {
      const view = await getUserProfile(db, actor, publicId);
      if (!view) notFound();
      header = view;
      body = (
        <ProfileTab user={view} canReveal={hasCapability(actor.role, "users.contact.reveal")} />
      );
      break;
    }
    case "izinler": {
      const view = await getUserConsents(db, actor, publicId, { cursor });
      if (!view) notFound();
      header = view.user;
      body = <ConsentsTab view={view} paging={paging} />;
      break;
    }
    case "aktivite": {
      const view = await getUserActivity(db, actor, publicId, { cursor });
      if (!view) notFound();
      header = view.user;
      body = <ActivityTab view={view} paging={paging} />;
      break;
    }
    case "oturumlar": {
      const view = await getUserSessions(db, actor, publicId, { cursor });
      if (!view) notFound();
      header = view.user;
      body = <SessionsTab view={view} paging={paging} />;
      break;
    }
    case "aramalar": {
      const view = await getUserSearches(db, actor, publicId, { cursor });
      if (!view) notFound();
      header = view.user;
      body = <SearchesTab view={view} paging={paging} />;
      break;
    }
    case "affiliate": {
      const view = await getUserAffiliate(db, actor, publicId, { cursor });
      if (!view) notFound();
      header = view.user;
      body = <AffiliateTab view={view} paging={paging} />;
      break;
    }
    case "denetim": {
      const beforeId = positiveInt(single(query.once));
      const view = await getUserAudit(db, actor, publicId, { beforeId });
      if (!view) notFound();
      header = view.user;
      body = (
        <AuditTab
          view={view}
          first={beforeId ? tabHref("denetim") : null}
          next={(id) => (id ? hrefWith(base, { sekme: "denetim", once: id }) : null)}
        />
      );
      break;
    }
  }

  const visibleTabs = TABS.filter((tab) => hasCapability(actor.role, tab.capability));

  return (
    <div className={styles.page}>
      <PageHeader title={header.displayName ?? "Hesap"}>
        <p className={styles.muted}>
          <Link href="/yonetim/kullanicilar">Kullanıcılar</Link>
          {" / "}
          <span className={styles.mono}>{header.publicId}</span>
          {" · "}
          {roleLabel(header.role)}
        </p>
      </PageHeader>

      <nav className={styles.tabs} aria-label="Hesap sekmeleri">
        {visibleTabs.map((tab) => (
          <Link
            key={tab.slug}
            href={tabHref(tab.slug)}
            className={tab.slug === active.slug ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            aria-current={tab.slug === active.slug ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {body}

      <p className={styles.muted}>
        Salt okunur ekran. Rol değişikliği yalnızca yerel betikle ya da onaylı SQL ile yapılır
        (docs/ops.md); hak, davet ve rıza burada düzenlenmez. Hesap silme kullanıcının kendi
        isteğiyle /hesap üzerinden yürür.
      </p>
    </div>
  );
}
