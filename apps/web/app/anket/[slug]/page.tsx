import { getFormForViewer, getFormMeta, needsOnboarding } from "@arilla/core";
import { loginPathWithNext } from "@arilla/core/auth-redirect";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { verifySession } from "../../lib/dal.ts";
import { SubpageShell } from "../../public-site-shell.tsx";
import styles from "../page.module.css";
import { SURVEY_COPY as COPY } from "../survey-copy.ts";
import { skipSurveyAction } from "./actions.ts";
import { SurveyFormClient } from "./survey-form-client.tsx";

type Params = { slug: string };

/**
 * Sosyal medyada paylaşılabilsin diye başlık/açıklama (Open Graph) yayındaki
 * formdan gelir. Arama motoruna girmez (`noindex`) ve robots.txt'te
 * engellenmez: önizleme botlarının sayfayı okuyabilmesi gerekir.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = await getFormMeta(getDatabase(), slug);
  const title = meta?.title ?? COPY.metaFallbackTitle;
  return {
    title,
    ...(meta?.description ? { description: meta.description } : {}),
    alternates: { canonical: `/anket/${slug}` },
    robots: { index: false, follow: false },
    openGraph: {
      title,
      type: "website",
      ...(meta?.description ? { description: meta.description } : {}),
    },
  };
}

function StateCard({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className={styles.stateCard} role="status">
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{body}</p>
      {action ? (
        <a className={styles.primaryAction} href={action.href}>
          {action.label}
        </a>
      ) : null}
    </div>
  );
}

function Shell({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <SubpageShell currentPath={`/anket/${slug}`}>
      <div className={styles.page}>
        <section className={styles.panel}>{children}</section>
      </div>
    </SubpageShell>
  );
}

/**
 * `/anket/<slug>` (docs/decisions/0058). Ürün kapısının dışında; paylaşılan
 * bağlantı lansman öncesi de açılır. Taslak ziyaretçiye hiç görünmez (404).
 * Oturum yalnızca arayüzü belirler; kimlik server action'da yeniden okunur.
 */
export default async function SurveyPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ kaynak?: string }>;
}) {
  const { slug } = await params;
  const hint = (await searchParams).kaynak === "hesap" ? "account" : "link";
  const user = await verifySession();
  const view = await getFormForViewer(getDatabase(), slug, user ? { id: user.id } : null);

  switch (view.status) {
    case "not_found":
      return notFound();
    case "closed":
      return (
        <Shell slug={slug}>
          <StateCard title={COPY.closedTitle} body={COPY.closedBody} />
        </Shell>
      );
    case "not_started":
      return (
        <Shell slug={slug}>
          <StateCard title={COPY.notStartedTitle} body={COPY.notStartedBody} />
        </Shell>
      );
    case "login_required":
      return (
        <Shell slug={slug}>
          <StateCard
            title={COPY.loginTitle}
            body={COPY.loginBody}
            action={{ href: loginPathWithNext(`/anket/${slug}`), label: COPY.loginCta }}
          />
        </Shell>
      );
    case "early_access_required":
      return (
        <Shell slug={slug}>
          <StateCard
            title={COPY.earlyAccessTitle}
            body={COPY.earlyAccessBody}
            action={{ href: "/erken-erisim", label: COPY.earlyAccessCta }}
          />
        </Shell>
      );
    case "already_responded":
      return (
        <Shell slug={slug}>
          <StateCard
            title={COPY.respondedTitle}
            body={COPY.respondedBody}
            action={{ href: "/", label: COPY.backHome }}
          />
        </Shell>
      );
    case "open": {
      const { form } = view;
      const canSkip = form.allowSkip && user !== null;
      // Onboarding'in son adımı: yalnızca ilk karar henüz yoksa (karar 0060).
      const askNewsletter =
        form.kind === "onboarding" &&
        user !== null &&
        (await needsOnboarding(getDatabase(), user.id));
      const backToEarlyAccess = form.kind === "onboarding" && hint !== "account";
      return (
        <Shell slug={slug}>
          <header className={styles.intro}>
            <h1 className={styles.title}>{form.title}</h1>
            {form.description ? <p className={styles.description}>{form.description}</p> : null}
          </header>
          <SurveyFormClient
            slug={slug}
            signedIn={user !== null}
            hint={hint}
            questions={form.questions}
            newsletter={askNewsletter && user ? { email: user.email } : null}
            successHref={hint === "account" ? "/hesap" : backToEarlyAccess ? "/erken-erisim" : "/"}
            successLabel={
              hint === "account"
                ? "Hesabıma dön"
                : backToEarlyAccess
                  ? COPY.backEarlyAccess
                  : COPY.backHome
            }
            skipAction={
              canSkip ? (
                <form action={skipSurveyAction.bind(null, slug, hint)} className={styles.skipForm}>
                  <button type="submit" className={styles.skipButton}>
                    {COPY.skip}
                  </button>
                </form>
              ) : null
            }
          />
        </Shell>
      );
    }
  }
}
