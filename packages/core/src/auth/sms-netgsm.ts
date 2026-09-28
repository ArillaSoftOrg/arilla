/**
 * Netgsm OTP SMS adaptoru (`SMS_PROVIDER=netgsm`). Ek bagimlilik yok: resmi
 * `netgsm-sms-js` SDK'sinin `sendOtpSms` cagrisinin aynisi `fetch` ile:
 *
 *   POST https://api.netgsm.com.tr/sms/rest/v2/otp
 *   Authorization: Basic base64(usercode:password)
 *   { "msgheader": "...", "msg": "...", "no": "5XXXXXXXXX" }
 *   -> { "code": "00", "jobId": "..." }   ("00" disi her kod hata)
 *
 * OTP ucu yalnizca yurt ici numaraya gider; +90 disi numara burada da
 * reddedilir (izin listesi `phone-login.ts`'te zaten +90 ile sinirli).
 *
 * Saglayici kodlari (resmi SDK `SendOtpSmsErrorCode`): 20 mesaj metni/uzunluk,
 * 30 kimlik ya da API/IP kisiti (Vercel'in sabit cikis IP'si yok: panelde
 * IP kisiti kapali olmali), 40/41 gonderici basligi tanimsiz/gecersiz,
 * 50-52 numara, 60 OTP kredisi yok, 70 parametre, 100/101 sistem, 5000
 * tanimsiz. Loglarda `sms:netgsm:<kod>` olarak gorunur.
 *
 * Kimlik bilgisi, numara ve mesaj hicbir hata mesajina ya da loga girmez;
 * hata yalnizca saglayici kodunu tasir.
 */
import type { SmsMessage, SmsSender } from "./sms.ts";

export const NETGSM_OTP_URL = "https://api.netgsm.com.tr/sms/rest/v2/otp";
const REQUEST_TIMEOUT_MS = 10_000;

export class NetgsmConfigError extends Error {
  constructor(name: string) {
    super(`${name} tanimli degil. .env.example dosyasina bakin.`);
    this.name = "NetgsmConfigError";
  }
}

export class NetgsmSendError extends Error {
  /** Saglayici kodu ("30", "http_500", "timeout" ...); gizli veri icermez. */
  readonly code: string;

  constructor(code: string) {
    super(`netgsm gonderimi basarisiz: ${code}`);
    this.name = "NetgsmSendError";
    this.code = code;
  }
}

export interface NetgsmConfig {
  usercode: string;
  password: string;
  /** Netgsm'de onayli gonderici basligi. */
  msgheader: string;
}

export function netgsmConfigFromEnv(env: Record<string, string | undefined>): NetgsmConfig {
  const read = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new NetgsmConfigError(name);
    return value;
  };
  return {
    usercode: read("NETGSM_USERCODE"),
    password: read("NETGSM_PASSWORD"),
    msgheader: read("NETGSM_MSGHEADER"),
  };
}

const TURKISH_ASCII: Record<string, string> = {
  ç: "c",
  Ç: "C",
  ğ: "g",
  Ğ: "G",
  ı: "i",
  İ: "I",
  ö: "o",
  Ö: "O",
  ş: "s",
  Ş: "S",
  ü: "u",
  Ü: "U",
};

/**
 * OTP ucu tek parca, Turkce karaktersiz (GSM 7-bit) mesaj bekler; karakter
 * donusumu burada yapilir ki cekirdekteki mesaj metni degismesin.
 */
export function toNetgsmOtpText(body: string): string {
  return body.replace(/[çÇğĞıİöÖşŞüÜ]/g, (char) => TURKISH_ASCII[char] ?? char).slice(0, 160);
}

/** "+905321234567" -> "5321234567"; yurt ici degilse `null`. */
export function toNetgsmNumber(e164: string): string | null {
  return /^\+90\d{10}$/.test(e164) ? e164.slice(3) : null;
}

export class NetgsmSmsSender implements SmsSender {
  constructor(
    private readonly config: NetgsmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<void> {
    const no = toNetgsmNumber(message.to);
    if (!no) throw new NetgsmSendError("unsupported_number");

    const auth = Buffer.from(`${this.config.usercode}:${this.config.password}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(NETGSM_OTP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
        body: JSON.stringify({
          msgheader: this.config.msgheader,
          msg: toNetgsmOtpText(message.body),
          no,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new NetgsmSendError(timedOut ? "timeout" : "network");
    }

    let payload: { code?: unknown } | null = null;
    try {
      payload = (await response.json()) as { code?: unknown };
    } catch {
      payload = null;
    }
    const code = typeof payload?.code === "string" ? payload.code : null;
    // SDK ile ayni: 200 ve 406 govdeli yanittir, basari yalnizca "00".
    if ((response.status === 200 || response.status === 406) && code === "00") return;
    throw new NetgsmSendError(code ?? `http_${response.status}`);
  }
}
