import { describe, expect, it, vi } from "vitest";
import { completeNodeJob, executeStubJob, pollNodeJob, resolveJobInput } from "./service.js";

describe("massivenet provider node service", () => {
  it("poll uses Bearer node token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ job: null }), { status: 200 }));

    await pollNodeJob({
      fetchFn: fetchMock as unknown as typeof fetch,
      baseUrl: "https://massivenet.local",
      nodeToken: "node-token-123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer node-token-123");
  });

  it("payload_ref fetch uses Bearer node token", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ payload_json: { task: "chat" } }), { status: 200 }),
    );

    const payload = await resolveJobInput({
      fetchFn: fetchMock as unknown as typeof fetch,
      baseUrl: "https://massivenet.local",
      nodeToken: "node-token-123",
      job: {
        id: "job-1",
        kind: "chat",
        payload_ref: "/v1/nodes/jobs/job-1/payload",
      },
    });

    expect(payload).toEqual({ task: "chat" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://massivenet.local/v1/nodes/jobs/job-1/payload");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer node-token-123");
  });

  it("completion uses node-auth endpoint with Bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

    await completeNodeJob({
      fetchFn: fetchMock as unknown as typeof fetch,
      baseUrl: "https://massivenet.local",
      nodeToken: "node-token-123",
      jobId: "job-xyz",
      body: {
        status: "succeeded",
        result_text: "hello world",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://massivenet.local/v1/nodes/jobs/job-xyz/complete");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer node-token-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      status: "succeeded",
      result_text: "hello world",
    });
  });

  it("stub executor returns expected output shapes", () => {
    expect(executeStubJob("chat")).toEqual({
      result_text: "Stub response from MassiveNet provider node.",
    });
    expect(executeStubJob("image")).toEqual({
      output_urls: ["https://example.com/stub-output.png"],
    });
  });
});
