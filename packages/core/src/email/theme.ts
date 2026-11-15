/**
 * İşlemsel e-posta paleti. E-posta istemcileri CSS özel özelliklerini (`var()`)
 * desteklemez; bu yüzden değerler `docs/design.md` belirteçlerinin birebir
 * kopyasıdır ve YALNIZCA bu dosyada durur (şablonlar renk yazmaz). Değerlerin
 * design.md ile eşleştiği `theme.test.ts`'te doğrulanır; tasarım değişince önce
 * belge, sonra burası güncellenir.
 */
export interface EmailPalette {
  /** `--paper` */
  page: string;
  /** `--surface-raised` */
  card: string;
  /** `--ink` */
  ink: string;
  /** `--ink-secondary` */
  inkSecondary: string;
  /** `--ink-muted` */
  inkMuted: string;
  /** `--line` */
  line: string;
  /** `--accent` */
  accent: string;
  /** `--accent-foreground` */
  accentForeground: string;
  /** `--surface` (güvenlik notu zemini) */
  surface: string;
}

export const EMAIL_LIGHT: EmailPalette = {
  page: "#FCFCFC",
  card: "#FFFFFF",
  ink: "#0D0D0D",
  inkSecondary: "#404040",
  inkMuted: "#636363",
  line: "#E5E5E5",
  accent: "#0D0D0D",
  accentForeground: "#FFFFFF",
  surface: "#F4F4F4",
};

export const EMAIL_DARK: EmailPalette = {
  page: "#0E0F11",
  card: "#1E2125",
  ink: "#F2F3F4",
  inkSecondary: "#C9CDD1",
  inkMuted: "#9BA0A6",
  line: "#2A2E33",
  accent: "#F2F3F4",
  accentForeground: "#16181D",
  surface: "#17191C",
};

/** Sistem yazı tipleri: e-postada özel font yüklenmez (üçüncü taraf/CDN yok). */
export const EMAIL_FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
