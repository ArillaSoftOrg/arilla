"use client";

import {
  availableRanges,
  buildHistoryView,
  dayNumber,
  defaultRange,
  formatHistoryDate,
  type HistoryObservation,
  type HistoryRangeKey,
  yDomain,
} from "@arilla/core/price-history-view";
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./price-history.module.css";
import {
  DIRECTION_GLYPH,
  DIRECTION_WORD,
  formatChangeAmount,
  formatMoney,
  shortDate,
} from "./price-history-format.ts";

export interface PriceHistoryClientProps {
  points: readonly HistoryObservation[];
  currency: string;
  /** Sunucu "bugün"ü (Europe/Istanbul): SSR ve hidrasyon aynı pencereyi görür. */
  today: string;
  /** Sorgulanan en uzun dönem (gün); daha uzun dönem düğmesi gösterilmez. */
  horizonDays: number;
  /** Teklif güncel doğrulanamıyorsa: son fiyat güncelmiş gibi sunulmaz. */
  unverified?: boolean;
  /** Varyant bazlı seri: kapsam notu. */
  coverageNote?: string | null;
}

const MARGIN = { top: 16, right: 14, bottom: 28, left: 84 };
/** Nokta işaretleri bu sayıdan sonra yalnızca uç değerlerde ve etkin noktada çizilir. */
const MAX_DOTS = 40;

function heightFor(width: number): number {
  return width < 420 ? 200 : 240;
}

/**
 * Etkileşimli fiyat grafiği (karar 0168). Kütüphanesiz SVG. Ölçek zaman orantılıdır;
 * y ekseni en az %10'luk bir alan gösterir, böylece küçük oynama büyük görünmez.
 * Veri sentezlenmez: 1-2 gözlemde yalnızca nokta, 3+ gözlemde çizgi; uzun boşluklar
 * kesikli çizilir ve ilk gözlemden önceki dönem "kayıt yok" olarak işaretlenir.
 */
