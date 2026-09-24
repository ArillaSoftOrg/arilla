import { describe, expect, it } from "vitest";
import { EmailDeliveryError, toEmailDeliveryError } from "./delivery-error.ts";
import { SmtpConfigError } from "./transport.ts";

describe("toEmailDeliveryError", () => {
  it("maps config errors to ECONFIG", () => {
    expect(toEmailDeliveryError(new SmtpConfigError("x")).code).toBe("ECONFIG");
  });

  it("keeps nodemailer codes and drops the original message", () => {
    const original = Object.assign(new Error("550 rejected: someone@example.com"), {
      code: "EENVELOPE",
    });
    const wrapped = toEmailDeliveryError(original);
    expect(wrapped).toBeInstanceOf(EmailDeliveryError);
    expect(wrapped.code).toBe("EENVELOPE");
    expect(wrapped.message).not.toContain("someone@example.com");
    expect(wrapped.cause).toBe(original);
  });

  it("falls back to EUNKNOWN", () => {
    expect(toEmailDeliveryError("boom").code).toBe("EUNKNOWN");
  });
});
