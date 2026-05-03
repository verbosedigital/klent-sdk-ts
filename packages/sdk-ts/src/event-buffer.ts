import type { LogEventRequest } from '@klent/schema';

export type FlushFn = (events: LogEventRequest[]) => Promise<void>;

export interface EventBufferOptions {
  flushFn: FlushFn;
  maxBatchSize: number;
  flushIntervalMs: number;
}

export class EventBuffer {
  private readonly opts: EventBufferOptions;
  private readonly buffer: LogEventRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(opts: EventBufferOptions) {
    this.opts = opts;
  }

  enqueue(event: LogEventRequest): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.opts.maxBatchSize) {
      void this.flush();
      return;
    }
    this.scheduleTimer();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;

    this.flushing = true;
    this.clearTimer();
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      await this.opts.flushFn(batch);
    } catch {
      // Re-enqueue at the head so nothing is dropped; caller decides retry policy.
      this.buffer.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  size(): number {
    return this.buffer.length;
  }

  private scheduleTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushIntervalMs);
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
