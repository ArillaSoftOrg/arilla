import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDeliveryError } from "./delivery-error.ts";
import { sendTransactionalEmail } from "./send.ts";

describe("sendTransactionalEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends without any marketing consent, from EMAIL_FROM, with no unsubscribe header", async () => {
    vi.stubEnv("EMAIL_FROM", "ManiCepte <giris@example.test>");
    vi.stubEnv("MARKETING_EMAIL_MODE", "off");
    const sendMail = vi.fn().mockResolvedValue({});
    await sendTransactionalEmail(
      { to: "kisi@example.test", subject: "Giriş bağlantın", text: "t", html: "<p>t</p>" },
      { sendMail },
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      from: "ManiCepte <giris@example.test>",
      to: "kisi@example.test",
    });
    expect(message.headers).toBeUndefined();
    expect(message.text).not.toContain("ayrıl");
  });

  it("wraps provider failures without leaking the provider message", async () => {
    vi.stubEnv("EMAIL_FROM", "giris@example.test");
    const sendMail = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("kisi@example.test rejected"), { code: "EAUTH" }));
    const error = await sendTransactionalEmail(
      { to: "kisi@example.test", subject: "s", text: "t", html: "h" },
      { sendMail },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).code).toBe("EAUTH");
    expect((error as Error).message).not.toContain("kisi@example.test");
  });
});
