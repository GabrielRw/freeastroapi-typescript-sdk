import { FreeAstroError, NetworkError, RateLimitError, TimeoutError, errorFromResponse } from "./errors";
import { OPERATIONS, SIDE_EFFECTING_OPERATIONS, type OperationInfo } from "./generated/resources";
import type { Query, QueryValue } from "./types";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  maxRetries: number;
  /** @deprecated Use `maxRetries`. */
  retries?: number;
  /** First backoff delay; it doubles on each retry, with full jitter. Default 500 ms. */
  baseDelayMs: number;
  /** Cap on a single backoff delay. Default 8 s. */
  maxDelayMs: number;
  /**
   * Longest `Retry-After` (or `retry_after_ms`) a 429 is retried after. A longer wait raises
   * `RateLimitError` straight away with `retryAfter` set. Default 30 s.
   */
  maxRetryAfterMs: number;
  /** Transient statuses, besides 429, that are retried. Default 408, 500, 502, 503, 504. */
  statuses: readonly number[];
}

export interface FreeAstroOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Client-wide retry settings, or `false` to never retry. */
  retry?: false | Partial<RetryOptions>;
  fetch?: Fetch;
  headers?: HeadersInit;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: HeadersInit;
  /** Sent as `Idempotency-Key`; makes transient failures of side-effecting operations retryable. */
  idempotencyKey?: string;
  timeoutMs?: number;
  /**
   * `false` disables retries for this request. `true` (or an object, which also overrides
   * settings) opts a side-effecting operation into retries of transient failures.
   */
  retry?: boolean | Partial<RetryOptions>;
  signal?: AbortSignal;
  /** `Accept` header to send. Defaults to `application/json`. */
  accept?: string;
  /**
   * How to read a successful body: `auto` (default) parses JSON content types and returns
   * other bodies as text, `text` always returns a string and `bytes` returns a `Uint8Array`.
   */
  responseType?: ResponseType;
}

export type ResponseType = "auto" | "text" | "bytes";

export type EndpointRequestOptions = Omit<RequestOptions, "query" | "body">;

export interface RawResponse<T> {
  data: T;
  response: Response;
}

const DEFAULT_BASE_URL = "https://api.freeastroapi.com";
const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRY: Readonly<RetryOptions> = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  statuses: [408, 500, 502, 503, 504],
};

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const routePattern = (path: string) =>
  new RegExp(`^${path.split(/\{[^}]+\}/).map(escapeRegExp).join("[^/]+")}$`);
const ROUTES = OPERATIONS.map((op) => ({ op, pattern: routePattern(op.path) }));

/** The spec operation a request targets, if any. */
const operationFor = (method: string, path: string): OperationInfo | undefined => {
  const pathname = path.split(/[?#]/)[0]!;
  return ROUTES.find(({ op, pattern }) => op.method === method && pattern.test(pathname))?.op;
};

/**
 * Whether a transient failure (408, 5xx, network error, timeout) may be retried without an
 * idempotency key. Requests outside the spec are treated as side-effecting unless their
 * method is GET, HEAD or OPTIONS.
 */
const replaySafe = (method: string, path: string) => {
  const op = operationFor(method, path);
  return op ? !SIDE_EFFECTING_OPERATIONS.has(op.operationId) : IDEMPOTENT_METHODS.has(method);
};

/** Full-jitter exponential backoff: a random delay up to `base * 2^attempt`, capped. */
const backoffMs = (config: RetryOptions, attempt: number) =>
  Math.random() * Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);

const buildUrl = (baseUrl: string, path: string, query?: Query) => {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  if (!query) return url;

  for (const [key, value] of Object.entries(query) as [string, QueryValue][]) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
};

const sleep = (delayMs: number, signal?: AbortSignal) => {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const parseResponse = async <T>(response: Response, responseType: ResponseType = "auto"): Promise<T> => {
  if (response.status === 204) return undefined as T;
  if (responseType === "bytes") return new Uint8Array(await response.arrayBuffer()) as T;
  if (responseType === "text") return (await response.text()) as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return (await response.json()) as T;
  }
  return (await response.text()) as T;
};

const createSignal = (timeoutMs: number, signal?: AbortSignal) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: false | RetryOptions;
  private readonly fetch: Fetch;
  private readonly headers: Headers;

  constructor(options: FreeAstroOptions) {
    if (!options.apiKey?.trim()) throw new TypeError("apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry === false ? false : mergeRetry(DEFAULT_RETRY, options.retry);
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetch) throw new TypeError("A fetch implementation is required in this runtime");
    this.headers = new Headers(options.headers);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(method, path, options)).data;
  }

  async requestRaw<T>(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse<T>> {
    const normalizedMethod = method.toUpperCase();
    const retry = this.resolveRetry(normalizedMethod, path, options);
    let attempt = 0;
    const canRetry = (transient: boolean) =>
      retry !== false && attempt < retry.config.maxRetries && (!transient || retry.transient);
    const wait = async (delayMs: number) => {
      attempt += 1;
      await sleep(delayMs, options.signal);
    };

    while (true) {
      const abort = createSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
      let response: Response;
      try {
        const headers = new Headers(this.headers);
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
        headers.set("accept", options.accept ?? "application/json");
        headers.set("x-api-key", this.apiKey);
        if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
        if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

        response = await this.fetch(buildUrl(this.baseUrl, path, options.query), {
          method: normalizedMethod,
          headers,
          signal: abort.signal,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
        // The body is read under the same deadline as the request.
        if (response.ok) return { data: await parseResponse<T>(response, options.responseType), response };
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof SyntaxError) {
          throw new FreeAstroError("FreeAstroAPI returned a response that is not valid JSON", { cause: error });
        }
        const timedOut = abort.timedOut();
        abort.cleanup();
        if (retry !== false && canRetry(true)) {
          await wait(backoffMs(retry.config, attempt));
          continue;
        }
        if (timedOut) {
          throw new TimeoutError(`FreeAstroAPI request timed out after ${options.timeoutMs ?? this.timeoutMs}ms`, { cause: error });
        }
        throw new NetworkError("Unable to reach FreeAstroAPI", { cause: error });
      } finally {
        abort.cleanup();
      }

      const error = await errorFromResponse(response);
      if (retry !== false && error instanceof RateLimitError) {
        const delayMs = error.retryAfter !== undefined ? error.retryAfter * 1_000 : backoffMs(retry.config, attempt);
        if (delayMs <= retry.config.maxRetryAfterMs && canRetry(false)) {
          await wait(delayMs);
          continue;
        }
      } else if (retry !== false && retry.config.statuses.includes(response.status) && canRetry(true)) {
        await wait(backoffMs(retry.config, attempt));
        continue;
      }
      throw error;
    }
  }

  /**
   * Retry settings for one request. 429 is retried for every operation; transient failures
   * only when the operation is replay-safe, an idempotency key is sent, or the caller opted in.
   */
  private resolveRetry(method: string, path: string, options: RequestOptions): false | { config: RetryOptions; transient: boolean } {
    if (this.retry === false || options.retry === false) return false;
    const optedIn = options.retry === true || typeof options.retry === "object";
    const config = typeof options.retry === "object" ? mergeRetry(this.retry, options.retry) : this.retry;
    return { config, transient: optedIn || Boolean(options.idempotencyKey) || replaySafe(method, path) };
  }
}

const mergeRetry = (base: RetryOptions, override: Partial<RetryOptions> | undefined): RetryOptions => {
  const merged = { ...base, ...override };
  if (override?.maxRetries === undefined && override?.retries !== undefined) merged.maxRetries = override.retries;
  return merged;
};
