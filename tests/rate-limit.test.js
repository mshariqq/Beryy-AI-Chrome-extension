import test from "node:test";
import assert from "node:assert/strict";
import {
  GoogleRateLimiter,
  NVIDIA_RATE_LIMIT_RPM,
  SlidingWindowLimiter,
  WeightedWindowLimiter,
  acquireGoogleRateLimit,
  acquireNvidiaRateLimit,
  resetGoogleRateLimiters,
  resetNvidiaRateLimiters,
  shouldLimitNvidia
} from "../extension/shared/rate-limit.js";

test("NVIDIA rate limiting is gated by provider and setting", () => {
  assert.equal(shouldLimitNvidia({ provider: "nvidia", nvidiaRateLimit: true }), true);
  assert.equal(shouldLimitNvidia({ provider: "nvidia", nvidiaRateLimit: false }), false);
  assert.equal(shouldLimitNvidia({ provider: "google", nvidiaRateLimit: true }), false);
  assert.equal(shouldLimitNvidia({ provider: "custom", nvidiaRateLimit: true }), false);
});

test("NVIDIA rate limiter allows the standard RPM before waiting", async () => {
  let now = 0;
  const waits = [];
  const limiter = new SlidingWindowLimiter({
    limit: NVIDIA_RATE_LIMIT_RPM,
    windowMs: 60000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    }
  });

  for (let index = 0; index < NVIDIA_RATE_LIMIT_RPM; index += 1) {
    await limiter.acquire();
  }

  assert.deepEqual(waits, []);

  await limiter.acquire({ onWait: (ms) => waits.push(ms) });
  assert.ok(waits[0] >= 60000);
});

test("NVIDIA rate limiter waits again if the window is still full", async () => {
  let now = 0;
  let sleeps = 0;
  const waits = [];
  const limiter = new SlidingWindowLimiter({
    limit: 1,
    windowMs: 1000,
    bufferMs: 25,
    now: () => now,
    sleep: async (ms) => {
      now += sleeps === 0 ? 10 : ms;
      sleeps += 1;
    }
  });

  await limiter.acquire();
  await limiter.acquire({
    onWait: (ms) => {
      if (ms > 0) waits.push(ms);
    }
  });

  assert.deepEqual(waits, [1025, 1015]);
});

test("NVIDIA rate limit acquisition is a no-op when disabled", async () => {
  resetNvidiaRateLimiters();
  await acquireNvidiaRateLimit({ provider: "google", nvidiaRateLimit: true });
  await acquireNvidiaRateLimit({ provider: "nvidia", nvidiaRateLimit: false });
});

test("weighted limiter waits for the token budget to expire", async () => {
  let now = 0;
  const waits = [];
  const limiter = new WeightedWindowLimiter({
    limit: 100,
    windowMs: 1000,
    bufferMs: 0,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    }
  });

  await limiter.acquire({ weight: 60 });
  await limiter.acquire({ weight: 40 });
  await limiter.acquire({
    weight: 10,
    onWait: (ms) => {
      if (ms > 0) waits.push(ms);
    }
  });

  assert.deepEqual(waits, [1000]);
});

test("Google limiter enforces RPM before starting a request", async () => {
  let now = 0;
  const waits = [];
  const limiter = new GoogleRateLimiter({
    rpm: 2,
    rpd: 100,
    tpm: 1000000,
    windowMs: 1000,
    dayMs: 10000,
    bufferMs: 0,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    }
  });

  await limiter.acquire({ weight: 10 });
  await limiter.acquire({ weight: 10 });
  await limiter.acquire({
    weight: 10,
    onWait: (ms) => {
      if (ms > 0) waits.push(ms);
    }
  });

  assert.deepEqual(waits, [1000]);
});

test("Google limiter enforces RPD independently of RPM", async () => {
  let now = 0;
  const waits = [];
  const limiter = new GoogleRateLimiter({
    rpm: 100,
    rpd: 2,
    tpm: 1000000,
    windowMs: 1000,
    dayMs: 10000,
    bufferMs: 0,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    }
  });

  await limiter.acquire({ weight: 10 });
  await limiter.acquire({ weight: 10 });
  await limiter.acquire({
    weight: 10,
    onWait: (ms) => {
      if (ms > 0) waits.push(ms);
    }
  });

  assert.deepEqual(waits, [10000]);
});

test("Google rate limit acquisition is a no-op when all limits are zero", async () => {
  resetGoogleRateLimiters();
  await acquireGoogleRateLimit({
    provider: "google",
    googleTpm: 0,
    googleRpd: 0,
    googleRpm: 0
  });
});
