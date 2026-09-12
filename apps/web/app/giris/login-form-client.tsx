"use client";

import { Button, Input } from "@arilla/ui";
import { useActionState } from "react";
import { type RequestLoginLinkState, requestLoginLinkAction } from "./actions.ts";

const initialState: RequestLoginLinkState = { status: "idle" };

export function LoginFormClient() {
  const [state, action, pending] = useActionState(requestLoginLinkAction, initialState);

  if (state.status === "sent") {
    return (
      <div>
        <h2 style={{ margin: 0 }}>Bağlantıyı gönderdik</h2>
        <p style={{ margin: "8px 0 0" }}>
          E-postana bir giriş bağlantısı gönderdik. Bağlantı 15 dakika geçerli.
        </p>
      </div>
    );
  }

  return (
    <form action={action} style={{ display: "grid", gap: 12, maxWidth: 360 }}>
      <Input label="E-posta adresin" name="email" type="email" autoComplete="email" required />
      {state.status === "rate_limited" ? (
        <p style={{ margin: 0, color: "var(--ink-muted)" }}>
          Az önce bir bağlantı gönderdik. Birkaç dakika sonra tekrar dene.
        </p>
      ) : null}
      {state.status === "invalid_email" ? (
        <p style={{ margin: 0, color: "var(--ink-muted)" }}>Geçerli bir e-posta adresi gir.</p>
      ) : null}
      <Button type="submit" variant="primary" disabled={pending}>
        Bağlantı gönder
      </Button>
    </form>
  );
}
