"use client";

import { Button } from "@arilla/ui";
import { useActionState } from "react";
import styles from "../admin.module.css";
import { type LookupState, lookupUserAction } from "./actions.ts";

const INITIAL: LookupState = { message: null };

export function LookupFormClient() {
  const [state, action, pending] = useActionState(lookupUserAction, INITIAL);
  return (
    <form action={action} className={styles.filters}>
      <label className={styles.pageHeader}>
        <span className={styles.meta}>E-posta, telefon (+90…) ya da hesap kimliği</span>
        <input
          name="kimlik"
          required
          maxLength={254}
          autoComplete="off"
          className={styles.textInput}
        />
      </label>
      <Button type="submit" variant="primary" disabled={pending}>
        Bul
      </Button>
      {state.message ? (
        <p role="alert" className={styles.statusBad} style={{ margin: 0 }}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
