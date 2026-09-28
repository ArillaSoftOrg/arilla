import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppleConfigError,
  AppleIdTokenError,
  AppleOAuthError,
  appleConfigFromEnv,
  appleRedirectUri,
  buildAppleAuthorizeUrl,
  classifyAppleFailure,
  exchangeAppleCode,
} from "./apple-oauth.ts";
import { testAppleConfig } from "./apple-test-kit.ts";
import { classifyPhoneSendFailure } from "./phone-login.ts";
import { authProviderAvailability } from "./provider-availability.ts";
import { SmsDeliveryError, SmsUnavailableError } from "./sms.ts";
import { NetgsmSendError } from "./sms-netgsm.ts";

const config = testAppleConfig();
const appleEnv = {
  APPLE_CLIENT_ID: config.clientId,
  APPLE_TEAM_ID: config.teamId,
  APPLE_KEY_ID: config.keyId,
  APPLE_PRIVATE_KEY: config.privateKey,
};

describe("appleConfigFromEnv", () => {
  it("accepts a P-256 key, including one written with \\n escapes", () => {
    expect(appleConfigFromEnv(appleEnv).clientId).toBe(config.clientId);
    const oneLine = { ...appleEnv, APPLE_PRIVATE_KEY: config.privateKey.replace(/\n/g, "\\n") };
    expect(() => appleConfigFromEnv(oneLine)).not.toThrow();
  });

  it("names only the missing variable", () => {
    const { APPLE_KEY_ID: _unused, ...rest } = appleEnv;
    const error = (() => {
      try {
        appleConfigFromEnv(rest);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AppleConfigError);
    expect(classifyAppleFailure(error)).toBe("config_missing:APPLE_KEY_ID");
  });

  it("rejects a malformed or non-ES256 private key before any request", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    for (const bad of ["not-a-pem", rsa]) {
      const error = (() => {
        try {
          appleConfigFromEnv({ ...appleEnv, APPLE_PRIVATE_KEY: bad });
        } catch (e) {
          return e;
        }
      })();
      expect(classifyAppleFailure(error)).toBe("config_invalid:APPLE_PRIVATE_KEY");
      expect(String((error as Error).message)).not.toContain(bad.slice(0, 20));
    }
  });
});

describe("redirect URI and authorize URL", () => {
  it("uses one callback URI for authorize and token steps", async () => {
    const redirectUri = appleRedirectUri("https://manicepte.com/");
    expect(redirectUri).toBe("https://manicepte.com/giris/apple/callback");
    const url = new URL(
      buildAppleAuthorizeUrl({
        clientId: config.clientId,
        redirectUri,
        state: "s",
        nonceHash: "h",
      }),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.searchParams.get("scope")).toBe("name email");
    expect(url.searchParams.get("nonce")).toBe("h");

    const bodies: string[] = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ id_token: "x.y.z" });
    }) as typeof fetch;
    await exchangeAppleCode(config, { code: "c", redirectUri }, fake);
    const body = new URLSearchParams(bodies[0]);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_id")).toBe(config.clientId);
    // client_secret: ES256 JWT (header.payload.signature), secret değil anahtar değil.
    expect(body.get("client_secret")?.split(".")).toHaveLength(3);
  });
});

describe("token exchange failures are categorized", () => {
  it.each([
    [400, { error: "invalid_client" }, "token:http_400:invalid_client"],
    [400, { error: "invalid_grant" }, "token:http_400:invalid_grant"],
    [500, "<html>", "token:http_500:unknown"],
    [200, {}, "token:missing_id_token"],
  ])("HTTP %s -> %s", async (status, body, category) => {
    const fake = (async () =>
      typeof body === "string"
        ? new Response(body, { status })
        : Response.json(body, { status })) as unknown as typeof fetch;
    const error = await exchangeAppleCode(config, { code: "c", redirectUri: "r" }, fake).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AppleOAuthError);
    expect(classifyAppleFailure(error)).toBe(category);
  });

  it("maps id_token reasons to log-friendly names", () => {
    expect(classifyAppleFailure(new AppleIdTokenError("aud"))).toBe("id_token:audience");
    expect(classifyAppleFailure(new AppleIdTokenError("bilinmeyen kid"))).toBe(
      "id_token:unknown_kid",
    );
    expect(classifyAppleFailure(new AppleIdTokenError("nonce"))).toBe("id_token:nonce");
  });
});

describe("provider availability", () => {
  it("reports each provider from configuration only", () => {
    expect(authProviderAvailability({ NODE_ENV: "production" })).toEqual({
      google: false,
      apple: false,
      phone: false,
    });
    expect(
      authProviderAvailability({
        NODE_ENV: "production",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        ...appleEnv,
        SMS_PROVIDER: "netgsm",
        NETGSM_USERCODE: "8500000000",
        NETGSM_PASSWORD: "p",
        NETGSM_MSGHEADER: "MANICEPTE",
      }),
    ).toEqual({ google: true, apple: true, phone: true });
  });

  it("treats an invalid Apple key and partial Netgsm config as unavailable", () => {
    const status = authProviderAvailability({
      NODE_ENV: "production",
      ...appleEnv,
      APPLE_PRIVATE_KEY: "broken",
      SMS_PROVIDER: "netgsm",
      NETGSM_USERCODE: "8500000000",
    });
    expect(status.apple).toBe(false);
    expect(status.phone).toBe(false);
  });

  it("keeps the development SMS sender available locally", () => {
    expect(authProviderAvailability({ NODE_ENV: "development" }).phone).toBe(true);
  });
});

describe("classifyPhoneSendFailure", () => {
  it("never includes the number, code or message", () => {
    expect(
      classifyPhoneSendFailure(new SmsDeliveryError({ cause: new NetgsmSendError("30") })),
    ).toBe("sms:netgsm:30");
    expect(
      classifyPhoneSendFailure(new SmsDeliveryError({ cause: new NetgsmSendError("timeout") })),
    ).toBe("sms:netgsm:timeout");
    expect(classifyPhoneSendFailure(new SmsUnavailableError("SMS_PROVIDER tanimli degil"))).toBe(
      "sms_unavailable",
    );
    expect(classifyPhoneSendFailure(new Error("+905321234567 kod 123456"))).toBe(
      "unexpected:Error",
    );
  });
});
