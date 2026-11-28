import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmailPreviews,
  buildTeamNotificationEmail,
  buildVisitorConfirmationEmail,
  emailChannelStatus,
  type FormNotification,
  notifyFormReceived,
} from "./form-notifications.ts";
import {
  EMAIL_SETTING_DEFAULTS,
  type EmailSettings,
  EmailSettingsValidationError,
  readEmailSettings,
  validateEmailSettings,
} from "./settings.ts";

const ON: EmailSettings = {
  ...EMAIL_SETTING_DEFAULTS,
  teamNotifications: true,
  visitorConfirmations: true,
};
const ENV = { ADMIN_NOTIFY_EMAIL: "Ekip@Ornek.test", APP_URL: "https://ornek.test" } as const;

const FORM: FormNotification = {
  kind: "contact",
  categoryLabel: "Teknik sorun",
  title: "Giriş yapamıyorum",
  visitorEmail: "ziyaretci@ornek.test",
};

// Gönderim yolu veritabanına yalnızca ayar okumak için gider; testlerde ayar doğrudan verilir.
const NO_DB = {} as never;

function fakeTransport() {
  const sendMail = vi.fn(async (_message: { to: string; replyTo?: string }) => ({}));
  return { sendMail, transport: { sendMail } as never };
}

beforeEach(() => {
  vi.stubEnv("EMAIL_FROM", "Arilla <no-reply@ornek.test>");
  vi.stubEnv("EMAIL_REPLY_TO", "destek@ornek.test");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("validateEmailSettings", () => {
  const valid = {
    teamNotifications: true,
    visitorConfirmations: false,
    priceAlerts: true,
    marketingEmails: false,
  };

  it("dört boolean anahtarı kabul eder", () => {
    expect(validateEmailSettings(valid)).toEqual(valid);
  });

  it.each([
    ['boolean olmayan değer ("false" dizgesi)', { ...valid, priceAlerts: "false" }],
    ["eksik anahtar", { teamNotifications: true }],
    ["bilinmeyen anahtar", { ...valid, extra: true }],
    ["dizi", [true, false]],
    ["null", null],
    ["sayı", 1],
  ])("reddeder: %s", (_label, input) => {
    expect(() => validateEmailSettings(input)).toThrow(EmailSettingsValidationError);
  });

  it("varsayılanlar: yeni bildirimler kapalı, mevcut e-postalar açık", () => {
    expect(EMAIL_SETTING_DEFAULTS).toEqual({
      teamNotifications: false,
      visitorConfirmations: false,
      priceAlerts: true,
      marketingEmails: true,
    });
  });
});

describe("readEmailSettings", () => {
  it("satır yoksa varsayılanları döner", async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    expect(await readEmailSettings(db as never)).toEqual(EMAIL_SETTING_DEFAULTS);
  });

  it("veritabanı hata verirse fırlatmaz, varsayılana düşer", async () => {
    const db = {
      select: () => {
        throw new Error('relation "email_setting" does not exist');
      },
    };
    expect(await readEmailSettings(db as never)).toEqual(EMAIL_SETTING_DEFAULTS);
  });

  it("satırdaki değerleri döner", async () => {
    const row = {
      teamNotifications: true,
      visitorConfirmations: true,
      priceAlerts: false,
      marketingEmails: false,
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    };
    expect(await readEmailSettings(db as never)).toEqual(row);
  });
});

describe("şablonlar", () => {
  it("ekip bildirimi: kategori, başlık ve bağlantı var; konuda serbest metin yok", () => {
    const mail = buildTeamNotificationEmail(FORM, "https://ornek.test/yonetim/mesajlar");
    expect(mail.html).toContain("Teknik sorun");
    expect(mail.html).toContain("Giriş yapamıyorum");
    expect(mail.html).toContain("https://ornek.test/yonetim/mesajlar");
    expect(mail.subject).not.toContain("Giriş yapamıyorum");
    expect(mail.text).toContain("https://ornek.test/yonetim/mesajlar");
  });

  it("ekip bildirimi: başlıktaki HTML kaçırılır", () => {
    const mail = buildTeamNotificationEmail(
      { ...FORM, title: '<script>alert("x")</script>' },
      null,
    );
    expect(mail.html).not.toContain("<script>alert");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("ekip bildirimi: bağlantı yoksa düğme çizilmez", () => {
    expect(buildTeamNotificationEmail(FORM, null).html).not.toContain("Gelen kutusunu aç");
  });

  it("ekip bildirimi e-posta adresi ya da mesaj metni taşımaz", () => {
    const mail = buildTeamNotificationEmail(FORM, null);
    expect(mail.html).not.toContain("ziyaretci@ornek.test");
    expect(mail.text).not.toContain("ziyaretci@ornek.test");
  });

  it.each(["contact", "feedback"] as const)(
    "ziyaretçi onayı (%s): kullanıcı metnini yankılamaz, reklam içermez",
    (kind) => {
      const mail = buildVisitorConfirmationEmail({ kind, categoryLabel: "Teknik sorun" });
      expect(mail.html).not.toContain("Giriş yapamıyorum");
      expect(mail.html).toContain("reklam içermez");
      expect(mail.subject).toMatch(/\S/);
    },
  );

  it("önizleme: anahtarlar benzersiz, konu dolu, betik yok", () => {
    const previews = buildEmailPreviews();
    const keys = previews.map((preview) => preview.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(
      expect.arrayContaining([
        "contact_team",
        "feedback_team",
        "contact_visitor",
        "feedback_visitor",
      ]),
    );
    for (const preview of previews) {
      expect(preview.mail.subject).toMatch(/\S/);
      expect(preview.mail.html).not.toContain("<script");
    }
  });
});

describe("notifyFormReceived", () => {
  it("iki anahtar da kapalıyken hiçbir şey göndermez", async () => {
    const { sendMail, transport } = fakeTransport();
    const result = await notifyFormReceived(NO_DB, FORM, {
      transport,
      env: ENV,
      settings: EMAIL_SETTING_DEFAULTS,
    });
    expect(result).toEqual({ team: false, visitor: false });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("ikisi açıkken ekibe ve ziyaretçiye ayrı e-posta gönderir", async () => {
    const { sendMail, transport } = fakeTransport();
    const result = await notifyFormReceived(NO_DB, FORM, { transport, env: ENV, settings: ON });
    expect(result).toEqual({ team: true, visitor: true });
    expect(sendMail).toHaveBeenCalledTimes(2);
    const recipients = sendMail.mock.calls.map(([message]) => message.to);
    expect(recipients).toEqual(["ekip@ornek.test", "ziyaretci@ornek.test"]);
    const visitorMessage = sendMail.mock.calls[1]?.[0];
    expect(visitorMessage?.replyTo).toBe("destek@ornek.test");
  });

  it("yalnızca ekip anahtarı açıkken ziyaretçiye göndermez", async () => {
    const { sendMail, transport } = fakeTransport();
    const result = await notifyFormReceived(NO_DB, FORM, {
      transport,
      env: ENV,
      settings: { ...ON, visitorConfirmations: false },
    });
    expect(result).toEqual({ team: true, visitor: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("ADMIN_NOTIFY_EMAIL yok ya da geçersizse ekip bildirimi gitmez, ziyaretçi onayı gider", async () => {
    for (const bad of [undefined, "", "gecersiz"]) {
      const { sendMail, transport } = fakeTransport();
      const result = await notifyFormReceived(NO_DB, FORM, {
        transport,
        env: { ...ENV, ADMIN_NOTIFY_EMAIL: bad },
        settings: ON,
      });
      expect(result).toEqual({ team: false, visitor: true });
      expect(sendMail).toHaveBeenCalledTimes(1);
    }
  });

  it("adres bırakılmadıysa ya da geçersizse ziyaretçiye göndermez", async () => {
    for (const visitorEmail of [null, "", "gecersiz"]) {
      const { transport } = fakeTransport();
      const result = await notifyFormReceived(
        NO_DB,
        { ...FORM, visitorEmail },
        { transport, env: ENV, settings: ON },
      );
      expect(result.visitor).toBe(false);
    }
  });

  it("gönderim hatası fırlatmaz; diğer e-posta yine denenir; logda adres yok", async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("ziyaretci@ornek.test reddedildi"), { code: "EENVELOPE" }),
      )
      .mockResolvedValueOnce({});
    const result = await notifyFormReceived(NO_DB, FORM, {
      transport: { sendMail } as never,
      env: ENV,
      settings: ON,
    });
    expect(result).toEqual({ team: false, visitor: true });
    const logged = (console.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(logged).toContain("EENVELOPE");
    expect(logged).not.toContain("ornek.test");
  });

  it("gönderen adresi tanımsızsa fırlatmaz, hiçbir şey göndermez", async () => {
    vi.stubEnv("EMAIL_FROM", "");
    const { sendMail, transport } = fakeTransport();
    const result = await notifyFormReceived(NO_DB, FORM, { transport, env: ENV, settings: ON });
    expect(result).toEqual({ team: false, visitor: false });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("ayar okunamazsa (varsayılan) hiçbir şey göndermez ve fırlatmaz", async () => {
    const { sendMail, transport } = fakeTransport();
    const db = {
      select: () => {
        throw new Error("baglanti koptu");
      },
    };
    const result = await notifyFormReceived(db as never, FORM, { transport, env: ENV });
    expect(result).toEqual({ team: false, visitor: false });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("emailChannelStatus", () => {
  it("yalnızca boolean döner, değer sızdırmaz", () => {
    const status = emailChannelStatus({
      SMTP_HOST: "smtp.ornek.test",
      SMTP_PORT: "587",
      SMTP_USER: "kullanici",
      SMTP_PASS: "cok-gizli",
      EMAIL_FROM: "Arilla <no-reply@ornek.test>",
      ADMIN_NOTIFY_EMAIL: "ekip@ornek.test",
    });
    expect(status).toEqual({ smtpConfigured: true, fromConfigured: true, notifyConfigured: true });
    expect(JSON.stringify(status)).not.toContain("gizli");
  });

  it("eksik yapılandırmayı ayrı ayrı bildirir", () => {
    expect(emailChannelStatus({})).toEqual({
      smtpConfigured: false,
      fromConfigured: false,
      notifyConfigured: false,
    });
  });
});
