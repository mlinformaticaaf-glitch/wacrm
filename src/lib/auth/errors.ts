// ============================================================
// Supabase auth error → stable UI key.
//
// Supabase Auth returns raw English messages ("Invalid login
// credentials", "email rate limit exceeded", ...). Rendering
// `error.message` verbatim leaves users staring at untranslated
// text that often hides the actual fix (confirm the email, wait
// for the mailer limit, reset the password, ...).
//
// This maps the machine-readable `code` — and, as a fallback, the
// HTTP status / message — to a key the auth pages translate.
// Unknown errors keep their raw message so we never swallow a
// diagnostic that would help debugging.
// ============================================================

export type AuthErrorKey =
  | "invalidCredentials"
  | "emailNotConfirmed"
  | "emailAlreadyRegistered"
  | "emailRateLimit"
  | "tooManyRequests"
  | "invalidEmail"
  | "weakPassword"
  | "signupDisabled"
  | "unknown";

/** Minimal shape of a Supabase `AuthError` (kept structural so this module stays dependency-free). */
export interface AuthErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}

export function resolveAuthErrorKey(error: AuthErrorLike): AuthErrorKey {
  switch (error.code) {
    case "invalid_credentials":
      return "invalidCredentials";
    case "email_not_confirmed":
      return "emailNotConfirmed";
    case "user_already_exists":
    case "email_exists":
      return "emailAlreadyRegistered";
    case "over_email_send_rate_limit":
      return "emailRateLimit";
    case "over_request_rate_limit":
      return "tooManyRequests";
    case "email_address_invalid":
      return "invalidEmail";
    case "weak_password":
      return "weakPassword";
    case "signup_disabled":
      return "signupDisabled";
  }

  // Older auth-js versions / proxies sometimes drop `code` from
  // the response, so fall back to a case-insensitive message match
  // before giving up.
  const message = (error.message ?? "").toLowerCase();
  if (message.includes("invalid login credentials")) {
    return "invalidCredentials";
  }
  if (message.includes("email not confirmed")) {
    return "emailNotConfirmed";
  }
  if (message.includes("already registered") || message.includes("already exists")) {
    return "emailAlreadyRegistered";
  }
  if (message.includes("rate limit")) {
    return "emailRateLimit";
  }
  if (message.includes("invalid email")) {
    return "invalidEmail";
  }
  if (message.includes("password should be")) {
    return "weakPassword";
  }

  if (error.status === 429) {
    return "tooManyRequests";
  }

  return "unknown";
}
