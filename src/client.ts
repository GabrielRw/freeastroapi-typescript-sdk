import { NetworkError, TimeoutError, errorFromResponse } from "./errors";
import type { Query, QueryValue } from "./types";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  statuses: readonly number[];
}

export interface FreeAstroOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: false | Partial<RetryOptions>;
  fetch?: Fetch;
  headers?: HeadersInit;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: HeadersInit;
  idempotencyKey?: string;
  timeoutMs?: number;
  retry?: boolean | Partial<RetryOptions>;
  signal?: AbortSignal;
}

export type EndpointRequestOptions = Omit<RequestOptions, "query" | "body">;

export interface RawResponse<T> {
  data: T;
  response: Response;
}

const DEFAULT_BASE_URL = "https://api.freeastroapi.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY: RetryOptions = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  statuses: [408, 429, 500, 502, 503, 504],
};

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

const retryAfterMs = (response: Response) => {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
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

const parseResponse = async <T>(response: Response): Promise<T> => {
  if (response.status === 204) return undefined as T;
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
    this.retry = options.retry === false ? false : { ...DEFAULT_RETRY, ...options.retry };
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!this.fetch) throw new TypeError("A fetch implementation is required in this runtime");
    this.headers = new Headers(options.headers);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(method, path, options)).data;
  }

  async requestRaw<T>(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse<T>> {
    const normalizedMethod = method.toUpperCase();
    const retryConfig = this.resolveRetry(normalizedMethod, options);
    let attempt = 0;

    while (true) {
      const abort = createSignal(options.timeoutMs ?? this.timeoutMs, options.signal);
      try {
        const headers = new Headers(this.headers);
        new Headers(options.headers).forEach((value, key) => headers.set(key, value));
        headers.set("accept", "application/json");
        headers.set("x-api-key", this.apiKey);
        if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
        if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");

        const response = await this.fetch(buildUrl(this.baseUrl, path, options.query), {
          method: normalizedMethod,
          headers,
          signal: abort.signal,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });

        if (response.ok) {
          return { data: await parseResponse<T>(response), response };
        }

        if (retryConfig && retryConfig.statuses.includes(response.status) && attempt < retryConfig.retries) {
          const delay = Math.min(
            retryAfterMs(response) ?? retryConfig.baseDelayMs * 2 ** attempt,
            retryConfig.maxDelayMs,
          );
          attempt += 1;
          abort.cleanup();
          await sleep(delay, options.signal);
          continue;
        }

        throw await errorFromResponse(response);
      } catch (error) {
        if (error instanceof Error && error.name.endsWith("Error") && "status" in error) throw error;
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (abort.timedOut()) {
          if (retryConfig && attempt < retryConfig.retries) {
            const delay = Math.min(retryConfig.baseDelayMs * 2 ** attempt, retryConfig.maxDelayMs);
            attempt += 1;
            abort.cleanup();
            await sleep(delay, options.signal);
            continue;
          }
          throw new TimeoutError(`FreeAstroAPI request timed out after ${options.timeoutMs ?? this.timeoutMs}ms`, { cause: error });
        }
        if (retryConfig && attempt < retryConfig.retries) {
          const delay = Math.min(retryConfig.baseDelayMs * 2 ** attempt, retryConfig.maxDelayMs);
          attempt += 1;
          abort.cleanup();
          await sleep(delay, options.signal);
          continue;
        }
        throw new NetworkError("Unable to reach FreeAstroAPI", { cause: error });
      } finally {
        abort.cleanup();
      }
    }
  }

  private resolveRetry(method: string, options: RequestOptions): false | RetryOptions {
    if (this.retry === false || options.retry === false) return false;
    const explicitlyEnabled = options.retry === true || typeof options.retry === "object";
    const replaySafe = IDEMPOTENT_METHODS.has(method) || Boolean(options.idempotencyKey);
    if (!explicitlyEnabled && !replaySafe) return false;
    return typeof options.retry === "object" ? { ...this.retry, ...options.retry } : this.retry;
  }
}
