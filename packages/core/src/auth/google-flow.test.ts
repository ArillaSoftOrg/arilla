import { describe, expect, it } from "vitest";
import {
  buildGoogleAuthorizeUrl,
  classifyGoogleFailure,
  exchangeGoogleCode,
  fetchGoogleProfile,
  GOOGLE_TOKEN_URL,
  GoogleOAuthError,
  googleConfigFromEnv,
  googleRedirectUri,
} from "./google-flow.ts";
import { GoogleEmailNotVerifiedError } from "./google-oauth.ts";

const config = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "test-secret" };

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

describe("redirect_uri", () => {
  it("authorize and token steps use the identical callback URI", async () => {
    const redirectUri = googleRedirectUri("https://manicepte.com");
    expect(redirectUri).toBe("https://manicepte.com/giris/google/callback");
    // APP_URL sonunda eğik çizgi olsa da çift çizgi üretilmez.
    expect(googleRedirectUri("https://manicepte.com/")).toBe(redirectUri);

    const authorize = new URL(
      buildGoogleAuthorizeUrl({ clientId: config.clientId, redirectUri, state: "s1" }),
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorize.searchParams.get("state")).toBe("s1");
    expect(authorize.searchParams.get("scope")).toBe("openid email profile");

    const { impl, calls } = fakeFetch(() => Response.json({ access_token: "at" }));
    await exchangeGoogleCode(config, { code: "c1", redirectUri }, impl);
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(calls[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(body.get("redirect_uri")).toBe(redirectUri);
    expect(body.get("client_id")).toBe(config.clientId);
    expect(body.get("grant_type")).toBe("authorization_code");
  });
});

describe("config", () => {
  it("names only the missing variable", () => {
    expect(() => googleConfigFromEnv({ GOOGLE_CLIENT_ID: "id" })).toThrow(
      "config_missing:GOOGLE_CLIENT_SECRET",
    );
    expect(() => googleConfigFromEnv({})).toThrow("config_missing:GOOGLE_CLIENT_ID");
    expect(googleConfigFromEnv({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " s " })).toEqual({
      clientId: "id",
      clientSecret: "s",
    });
  });
});

describe("token exchange failures are categorized without secrets", () => {
  it.each([
    [401, { error: "invalid_client" }, "token:http_401:invalid_client"],
    [400, { error: "redirect_uri_mismatch" }, "token:http_400:redirect_uri_mismatch"],
    [400, { error: "invalid_grant" }, "token:http_400:invalid_grant"],
    [500, { error: "Some <b>html</b>" }, "token:http_500:unknown"],
  ])("HTTP %s -> %s", async (status, body, category) => {
    const { impl } = fakeFetch(() => Response.json(body, { status }));
    const error = await exchangeGoogleCode(config, { code: "c", redirectUri: "r" }, impl).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(error.category).toBe(category);
    expect(error.message).not.toContain(config.clientSecret);
  });

  it("missing access token and network errors", async () => {
    const empty = fakeFetch(() => Response.json({}));
    await expect(
      exchangeGoogleCode(config, { code: "c", redirectUri: "r" }, empty.impl),
    ).rejects.toMatchObject({ category: "token:missing_access_token" });

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      exchangeGoogleCode(config, { code: "c", redirectUri: "r" }, down),
    ).rejects.toMatchObject({ category: "token:network" });
  });
});

describe("userinfo", () => {
  it("parses the verified profile", async () => {
    const { impl, calls } = fakeFetch(() =>
      Response.json({ sub: "1", email: "A@B.test", email_verified: true, name: "Ada" }),
    );
    const profile = await fetchGoogleProfile("at", impl);
    expect(profile).toEqual({
      sub: "1",
      email: "A@B.test",
      emailVerified: true,
      name: "Ada",
      picture: null,
    });
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer at");
  });

  it("treats a missing or false email_verified as unverified", async () => {
    const { impl } = fakeFetch(() => Response.json({ sub: "1", email: "a@b.test" }));
    expect((await fetchGoogleProfile("at", impl)).emailVerified).toBe(false);
  });

  it("categorizes HTTP and shape failures", async () => {
    const failing = fakeFetch(() => new Response("no", { status: 401 }));
    await expect(fetchGoogleProfile("at", failing.impl)).rejects.toMatchObject({
      category: "userinfo:http_401",
    });
    const partial = fakeFetch(() => Response.json({ sub: "1" }));
    await expect(fetchGoogleProfile("at", partial.impl)).rejects.toMatchObject({
      category: "userinfo:missing_identity",
    });
  });
});

describe("classifyGoogleFailure", () => {
  it("maps known failures to safe categories", () => {
    expect(classifyGoogleFailure(new GoogleOAuthError("token:http_401:invalid_client"))).toBe(
      "token:http_401:invalid_client",
    );
    expect(classifyGoogleFailure(new GoogleEmailNotVerifiedError())).toBe("email_unverified");
  });

  it("names the missing table for an unapplied migration (production root cause)", () => {
    const pg = Object.assign(new Error('relation "user_identity" does not exist'), {
      code: "42P01",
    });
    expect(classifyGoogleFailure(new Error("Failed query", { cause: pg }))).toBe(
      "db:42P01:user_identity",
    );
    expect(classifyGoogleFailure(Object.assign(new Error("dup"), { code: "23505" }))).toBe(
      "db:23505",
    );
  });

  it("never echoes the error message for unknown failures", () => {
    expect(classifyGoogleFailure(new Error("user@example.test secret-token"))).toBe(
      "unexpected:Error",
    );
    expect(classifyGoogleFailure("boom")).toBe("unexpected:unknown");
  });
});
