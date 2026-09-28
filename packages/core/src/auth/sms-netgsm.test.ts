import { describe, expect, it } from "vitest";
import { getSmsSender, SmsUnavailableError } from "./sms.ts";
import {
  NETGSM_OTP_URL,
  NetgsmSendError,
  NetgsmSmsSender,
  toNetgsmNumber,
  toNetgsmOtpText,
} from "./sms-netgsm.ts";

const config = { usercode: "8500000000", password: "test-only-password", msgheader: "ARILLA" };
const message = { to: "+905321234567", body: "Arilla giriş kodun: 123456. Kimseyle paylaşma." };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

describe("NetgsmSmsSender", () => {
  it("posts the OTP request with basic auth and a national number", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ code: "00", jobId: "1" }));
    await new NetgsmSmsSender(config, impl).send(message);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(NETGSM_OTP_URL);
    expect(call?.init.method).toBe("POST");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${config.usercode}:${config.password}`).toString("base64")}`,
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      msgheader: "ARILLA",
      msg: "Arilla giris kodun: 123456. Kimseyle paylasma.",
      no: "5321234567",
    });
  });

  it("treats any provider code other than 00 as a failure without leaking secrets", async () => {
    const { impl } = fakeFetch(() => Response.json({ code: "30" }, { status: 406 }));
    const error = await new NetgsmSmsSender(config, impl).send(message).catch((e) => e);
    expect(error).toBeInstanceOf(NetgsmSendError);
    expect(error.code).toBe("30");
    expect(error.message).not.toContain(config.password);
    expect(error.message).not.toContain("5321234567");
  });

  it("fails on HTTP errors and unparsable bodies", async () => {
    const { impl } = fakeFetch(() => new Response("oops", { status: 500 }));
    const error = await new NetgsmSmsSender(config, impl).send(message).catch((e) => e);
    expect(error).toBeInstanceOf(NetgsmSendError);
    expect(error.code).toBe("http_500");
  });

  it("fails on network errors", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await new NetgsmSmsSender(config, impl).send(message).catch((e) => e);
    expect(error).toBeInstanceOf(NetgsmSendError);
    expect(error.code).toBe("network");
  });

  it("never calls the provider for a non-Turkish number", async () => {
    const { impl, calls } = fakeFetch(() => Response.json({ code: "00" }));
    const error = await new NetgsmSmsSender(config, impl)
      .send({ ...message, to: "+442079460958" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NetgsmSendError);
    expect(calls).toHaveLength(0);
  });
});

describe("netgsm helpers", () => {
  it("maps E.164 to the national format", () => {
    expect(toNetgsmNumber("+905321234567")).toBe("5321234567");
    expect(toNetgsmNumber("+4420794609")).toBeNull();
  });

  it("keeps OTP text single-part and GSM friendly", () => {
    expect(toNetgsmOtpText("Çığ öşü İĞÜ")).toBe("Cig osu IGU");
    expect(toNetgsmOtpText("x".repeat(200))).toHaveLength(160);
  });
});

describe("getSmsSender with netgsm", () => {
  it("selects the netgsm adapter when fully configured", () => {
    const sender = getSmsSender({
      NODE_ENV: "production",
      SMS_PROVIDER: "netgsm",
      NETGSM_USERCODE: config.usercode,
      NETGSM_PASSWORD: config.password,
      NETGSM_MSGHEADER: config.msgheader,
    });
    expect(sender).toBeInstanceOf(NetgsmSmsSender);
  });

  it("fails closed and names only the missing variable", () => {
    const attempt = () =>
      getSmsSender({
        NODE_ENV: "production",
        SMS_PROVIDER: "netgsm",
        NETGSM_USERCODE: config.usercode,
        NETGSM_PASSWORD: config.password,
      });
    expect(attempt).toThrow(SmsUnavailableError);
    expect(attempt).toThrow(/NETGSM_MSGHEADER/);
    expect(attempt).not.toThrow(new RegExp(config.password));
  });
});
