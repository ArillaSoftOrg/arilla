import { describe, expect, it } from "vitest";
import {
  checkCronAuthorization,
  cronAuthFailureResponse,
  isCronRequestAuthorized,
  MIN_CRON_SECRET_LENGTH,
} from "./cron-auth.ts";

const SECRET = "s3cr3t-value-for-tests-0123456789";

describe("checkCronAuthorization", () => {
  it("refuses when the secret is missing", () => {
    expect(checkCronAuthorization(`Bearer ${SECRET}`, undefined)).toBe("misconfigured");
    expect(checkCronAuthorization(`Bearer ${SECRET}`, null)).toBe("misconfigured");
    // The old check let this through when CRON_SECRET was unset.
    expect(checkCronAuthorization("Bearer undefined", undefined)).toBe("misconfigured");
  });

  it("refuses when the secret is empty or whitespace", () => {
    expect(checkCronAuthorization("Bearer ", "")).toBe("misconfigured");
    expect(checkCronAuthorization("Bearer                  ", " ".repeat(20))).toBe(
      "misconfigured",
    );
  });

  it("refuses when the secret is too short", () => {
    const short = "a".repeat(MIN_CRON_SECRET_LENGTH - 1);
    expect(checkCronAuthorization(`Bearer ${short}`, short)).toBe("misconfigured");
    const exact = "a".repeat(MIN_CRON_SECRET_LENGTH);
    expect(checkCronAuthorization(`Bearer ${exact}`, exact)).toBe("authorized");
  });

  it("rejects a missing header", () => {
    expect(checkCronAuthorization(null, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(undefined, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization("", SECRET)).toBe("unauthorized");
  });

  it("rejects a wrong scheme", () => {
    expect(checkCronAuthorization(SECRET, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(`Basic ${SECRET}`, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(`bearer ${SECRET}`, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(`Bearer${SECRET}`, SECRET)).toBe("unauthorized");
  });

  it("rejects a wrong secret", () => {
    expect(checkCronAuthorization(`Bearer ${SECRET}x`, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization("Bearer undefined", SECRET)).toBe("unauthorized");
  });

  it("rejects surrounding whitespace in the token", () => {
    expect(checkCronAuthorization(`Bearer  ${SECRET}`, SECRET)).toBe("unauthorized");
    expect(checkCronAuthorization(`Bearer ${SECRET} `, SECRET)).toBe("unauthorized");
  });

  it("tolerates a trailing newline in the configured secret", () => {
    expect(checkCronAuthorization(`Bearer ${SECRET}`, `${SECRET}\n`)).toBe("authorized");
  });

  it("accepts the correct secret", () => {
    expect(checkCronAuthorization(`Bearer ${SECRET}`, SECRET)).toBe("authorized");
    expect(isCronRequestAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isCronRequestAuthorized(`Bearer nope`, SECRET)).toBe(false);
  });
});

describe("cronAuthFailureResponse", () => {
  it("returns null when authorized", () => {
    expect(cronAuthFailureResponse(`Bearer ${SECRET}`, SECRET)).toBeNull();
  });

  it("returns 401 without echoing the secret or header", async () => {
    const response = cronAuthFailureResponse(`Bearer wrong-${SECRET}`, SECRET);
    expect(response?.status).toBe(401);
    const body = await response?.text();
    expect(body).toBe("Unauthorized");
    expect(body).not.toContain(SECRET);
  });

  it("returns 500 when misconfigured, without leaking details", async () => {
    const response = cronAuthFailureResponse("Bearer undefined", undefined);
    expect(response?.status).toBe(500);
    expect(await response?.text()).toBe("Server misconfigured");
  });
});