export function PriceHistoryClient({
  points,
  currency,
  today,
  horizonDays,
  unverified = false,
  coverageNote = null,
}: PriceHistoryClientProps) {
  const ranges = useMemo(() => availableRanges(horizonDays), [horizonDays]);
  const [range, setRange] = useState<HistoryRangeKey>(() =>
    defaultRange(points, today, horizonDays),
  );
  const [active, setActive] = useState<number | null>(null);
  const [width, setWidth] = useState(640);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const readoutId = useId();

  const view = useMemo(() => buildHistoryView(points, range, today), [points, range, today]);

  useEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    setWidth(Math.max(240, Math.round(node.clientWidth)));
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(240, Math.round(w)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Dönem değişince etkin nokta bırakılır (eski indeks yeni seriye ait değildir).
  // biome-ignore lint/correctness/useExhaustiveDependencies: yalnızca `range` değişimi sıfırlar.
  useEffect(() => setActive(null), [range]);

  const height = heightFor(width);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const pts = view.points;
  const firstPoint = pts[0];
  const lastPoint = pts[pts.length - 1];

  // x alanı: dönem başı (yoksa ilk gözlem) -> bugün/son gözlem. Veri olmayan aralık boş kalır.
  let x0 = firstPoint ? dayNumber(firstPoint.date) : dayNumber(today);
  if (view.windowStart) x0 = dayNumber(view.windowStart);
  let x1 = Math.max(dayNumber(today), lastPoint ? dayNumber(lastPoint.date) : 0);
  if (x1 - x0 < 6) {
    x0 -= 3;
    x1 += 3;
  }
  const xOf = (date: string) => MARGIN.left + ((dayNumber(date) - x0) / (x1 - x0)) * innerW;

  const [yLo, yHi] =
    view.min && view.max ? yDomain(view.min.priceMinor, view.max.priceMinor) : [0, 1];
  const yOf = (minor: number) => MARGIN.top + innerH - ((minor - yLo) / (yHi - yLo)) * innerH;
  // Büyük aralıkta tam birime yuvarlanır (okunaklı eksen), küçükte kuruş/cent korunur.
  const tickStep = yHi - yLo >= 1000 ? 100 : 1;
  const roundTick = (v: number) => Math.round(v / tickStep) * tickStep;
  const yTicks = [roundTick(yLo), roundTick((yLo + yHi) / 2), roundTick(yHi)];
  const xTickDays = [x0, Math.round(x0 + (x1 - x0) / 3), Math.round(x0 + ((x1 - x0) * 2) / 3), x1];
  const xTicks = xTickDays.map((d) => new Date(d * 86_400_000).toISOString().slice(0, 10));

  const drawLine = pts.length >= 3;
  const gapKeys = new Set(view.gaps.map((g) => `${g.from}|${g.to}`));
  const segments: { d: string; dashed: boolean }[] = [];
  if (drawLine) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b) continue;
      segments.push({
        d: `M${xOf(a.date).toFixed(1)},${yOf(a.priceMinor).toFixed(1)} L${xOf(b.date).toFixed(1)},${yOf(b.priceMinor).toFixed(1)}`,
        dashed: gapKeys.has(`${a.date}|${b.date}`),
      });
    }
  }

  const showAllDots = pts.length <= MAX_DOTS;
  const extremesDiffer = view.min && view.max && view.min.priceMinor !== view.max.priceMinor;
  const activePoint = active !== null ? (pts[active] ?? null) : null;

  function nearestIndex(clientX: number, rect: DOMRect): number {
    const px = clientX - rect.left;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    pts.forEach((p, i) => {
      const dist = Math.abs(xOf(p.date) - px);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function onPointer(event: PointerEvent<HTMLDivElement>) {
    if (pts.length === 0) return;
    setActive(nearestIndex(event.clientX, event.currentTarget.getBoundingClientRect()));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (pts.length === 0) return;
    const cur = active ?? pts.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (event.key === "ArrowRight") next = Math.min(pts.length - 1, cur + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = pts.length - 1;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  const notes: string[] = [];
  if (pts.length === 0) {
    notes.push("Seçilen dönemde fiyat gözlemi yok.");
  } else if (pts.length === 1) {
    notes.push("Bu dönemde tek gözlem var; değişim hesaplanamaz.");
  } else if (pts.length === 2) {
    notes.push("Yalnızca iki gözlem var. Aradaki fiyatlar bilinmiyor, bu yüzden çizgi çizilmedi.");
  }
  if (view.uncoveredDays > 0 && firstPoint) {
    const firstEver = points.reduce((a, b) => (a.date < b.date ? a : b));
    notes.push(
      `Kayıtlar ${formatHistoryDate(firstEver.date)} tarihinde başlıyor; bu dönemin ilk ${view.uncoveredDays} günü için veri yok.`,
    );
  }
  for (const gap of view.gaps) {
    notes.push(
      `${formatHistoryDate(gap.from)} – ${formatHistoryDate(gap.to)} arasında ${gap.days} gün gözlem yok (kesikli çizgi).`,
    );
  }
  if (unverified || view.stale) {
    notes.push(
      view.daysSinceLast !== null
        ? `Son gözlem ${view.daysSinceLast} gün önce. Güncel fiyat doğrulanamadı, fiyat değişmiş olabilir.`
        : "Güncel fiyat doğrulanamadı.",
    );
  }
  if (coverageNote) notes.push(coverageNote);

  const change = view.change;
  const ariaLabel =
    view.min && view.max
      ? `Fiyat grafiği, ${view.points.length} gözlem. En düşük ${formatMoney(view.min.priceMinor, currency)}, en yüksek ${formatMoney(view.max.priceMinor, currency)}.`
      : "Fiyat grafiği, gözlem yok.";
  const readout = activePoint
    ? `${formatHistoryDate(activePoint.date)}: ${formatMoney(activePoint.priceMinor, currency)}`
    : "";

  // Tooltip kutusu grafiğin dışına taşmaz.
  const tipLeft = activePoint ? Math.min(Math.max(xOf(activePoint.date), 70), width - 70) : 0;
  const tipTop = activePoint ? yOf(activePoint.priceMinor) : 0;

  return (
    <div className={styles.history}>
      {/* biome-ignore lint/a11y/useSemanticElements: düğme grubu; fieldset görünümü gereksiz. */}
      <div className={styles.rangeBar} role="group" aria-label="Dönem">
        {ranges.map((r) => (
          <button
            key={r.key}
            type="button"
            className={
              r.key === range ? `${styles.rangeBtn} ${styles.rangeActive}` : styles.rangeBtn
            }
            aria-pressed={r.key === range}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <dl className={`${styles.stats} tabular-nums`}>
        <div className={styles.stat}>
          <dt>En düşük</dt>
          <dd>
            {view.min ? formatMoney(view.min.priceMinor, currency) : "—"}
            {view.min ? (
              <span className={styles.statDate}>{formatHistoryDate(view.min.date)}</span>
            ) : null}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>En yüksek</dt>
          <dd>
            {view.max ? formatMoney(view.max.priceMinor, currency) : "—"}
            {view.max ? (
              <span className={styles.statDate}>{formatHistoryDate(view.max.date)}</span>
            ) : null}
          </dd>
        </div>
        {view.average !== null ? (
          <div className={styles.stat}>
            <dt>Ortalama</dt>
            <dd>
              {formatMoney(view.average, currency)}
              <span className={styles.statDate}>gözlenen günler</span>
            </dd>
          </div>
        ) : null}
        <div className={styles.stat}>
          <dt>Değişim</dt>
          <dd>
            {change ? (
              <>
                <span className={`${styles.change} ${styles[change.direction]}`}>
                  <span aria-hidden="true">{DIRECTION_GLYPH[change.direction]}</span>{" "}
                  {change.direction === "flat"
                    ? "Değişmedi"
                    : `${formatChangeAmount(change, currency)} ${DIRECTION_WORD[change.direction]}`}
                </span>
                <span className={styles.statDate}>
                  {`${formatHistoryDate(change.fromDate)} → ${formatHistoryDate(change.toDate)}`}
                </span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

      {/* biome-ignore lint/a11y/useSemanticElements: grafik alanı odaklanabilir bir "slider" benzeri görünümdür; ok tuşlarıyla gözlem gezilir. */}
      <div
        ref={plotRef}
        className={styles.plot}
        // Dikey kaydırma sayfada kalır, yatay sürükleme gözlemi seçer.
        style={{ height }}
        tabIndex={pts.length > 0 ? 0 : -1}
        role="group"
        aria-label={ariaLabel}
        aria-describedby={readoutId}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setActive(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg className={styles.svg} width={width} height={height} aria-hidden="true">
          {/* y ızgarası + etiketleri */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={styles.grid}
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={yOf(tick)}
                y2={yOf(tick)}
              />
              <text
                className={styles.axisText}
                x={MARGIN.left - 8}
                y={yOf(tick)}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {formatMoney(tick, currency)}
              </text>
            </g>
          ))}
          {xTicks.map((tick, i) => (
            <text
              key={tick}
              className={styles.axisText}
              x={xOf(tick)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            >
              {shortDate(tick)}
            </text>
          ))}

          {/* Kayıt olmayan başlangıç dönemi */}
          {view.uncoveredDays > 0 && firstPoint ? (
            <g>
              <rect
                className={styles.noData}
                x={MARGIN.left}
                y={MARGIN.top}
                width={Math.max(
                  0,
                  xOf(points.reduce((a, b) => (a.date < b.date ? a : b)).date) - MARGIN.left,
                )}
                height={innerH}
              />
              <text className={styles.noDataText} x={MARGIN.left + 6} y={MARGIN.top + 14}>
                Kayıt yok
              </text>
            </g>
          ) : null}

          {segments.map((s) => (
            <path key={s.d} className={s.dashed ? styles.lineGap : styles.line} d={s.d} />
          ))}

          {activePoint ? (
            <line
              className={styles.cursor}
              x1={xOf(activePoint.date)}
              x2={xOf(activePoint.date)}
              y1={MARGIN.top}
              y2={MARGIN.top + innerH}
            />
          ) : null}

          {pts.map((p, i) => {
            const isMin =
              extremesDiffer && view.min?.date === p.date && view.min.priceMinor === p.priceMinor;
            const isMax =
              extremesDiffer && view.max?.date === p.date && view.max.priceMinor === p.priceMinor;
            if (!showAllDots && !isMin && !isMax && i !== active) return null;
            return (
              <g key={p.date}>
                {isMin || isMax ? (
                  <circle
                    className={isMin ? styles.ringMin : styles.ringMax}
                    cx={xOf(p.date)}
                    cy={yOf(p.priceMinor)}
                    r={7}
                  />
                ) : null}
                <circle
                  className={i === active ? styles.dotActive : styles.dot}
                  cx={xOf(p.date)}
                  cy={yOf(p.priceMinor)}
                  r={i === active ? 5 : 3.5}
                />
              </g>
            );
          })}
        </svg>

        {activePoint ? (
          <div className={`${styles.tooltip} tabular-nums`} style={{ left: tipLeft, top: tipTop }}>
            <strong>{formatMoney(activePoint.priceMinor, currency)}</strong>
            <span>{formatHistoryDate(activePoint.date)}</span>
          </div>
        ) : null}
        {pts.length === 0 ? <p className={styles.emptyPlot}>Bu dönemde gözlem yok.</p> : null}
      </div>

      <p id={readoutId} className={styles.readout} aria-live="polite">
        {readout || "Noktaya dokunarak ya da ok tuşlarıyla tarih ve fiyatı görebilirsin."}
      </p>

      {extremesDiffer ? (
        <p className={styles.legend}>
          <span className={styles.keyMin} aria-hidden="true" /> En düşük gözlem
          <span className={styles.keyMax} aria-hidden="true" /> En yüksek gözlem
        </p>
      ) : null}

      <ul className={styles.notes}>
        <li>
          {currency === "TRY"
            ? "Fiyatlar TL cinsindendir."
            : `Fiyatlar ${currency} cinsindendir; TL'ye çevrilmedi.`}{" "}
          Her nokta o gün gözlenen en düşük fiyattır. Tarih, fiyatın kontrol edildiği gündür;
          fiyatın değiştiği gün olmayabilir.
        </li>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
