import { isChatDiscoveryEnabled } from "@arilla/core";
import { notFound } from "next/navigation";
import { requireProductUser } from "../../lib/dal.ts";
import { ChatBootstrap } from "../chat-bootstrap-client.tsx";

/** `startChatBootstrapAction` yanit sonrasi `after()` ile ilk turu calistirir; sure bu rotaya baglidir. */
export const maxDuration = 60;

/**
 * `/sohbet/yeni`: ana sayfadan acilan sekmenin ILK gorunen icerigi (about:blank
 * degil). Gercek sohbet kabugunu cizer, kullanici mesajini iyimser gosterir,
 * sohbeti olusturup bu girisi `/sohbet/[id]` ile degistirir (history girisi yok).
 */
export default async function NewChatPage() {
  await requireProductUser();
  if (!isChatDiscoveryEnabled()) notFound();
  return <ChatBootstrap />;
}
