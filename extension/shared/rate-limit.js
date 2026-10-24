export const NVIDIA_RATE_LIMIT_RPM = 40;
export const NVIDIA_RATE_WINDOW_MS = 60000;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export class SlidingWindowLimiter {
  constructor({
    limit = NVIDIA_RATE_LIMIT_RPM,
    windowMs = NVIDIA_RATE_WINDOW_MS,
    bufferMs = 25,
    now = Date.now,
    sleep = abortableSleep
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.bufferMs = bufferMs;
    this.now = now;
    this.sleep = sleep;
    this.times = [];
    this.queue = Promise.resolve();
  }

  async acquire({ onWait, signal } = {}) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      while (true) {
        const now = this.now();
        this.times = this.times.filter((time) => now - time < this.windowMs);

        if (this.times.length < this.limit) {
          this.times.push(now);
          return;
        }

        const waitMs = this.windowMs - (now - this.times[0]) + this.bufferMs;
        onWait?.(waitMs);
        await this.sleep(waitMs, signal);
        onWait?.(0);
      }
    } finally {
      release();
    }
  }
}

export function shouldLimitNvidia(settings) {
  return settings?.provider === "nvidia" && settings?.nvidiaRateLimit === true;
}

const nvidiaLimiters = new Map();

function limiterFor(settings) {
  const key = `${settings?.baseUrl || ""}|${settings?.apiKey || ""}`;
  let limiter = nvidiaLimiters.get(key);

  if (!limiter) {
    limiter = new SlidingWindowLimiter();
    nvidiaLimiters.set(key, limiter);
  }

  return limiter;
}

export function acquireNvidiaRateLimit(settings, options) {
  if (!shouldLimitNvidia(settings)) return Promise.resolve();
  return limiterFor(settings).acquire(options);
}

export function resetNvidiaRateLimiters() {
  nvidiaLimiters.clear();
}
