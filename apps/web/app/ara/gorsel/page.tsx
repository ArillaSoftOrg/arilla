import { permanentRedirect } from "next/navigation";

/**
 * Karar 0091: görsel artık normal sohbet mesajının ekidir; bağımsız görsel arama sonucu
 * sayfası kalktı. Eski bağlantılar (yer imi, açık sekme) ana sayfaya taşınır; hiçbir
 * görsel verisi okunmaz. Arka uç (`searchByImageVector`, `image_upload`) link araması
 * ve yönetim ekranları için yerinde durur.
 */
export default function GorselAramaPage(): never {
  permanentRedirect("/");
}
