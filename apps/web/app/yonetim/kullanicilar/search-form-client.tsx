"use client";

import { Button } from "@arilla/ui";
import Link from "next/link";
import { useActionState, useState } from "react";
import styles from "../admin.module.css";
import { earlyAccessStatusLabel, formatDateTime, roleLabel } from "../format.ts";
import { type SearchState, searchUsersAction } from "./actions.ts";

const INITIAL: SearchState = { status: "idle" };

/**
 * Kısmi kullanıcı araması. Sorgu kontrollü tutulur: React 19 form eylemi
 * sonrası kontrolsüz alanları sıfırlar, sayfalarken sorgu kaybolmasın.
 */
export function SearchFormClient() {
  const [state, action, pending] = useActionState(searchUsersAction, INITIAL);
  const [query, setQuery] = useState("");
  // Sayfalama, kutudaki güncel metni değil son aranan sorguyu kullanır.
  const [submitted, setSubmitted] = useState("");
  const page = state.status === "ok" ? state.page : 1;

  return (
    <div className={styles.pageHeader}>
      <form
        action={action}
        onSubmit={() => setSubmitted(query)}
        className={styles.filters}
        aria-label="Kullanıcı ara"
      >
        <label className={styles.pageHeader}>
          <span className={styles.meta}>Ad, e-posta ya da hesap kimliği (en az 2 karakter)</span>
          <input
            name="q"
            required
            minLength={2}
            maxLength={100}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={styles.textInput}
          />
        </label>
        <input type="hidden" name="sayfa" value="1" />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Aranıyor…" : "Ara"}
        </Button>
      </form>

      {state.status === "error" ? (
        <p role="alert" className={styles.statusBad}>
          {state.message}
        </p>
      ) : null}

      {state.status === "ok" ? (
        <div className={styles.pageHeader} aria-live="polite">
          <p className={styles.muted}>
            {state.rows.length === 0
              ? "Eşleşen kullanıcı bulunamadı."
              : `${state.rows.length}${state.hasNext ? "+" : ""} kullanıcı bulundu${
                  page > 1 ? ` (sayfa ${page})` : ""
                }.`}
          </p>
          {state.rows.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Kullanıcı</th>
                    <th scope="col">Rol</th>
                    <th scope="col">Erken erişim</th>
                    <th scope="col">Kayıt</th>
                  </tr>
                </thead>
                <tbody>
                  {state.rows.map((row) => (
                    <tr key={row.publicId}>
                      <td>
                        <Link href={`/yonetim/kullanicilar/${row.publicId}`}>
                          {row.displayName ?? row.emailMasked ?? "Adsız hesap"}
                        </Link>
                        <div className={styles.meta}>
                          {[row.displayName ? row.emailMasked : null, row.phoneMasked]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </td>
                      <td>{roleLabel(row.role)}</td>
                      <td>
                        {row.earlyAccess
                          ? `${earlyAccessStatusLabel(row.earlyAccess.status)} · ${formatDateTime(
                              row.earlyAccess.joinedAt,
                            )}`
                          : "Listede değil"}
                      </td>
                      <td>{formatDateTime(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {page > 1 || state.hasNext ? (
            <div className={styles.row}>
              {page > 1 ? (
                <form action={action}>
                  <input type="hidden" name="q" value={submitted} />
                  <input type="hidden" name="sayfa" value={page - 1} />
                  <Button type="submit" variant="secondary" disabled={pending}>
                    Önceki sayfa
                  </Button>
                </form>
              ) : null}
              {state.hasNext ? (
                <form action={action}>
                  <input type="hidden" name="q" value={submitted} />
                  <input type="hidden" name="sayfa" value={page + 1} />
                  <Button type="submit" variant="secondary" disabled={pending}>
                    Sonraki sayfa
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
