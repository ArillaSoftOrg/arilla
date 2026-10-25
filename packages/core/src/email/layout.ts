/**
 * Ortak işlemsel e-posta yerleşimi: tek `renderEmail` tüm şablonların HTML ve
 * düz metin çıktısını üretir. Dinamik her değer `escapeHtml`'den geçer; renkler
 * yalnızca `theme.ts`'ten gelir.
 *
 * İstemci uyumu: tablo tabanlı, satır içi stil (Gmail/Outlook), `<style>` yalnızca
 * mobil daraltma ve koyu mod için (`prefers-color-scheme` → Apple Mail/Gmail,
 * `[data-ogsc]` → Outlook.com). Harici görsel, font ya da betik yok: marka
 * kelime işareti metindir (resim engelleyen istemcilerde de görünür).
 */
import { LEGAL_IDENTITY } from "../config/legal-identity.ts";
import { escapeHtml } from "./escape-html.ts";
import { EMAIL_DARK, EMAIL_FONT_STACK, EMAIL_LIGHT, type EmailPalette } from "./theme.ts";

export const EMAIL_BRAND = LEGAL_IDENTITY.brandName;

export interface EmailAction {
  label: string;
  url: string;
}

export interface EmailSpec {
  subject: string;
  /** Gelen kutusu önizleme metni (gövdede görünmez). */
  preheader: string;
  title: string;
  paragraphs: readonly string[];
  /** Ana düğme; verilirse düz metin bağlantısı da eklenir. */
  action?: EmailAction;
  /** "Sen yapmadıysan..." gibi güvenlik bilgisi; kutu içinde gösterilir. */
  security?: readonly string[];
  /** Madde işaretli kısa liste (hoş geldin e-postasında özellikler). */
  highlights?: readonly string[];
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const L: EmailPalette = EMAIL_LIGHT;
const D: EmailPalette = EMAIL_DARK;

/** Satır içi stil değerleri: açık tema; koyu tema sınıflarla ezilir. */
function darkCss(): string {
  return [
    `.em-page{background-color:${D.page} !important}`,
    `.em-card{background-color:${D.card} !important;border-color:${D.line} !important}`,
    `.em-ink{color:${D.ink} !important}`,
    `.em-sec{color:${D.inkSecondary} !important}`,
    `.em-muted{color:${D.inkMuted} !important}`,
    `.em-note{background-color:${D.surface} !important;border-color:${D.line} !important}`,
    `.em-btn{background-color:${D.accent} !important}`,
    `.em-btn a{color:${D.accentForeground} !important}`,
    `.em-link{color:${D.ink} !important}`,
  ].join("");
}

function outlookDarkCss(): string {
  const rules = darkCss().split("}").filter(Boolean);
  return rules.map((rule) => `[data-ogsc] ${rule}}`).join("");
}

function wordmarkHtml(): string {
  return `<div class="em-ink" style="margin:0 0 28px;font-size:24px;line-height:28px;font-style:italic;font-weight:600;color:${L.ink}">${escapeHtml(EMAIL_BRAND)}</div>`;
}

function buttonHtml(action: EmailAction): string {
  const url = escapeHtml(action.url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td class="em-btn" bgcolor="${L.accent}" style="border-radius:999px;background-color:${L.accent}"><a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:16px;line-height:20px;font-weight:600;color:${L.accentForeground};text-decoration:none;border-radius:999px">${escapeHtml(action.label)}</a></td></tr></table>`;
}

function fallbackLinkHtml(action: EmailAction): string {
  const url = escapeHtml(action.url);
  return `<p class="em-muted" style="margin:0 0 24px;font-size:13px;line-height:20px;color:${L.inkMuted}">Düğme çalışmazsa bu bağlantıyı tarayıcına yapıştır:<br><a class="em-link" href="${url}" target="_blank" style="color:${L.ink};word-break:break-all">${url}</a></p>`;
}

function securityHtml(lines: readonly string[]): string {
  const body = lines
    .map(
      (line, index) =>
        `<p class="em-sec" style="margin:${index === 0 ? "0" : "8px"} 0 0;font-size:14px;line-height:21px;color:${L.inkSecondary}">${escapeHtml(line)}</p>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px"><tr><td class="em-note" bgcolor="${L.surface}" style="padding:16px 18px;border:1px solid ${L.line};border-radius:12px;background-color:${L.surface}">${body}</td></tr></table>`;
}

function highlightsHtml(items: readonly string[]): string {
  const rows = items
    .map(
      (item) =>
        `<tr><td class="em-sec" valign="top" style="padding:0 10px 10px 0;font-size:16px;line-height:24px;color:${L.inkSecondary}">&bull;</td><td class="em-sec" style="padding:0 0 10px;font-size:16px;line-height:24px;color:${L.inkSecondary}">${escapeHtml(item)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">${rows}</table>`;
}

export function renderEmail(spec: EmailSpec): RenderedMail {
  const paragraphs = spec.paragraphs
    .map(
      (p) =>
        `<p class="em-sec" style="margin:0 0 16px;font-size:16px;line-height:24px;color:${L.inkSecondary}">${escapeHtml(p)}</p>`,
    )
    .join("");

  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(spec.subject)}</title><style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:600px){.em-wrap{padding:16px 12px !important}.em-card{padding:24px 20px !important}}@media (prefers-color-scheme:dark){${darkCss()}}${outlookDarkCss()}</style></head><body class="em-page" style="margin:0;padding:0;background-color:${L.page}"><div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${L.page}">${escapeHtml(spec.preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-page" bgcolor="${L.page}" style="background-color:${L.page}"><tr><td align="center" class="em-wrap" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr><td class="em-card" bgcolor="${L.card}" style="padding:36px 32px;border:1px solid ${L.line};border-radius:16px;background-color:${L.card};font-family:${EMAIL_FONT_STACK}">${wordmarkHtml()}<h1 class="em-ink" style="margin:0 0 16px;font-size:24px;line-height:30px;font-weight:600;color:${L.ink}">${escapeHtml(spec.title)}</h1>${paragraphs}${spec.highlights ? highlightsHtml(spec.highlights) : ""}${spec.action ? buttonHtml(spec.action) + fallbackLinkHtml(spec.action) : ""}${spec.security?.length ? securityHtml(spec.security) : ""}</td></tr><tr><td class="em-muted" style="padding:20px 8px 0;font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:18px;color:${L.inkMuted};text-align:center">${escapeHtml(EMAIL_BRAND)} hesabınla ilgili bir işlem nedeniyle gönderildi. Bu ileti işlemseldir; reklam içermez.</td></tr></table></td></tr></table></body></html>`;

  const textParts: string[] = [spec.title, "", ...spec.paragraphs.flatMap((p) => [p, ""])];
  if (spec.highlights) textParts.push(...spec.highlights.map((h) => `- ${h}`), "");
  if (spec.action) textParts.push(`${spec.action.label}: ${spec.action.url}`, "");
  if (spec.security?.length) textParts.push(...spec.security.flatMap((s) => [s, ""]));
  textParts.push(
    `${EMAIL_BRAND} hesabınla ilgili bir işlem nedeniyle gönderildi. Bu ileti işlemseldir; reklam içermez.`,
  );

  return { subject: spec.subject, html, text: textParts.join("\n") };
}
