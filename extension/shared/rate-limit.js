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

export class WeightedWindowLimiter {
  constructor({
    limit = 1,
    windowMs = 60000,
    bufferMs = 25,
    now = Date.now,
    sleep = abortableSleep
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.bufferMs = bufferMs;
    this.now = now;
    this.sleep = sleep;
    this.entries = [];
    this.queue = Promise.resolve();
  }

  async acquire({ weight = 0, onWait, signal } = {}) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const cost = Math.max(0, Number(weight) || 0);
      if (this.limit <= 0 || cost === 0) return;

      while (true) {
        const now = this.now();
        this.entries = this.entries.filter((entry) => now - entry.time < this.windowMs);
        const used = this.entries.reduce((total, entry) => total + entry.cost, 0);

        if (!this.entries.length || used + cost <= this.limit) {
          this.entries.push({ time: now, cost });
          return;
        }

        const waitMs = this.windowMs - (now - this.entries[0].time) + this.bufferMs;
        onWait?.(waitMs);
        await this.sleep(waitMs, signal);
        onWait?.(0);
      }
    } finally {
      release();
    }
  }
}

export class GoogleRateLimiter {
  constructor({
    tpm = 150000,
    rpd = 50,
    rpm = 10,
    windowMs = 60000,
    dayMs = 86400000,
    bufferMs = 25,
    now = Date.now,
    sleep = abortableSleep
  } = {}) {
    this.tpm = tpm;
    this.rpd = rpd;
    this.rpm = rpm;
    this.rpmLimiter =
      rpm > 0
        ? new SlidingWindowLimiter({ limit: rpm, windowMs, bufferMs, now, sleep })
        : null;
    this.rpdLimiter =
      rpd > 0
        ? new SlidingWindowLimiter({ limit: rpd, windowMs: dayMs, bufferMs, now, sleep })
        : null;
    this.tpmLimiter =
      tpm > 0
        ? new WeightedWindowLimiter({ limit: tpm, windowMs, bufferMs, now, sleep })
        : null;
  }

  async acquire({ weight = 0, onWait, signal } = {}) {
    await this.rpmLimiter?.acquire({ onWait, signal });
    await this.rpdLimiter?.acquire({ onWait, signal });
    await this.tpmLimiter?.acquire({ weight, onWait, signal });
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

const googleLimiters = new Map();

export function googleLimits(settings) {
  return {
    tpm: Math.max(0, Number(settings?.googleTpm) || 0),
    rpd: Math.max(0, Number(settings?.googleRpd) || 0),
    rpm: Math.max(0, Number(settings?.googleRpm) || 0)
  };
}

function googleLimiterFor(settings) {
  const limits = googleLimits(settings);
  const key = [
    settings?.baseUrl || "",
    settings?.apiKey || "",
    limits.tpm,
    limits.rpd,
    limits.rpm
  ].join("|");
  let limiter = googleLimiters.get(key);

  if (!limiter) {
    limiter = new GoogleRateLimiter(limits);
    googleLimiters.set(key, limiter);
  }

  return limiter;
}

export function acquireGoogleRateLimit(settings, options = {}) {
  const { tpm, rpd, rpm } = googleLimits(settings);
  if (tpm <= 0 && rpd <= 0 && rpm <= 0) return Promise.resolve();
  return googleLimiterFor(settings).acquire(options);
}

export function acquireProviderRateLimit(settings, options = {}) {
  if (shouldLimitNvidia(settings)) {
    return acquireNvidiaRateLimit(settings, options);
  }
  if (settings?.provider === "google") {
    return acquireGoogleRateLimit(settings, options);
  }
  return Promise.resolve();
}

export function resetGoogleRateLimiters() {
  googleLimiters.clear();
}
