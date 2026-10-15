import type { AdapterModel } from "@paperclipai/adapter-utils";
import { isAllowedAiEndpointUrl } from "@paperclipai/shared";

/** Normalize an OpenAI-compatible base URL (strip trailing slash, keep `/v1`). */
export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** Build the models catalog URL for an OpenAI-compatible base. */
export function openAiCompatibleModelsUrl(baseUrl: string): string {
  const base = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  return base.endsWith("/models") ? base : `${base}/models`;
}

/**
 * List models from an OpenAI-compatible `GET {baseUrl}/models` endpoint.
 * Optional bearer token; auth `none` when omitted.
 */
export async function listOpenAiCompatibleModels(
  baseUrl: string,
  apiKey?: string,
): Promise<AdapterModel[]> {
  if (!isAllowedAiEndpointUrl(baseUrl, { allowPrivateHttp: true })) {
    throw new Error(
      "Enter an HTTPS base URL without credentials, query parameters, or a fragment. Loopback and private LAN endpoints may use HTTP.",
    );
  }
  const endpoint = openAiCompatibleModelsUrl(baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Could not reach the model endpoint: ${err.message}`
        : "Could not reach the model endpoint.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Model catalog request failed (${response.status}). Check the base URL and API key.`,
    );
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>;
  };
  if (!Array.isArray(body.data)) {
    throw new Error("The endpoint returned an invalid OpenAI-compatible model catalog.");
  }
  return body.data.flatMap((entry) => {
    if (typeof entry.id !== "string" || !entry.id.trim()) return [];
    const id = entry.id.trim();
    return [
      {
        id,
        label: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      },
    ];
  });
}
