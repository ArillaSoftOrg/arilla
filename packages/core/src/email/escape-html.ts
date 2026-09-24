/**
 * E-posta HTML gövdesine giren her dinamik değer (ürün başlığı feed'den veya
 * kullanıcı linkinden gelir) buradan geçer. Öznitelik değerleri (`href="..."`)
 * için de güvenlidir: çift ve tek tırnak kaçırılır.
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
