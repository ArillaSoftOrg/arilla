/**
 * İşletim durumunu ortak bulgu diline çevirir (karar 0052 önem modeli,
 * karar 0055). Saf fonksiyonlar: veriyi `operations.ts`,
 * `pipeline-evidence.ts`, `merchant-attention.ts` ve `job-runs.ts` okur; burası
 * yalnızca önem, anlam, olası neden, ne yapmalı ve teşhis bağlantısını kurar.
 *
 * - Denetim çalışmadıysa `unknown`; sessizce sağlıklı sayılmaz.
 * - Kesin olmayan sinyal (geride olabilir, fiyatlanmamış çağrı) `info`.
 * - `critical` yalnızca veri kaybı/uyumluluk riski (partition dışı satır,
 *   saklanmaması gereken ham görsel).
 * - Bağlantının yanındaki `capability` yalnızca gösterim koşuludur; hedef
 *   sayfa yetkiyi ayrıca ister.
 *
 * Kalıcı alarm durumu, bildirim ya da genel log YOK: liste her bakışta mevcut
 * durumdan yeniden türetilir.
 */
import { MATCH_QUEUE_ALERT_THRESHOLD } from "./dashboard.ts";
import { type JobRunSummary, jobLabel, KNOWN_JOBS } from "./job-runs.ts";
import type { AttentionState, MerchantAttentionItem } from "./merchant-attention.ts";
import type {
  Check,
  ComplianceHealth,
  CostWindow,
  JobEvidence,
  OperationsOverview,
  PartitionHealth,
} from "./operations.ts";
import { PARTITION_MONTHS_AHEAD } from "./operations.ts";
import {
  evaluatePipeline,
  type PipelineStage,
  type PipelineStageView,
  STAGE_JOBS,
} from "./pipeline-evidence.ts";
import { type AdminFinding, type Severity, sortFindings } from "./severity.ts";

/** Son 24 saat, önceki 7 günün günlük ortalamasının bu katını aşarsa sapma. */
export const COST_SPIKE_FACTOR = 3;
/** Bu kadar çağrının altında sapma aranmaz (küçük sayılarda gürültü). */
export const COST_SPIKE_MIN_CALLS = 50;
/** Link çözümleme kuyruğu (Redis) bu uzunluğu aşarsa işçi yetişmiyor. */
export const LINK_QUEUE_WARN_DEPTH = 100;

const OPS = "operations.read" as const;

function finding(
  partial: Omit<AdminFinding, "href" | "capability" | "evidence" | "evidenceAt"> &
    Partial<Pick<AdminFinding, "href" | "capability" | "evidence" | "evidenceAt">>,
): AdminFinding {
  return { href: null, capability: null, evidence: null, evidenceAt: null, ...partial };
}

function unknown(key: string, title: string, error: string, href: string, at: Date): AdminFinding {
  return finding({
    key,
    severity: "unknown",
    title,
    meaning: "Denetim çalıştırılamadı; durum bilinmiyor, sağlıklı sayılmaz.",
    evidence: error,
    action:
      "Sayfayı yenileyin; sürerse veritabanı/Redis bağlantısını ve yavaş sorguları inceleyin.",
    href,
    capability: OPS,
    evidenceAt: at,
  });
}

function count(n: number): string {
  return n.toLocaleString("tr-TR");
}

