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

const messageFromPayload = (payload: ErrorResponse | undefined, fallback: string) => {
  if (typeof payload?.detail === "string" && payload.detail.trim()) return payload.detail;
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  return fallback;
};

export const errorFromResponse = async (response: Response): Promise<FreeAstroError> => {
  let payload: ErrorResponse | undefined;
  try {
    payload = (await response.clone().json()) as ErrorResponse;
  } catch {
    payload = undefined;
  }

  const fallback = response.statusText || `FreeAstroAPI request failed with status ${response.status}`;
  const message = messageFromPayload(payload, fallback);
  const options: FreeAstroErrorOptions = {
    status: response.status,
    code: payload?.code,
    requestId: response.headers.get("x-request-id") ?? payload?.trace_id,
    details: payload,
  };

  if (response.status === 401) return new AuthenticationError(message, options);
  if (response.status === 403) return new PermissionError(message, options);
  if (response.status === 400 || response.status === 422) return new ValidationError(message, options);
  if (response.status === 409) return new ConflictError(message, options);
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? undefined : Number(retryAfterHeader);
    return new RateLimitError(message, {
      ...options,
      ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
    });
  }
  if (response.status >= 500) return new ServerError(message, options);
  return new FreeAstroError(message, options);
};
