"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { CHAT_MESSAGE_MAX, ChatComposer } from "../chat-shell-parts.tsx";

export function GuestComposer({
  query,
  steps,
  locked,
}: {
  query: string;
  steps: readonly string[];
  locked: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim().slice(0, CHAT_MESSAGE_MAX);
    if (locked || !text) return;
    const params = new URLSearchParams({ q: query });
    for (const step of steps) params.append("n", step);
    params.append("n", `t~${text}`);
    router.push(`/sohbet/misafir?${params.toString()}`);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <ChatComposer
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      locked={locked}
    />
  );
}
