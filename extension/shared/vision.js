const VISION_MODEL_PATTERN =
  /(?:vision|multimodal|llava|pixtral|paligemma|smolvlm|molmo|idefics|internvl|cogvlm|vila|blip|minicpm[-_.]?v|qwen(?:\d+(?:\.\d+)?)?[-_.]?(?:vl|omni)|llama[-_.]?\d+(?:\.\d+)?[-_.][^/]*vision|llama[-_.]?4(?:[.-]|$)|gemma[-_.]?3|phi[-_.]?\d+(?:\.\d+)?[-_.][^/]*vision|gpt[-_.]?4o|gpt[-_.]?4(?:\.1|[-_.]?turbo|[-_.]?vision)|gpt[-_.]?5|o[3-9](?:[-_.]|$)|claude|gemini)/i;

const TEXT_ONLY_MODEL_PATTERN =
  /(?:llama[-_.]?(?:2|3(?:\.\d+)?)(?:[-_.]|$)|qwen[^/]*(?:coder|math)|deepseek[-_.]?(?:v[23]|r1|coder|math)|gpt[-_.]?oss|codestral|devstral|mixtral|nemotron[-_.]?4|phi[-_.]?\d+(?:\.\d+)?(?:[-_.]|$)|gemma[-_.]?2)/i;

export function modelVisionSupport(model) {
  const name = String(model || "");
  if (!name) return "unknown";
  if (VISION_MODEL_PATTERN.test(name)) return "yes";
  if (TEXT_ONLY_MODEL_PATTERN.test(name)) return "no";
  return "unknown";
}

export function shouldSendScreenshotImages(model) {
  return modelVisionSupport(model) !== "no";
}