function examples(names: string[]): string {
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${head} ve ${count(names.length - 3)} mağaza daha` : head;
}

// --- partition ---------------------------------------------------------------

export function partitionFindings(check: Check<PartitionHealth>, now: Date): AdminFinding[] {
  const href = "/yonetim/islemler#partition";
  if (!check.ok)
    return [unknown("ops.partitions", "Fiyat geçmişi partition'ları", check.error, href, now)];
  const p = check.value;
  const out: AdminFinding[] = [];
  if (p.uncoveredRows > 0) {
    out.push(
      finding({
        key: "ops.partitions.default",
        severity: "critical",
        title: `${count(p.uncoveredRows)} fiyat noktası hiçbir aylık partition'a girmiyor`,
        meaning:
          "Satırlar price_point_default'a düşüyor; sonradan o aya partition eklemek bu satırlar yüzünden başarısız olur.",
        evidence: `Aylık aralık sayısı ${count(p.ranges.length)}, boşluk ${count(p.gaps.length)}.`,
        action: "docs/ops.md 'price_point_default doldu' runbook'unu uygulayın.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (p.monthsAhead < PARTITION_MONTHS_AHEAD) {
    const ahead = Math.max(0, p.monthsAhead);
    out.push(
      finding({
        key: "ops.partitions.ahead",
        severity: p.monthsAhead < 0 ? "critical" : "warning",
        title:
          p.monthsAhead < 0
            ? "Bu ay için fiyat partition'ı yok"
            : `Yalnızca ${ahead} ay ileri partition hazır`,
        meaning: `En az ${PARTITION_MONTHS_AHEAD} ay ileri partition hazır olmalı; yoksa yeni fiyat noktaları default partition'a düşer.`,
        evidence: null,
        action: "Çalıştırın: pnpm db:partitions",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (p.gaps.length > 0) {
    out.push(
      finding({
        key: "ops.partitions.gaps",
        severity: "warning",
        title: `Aylık partition aralığında ${count(p.gaps.length)} boşluk var`,
        meaning: "Boşluğa düşen tarihli fiyat noktaları default partition'a yazılır.",
        action: "Eksik ayları pnpm db:partitions ile oluşturun.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      finding({
        key: "ops.partitions",
        severity: "healthy",
        title: `Fiyat partition'ları hazır (${Math.max(0, p.monthsAhead)} ay ileri)`,
        meaning: "Default partition boş, aralıkta boşluk yok.",
        action: "Bir şey gerekmiyor.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  return out;
}

// --- boru hattı ----------------------------------------------------------------

const STAGE_LABELS: Record<PipelineStage, { label: string; command: string | null }> = {
  collect: { label: "Veri toplama", command: "python -m collect.bootstrap" },
  resolve: { label: "Eşleştirme", command: "python -m resolve" },
  prices: { label: "Fiyat özeti", command: "python -m similarity --prices" },
  enrich: { label: "Zenginleştirme (vektör)", command: "python -m enrich" },
  edges: { label: "Benzerlik kenarları", command: "python -m similarity --edges" },
  link: { label: "Link çözümleme", command: null },
};

const REASON_TEXT: Record<string, { cause: string; action: string }> = {
  stuck_runs: {
    cause: '2 saattir "sürüyor" kalan toplama koşusu var; süreç büyük olasılıkla çöktü.',
    action:
      "Veri toplama sayfasında takılı koşuyu bulun, süreç günlüğüne bakın ve toplamayı yeniden çalıştırın.",
  },
  stale_feed: {
    cause: "Son başarılı toplama 24 saatten eski.",
    action: "Toplama işinin zamanlayıcısını/komutunu kontrol edin.",
  },
  link_stuck: {
    cause: "10 dakikadır işlenen link isteği var; link işçisi takılmış olabilir.",
    action: "Link işçisinin (python -m collect.link --worker) çalıştığını doğrulayın.",
  },
  link_queue_old: {
    cause: "10 dakikadan uzun bekleyen link isteği var; işçi çalışmıyor olabilir.",
    action: "Link işçisinin (python -m collect.link --worker) çalıştığını doğrulayın.",
  },
  job_failed: {
    cause: "Aşamanın son iş koşusu başarısız bitti.",
    action: "İş koşuları listesinde hata özetine bakın, nedeni giderip işi yeniden çalıştırın.",
  },
  job_stuck: {
    cause: 'Aşamanın son iş koşusu 2 saattir "sürüyor"; süreç ölmüş olabilir.',
    action: "Süreci kontrol edin; ölmüşse işi yeniden çalıştırın (koşu kaydı kapanmamış kalır).",
  },
};

export function pipelineFindings(views: readonly PipelineStageView[], now: Date): AdminFinding[] {
  return views.map((view) => {
    const info = STAGE_LABELS[view.stage];
    const base = {
      key: `pipeline.${view.stage}`,
      href: "/yonetim/islemler#boru-hatti",
      capability: OPS,
      evidenceAt: view.lastAt ?? now,
    };
    const when = view.source === "job_run" ? "son çalıştı" : "son kanıt";
    const run = info.command ? `Çalıştırın: ${info.command}` : "İşçinin çalıştığını doğrulayın.";
    switch (view.state) {
      case "unknown":
        return finding({
          ...base,
          severity: "unknown",
          title: `${info.label}: kanıt okunamadı`,
          meaning: "Aşamanın kanıt sorgusu zaman aşımına uğradı ya da hata verdi.",
          action: "Sayfayı yenileyin; sürerse ilgili tabloyu ve sorgu süresini inceleyin.",
          evidenceAt: now,
        });
      case "warning": {
        const reasons = view.reasons.map((r) => REASON_TEXT[r]).filter(Boolean);
        return finding({
          ...base,
          severity: "warning",
          title: `${info.label}: müdahale gerekli`,
          meaning: reasons.map((r) => r?.cause).join(" "),
          evidence: view.lastAt ? null : `Henüz ${when} yok.`,
          action: reasons[0]?.action ?? run,
        });
      }
      case "behind":
        return finding({
          ...base,
          severity: "info",
          title: `${info.label}: geride olabilir`,
          meaning:
            "Beslendiği aşama bundan daha yeni çalıştı. Yeni veri yoksa aşama iz bırakmadığı için kesin değildir.",
          action: run,
        });
      case "none":
        return finding({
          ...base,
          severity: view.stage === "link" ? "healthy" : "info",
          title:
            view.stage === "link"
              ? `${info.label}: henüz istek yok`
              : `${info.label}: hiç kanıt yok`,
          meaning:
            view.stage === "link"
              ? "Link aramasına hiç istek gelmemiş; sorun değildir."
              : "Aşama hiç çalışmamış ya da hiç veri üretmemiş.",
          action: view.stage === "link" ? "Bir şey gerekmiyor." : run,
          evidenceAt: now,
        });
      default:
        return finding({
          ...base,
          severity: "healthy",
          title: `${info.label}: güncel`,
          meaning: `Aşamanın ${when} beslendiği aşamadan eski değil.`,
          action: "Bir şey gerekmiyor.",
        });
    }
  });
}

// --- mağazalar ---------------------------------------------------------------

export function merchantFindings(
  items: readonly MerchantAttentionItem[],
  now: Date,
): AdminFinding[] {
  const by = (state: AttentionState) => items.filter((item) => item.states.includes(state));
  const link = (list: MerchantAttentionItem[], fallback: string) =>
    list.length === 1 && list[0] ? `/yonetim/magazalar/${list[0].merchantSlug}` : fallback;
  const names = (list: MerchantAttentionItem[]) => examples(list.map((i) => i.merchantName));
  const latest = (list: MerchantAttentionItem[]) =>
    list.reduce<Date | null>(
      (at, i) => (i.lastRun && (!at || i.lastRun.startedAt > at) ? i.lastRun.startedAt : at),
      null,
    ) ?? now;
  const out: AdminFinding[] = [];

  const stuck = by("stuck");
  if (stuck.length > 0) {
    out.push(
      finding({
        key: "merchants.stuck",
        severity: "warning",
        title: `${count(stuck.length)} mağazanın toplama koşusu 2 saattir sürüyor`,
        meaning: "Koşu kapanmamış; toplayıcı süreci büyük olasılıkla çöktü.",
        evidence: names(stuck),
        action: "Süreç günlüğüne bakın ve toplamayı yeniden çalıştırın.",
        href: "/yonetim/ingest?durum=running",
        capability: "ingest.read",
        evidenceAt: latest(stuck),
      }),
    );
  }

  const failed = by("failed");
  const repeated = failed.filter((i) => i.failuresSinceSuccess >= 2);
  const once = failed.filter((i) => i.failuresSinceSuccess < 2);
  if (repeated.length > 0) {
    out.push(
      finding({
        key: "merchants.failed_repeatedly",
        severity: "warning",
        title: `${count(repeated.length)} mağaza üst üste başarısız`,
        meaning:
          "Aynı mağazanın toplaması art arda başarısız (ops.md eşiği: 2). Fiyatlar eskiyor; başarısız koşunun yazımları geri alınır.",
        evidence: names(repeated),
        action:
          "Koşunun hata metnine bakın (feed adresi, kapı reddi, para birimi) ve nedeni giderin.",
        href: "/yonetim/ingest?durum=failed",
        capability: "ingest.read",
        evidenceAt: latest(repeated),
      }),
    );
  }
  if (once.length > 0) {
    out.push(
      finding({
        key: "merchants.failed_once",
        severity: "info",
        title: `${count(once.length)} mağazanın son toplama koşusu başarısız`,
        meaning: "Tek başarısızlık geçici olabilir; bir sonraki koşu da başarısızsa uyarıya döner.",
        evidence: names(once),
        action: "Hata metnine göz atın; tekrarlarsa nedeni giderin.",
        href: "/yonetim/ingest?durum=failed",
        capability: "ingest.read",
        evidenceAt: latest(once),
      }),
    );
  }

  const currency = by("currency_unverified");
  if (currency.length > 0) {
    out.push(
      finding({
        key: "merchants.currency_unverified",
        severity: "warning",
        title: `${count(currency.length)} aktif mağazanın para birimi doğrulanmadı`,
        meaning: "Toplama kapısı bu mağazaların koşusunu reddeder; teklifleri yenilenmez.",
        evidence: names(currency),
        action:
          "Para birimini doğrulayın (python -m collect.verify_currency) ya da mağazayı kapatın.",
        href: link(currency, "/yonetim/magazalar?durum=aktif"),
        capability: "merchant.read",
        evidenceAt: now,
      }),
    );
  }

  const never = by("never_ran");
  if (never.length > 0) {
    out.push(
      finding({
        key: "merchants.never_ran",
        severity: "warning",
        title: `${count(never.length)} aktif mağaza hiç toplanmadı`,
        meaning: "Mağaza açık ama hiç toplama koşusu yok; teklifi yok.",
        evidence: names(never),
        action:
          "Toplamayı çalıştırın (python -m collect --merchant <slug>) ya da mağazayı kapatın.",
        href: link(never, "/yonetim/magazalar?durum=aktif"),
        capability: "merchant.read",
        evidenceAt: now,
      }),
    );
  }

  const stale = by("stale");
  if (stale.length > 0) {
    out.push(
      finding({
        key: "merchants.stale",
        severity: "warning",
        title: `${count(stale.length)} aktif mağazanın verisi 24 saatten eski`,
        meaning: "Fiyat ve stok bilgisi yenilenmiyor; kullanıcı eski fiyat görebilir.",
        evidence: names(stale),
        action: "Toplama zamanlayıcısını ve mağazanın son koşularını kontrol edin.",
        href: link(stale, "/yonetim/ingest"),
        capability: stale.length === 1 ? "merchant.read" : "ingest.read",
        evidenceAt: now,
      }),
    );
  }

  if (out.length === 0) {
    out.push(
      finding({
        key: "merchants",
        severity: "healthy",
        title: "Aktif mağazaların toplaması yolunda",
        meaning: "Takılı, başarısız, doğrulanmamış ya da bayat aktif mağaza yok.",
        action: "Bir şey gerekmiyor.",
        href: "/yonetim/magazalar?durum=aktif",
        capability: "merchant.read",
        evidenceAt: now,
      }),
    );
  }
  return out;
}

// --- iş koşuları -------------------------------------------------------------

const STAGE_JOB_NAMES = new Set(Object.values(STAGE_JOBS).flat());

/**
 * `job_run` bulguları. Boru hattı aşamasına bağlı işlerin başarısızlığı
 * aşama bulgusunda görünür; burada tekrar edilmez.
 */
export function jobRunFindings(check: Check<JobRunSummary>, now: Date): AdminFinding[] {
  const href = "/yonetim/islemler/isler";
  if (!check.ok) return [unknown("jobs", "İş koşuları", check.error, href, now)];
  const out: AdminFinding[] = [];
  const latestIds = new Set(
    check.value.jobs.map((j) => j.lastRun?.id).filter((id): id is number => id !== undefined),
  );

  const stuckLatest = check.value.stuck.filter((s) => latestIds.has(s.id));
  const stuckOld = check.value.stuck.filter((s) => !latestIds.has(s.id));
  if (stuckLatest.length > 0) {
    out.push(
      finding({
        key: "jobs.stuck",
        severity: "warning",
        title: `${count(stuckLatest.length)} iş 2 saattir "sürüyor" görünüyor`,
        meaning: "Koşu kapanmamış: süreç öldü ya da zaman aşımına uğradı.",
        evidence: stuckLatest.map((s) => jobLabel(s.job)).join(", "),
        action:
          "Sürecin/zamanlayıcının günlüğüne bakın; iş bir sonraki çalıştırmada yeni koşu açar.",
        href: `${href}?durum=running`,
        capability: OPS,
        evidenceAt: stuckLatest[0]?.startedAt ?? now,
      }),
    );
  }
  if (stuckOld.length > 0) {
    out.push(
      finding({
        key: "jobs.stuck_old",
        severity: "info",
        title: `${count(stuckOld.length)} eski koşu kapanmamış`,
        meaning:
          "İş sonradan yeniden çalıştı; bu koşular süreç öldüğü için açık kaldı (ör. sunucusuz zaman aşımı).",
        evidence: stuckOld.map((s) => jobLabel(s.job)).join(", "),
        action: "Sık tekrarlıyorsa işin süre sınırını inceleyin.",
        href: `${href}?durum=running`,
        capability: OPS,
        evidenceAt: stuckOld[0]?.startedAt ?? now,
      }),
    );
  }

  const quiet: string[] = [];
  for (const job of check.value.jobs) {
    const meta = KNOWN_JOBS[job.job];
    const run = job.lastRun;
    const jobHref = `${href}?is=${job.job}`;
    if (!run) {
      if (meta?.kind === "cron") quiet.push(meta.label);
      continue;
    }
    if (run.status === "failed" && !STAGE_JOB_NAMES.has(job.job)) {
      out.push(
        finding({
          key: `jobs.${job.job}.failed`,
          severity: "warning",
          title: `${jobLabel(job.job)}: son koşu başarısız`,
          meaning:
            job.failuresSinceGood >= 2
              ? `Son başarılı koşudan beri ${count(job.failuresSinceGood)} başarısız koşu.`
              : "İşin son koşusu hata ile bitti.",
          evidence: run.errorSummary,
          action: "Hata özetine göre nedeni giderin; iş bir sonraki tetikte yeniden çalışır.",
          href: jobHref,
          capability: OPS,
          evidenceAt: run.startedAt,
        }),
      );
    }
    if (
      meta?.overdueAfterMs &&
      run.status !== "running" &&
      now.getTime() - run.startedAt.getTime() > meta.overdueAfterMs
    ) {
      out.push(
        finding({
          key: `jobs.${job.job}.overdue`,
          severity: "warning",
          title: `${meta.label}: zamanında çalışmadı`,
          meaning: `Zamanlanmış iş (${meta.how}) beklenen aralıkta koşu bırakmadı.`,
          evidence: null,
          action: "Zamanlayıcıyı (Vercel cron / GitHub Actions) ve CRON_SECRET'ı kontrol edin.",
          href: jobHref,
          capability: OPS,
          evidenceAt: run.startedAt,
        }),
      );
    }
  }
  if (quiet.length > 0) {
    out.push(
      finding({
        key: "jobs.no_record",
        severity: "info",
        title: `${count(quiet.length)} zamanlanmış işin koşu kaydı yok`,
        meaning:
          "İş henüz kayıt tutan sürümle hiç çalışmadı ya da zamanlayıcısı kurulu değil. Durumu verinin tazeliğinden okunur.",
        evidence: quiet.join(", "),
        action:
          "Dağıtımdan sonra ilk tetikte kayıt oluşmalı; oluşmuyorsa zamanlayıcıyı kontrol edin.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      finding({
        key: "jobs",
        severity: "healthy",
        title: "İşler zamanında ve hatasız",
        meaning: "Takılı, başarısız ya da gecikmiş iş koşusu yok.",
        action: "Bir şey gerekmiyor.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  return out;
}

// --- tekil denetimler ----------------------------------------------------------

export function complianceFindings(check: Check<ComplianceHealth>, now: Date): AdminFinding[] {
  const href = "/yonetim/islemler#kvkk";
  if (!check.ok)
    return [unknown("ops.compliance", "Saklama ve temizlik (KVKK)", check.error, href, now)];
  const c = check.value;
  const out: AdminFinding[] = [];
  if (c.imagePurgeOverdue > 0) {
    out.push(
      finding({
        key: "ops.compliance.raw_images",
        severity: "critical",
        title: `${count(c.imagePurgeOverdue)} yüklenen görselin ham dosyası depoda`,
        meaning:
          "Ham görsel saklanmamalı (CLAUDE.md kural 10); saklama süresi de geçmiş. Aydınlatma metnine aykırı.",
        action: "Kodu ve obje deposunu inceleyin, dosyaları silin; docs/kvkk.md.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  const backlog = c.expiredLoginTokens + c.expiredPhoneCodes;
  if (backlog > 0) {
    out.push(
      finding({
        key: "ops.compliance.cleanup_backlog",
        severity: "warning",
        title: `${count(backlog)} süresi geçmiş giriş kaydı temizlenmemiş`,
        meaning:
          "Günlük temizlik işi 1 günden eski bağlantı/kodları silmeliydi; iş çalışmıyor ya da yarım kalıyor.",
        evidence: `Giriş bağlantısı ${count(c.expiredLoginTokens)}, telefon kodu ${count(c.expiredPhoneCodes)}.`,
        action: "cleanup-auth cron'unun son koşusuna bakın (İş koşuları).",
        href: "/yonetim/islemler/isler?is=cleanup_auth",
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      finding({
        key: "ops.compliance",
        severity: "healthy",
        title: "Saklama ve temizlik yolunda",
        meaning: "Ham görsel yok, süresi geçmiş giriş kaydı birikmemiş.",
        action: "Bir şey gerekmiyor.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  return out;
}

export function costFindings(check: Check<CostWindow>, now: Date): AdminFinding[] {
  const href = "/yonetim/islemler#maliyet";
  if (!check.ok) return [unknown("ops.cost", "Model maliyeti", check.error, href, now)];
  const { last24h, previous7d } = check.value;
  const out: AdminFinding[] = [];
  const avgCalls = previous7d.calls / 7;
  const avgCost = previous7d.costMicros / 7;
  const callSpike =
    last24h.calls >= COST_SPIKE_MIN_CALLS &&
    last24h.calls > COST_SPIKE_FACTOR * Math.max(avgCalls, 1);
  const costSpike = last24h.costMicros > 0 && last24h.costMicros > COST_SPIKE_FACTOR * avgCost;
  if (callSpike || (costSpike && last24h.calls >= COST_SPIKE_MIN_CALLS)) {
    out.push(
      finding({
        key: "ops.cost.spike",
        severity: "warning",
        title: "Model kullanımı olağandışı arttı",
        meaning: `Son 24 saat, önceki 7 günün günlük ortalamasının ${COST_SPIKE_FACTOR} katını aşıyor. Kötüye kullanım, önbellek hatası ya da toplu iş olabilir.`,
        evidence: `24 saat: ${count(last24h.calls)} çağrı · önceki 7 gün ortalaması: ${count(Math.round(avgCalls))} çağrı/gün.`,
        action: "İşleme göre dağılıma bakın; beklenmeyen artışta kaynağı (arama, toplu iş) bulun.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (last24h.unpricedCalls > 0) {
    out.push(
      finding({
        key: "ops.cost.unpriced",
        severity: "info",
        title: `${count(last24h.unpricedCalls)} model çağrısı fiyatlanmadı (24 saat)`,
        meaning:
          "Maliyet oranı tanımsız olduğu için çağrılar 0 maliyetle yazıldı; gerçek tutar bilinmiyor.",
        action: "EMBEDDING_COST_MICROS_PER_1K_TOKENS'ı Vercel'de ve Python işlerinde tanımlayın.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  if (out.length === 0) {
    out.push(
      finding({
        key: "ops.cost",
        severity: "healthy",
        title: "Model maliyeti olağan seyrinde",
        meaning: "Son 24 saat önceki haftanın ortalamasından sapmıyor; tüm çağrılar fiyatlandı.",
        action: "Bir şey gerekmiyor.",
        href,
        capability: OPS,
        evidenceAt: now,
      }),
    );
  }
  return out;
}

export function matchingBacklogFinding(pending: number, now: Date): AdminFinding {
  const over = pending > MATCH_QUEUE_ALERT_THRESHOLD;
  return finding({
    key: "matching.backlog",
    severity: over ? "warning" : "healthy",
    title: over
      ? `Eşleştirme kuyruğunda ${count(pending)} bekleyen aday`
      : `Eşleştirme kuyruğu eşiğin altında (${count(pending)})`,
    meaning: over
      ? `Eşik ${MATCH_QUEUE_ALERT_THRESHOLD}; incelenmeyen adaylar ürün karşılaştırmasını eksik bırakır.`
      : `Eşik ${MATCH_QUEUE_ALERT_THRESHOLD}.`,
    action: over
      ? "Kuyruğu inceleyin; tekrarlayan bir hata varsa eşleştirme eşiğini gözden geçirin."
      : "Bir şey gerekmiyor.",
    href: "/yonetim/eslestirme",
    capability: "matching.review",
    evidenceAt: now,
  });
}

export function linkQueueFinding(check: Check<number>, now: Date): AdminFinding {
  const href = "/yonetim/arama/link";
  if (!check.ok) {
    return finding({
      key: "ops.link_queue",
      severity: "unknown",
      title: "Link çözümleme kuyruğu okunamadı",
      meaning: "Redis'e ulaşılamadı; link araması da büyük olasılıkla çalışmıyor.",
      evidence: check.error,
      action: "REDIS_URL'i ve Redis sağlayıcısının durumunu kontrol edin.",
      href,
      capability: "diagnostics.read",
      evidenceAt: now,
    });
  }
  const depth = check.value;
  const over = depth > LINK_QUEUE_WARN_DEPTH;
  return finding({
    key: "ops.link_queue",
    severity: over ? "warning" : "healthy",
    title: over
      ? `Link çözümleme kuyruğunda ${count(depth)} istek bekliyor`
      : `Link çözümleme kuyruğu ${count(depth)}`,
    meaning: over
      ? "İşçi yetişmiyor ya da çalışmıyor; kullanıcılar link aramasında bekliyor."
      : "Kuyruk normal.",
    action: over
      ? "Link işçisinin (python -m collect.link --worker) çalıştığını doğrulayın."
      : "Bir şey gerekmiyor.",
    href,
    capability: "diagnostics.read",
    evidenceAt: now,
  });
}

export function discoveryFinding(check: Check<JobEvidence>, now: Date): AdminFinding | null {
  if (!check.ok)
    return unknown("ops.jobs", "İş kanıtları", check.error, "/yonetim/islemler#isler", now);
  const today = now.toISOString().slice(0, 10);
  const latest = check.value.latestDiscoverySlot;
  if (latest && latest >= today) return null;
  return finding({
    key: "ops.discovery",
    severity: latest ? "warning" : "info",
    title: latest ? "Keşfet bugün için üretilmedi" : "Keşfet slotu hiç üretilmedi",
    meaning: latest
      ? "Gece cron'u bugünün slotlarını yazmadı; /kesfet dünkü içeriği gösteriyor."
      : "discovery_slot boş; cron hiç çalışmamış olabilir.",
    evidence: latest ? `En ileri slot: ${latest}` : null,
    action: "generate-discovery-slots cron'unun son koşusuna bakın.",
    href: "/yonetim/islemler/isler?is=discovery_slots",
    capability: OPS,
    evidenceAt: now,
  });
}

// --- toplu -------------------------------------------------------------------

/** `/yonetim/islemler` için tüm bulgular (sağlıklılar dahil), önem sırasıyla. */
export function operationsFindings(ops: OperationsOverview): AdminFinding[] {
  const now = ops.generatedAt;
  const merchants: AdminFinding[] = ops.merchants.ok
    ? merchantFindings(ops.merchants.value, now)
    : [
        unknown(
          "merchants",
          "Mağaza toplama durumu",
          ops.merchants.error,
          "/yonetim/magazalar",
          now,
        ),
      ];
  const discovery = discoveryFinding(ops.jobs, now);
  return sortFindings([
    ...partitionFindings(ops.partitions, now),
    ...jobRunFindings(ops.jobRuns, now),
    ...pipelineFindings(evaluatePipeline(ops.pipeline, now), now),
    ...merchants,
    ...(ops.jobs.ok ? [matchingBacklogFinding(ops.jobs.value.pendingMatches, now)] : []),
    ...(discovery ? [discovery] : []),
    linkQueueFinding(ops.linkQueue, now),
    ...complianceFindings(ops.compliance, now),
    ...costFindings(ops.costWindow, now),
  ]);
}

/** "Şimdi dikkat isteyenler": yalnızca eylem/inceleme isteyenler. */
const ATTENTION: ReadonlySet<Severity> = new Set(["critical", "warning", "unknown"]);

export function needsAttention(findings: readonly AdminFinding[]): AdminFinding[] {
  return sortFindings(findings.filter((f) => ATTENTION.has(f.severity)));
}

/**
 * Genel bakışın dikkat listesi. `ops` yalnızca `operations.read` sahibi için
 * okunur (yönetici); moderatör bugün gördüğü sinyallerden türetilen listeyi
 * görür: mağazalar, boru hattı, eşleştirme kuyruğu.
 */
export function dashboardAttention(input: {
  now: Date;
  merchants: readonly MerchantAttentionItem[];
  pipeline: readonly PipelineStageView[];
  pendingMatches: number;
  ops?: OperationsOverview | null;
}): AdminFinding[] {
  if (input.ops) return needsAttention(operationsFindings(input.ops));
  return needsAttention([
    ...merchantFindings(input.merchants, input.now),
    ...pipelineFindings(input.pipeline, input.now),
    matchingBacklogFinding(input.pendingMatches, input.now),
  ]);
}
