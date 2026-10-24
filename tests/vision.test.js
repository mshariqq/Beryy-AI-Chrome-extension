import test from "node:test";
import assert from "node:assert/strict";

import {
  modelVisionSupport,
  shouldSendScreenshotImages
} from "../extension/shared/vision.js";

test("recognizes common vision model names", () => {
  for (const model of [
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-4-maverick-17b-128e-instruct",
    "microsoft/phi-3.5-vision-instruct",
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "mistralai/pixtral-12b",
    "google/gemma-3-27b-it",
    "openai/gpt-4o",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-1.5-pro",
    "llava-hf/llava-1.5-7b-hf"
  ]) {
    assert.equal(modelVisionSupport(model), "yes", model);
    assert.equal(shouldSendScreenshotImages(model), true, model);
  }
});

test("does not send screenshots to known text-only models", () => {
  for (const model of [
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.2-3b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "qwen/qwen2.5-coder-32b-instruct",
    "deepseek-ai/deepseek-v3"
  ]) {
    assert.equal(modelVisionSupport(model), "no", model);
    assert.equal(shouldSendScreenshotImages(model), false, model);
  }
});

test("sends screenshots when the model capability is unknown", () => {
  for (const model of [
    "",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-nano-12b-v2-vl",
    "mistralai/mistral-small-3.1-24b-instruct"
  ]) {
    assert.notEqual(modelVisionSupport(model), "no", model);
    assert.equal(shouldSendScreenshotImages(model), true, model);
  }
});
