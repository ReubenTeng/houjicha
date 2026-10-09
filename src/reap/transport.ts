import { parseJsonPreservingNumbers } from "./money.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 450;
const PROVIDER_CODE = /^[A-Z0-9_]{1,100}$/;

export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  reapVersion: string;
  fetchImpl: typeof globalThis.fetch;
  bypassThrottle: boolean;
  minIntervalMs?: number;
  timeoutMs?: number;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, providerCode: string | null, retryAfterSeconds: number | null) {
    super(`Provider returned status ${status}.`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.providerCode = providerCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TransportFailure extends Error {
  readonly kind: "network" | "timeout" | "redirect";

  constructor(kind: "network" | "timeout" | "redirect") {
    super(kind === "timeout" ? "Provider request timed out." : "Provider request failed.");
    this.name = "TransportFailure";
    this.kind = kind;
  }
}

export class MalformedResponseError extends Error {
  constructor() {
    super("Provider returned a malformed response.");
    this.name = "MalformedResponseError";
  }
}

export interface TransportRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  simulateCheckout?: boolean;
}

export function providerPath(...segments: string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function sanitizeProviderCode(value: unknown): string | null {
  if (typeof value === "string" && PROVIDER_CODE.test(value)) {
    return value.slice(0, 100);
  }
  return null;
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds <= 86400 ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) {
    return null;
  }
  const seconds = Math.ceil((at - Date.now()) / 1000);
  return seconds >= 0 && seconds <= 86400 ? seconds : null;
}

export class ReapTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly reapVersion: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly bypassThrottle: boolean;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private chain: Promise<void> = Promise.resolve();
  private notBefore = 0;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.reapVersion = options.reapVersion;
    this.fetchImpl = options.fetchImpl;
    this.bypassThrottle = options.bypassThrottle;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private throttle(): Promise<void> {
    if (this.bypassThrottle) {
      return Promise.resolve();
    }
    const run = this.chain.then(async () => {
      const wait = this.notBefore - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.notBefore = Date.now() + this.minIntervalMs;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private honorRetryAfter(retryAfterSeconds: number | null): void {
    if (retryAfterSeconds !== null) {
      this.notBefore = Math.max(this.notBefore, Date.now() + retryAfterSeconds * 1000);
    }
  }

  async request(request: TransportRequest): Promise<{ status: number; data: unknown }> {
    await this.throttle();
    const url = new URL(this.baseUrl + request.path);
    if (request.query !== undefined) {
      for (const [key, value] of Object.entries(request.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Reap-Version": this.reapVersion,
    };
    if (request.method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    if (request.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = request.idempotencyKey;
    }
    if (request.simulateCheckout === true) {
      headers["X-Simulate-Checkout"] = "COMPLETED";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TransportFailure("timeout")), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof TransportFailure) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TransportFailure("timeout");
      }
      if (error instanceof TypeError && /redirect/i.test(error.message)) {
        throw new TransportFailure("redirect");
      }
      throw new TransportFailure("network");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      throw new TransportFailure(controller.signal.aborted ? "timeout" : "network");
    }
    clearTimeout(timer);
    let data: unknown;
    try {
      data = parseJsonPreservingNumbers(text);
    } catch {
      data = undefined;
    }
    if (response.status >= 200 && response.status < 300) {
      if (data === undefined || typeof data !== "object" || data === null) {
        throw new MalformedResponseError();
      }
      return { status: response.status, data };
    }
    let providerCode: string | null = null;
    if (typeof data === "object" && data !== null) {
      const errorObject = (data as Record<string, unknown>).error;
      if (typeof errorObject === "object" && errorObject !== null) {
        providerCode = sanitizeProviderCode((errorObject as Record<string, unknown>).code);
      }
    }
    const retryAfter = parseRetryAfter(response.headers);
    this.honorRetryAfter(retryAfter);
    throw new ProviderHttpError(response.status, providerCode, retryAfter);
  }
}
