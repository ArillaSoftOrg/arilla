/**
 * SMS gonderim soyutlamasi. Gercek saglayici (Netgsm, Twilio, ...) sonradan
 * `SMS_PROVIDER` ile baglanir; bu asamada yalnizca gelistirme gondericisi var.
 *
 * Production'da saglayici yoksa `SmsUnavailableError`: kod "gonderildi"
 * denip gonderilmemis bir SMS'e kullanici bekletilmez (fail-closed).
 */

export interface SmsMessage {
  /** E.164 */
  to: string;
  body: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

export class SmsUnavailableError extends Error {
  constructor(reason: string) {
    super(`sms gonderilemiyor: ${reason}`);
    this.name = "SmsUnavailableError";
  }
}

export class SmsDeliveryError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("sms teslim edilemedi", options);
    this.name = "SmsDeliveryError";
  }
}

/** "+905321234567" -> "+90532***4567": log satirinda tam numara olmaz. */
export function maskPhone(phone: string): string {
  return phone.length > 8 ? `${phone.slice(0, 6)}***${phone.slice(-4)}` : "***";
}

/**
 * Yalnizca gelistirme: mesaj konsola ve bellekteki kutuya yazilir. Numara
 * maskelenir. Production'da hic secilmez (`getSmsSender`).
 */
export class DevSmsSender implements SmsSender {
  readonly outbox: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<void> {
    this.outbox.push(message);
    console.info(`[sms:dev] ${maskPhone(message.to)} <- ${message.body}`);
  }
}

let devSender: DevSmsSender | null = null;

export function getSmsSender(env: Record<string, string | undefined> = process.env): SmsSender {
  const provider = env.SMS_PROVIDER?.trim().toLowerCase() || "";
  const isProduction = env.NODE_ENV === "production";

  if (provider === "dev" || (!provider && !isProduction)) {
    if (isProduction) throw new SmsUnavailableError("dev gondericisi production'da kapali");
    devSender ??= new DevSmsSender();
    return devSender;
  }
  if (!provider) throw new SmsUnavailableError("SMS_PROVIDER tanimli degil");
  throw new SmsUnavailableError(`bilinmeyen saglayici: ${provider}`);
}
