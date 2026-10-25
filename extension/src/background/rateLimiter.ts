/** Sliding-window limiter so a chatty session can't burn through the OpenAI quota. */
export class RateLimiter {
  private calls: number[] = [];
  constructor(private maxPerWindow: number, private windowMs = 60_000) {}

  /** Waits up to `maxWaitMs` for a slot, otherwise throws. */
  async acquire(maxWaitMs = 5000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < this.windowMs);
      if (this.calls.length < this.maxPerWindow) {
        this.calls.push(now);
        return;
      }
      const wait = this.calls[0] + this.windowMs - now;
      if (now + wait > deadline) throw new RateLimitError();
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('Too many requests. Give me a few seconds.');
    this.name = 'RateLimitError';
  }
}
