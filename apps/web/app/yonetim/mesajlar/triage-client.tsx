"use client";

import { Button } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import styles from "../admin.module.css";
import { inboxPriorityLabel, inboxStatusLabel } from "../format.ts";
import {
  type InboxActionResult,
  setMessagePriorityAction,
  setMessageStatusAction,
} from "./actions.ts";

const PRIORITIES = ["low", "medium", "high"] as const;

/**
 * Mesaj başına durum ve öncelik (karar 0086). Yalnızca izinli geçişler
 * listelenir (sunucudan); core aynı kuralı ayrıca uygular ve denetime yazar.
 */
export function InboxTriageClient({
  messageId,
  status,
  priority,
  transitions,
}: {
  messageId: number;
  status: string;
  priority: string | null;
  transitions: readonly string[];
}) {
  const router = useRouter();
  const statusId = useId();
  const priorityId = useId();
  const [pending, startTransition] = useTransition();
  const [nextStatus, setNextStatus] = useState(transitions[0] ?? "");
  const [nextPriority, setNextPriority] = useState(priority ?? "");
  const [result, setResult] = useState<InboxActionResult | null>(null);

  function apply(call: () => Promise<InboxActionResult>) {
    startTransition(async () => {
      const response = await call();
      setResult(response);
      if (response.ok) router.refresh();
    });
  }

  return (
    <div className={styles.filters}>
      {transitions.length > 0 ? (
        <span className={styles.row}>
          <label htmlFor={statusId} className={styles.filterLabel}>
            Durum
          </label>
          <select id={statusId} value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
            {transitions.map((value) => (
              <option key={value} value={value}>
                {inboxStatusLabel(value)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !nextStatus}
            onClick={() =>
              apply(() =>
                setMessageStatusAction({ messageId, next: nextStatus, expectedStatus: status }),
              )
            }
          >
            Durumu değiştir
          </Button>
        </span>
      ) : null}
      <span className={styles.row}>
        <label htmlFor={priorityId} className={styles.filterLabel}>
          Öncelik
        </label>
        <select
          id={priorityId}
          value={nextPriority}
          onChange={(e) => setNextPriority(e.target.value)}
        >
          <option value="">{inboxPriorityLabel(null)}</option>
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {inboxPriorityLabel(value)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || nextPriority === (priority ?? "")}
          onClick={() =>
            apply(() => setMessagePriorityAction({ messageId, priority: nextPriority || null }))
          }
        >
          Önceliği kaydet
        </Button>
      </span>
      <span aria-live="polite">
        {result && !result.ok ? (
          <span className={styles.statusBad} role="alert">
            {result.message}
          </span>
        ) : null}
      </span>
    </div>
  );
}
