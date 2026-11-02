import { describe, expect, it } from "vitest";
import { resolveAuthErrorKey } from "./errors";

describe("resolveAuthErrorKey", () => {
  it.each([
    ["invalid_credentials", "invalidCredentials"],
    ["email_not_confirmed", "emailNotConfirmed"],
    ["user_already_exists", "emailAlreadyRegistered"],
    ["email_exists", "emailAlreadyRegistered"],
    ["over_email_send_rate_limit", "emailRateLimit"],
    ["over_request_rate_limit", "tooManyRequests"],
    ["email_address_invalid", "invalidEmail"],
    ["weak_password", "weakPassword"],
    ["signup_disabled", "signupDisabled"],
  ])("maps code %s to %s", (code, expected) => {
    expect(resolveAuthErrorKey({ code })).toBe(expected);
  });

  it("falls back to the message when the code is missing", () => {
    expect(
      resolveAuthErrorKey({ message: "Invalid login credentials" }),
    ).toBe("invalidCredentials");
    expect(resolveAuthErrorKey({ message: "Email not confirmed" })).toBe(
      "emailNotConfirmed",
    );
    expect(
      resolveAuthErrorKey({ message: "User already registered" }),
    ).toBe("emailAlreadyRegistered");
    expect(resolveAuthErrorKey({ message: "Email rate limit exceeded" })).toBe(
      "emailRateLimit",
    );
  });

  it("treats a bare 429 as a rate limit", () => {
    expect(resolveAuthErrorKey({ status: 429 })).toBe("tooManyRequests");
  });

  it("returns unknown for unrelated failures so the raw message can surface", () => {
    expect(resolveAuthErrorKey({ message: "Failed to fetch" })).toBe("unknown");
    expect(resolveAuthErrorKey({})).toBe("unknown");
  });
});
