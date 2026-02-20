import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 5000;
const DEFAULT_EXECUTOR = "stub";
const DEFAULT_LOG_JSON = true;
const STUB_CHAT_RESPONSE = "Stub response from MassiveNet provider node.";
const STUB_IMAGE_OUTPUT_URL = "https://example.com/stub-output.png";

export type MassiveNetExecutor = "stub" | "http";

export type MassiveNetProviderNodeConfig = {
  baseUrl: string;
  nodeToken: string;
  pollIntervalMs: number;
  backoffMaxMs: number;
  executor: MassiveNetExecutor;
  localExecutorUrl?: string;
  logJson: boolean;
};

type JobEnvelope = {
  id?: unknown;
  kind?: unknown;
  input?: unknown;
  payload_ref?: unknown;
};

type PollResponse = {
  job?: JobEnvelope | null;
};

type JobKind = "chat" | "image";

type CompletionStatus = "succeeded" | "failed";

type CompletionBody = {
  status: CompletionStatus;
  result_text?: string;
  output_urls?: string[];
  error?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

type LogWriter = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type WorkerDependencies = {
  fetchFn: typeof fetch;
  sleepMs: (ms: number) => Promise<void>;
  random: () => number;
  nowMs: () => number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function resolveMassiveNetProviderNodeConfig(
  env: NodeJS.ProcessEnv = process.env,
): MassiveNetProviderNodeConfig {
  const baseUrl = (env.MASSIVENET_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("MASSIVENET_BASE_URL is required");
  }

  const nodeToken = (env.MASSIVENET_NODE_TOKEN ?? "").trim();
  if (!nodeToken) {
    throw new Error("MASSIVENET_NODE_TOKEN is required");
  }

  const executorRaw = (env.MASSIVENET_EXECUTOR ?? DEFAULT_EXECUTOR).trim().toLowerCase();
  if (executorRaw !== "stub" && executorRaw !== "http") {
    throw new Error('MASSIVENET_EXECUTOR must be either "stub" or "http"');
  }

  const localExecutorUrl = (env.MASSIVENET_LOCAL_EXECUTOR_URL ?? "").trim();
  if (executorRaw === "http" && !localExecutorUrl) {
    throw new Error("MASSIVENET_LOCAL_EXECUTOR_URL is required when MASSIVENET_EXECUTOR=http");
  }

  return {
    baseUrl,
    nodeToken,
    pollIntervalMs: parsePositiveInt(env.MASSIVENET_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    backoffMaxMs: parsePositiveInt(env.MASSIVENET_BACKOFF_MAX_MS, DEFAULT_BACKOFF_MAX_MS),
    executor: executorRaw,
    localExecutorUrl: localExecutorUrl || undefined,
    logJson: parseBoolean(env.MASSIVENET_LOG_JSON, DEFAULT_LOG_JSON),
  };
}

export function buildNodeAuthHeaders(nodeToken: string): Record<string, string> {
  return { Authorization: `Bearer ${nodeToken}` };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid job id");
  }
  return value.trim();
}

function normalizeJobKind(value: unknown): JobKind {
  if (typeof value !== "string") {
    throw new Error("Job kind missing");
  }
  const kind = value.trim().toLowerCase();
  if (kind === "chat") {
    return "chat";
  }
  if (kind === "image" || kind.includes("image")) {
    return "image";
  }
  throw new Error(`Unsupported job kind: ${kind}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function assertOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status})`);
  }
}

export async function fetchNodeIdentity(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  nodeToken: string;
}): Promise<Record<string, unknown>> {
  const response = await params.fetchFn(`${params.baseUrl}/v1/nodes/me`, {
    method: "GET",
    headers: buildNodeAuthHeaders(params.nodeToken),
  });
  assertOk(response, "node sanity check");
  const parsed = await parseJson(response);
  if (!isRecord(parsed)) {
    throw new Error("Invalid /v1/nodes/me response");
  }
  return parsed;
}

