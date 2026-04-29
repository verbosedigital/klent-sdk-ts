import type {
  CreateExecutionRequest,
  EvaluateActionRequest,
  EvaluateActionResponse,
  Execution,
  LogEventRequest,
  PendingAction,
} from '@argus/schema';
import { EventBuffer } from './event-buffer.js';

export interface ArgusClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Max events buffered before a flush. Default: 50. */
  maxBatchSize?: number;
  /** Max ms to wait before flushing a partial batch. Default: 2000. */
  flushIntervalMs?: number;
  /** Retries for transient failures (5xx / network). Default: 3. */
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://api.argus.dev/v1';

export class ArgusClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly eventBuffer: EventBuffer;

  constructor(options: ArgusClientOptions) {
    if (!options.apiKey) {
      throw new Error('ArgusClient: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? 3;

    this.eventBuffer = new EventBuffer({
      maxBatchSize: options.maxBatchSize ?? 50,
      flushIntervalMs: options.flushIntervalMs ?? 2000,
      flushFn: (batch) => this.sendEventBatch(batch),
    });
  }

  async startExecution(body: CreateExecutionRequest): Promise<Execution> {
    return this.request<Execution>('POST', '/executions', body);
  }

  logEvent(body: LogEventRequest): void {
    this.eventBuffer.enqueue(body);
  }

  async flush(): Promise<void> {
    await this.eventBuffer.flush();
  }

  async evaluateAction(body: EvaluateActionRequest): Promise<EvaluateActionResponse> {
    return this.request<EvaluateActionResponse>('POST', '/actions/evaluate', body);
  }

  /**
   * Read a pending action.
   *
   * Pass `waitMs` (≤ 30000) to long-poll: the call holds the connection until
   * the row is resolved or the budget elapses. Otherwise it's a single-shot
   * read. The HTTP retry loop is bypassed for long polls so timeouts don't
   * snowball.
   */
  async getPendingAction(id: string, options: { waitMs?: number } = {}): Promise<PendingAction> {
    const waitMs = options.waitMs ?? 0;
    if (waitMs > 0) {
      // Long polls bypass the retry/backoff loop — the wait *is* the budget.
      return this.requestNoRetry<PendingAction>('GET', `/pending_actions/${id}?wait_ms=${waitMs}`);
    }
    return this.request<PendingAction>('GET', `/pending_actions/${id}`);
  }

  /** Single-attempt request, no retry/backoff. Used for long-poll endpoints. */
  private async requestNoRetry<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Argus ${method} ${path}: ${res.status} ${text}`);
    }
    if (res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  }

  private async sendEventBatch(batch: LogEventRequest[]): Promise<void> {
    await Promise.all(batch.map((ev) => this.request<void>('POST', '/events', ev)));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const res = await this.fetchImpl(url, init);

        if (res.ok) {
          if (res.status === 204 || res.status === 202) return undefined as T;
          return (await res.json()) as T;
        }

        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error(`Argus ${method} ${path}: ${res.status}`);
        } else {
          const text = await res.text().catch(() => '');
          throw new Error(`Argus ${method} ${path}: ${res.status} ${text}`);
        }
      } catch (err) {
        lastErr = err;
      }

      attempt++;
      if (attempt > this.maxRetries) break;
      await sleep(backoffMs(attempt));
    }

    throw lastErr ?? new Error(`Argus ${method} ${path} failed`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  const jitter = Math.random() * 250;
  return base + jitter;
}
