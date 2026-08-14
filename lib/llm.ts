// Unified LLM call wrapper: supports both the OpenAI Responses API (/responses) and
// Chat Completions (/chat/completions). Responses is preferred by default; if the
// gateway returns 404 (endpoint not supported), it automatically falls back to Chat
// Completions and caches the result.
// In local development, OPENAI_DEV_PROXY_URL can point requests at a local Node proxy
// (see the llm-dev-proxy plugin in vite.config.ts) to work around workerd's limitation
// of not supporting HTTP proxies (it can only make direct connections). The binding is
// injected only in vite.config.ts's local vars (and guarded by ARBOR_LOCAL_DEV=1), so
// production deployments never carry it — keeping the localhost proxy address out of
// the Cloudflare worker.
import { env } from "cloudflare:workers";

export type ModelPayload = {
  output_text?: string;
  output?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
  choices?: Array<{ message?: { role?: string; content?: string } }>;
};

export type ModelInput =
  | string
  | Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string }> }>;

export type LlmRequest = {
  instructions: string;
  input: ModelInput;
  maxOutputTokens: number;
  /** Set to true when the model must return a JSON object; maps to Responses text.format / Chat response_format */
  json?: boolean;
};

type Style = "responses" | "chat";

// Cached protocol-detection result; reused across requests within the same worker isolate.
let styleCache: Style | undefined;
let consecutiveUpstreamFailures = 0;
let circuitOpenUntil = 0;

function assertCircuitClosed() {
  if (Date.now() < circuitOpenUntil) throw new Error("MODEL_CIRCUIT_OPEN");
}

function recordSuccess() {
  consecutiveUpstreamFailures = 0;
  circuitOpenUntil = 0;
}

function recordFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/MODEL_ERROR: (429|5\d\d)|timeout|fetch failed|network/i.test(message)) return;
  consecutiveUpstreamFailures += 1;
  if (consecutiveUpstreamFailures >= 5) circuitOpenUntil = Date.now() + 60_000;
}

function messageText(payload: ModelPayload) {
  const responsesText = payload.output
    ?.filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();
  return (
    responsesText ||
    payload.choices?.[0]?.message?.content?.trim() ||
    payload.output_text?.trim() ||
    ""
  );
}

function chatUserMessages(input: ModelInput): Array<{ role: string; content: unknown }> {
  if (typeof input === "string") return [{ role: "user", content: input }];
  return input.map((message) => ({
    role: message.role,
    content: (message.content ?? []).map((part) =>
      part.type === "input_image" || part.type === "image_url"
        ? { type: "image_url", image_url: { url: part.image_url } }
        : { type: "text", text: part.text ?? "" },
    ),
  }));
}

/** Send the request: when a dev proxy is configured, route it through the local Node proxy; otherwise connect directly to the gateway. */
async function forward(
  targetUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
) {
  const proxy = env.OPENAI_DEV_PROXY_URL?.trim();
  // The dev proxy may only be enabled in local development: both ARBOR_LOCAL_DEV=1
  // (set only in vite.config.ts's local bindings, never in Cloudflare production) and a
  // proxy pointing at the machine's own loopback address are required. This way, even if
  // a proxy configuration from .env is accidentally carried into the online worker, it
  // will never forward requests to a non-existent localhost.
  const useDevProxy =
    proxy && env.ARBOR_LOCAL_DEV === "1" && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(proxy);
  if (useDevProxy) {
    return await fetch(proxy, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUrl, body, headers }),
      signal: AbortSignal.timeout(90_000),
    });
  }
  return await fetch(targetUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
}

async function responsesCall(baseUrl: string, apiKey: string, model: string, request: LlmRequest) {
  const body: Record<string, unknown> = {
    model,
    store: false,
    max_output_tokens: request.maxOutputTokens,
    input: request.input,
    instructions: request.instructions,
  };
  if (request.json) body.text = { format: { type: "json_object" } };
  const response = await forward(`${baseUrl}/responses`, body, {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  });
  if (!response.ok) {
    const detail = await response.text();
    return { ok: false as const, status: response.status, detail: detail.slice(0, 240) };
  }
  const raw = messageText((await response.json()) as ModelPayload);
  return { ok: true as const, status: response.status, raw };
}

async function chatCall(baseUrl: string, apiKey: string, model: string, request: LlmRequest) {
  // Reasoning models in the gpt-5 family spend much of the max_tokens budget on thinking,
  // which can leave message.content empty. Use max_completion_tokens instead (this gateway
  // ignores the hard cap and reliably produces body text) and lower the reasoning effort
  // to speed up responses.
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: request.instructions },
      ...chatUserMessages(request.input),
    ],
    max_completion_tokens: request.maxOutputTokens,
    reasoning_effort: "low",
  };
  if (request.json) body.response_format = { type: "json_object" };
  const response = await forward(`${baseUrl}/chat/completions`, body, {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`MODEL_ERROR: ${response.status} ${detail.slice(0, 240)}`);
  }
  const raw = messageText((await response.json()) as ModelPayload);
  if (!raw) throw new Error("Model returned no usable content");
  return raw;
}

export async function requestLLM(request: LlmRequest) {
  assertCircuitClosed();
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("LLM_NOT_CONFIGURED");
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_MODEL || "gpt-5.6-luna";

  try {
    let raw: string;
    if (styleCache === "chat") raw = await chatCall(baseUrl, apiKey, model, request);
    else if (styleCache === "responses") {
      const result = await responsesCall(baseUrl, apiKey, model, request);
      if (!result.ok) throw new Error(`MODEL_ERROR: ${result.status} ${result.detail}`);
      if (!result.raw) throw new Error("Model returned no usable content");
      raw = result.raw;
    } else {
      const first = await responsesCall(baseUrl, apiKey, model, request);
      if (first.ok) {
        styleCache = "responses";
        if (!first.raw) throw new Error("Model returned no usable content");
        raw = first.raw;
      } else if (first.status === 404) {
        styleCache = "chat";
        raw = await chatCall(baseUrl, apiKey, model, request);
      } else throw new Error(`MODEL_ERROR: ${first.status} ${first.detail}`);
    }
    recordSuccess();
    return raw;
  } catch (error) {
    recordFailure(error);
    throw error;
  }
}
