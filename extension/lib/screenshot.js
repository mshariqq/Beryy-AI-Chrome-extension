const MAX_BASE64_CHARS = 350000;

export class ScreenshotStore {
  constructor(max = 10) {
    this.max = max;
    this.images = new Map();
    this.sequence = 0;
  }

  add(data) {
    const imageId = `screenshot_${Date.now()}_${++this.sequence}`;
    this.images.set(imageId, data);
    while (this.images.size > this.max) {
      const oldest = this.images.keys().next().value;
      this.images.delete(oldest);
    }
    return imageId;
  }

  get(imageId) {
    return this.images.get(String(imageId)) || null;
  }
}

async function viewport(cdp, tabId) {
  const result = await cdp.send(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio])",
    returnByValue: true
  });
  const parsed = JSON.parse(result?.result?.value || "[]");
  const [width, height, dpr] = parsed;
  if (!width || !height) return null;
  return { width, height, dpr: dpr > 0 ? dpr : 1 };
}

/**
 * Capture the viewport at exactly CSS-pixel dimensions. Input coordinates and
 * screenshot pixels then share one coordinate space, which is the single most
 * important invariant for reliable clicking on HiDPI displays.
 */
export async function takeScreenshot(cdp, tabId) {
  const vp = await viewport(cdp, tabId).catch(() => null);
  const clip = vp
    ? { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 / vp.dpr }
    : null;

  const capture = async (quality) => {
    const params = {
      format: "jpeg",
      quality,
      optimizeForSpeed: true,
      captureBeyondViewport: false
    };
    if (clip) params.clip = clip;
    return (await cdp.send(tabId, "Page.captureScreenshot", params)).data;
  };

  let data = await capture(55);
  if (data.length > MAX_BASE64_CHARS) data = await capture(30);

  return {
    data,
    mimeType: "image/jpeg",
    width: vp?.width || null,
    height: vp?.height || null,
    dpr: vp?.dpr || 1
  };
}

export async function takeRegionScreenshot(cdp, tabId, region) {
  const vp = await viewport(cdp, tabId).catch(() => null);
  const dpr = vp?.dpr || 1;
  const [x0, y0, x1, y1] = region.map(Number);
  const x = Math.max(0, Math.min(x0, x1));
  const y = Math.max(0, Math.min(y0, y1));
  const width = Math.max(1, Math.abs(x1 - x0));
  const height = Math.max(1, Math.abs(y1 - y0));

  const params = {
    format: "jpeg",
    quality: 75,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
    clip: { x, y, width, height, scale: 1 / dpr }
  };

  const data = (await cdp.send(tabId, "Page.captureScreenshot", params)).data;
  return { data, mimeType: "image/jpeg", width, height, dpr };
}
