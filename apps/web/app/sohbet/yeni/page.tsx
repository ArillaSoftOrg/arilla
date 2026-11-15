import { redirect } from "next/navigation";

/**
 * Eski "yeni sekmede sohbet" kabuğu (karar 0091, 0204'te kaldırıldı): ana sayfa mesajı aynı
 * sekmede gönderir. Eski sekme/yer imi ana sayfaya düşer.
 */
export default function LegacyNewChatPage() {
  redirect("/");
}
