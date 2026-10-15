import { afterEach, describe, expect, it, vi } from "vitest";

describe("listOpenAiCompatibleModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fetches GET {base}/models with an optional bearer token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: "qwen/qwen3.8-27b", name: "Qwen 3.8" },
          { id: "skip-me" },
          { id: 12 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenAiCompatibleModels, openAiCompatibleModelsUrl } = await import(
      "./openai-compatible-models.js"
    );
    expect(openAiCompatibleModelsUrl("http://192.168.30.60:11434/v1/")).toBe(
      "http://192.168.30.60:11434/v1/models",
    );
    await expect(
      listOpenAiCompatibleModels("http://192.168.30.60:11434/v1", "secret"),
    ).resolves.toEqual([
      { id: "qwen/qwen3.8-27b", label: "Qwen 3.8" },
      { id: "skip-me", label: "skip-me" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.30.60:11434/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        redirect: "error",
      }),
    );
  });

  it("rejects unsafe base URLs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { listOpenAiCompatibleModels } = await import("./openai-compatible-models.js");
    await expect(
      listOpenAiCompatibleModels("http://169.254.169.254/v1"),
    ).rejects.toThrow(/HTTPS base URL|private LAN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
