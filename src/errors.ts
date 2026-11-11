import type { ErrorResponse } from "./types";

export interface FreeAstroErrorOptions {
  status?: number | undefined;
  code?: string | undefined;
  requestId?: string | undefined;
  details?: unknown;
  cause?: unknown;
}

export class FreeAstroError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "FreeAstroError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export class AuthenticationError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

export class PermissionError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "PermissionError";
  }
}

export class ValidationError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "ValidationError";
  }
}

export class ConflictError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends FreeAstroError {
  /** Seconds to wait before retrying, from `Retry-After` or the body's `retry_after_ms`. */
  readonly retryAfter: number | undefined;

  constructor(message: string, options: FreeAstroErrorOptions & { retryAfter?: number | undefined } = {}) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfter = options.retryAfter;
  }
}

export class ServerError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "ServerError";
  }
}

export class NetworkError extends FreeAstroError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends NetworkError {
  constructor(message: string, options: FreeAstroErrorOptions = {}) {
    super(message, options);
    this.name = "TimeoutError";
  }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// Route errors carry `detail` (a message, or an object with `error` and `message`), gateway
// errors a top-level `error` code, and 422 validation errors a `detail` array.
const messageFromPayload = (payload: ErrorResponse | undefined, fallback: string) => {
  const detail = payload?.detail;
  const firstIssue = Array.isArray(detail) ? record(detail[0]) : undefined;
  return (
    text(detail) ??
    text(record(detail)?.message) ??
    text(firstIssue?.msg) ??
    text(payload?.message) ??
    text(payload?.error) ??
    fallback
  );
};

const codeFromPayload = (payload: ErrorResponse | undefined) =>
  text(payload?.code) ?? text(record(payload?.detail)?.error) ?? text(payload?.error);

const retryAfterSeconds = (value: string | null) => {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, (dateMs - Date.now()) / 1_000);
};

export const errorFromResponse = async (response: Response): Promise<FreeAstroError> => {
  let payload: ErrorResponse | undefined;
  try {
    payload = record(await response.clone().json()) as ErrorResponse | undefined;
  } catch {
    payload = undefined;
  }

  const fallback = response.statusText || `FreeAstroAPI request failed with status ${response.status}`;
  const message = messageFromPayload(payload, fallback);
  const options: FreeAstroErrorOptions = {
    status: response.status,
    code: codeFromPayload(payload),
    requestId: response.headers.get("x-request-id") ?? text(payload?.trace_id),
    details: payload,
  };

  if (response.status === 401) return new AuthenticationError(message, options);
  if (response.status === 403) return new PermissionError(message, options);
  if (response.status === 400 || response.status === 422) return new ValidationError(message, options);
  if (response.status === 409) return new ConflictError(message, options);
  if (response.status === 429) {
    const retryAfterMs = typeof payload?.retry_after_ms === "number" ? payload.retry_after_ms : undefined;
    const retryAfter =
      retryAfterSeconds(response.headers.get("retry-after")) ??
      (retryAfterMs !== undefined && retryAfterMs >= 0 ? retryAfterMs / 1_000 : undefined);
    return new RateLimitError(message, {
      ...options,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    });
  }
  if (response.status >= 500) return new ServerError(message, options);
  return new FreeAstroError(message, options);
};
