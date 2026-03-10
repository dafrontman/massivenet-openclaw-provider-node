import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeNodeJob,
  executeStubJob,
  pollNodeJob,
  prepareNodeRuntimeAccess,
  registerNode,
  resolveJobInput,
  resolveMassiveNetProviderNodeConfig,
} from "./service.js";

describe("massivenet provider node service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        payload_ref: "/v1/nodes/jobs/job-1/input",
      },
    });

    expect(payload).toEqual({ task: "chat" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://massivenet.local/v1/nodes/jobs/job-1/input");
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

  it("register posts the protocol request body and provider auth", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            node_id: 12,
            account_id: 34,
            shard_id: 0,
            status: "online",
            node_token: "mnn.token",
          }),
          { status: 200 },
        ),
    );

    const response = await registerNode({
      fetchFn: fetchMock as unknown as typeof fetch,
      baseUrl: "https://massivenet.local",
      providerApiKey: "provider-key-123",
      inviteToken: "invite-123",
      nodeName: "provider-node-01",
      capabilities: { gpu: true, max_concurrency: 2 },
      payoutAddressSolana: null,
      payoutAddressEthereum: null,
    });

    expect(response).toEqual({
      node_id: 12,
      account_id: 34,
      shard_id: 0,
      status: "online",
      node_token: "mnn.token",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://massivenet.local/v1/nodes/register");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer provider-key-123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "provider-node-01",
      capabilities: { gpu: true, max_concurrency: 2 },
      invite_token: "invite-123",
      payout_address_solana: null,
      payout_address_ethereum: null,
    });
  });

  it("prepareNodeRuntimeAccess reuses persisted credentials before bootstrap", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "massivenet-provider-node-"));
    const credentialPath = path.join(tempDir, "node.json");
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        node_id: 12,
        account_id: 34,
        shard_id: 1,
        status: "online",
        node_token: "persisted-node-token",
        saved_at: "2026-03-10T15:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const fetchMock = vi.fn();
    const access = await prepareNodeRuntimeAccess({
      fetchFn: fetchMock as unknown as typeof fetch,
      cfg: {
        baseUrl: "https://massivenet.local",
        credentialPath,
        nodeCapabilities: {},
        payoutAddressSolana: null,
        payoutAddressEthereum: null,
        pollIntervalMs: 500,
        backoffMaxMs: 5000,
        executor: "stub",
        logJson: true,
      },
      nowIso: "2026-03-10T15:05:00.000Z",
    });

    expect(access.source).toBe("persisted");
    expect(access.credentials.node_token).toBe("persisted-node-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepareNodeRuntimeAccess bootstraps and persists when no token exists", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "massivenet-provider-node-"));
    const credentialPath = path.join(tempDir, "node.json");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            node_id: 9,
            account_id: 7,
            shard_id: 3,
            status: "online",
            node_token: "mnn.bootstrap",
          }),
          { status: 200 },
        ),
    );

    const access = await prepareNodeRuntimeAccess({
      fetchFn: fetchMock as unknown as typeof fetch,
      cfg: {
        baseUrl: "https://massivenet.local",
        providerApiKey: "provider-key",
        inviteToken: "invite-token",
        nodeName: "provider-node-01",
        nodeCapabilities: { models_supported: ["kimi-k2.5"] },
        payoutAddressSolana: null,
        payoutAddressEthereum: null,
        credentialPath,
        pollIntervalMs: 500,
        backoffMaxMs: 5000,
        executor: "stub",
        logJson: true,
      },
      nowIso: "2026-03-10T15:10:00.000Z",
    });

    expect(access.source).toBe("bootstrap");
    expect(access.credentials).toMatchObject({
      node_id: 9,
      account_id: 7,
      shard_id: 3,
      status: "online",
      node_token: "mnn.bootstrap",
      saved_at: "2026-03-10T15:10:00.000Z",
    });

    const persisted = JSON.parse(await readFile(credentialPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      node_id: 9,
      account_id: 7,
      shard_id: 3,
      status: "online",
      node_token: "mnn.bootstrap",
      saved_at: "2026-03-10T15:10:00.000Z",
    });
  });

  it("config accepts bootstrap env without a pre-seeded node token", () => {
    const cfg = resolveMassiveNetProviderNodeConfig({
      MASSIVENET_BASE_URL: "https://massivenet.local/",
      MASSIVENET_PROVIDER_API_KEY: "provider-key",
      MASSIVENET_INVITE_TOKEN: "invite-token",
      MASSIVENET_NODE_NAME: "provider-node-01",
      MASSIVENET_NODE_CAPABILITIES_JSON: '{"gpu":true,"max_concurrency":2}',
      MASSIVENET_NODE_CREDENTIALS_PATH: "C:\\temp\\node.json",
    });

    expect(cfg.baseUrl).toBe("https://massivenet.local");
    expect(cfg.providerApiKey).toBe("provider-key");
    expect(cfg.inviteToken).toBe("invite-token");
    expect(cfg.nodeName).toBe("provider-node-01");
    expect(cfg.nodeCapabilities).toEqual({ gpu: true, max_concurrency: 2 });
    expect(cfg.nodeToken).toBeUndefined();
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