export async function sendHeartbeat(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  nodeToken: string;
}): Promise<void> {
  const response = await params.fetchFn(`${params.baseUrl}/v1/nodes/heartbeat`, {
    method: "POST",
    headers: {
      ...buildNodeAuthHeaders(params.nodeToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assertOk(response, "heartbeat");
}

export async function pollNodeJob(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  nodeToken: string;
}): Promise<JobEnvelope | null> {
  const response = await params.fetchFn(`${params.baseUrl}/v1/nodes/poll`, {
    method: "POST",
    headers: buildNodeAuthHeaders(params.nodeToken),
  });
  assertOk(response, "poll");
  const parsed = (await parseJson(response)) as PollResponse | null;
  if (!isRecord(parsed) || !("job" in parsed)) {
    return null;
  }
  const job = parsed.job;
  return isRecord(job) ? job : null;
}

export async function resolveJobInput(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  nodeToken: string;
  job: JobEnvelope;
}): Promise<Record<string, unknown>> {
  if (isRecord(params.job.input)) {
    return params.job.input;
  }

  if (typeof params.job.payload_ref !== "string" || !params.job.payload_ref.trim()) {
    throw new Error("Job payload missing");
  }

  const payloadRef = params.job.payload_ref.trim();
  const url =
    payloadRef.startsWith("http://") || payloadRef.startsWith("https://")
      ? payloadRef
      : `${params.baseUrl}/${payloadRef.replace(/^\/+/, "")}`;

  const response = await params.fetchFn(url, {
    method: "GET",
    headers: buildNodeAuthHeaders(params.nodeToken),
  });
  assertOk(response, "payload_ref fetch");
  const parsed = await parseJson(response);
  if (!isRecord(parsed) || !isRecord(parsed.payload_json)) {
    throw new Error("Invalid payload_ref response");
  }
  return parsed.payload_json;
}

type ChatExecutionResult = { result_text: string };
type ImageExecutionResult = { output_urls: string[] };

type ExecutionResult = ChatExecutionResult | ImageExecutionResult;

export function executeStubJob(kind: JobKind): ExecutionResult {
  if (kind === "chat") {
    return { result_text: STUB_CHAT_RESPONSE };
  }
  return { output_urls: [STUB_IMAGE_OUTPUT_URL] };
}

export async function executeHttpJob(params: {
  fetchFn: typeof fetch;
  localExecutorUrl: string;
  kind: JobKind;
  input: Record<string, unknown>;
}): Promise<ExecutionResult> {
  const response = await params.fetchFn(params.localExecutorUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params.input),
  });
  assertOk(response, "local executor");
  const parsed = await parseJson(response);
  if (!isRecord(parsed)) {
    throw new Error("Invalid local executor response");
  }
  if (params.kind === "chat") {
    if (typeof parsed.result_text !== "string") {
      throw new Error("local executor chat response missing result_text");
    }
    return { result_text: parsed.result_text };
  }
  if (
    !Array.isArray(parsed.output_urls) ||
    !parsed.output_urls.every((item) => typeof item === "string")
  ) {
    throw new Error("local executor image response missing output_urls");
  }
  return { output_urls: parsed.output_urls };
}

