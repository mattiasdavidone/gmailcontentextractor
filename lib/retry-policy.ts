export type RetryDecision = {
  retryable: boolean;
  permanent: boolean;
  retryAfterSeconds?: number;
  reason: string;
};

function statusCode(error: unknown) {
  return Number(
    (error as any)?.status ??
      (error as any)?.statusCode ??
      (error as any)?.code ??
      (error as any)?.response?.status ??
      (error as any)?.response?.data?.error?.code ??
      0
  );
}

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function classifyProcessingError(error: unknown): RetryDecision {
  const status = statusCode(error);
  const text = message(error);

  if (
    status === 401 ||
    status === 403 &&
      (text.includes("insufficient permission") ||
        text.includes("invalid_grant") ||
        text.includes("token") ||
        text.includes("forbidden"))
  ) {
    return {
      retryable: false,
      permanent: true,
      reason: "google_authorization_or_permission",
    };
  }

  if (text.includes("invalid_grant") || text.includes("refresh token")) {
    return {
      retryable: false,
      permanent: true,
      reason: "google_refresh_token_invalid",
    };
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    text.includes("invalid json") ||
    text.includes("does not contain a from address") ||
    text.includes("no target google sheet")
  ) {
    return {
      retryable: false,
      permanent: true,
      reason: "permanent_input_or_configuration_error",
    };
  }

  if (status === 429) {
    return {
      retryable: true,
      permanent: false,
      retryAfterSeconds: 10,
      reason: "rate_limited",
    };
  }

  if (status >= 500 || status === 408) {
    return {
      retryable: true,
      permanent: false,
      retryAfterSeconds: 5,
      reason: "upstream_transient_error",
    };
  }

  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("fetch failed")
  ) {
    return {
      retryable: true,
      permanent: false,
      retryAfterSeconds: 5,
      reason: "network_transient_error",
    };
  }

  return {
    retryable: true,
    permanent: false,
    retryAfterSeconds: 5,
    reason: "unknown_error_safe_retry",
  };
}
