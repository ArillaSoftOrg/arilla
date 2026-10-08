import { getPublicTrends } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { EmptyState, Section } from "@arilla/ui";
import { HomeSectionHeading } from "../home-section-heading.tsx";
import actions from "../public-actions.module.css";
import { TrendCardGrid } from "./trend-cards.tsx";
import { TREND_COPY } from "./trend-copy.ts";
import { buildTrendsPageModel } from "./trend-page-model.ts";
import styles from "./trendler.module.css";

/** `/trendler` govdesi: veriyi okur, kesitleri cizer. Sayfa bunu Suspense icinde sarar. */
export async function TrendlerContent() {
  const trends = await getPublicTrends(getDatabase());

  if (trends.length === 0) {
    return (
      <Section aria-labelledby="trendler-baslik">
        <HomeSectionHeading
          id="trendler-baslik"
          level={1}
          title={TREND_COPY.pageTitle}
          description={TREND_COPY.pageDescription}
        />
        <EmptyState
          title={TREND_COPY.emptyTitle}
          description={TREND_COPY.emptyDescription}
          action={
            <div className={actions.actions}>
              <a href="/" className={actions.primary}>
                {TREND_COPY.emptyAction}
              </a>
            </div>
          }
          className={styles.empty}
        />
      </Section>
    );
  }

  const model = buildTrendsPageModel(trends);
  const navKeys = [...model.sections.map((section) => section.key), "all" as const];

  return (
    <div className={styles.page}>
      <Section aria-labelledby="trendler-baslik">
        <HomeSectionHeading
          id="trendler-baslik"
          level={1}
          title={TREND_COPY.pageTitle}
          description={TREND_COPY.pageDescription}
        />
        <nav aria-label={TREND_COPY.navLabel}>
          {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
          <ul role="list" className={styles.sectionNav}>
            {navKeys.map((key) => (
              <li key={key}>
                <a href={`#trend-${key}`} className={styles.sectionNavLink}>
                  {TREND_COPY.sections[key]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </Section>

      {model.sections.map((section, index) => (
        <Section
          key={section.key}
          id={`trend-${section.key}`}
          aria-labelledby={`trend-${section.key}-baslik`}
          className={styles.anchored}
        >
          <HomeSectionHeading
            id={`trend-${section.key}-baslik`}
            title={TREND_COPY.sections[section.key]}
          />
          <TrendCardGrid
            trends={section.trends}
            eagerFirst={index === 0}
            labelledBy={`trend-${section.key}-baslik`}
          />
        </Section>
      ))}

      <Section id="trend-all" aria-labelledby="trend-all-baslik" className={styles.anchored}>
        <details className={styles.all}>
          <summary className={styles.allSummary} id="trend-all-baslik">
            {TREND_COPY.sections.all} ({model.all.length})
          </summary>
          <div className={styles.allBody}>
            <TrendCardGrid trends={model.all} labelledBy="trend-all-baslik" />
          </div>
        </details>
      </Section>
    </div>
  );
}