export async function completeNodeJob(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  nodeToken: string;
  jobId: string;
  body: CompletionBody;
}): Promise<void> {
  const response = await params.fetchFn(`${params.baseUrl}/v1/nodes/jobs/${params.jobId}/complete`, {
    method: "POST",
    headers: {
      ...buildNodeAuthHeaders(params.nodeToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.body),
  });
  assertOk(response, "complete");
}

type PollOutcome = "worked" | "idle" | "error";

export class MassiveNetProviderNodeWorker {
  private readonly cfg: MassiveNetProviderNodeConfig;

  private readonly logger: LogWriter;

  private readonly deps: WorkerDependencies;

  private stopped = false;

  private backoffMs: number;

  constructor(
    cfg: MassiveNetProviderNodeConfig,
    logger: LogWriter,
    deps?: Partial<WorkerDependencies>,
  ) {
    this.cfg = cfg;
    this.logger = logger;
    this.backoffMs = cfg.pollIntervalMs;
    this.deps = {
      fetchFn: deps?.fetchFn ?? fetch,
      sleepMs:
        deps?.sleepMs ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
      random: deps?.random ?? Math.random,
      nowMs: deps?.nowMs ?? Date.now,
    };
  }

  stop(): void {
    this.stopped = true;
  }

  private emit(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
    const payload = {
      ts: new Date(this.deps.nowMs()).toISOString(),
      event,
      ...fields,
    };

    if (this.cfg.logJson) {
      this.logger[level](JSON.stringify(payload));
      return;
    }
    const pairs = Object.entries(payload).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    this.logger[level](pairs.join(" "));
  }

  private async sanityCheck(): Promise<void> {
    const profile = await fetchNodeIdentity({
      fetchFn: this.deps.fetchFn,
      baseUrl: this.cfg.baseUrl,
      nodeToken: this.cfg.nodeToken,
    });
    this.emit("info", "startup_sanity_check_success", { node_profile: profile });
  }

  private async sleepWithBackoff(increase: boolean): Promise<void> {
    const jitter = Math.floor(this.deps.random() * Math.max(1, Math.floor(this.cfg.pollIntervalMs / 4)));
    await this.deps.sleepMs(this.backoffMs + jitter);
    if (increase) {
      this.backoffMs = Math.min(this.cfg.backoffMaxMs, this.backoffMs * 2);
    } else {
      this.backoffMs = this.cfg.pollIntervalMs;
    }
  }

  async pollAndProcessOnce(): Promise<PollOutcome> {
    this.emit("info", "poll_start");

    try {
      await sendHeartbeat({
        fetchFn: this.deps.fetchFn,
        baseUrl: this.cfg.baseUrl,
        nodeToken: this.cfg.nodeToken,
      });
      this.emit("info", "heartbeat_success");
    } catch (error) {
      this.emit("warn", "heartbeat_failure", { error: toErrorMessage(error) });
    }

    let job: JobEnvelope | null = null;
    try {
      job = await pollNodeJob({
        fetchFn: this.deps.fetchFn,
        baseUrl: this.cfg.baseUrl,
        nodeToken: this.cfg.nodeToken,
      });
      this.emit("info", "poll_success", { has_job: Boolean(job) });
    } catch (error) {
      this.emit("error", "poll_failure", { error: toErrorMessage(error) });
      return "error";
    }

    if (!job) {
      this.emit("info", "poll_idle");
      return "idle";
    }

    let jobId = "";
    let jobKind: JobKind = "chat";
    try {
      jobId = normalizeJobId(job.id);
      jobKind = normalizeJobKind(job.kind);
    } catch (error) {
      this.emit("error", "claim_failure", { error: toErrorMessage(error) });
      return "error";
    }

    this.emit("info", "claim_success", { job_id: jobId, job_kind: jobKind });

    const startedAt = this.deps.nowMs();
    try {
      const input = await resolveJobInput({
        fetchFn: this.deps.fetchFn,
        baseUrl: this.cfg.baseUrl,
        nodeToken: this.cfg.nodeToken,
        job,
      });

      this.emit("info", "execute_start", { job_id: jobId, job_kind: jobKind, executor: this.cfg.executor });

      const result =
        this.cfg.executor === "http"
          ? await executeHttpJob({
              fetchFn: this.deps.fetchFn,
              localExecutorUrl: this.cfg.localExecutorUrl ?? "",
              kind: jobKind,
              input,
            })
          : executeStubJob(jobKind);

      this.emit("info", "execute_success", { job_id: jobId, job_kind: jobKind });

      try {
        await completeNodeJob({
          fetchFn: this.deps.fetchFn,
          baseUrl: this.cfg.baseUrl,
          nodeToken: this.cfg.nodeToken,
          jobId,
          body: {
            status: "succeeded",
            ...(jobKind === "chat" && "result_text" in result ? { result_text: result.result_text } : {}),
            ...(jobKind === "image" && "output_urls" in result ? { output_urls: result.output_urls } : {}),
            metrics: {
              executor: this.cfg.executor,
              duration_ms: this.deps.nowMs() - startedAt,
            },
          },
        });
        this.emit("info", "complete_success", { job_id: jobId, status: "succeeded" });
      } catch (error) {
        this.emit("error", "complete_failure", { job_id: jobId, error: toErrorMessage(error) });
      }
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.emit("error", "execute_failure", { job_id: jobId, error: errorMessage });

      try {
        await completeNodeJob({
          fetchFn: this.deps.fetchFn,
          baseUrl: this.cfg.baseUrl,
          nodeToken: this.cfg.nodeToken,
          jobId,
          body: {
            status: "failed",
            error: { message: errorMessage },
            metrics: {
              executor: this.cfg.executor,
              duration_ms: this.deps.nowMs() - startedAt,
            },
          },
        });
        this.emit("info", "complete_success", { job_id: jobId, status: "failed" });
      } catch (completionError) {
        this.emit("error", "complete_failure", { job_id: jobId, error: toErrorMessage(completionError) });
      }
    }

    return "worked";
  }

  async run(): Promise<void> {
    this.emit("info", "worker_start", { executor: this.cfg.executor });

    while (!this.stopped) {
      try {
        await this.sanityCheck();
        break;
      } catch (error) {
        this.emit("error", "startup_sanity_check_failure", { error: toErrorMessage(error) });
        await this.sleepWithBackoff(true);
      }
    }

    while (!this.stopped) {
      const outcome = await this.pollAndProcessOnce();
      if (outcome === "worked") {
        this.backoffMs = this.cfg.pollIntervalMs;
        continue;
      }
      await this.sleepWithBackoff(true);
    }

    this.emit("info", "worker_stop");
  }
}

export function createMassiveNetProviderNodeService(): OpenClawPluginService {
  let worker: MassiveNetProviderNodeWorker | null = null;
  let workerPromise: Promise<void> | null = null;

  return {
    id: "massivenet_provider_node",
    async start(ctx: OpenClawPluginServiceContext) {
      try {
        const cfg = resolveMassiveNetProviderNodeConfig(process.env);
        worker = new MassiveNetProviderNodeWorker(cfg, ctx.logger);
        workerPromise = worker.run().catch((error) => {
          ctx.logger.error(`[massivenet_provider_node] worker crashed: ${toErrorMessage(error)}`);
        });
      } catch (error) {
        ctx.logger.error(`[massivenet_provider_node] not started: ${toErrorMessage(error)}`);
      }
    },
    async stop() {
      worker?.stop();
      if (workerPromise) {
        await workerPromise;
      }
      worker = null;
      workerPromise = null;
    },
  };
}
