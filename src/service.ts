import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 5000;
const DEFAULT_EXECUTOR = "stub";
const DEFAULT_LOG_JSON = true;
const DEFAULT_CREDENTIAL_FILENAME = ".massivenet-node-credentials.json";
const STUB_CHAT_RESPONSE = "Stub response from MassiveNet provider node.";
const STUB_IMAGE_OUTPUT_URL = "https://example.com/stub-output.png";

export type MassiveNetExecutor = "stub" | "http";

export type MassiveNetProviderNodeConfig = {
  baseUrl: string;
  nodeToken?: string;
  providerApiKey?: string;
  inviteToken?: string;
  nodeName?: string;
  nodeCapabilities: Record<string, unknown>;
  payoutAddressSolana: string | null;
  payoutAddressEthereum: string | null;
  credentialPath: string;
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

export type PersistedNodeCredentials = {
  node_id: number;
  account_id: number;
  shard_id: number;
  status: string;
  node_token: string;
  saved_at: string;
};

type RuntimeNodeAccess = {
  credentials: PersistedNodeCredentials;
  source: "persisted" | "env" | "bootstrap";
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

export class MassiveNetHttpError extends Error {
  readonly status: number;

  readonly action: string;

  readonly responseBody: unknown;

  constructor(action: string, status: number, message: string, responseBody: unknown) {
    super(`${action} failed (${status}): ${message}`);
    this.name = "MassiveNetHttpError";
    this.status = status;
    this.action = action;
    this.responseBody = responseBody;
  }
}

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

function parseOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseNullableString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function parseCapabilities(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("MASSIVENET_NODE_CAPABILITIES_JSON must be a JSON object");
  }
  return parsed;
}

export function resolveMassiveNetProviderNodeConfig(
  env: NodeJS.ProcessEnv = process.env,
): MassiveNetProviderNodeConfig {
  const baseUrl = (env.MASSIVENET_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("MASSIVENET_BASE_URL is required");
  }

  const executorRaw = (env.MASSIVENET_EXECUTOR ?? DEFAULT_EXECUTOR).trim().toLowerCase();
  if (executorRaw !== "stub" && executorRaw !== "http") {
    throw new Error('MASSIVENET_EXECUTOR must be either "stub" or "http"');
  }

  const localExecutorUrl = (env.MASSIVENET_LOCAL_EXECUTOR_URL ?? "").trim();
  if (executorRaw === "http" && !localExecutorUrl) {
    throw new Error("MASSIVENET_LOCAL_EXECUTOR_URL is required when MASSIVENET_EXECUTOR=http");
  }

  const nodeToken = parseOptionalString(env.MASSIVENET_NODE_TOKEN);
  const providerApiKey = parseOptionalString(env.MASSIVENET_PROVIDER_API_KEY);
  const inviteToken = parseOptionalString(env.MASSIVENET_INVITE_TOKEN);
  const nodeName = parseOptionalString(env.MASSIVENET_NODE_NAME);
  const credentialPath =
    parseOptionalString(env.MASSIVENET_NODE_CREDENTIALS_PATH) ??
    path.join(process.cwd(), DEFAULT_CREDENTIAL_FILENAME);

  if (!nodeToken && !providerApiKey && !inviteToken && !nodeName) {
    throw new Error(
      "Either MASSIVENET_NODE_TOKEN must be set, or MASSIVENET_PROVIDER_API_KEY + MASSIVENET_INVITE_TOKEN + MASSIVENET_NODE_NAME must be set",
    );
  }

  const bootstrapFields = [
    { key: "MASSIVENET_PROVIDER_API_KEY", value: providerApiKey },
    { key: "MASSIVENET_INVITE_TOKEN", value: inviteToken },
    { key: "MASSIVENET_NODE_NAME", value: nodeName },
  ];
  const hasBootstrapFields = bootstrapFields.some((field) => Boolean(field.value));
  if (hasBootstrapFields && bootstrapFields.some((field) => !field.value)) {
    const missing = bootstrapFields
      .filter((field) => !field.value)
      .map((field) => field.key)
      .join(", ");
    throw new Error(`Bootstrap configuration incomplete; missing ${missing}`);
  }

  return {
    baseUrl,
    nodeToken,
    providerApiKey,
    inviteToken,
    nodeName,
    nodeCapabilities: parseCapabilities(env.MASSIVENET_NODE_CAPABILITIES_JSON),
    payoutAddressSolana: parseNullableString(env.MASSIVENET_PAYOUT_ADDRESS_SOLANA),
    payoutAddressEthereum: parseNullableString(env.MASSIVENET_PAYOUT_ADDRESS_ETHEREUM),
    credentialPath,
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

export function buildProviderAuthHeaders(providerApiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${providerApiKey}` };
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

function extractErrorMessage(parsed: unknown, fallback: string): string {
  if (typeof parsed === "string" && parsed.trim()) {
    return parsed.trim();
  }
  if (!isRecord(parsed)) {
    return fallback;
  }
  const candidates = [parsed.detail, parsed.message, parsed.error];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return fallback;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const text = await response.clone().text();
  let parsed: unknown = text;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  throw new MassiveNetHttpError(action, response.status, extractErrorMessage(parsed, response.statusText), parsed);
}

function normalizePersistedNodeCredentials(
  value: unknown,
  savedAtFallback: string,
): PersistedNodeCredentials {
  if (!isRecord(value)) {
    throw new Error("Invalid node credentials file");
  }
  if (
    typeof value.node_id !== "number" ||
    typeof value.account_id !== "number" ||
    typeof value.shard_id !== "number" ||
    typeof value.status !== "string" ||
    typeof value.node_token !== "string"
  ) {
    throw new Error("Invalid node credentials file");
  }
  return {
    node_id: value.node_id,
    account_id: value.account_id,
    shard_id: value.shard_id,
    status: value.status,
    node_token: value.node_token,
    saved_at: typeof value.saved_at === "string" ? value.saved_at : savedAtFallback,
  };
}

export async function loadPersistedNodeCredentials(
  credentialPath: string,
): Promise<PersistedNodeCredentials | null> {
  try {
    const raw = await fs.readFile(credentialPath, "utf8");
    return normalizePersistedNodeCredentials(JSON.parse(raw) as unknown, new Date().toISOString());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function savePersistedNodeCredentials(
  credentialPath: string,
  credentials: Omit<PersistedNodeCredentials, "saved_at">,
  nowIso = new Date().toISOString(),
): Promise<PersistedNodeCredentials> {
  const persisted: PersistedNodeCredentials = { ...credentials, saved_at: nowIso };
  await fs.mkdir(path.dirname(credentialPath), { recursive: true });
  await fs.writeFile(credentialPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return persisted;
}

export async function deletePersistedNodeCredentials(credentialPath: string): Promise<void> {
  try {
    await fs.unlink(credentialPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function buildEnvNodeCredentials(nodeToken: string, nowIso: string): PersistedNodeCredentials {
  return {
    node_id: -1,
    account_id: -1,
    shard_id: -1,
    status: "unknown",
    node_token: nodeToken,
    saved_at: nowIso,
  };
}

function hasBootstrapConfig(cfg: MassiveNetProviderNodeConfig): boolean {
  return Boolean(cfg.providerApiKey && cfg.inviteToken && cfg.nodeName);
}

function isBootstrapHardFailure(error: unknown): boolean {
  return (
    error instanceof MassiveNetHttpError &&
    [400, 401, 403, 409].includes(error.status)
  );
}

function isFatalNodeAuthError(error: unknown): boolean {
  if (!(error instanceof MassiveNetHttpError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.status === 401 ||
    message.includes("node shard mismatch") ||
    message.includes("missing or invalid node token") ||
    message.includes("node is disabled")
  );
}

export async function registerNode(params: {
  fetchFn: typeof fetch;
  baseUrl: string;
  providerApiKey: string;
  inviteToken: string;
  nodeName: string;
  capabilities: Record<string, unknown>;
  payoutAddressSolana: string | null;
  payoutAddressEthereum: string | null;
}): Promise<Omit<PersistedNodeCredentials, "saved_at">> {
  const response = await params.fetchFn(`${params.baseUrl}/v1/nodes/register`, {
    method: "POST",
    headers: {
      ...buildProviderAuthHeaders(params.providerApiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.nodeName,
      capabilities: params.capabilities,
      invite_token: params.inviteToken,
      payout_address_solana: params.payoutAddressSolana,
      payout_address_ethereum: params.payoutAddressEthereum,
    }),
  });
  await assertOk(response, "register");
  const parsed = await parseJson(response);
  const credentials = normalizePersistedNodeCredentials(parsed, new Date().toISOString());
  return {
    node_id: credentials.node_id,
    account_id: credentials.account_id,
    shard_id: credentials.shard_id,
    status: credentials.status,
    node_token: credentials.node_token,
  };
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
  await assertOk(response, "node sanity check");
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
  await assertOk(response, "heartbeat");
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
  await assertOk(response, "poll");
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
  await assertOk(response, "payload_ref fetch");
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
  await assertOk(response, "local executor");
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
  await assertOk(response, "complete");
}

export async function prepareNodeRuntimeAccess(params: {
  fetchFn: typeof fetch;
  cfg: MassiveNetProviderNodeConfig;
  nowIso?: string;
}): Promise<RuntimeNodeAccess> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const persisted = await loadPersistedNodeCredentials(params.cfg.credentialPath);
  if (persisted?.node_token) {
    return { credentials: persisted, source: "persisted" };
  }

  if (params.cfg.nodeToken) {
    return { credentials: buildEnvNodeCredentials(params.cfg.nodeToken, nowIso), source: "env" };
  }

  if (!hasBootstrapConfig(params.cfg)) {
    throw new Error(
      `No node token available and bootstrap configuration is incomplete. Expected persisted credentials at ${params.cfg.credentialPath} or MASSIVENET_PROVIDER_API_KEY + MASSIVENET_INVITE_TOKEN + MASSIVENET_NODE_NAME`,
    );
  }

  try {
    const registered = await registerNode({
      fetchFn: params.fetchFn,
      baseUrl: params.cfg.baseUrl,
      providerApiKey: params.cfg.providerApiKey ?? "",
      inviteToken: params.cfg.inviteToken ?? "",
      nodeName: params.cfg.nodeName ?? "",
      capabilities: params.cfg.nodeCapabilities,
      payoutAddressSolana: params.cfg.payoutAddressSolana,
      payoutAddressEthereum: params.cfg.payoutAddressEthereum,
    });
    const saved = await savePersistedNodeCredentials(params.cfg.credentialPath, registered, nowIso);
    return { credentials: saved, source: "bootstrap" };
  } catch (error) {
    if (isBootstrapHardFailure(error)) {
      throw new Error(`Bootstrap registration failed and requires operator action: ${toErrorMessage(error)}`);
    }
    throw error;
  }
}

type PollOutcome = "worked" | "idle" | "error";

export class MassiveNetProviderNodeWorker {
  private readonly cfg: MassiveNetProviderNodeConfig;

  private readonly logger: LogWriter;

  private readonly deps: WorkerDependencies;

  private stopped = false;

  private backoffMs: number;

  private runtimeAccess: RuntimeNodeAccess | null = null;

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

  private getNodeToken(): string {
    if (!this.runtimeAccess?.credentials.node_token) {
      throw new Error("Node credentials not initialized");
    }
    return this.runtimeAccess.credentials.node_token;
  }

  private async bootstrapOrLoadNodeAccess(): Promise<void> {
    this.runtimeAccess = await prepareNodeRuntimeAccess({
      fetchFn: this.deps.fetchFn,
      cfg: this.cfg,
      nowIso: new Date(this.deps.nowMs()).toISOString(),
    });
    this.emit("info", "node_credentials_ready", {
      source: this.runtimeAccess.source,
      credential_path: this.cfg.credentialPath,
      node_id: this.runtimeAccess.credentials.node_id,
      shard_id: this.runtimeAccess.credentials.shard_id,
    });
  }

  private async sanityCheck(): Promise<void> {
    const profile = await fetchNodeIdentity({
      fetchFn: this.deps.fetchFn,
      baseUrl: this.cfg.baseUrl,
      nodeToken: this.getNodeToken(),
    });
    this.emit("info", "startup_sanity_check_success", {
      node_profile: profile,
      node_access_source: this.runtimeAccess?.source,
    });
  }

  private async recoverFromInvalidNodeToken(error: unknown): Promise<boolean> {
    if (!isFatalNodeAuthError(error) || !hasBootstrapConfig(this.cfg) || this.stopped) {
      return false;
    }

    this.emit("warn", "node_token_rebootstrap_start", {
      source: this.runtimeAccess?.source,
      error: toErrorMessage(error),
    });

    if (this.runtimeAccess?.source === "persisted" || this.runtimeAccess?.source === "bootstrap") {
      await deletePersistedNodeCredentials(this.cfg.credentialPath);
    }

    try {
      const registered = await registerNode({
        fetchFn: this.deps.fetchFn,
        baseUrl: this.cfg.baseUrl,
        providerApiKey: this.cfg.providerApiKey ?? "",
        inviteToken: this.cfg.inviteToken ?? "",
        nodeName: this.cfg.nodeName ?? "",
        capabilities: this.cfg.nodeCapabilities,
        payoutAddressSolana: this.cfg.payoutAddressSolana,
        payoutAddressEthereum: this.cfg.payoutAddressEthereum,
      });
      const saved = await savePersistedNodeCredentials(
        this.cfg.credentialPath,
        registered,
        new Date(this.deps.nowMs()).toISOString(),
      );
      this.runtimeAccess = { credentials: saved, source: "bootstrap" };
      this.emit("info", "node_token_rebootstrap_success", {
        credential_path: this.cfg.credentialPath,
        node_id: saved.node_id,
        shard_id: saved.shard_id,
      });
      return true;
    } catch (registrationError) {
      throw new Error(
        `Node token is no longer valid and automatic re-bootstrap failed: ${toErrorMessage(registrationError)}`,
      );
    }
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
        nodeToken: this.getNodeToken(),
      });
      this.emit("info", "heartbeat_success");
    } catch (error) {
      if (isFatalNodeAuthError(error)) {
        throw error;
      }
      this.emit("warn", "heartbeat_failure", { error: toErrorMessage(error) });
    }

    let job: JobEnvelope | null = null;
    try {
      job = await pollNodeJob({
        fetchFn: this.deps.fetchFn,
        baseUrl: this.cfg.baseUrl,
        nodeToken: this.getNodeToken(),
      });
      this.emit("info", "poll_success", { has_job: Boolean(job) });
    } catch (error) {
      if (isFatalNodeAuthError(error)) {
        throw error;
      }
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
        nodeToken: this.getNodeToken(),
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
          nodeToken: this.getNodeToken(),
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
        if (isFatalNodeAuthError(error)) {
          throw error;
        }
        this.emit("error", "complete_failure", { job_id: jobId, error: toErrorMessage(error) });
      }
    } catch (error) {
      if (isFatalNodeAuthError(error)) {
        throw error;
      }

      const errorMessage = toErrorMessage(error);
      this.emit("error", "execute_failure", { job_id: jobId, error: errorMessage });

      try {
        await completeNodeJob({
          fetchFn: this.deps.fetchFn,
          baseUrl: this.cfg.baseUrl,
          nodeToken: this.getNodeToken(),
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
        if (isFatalNodeAuthError(completionError)) {
          throw completionError;
        }
        this.emit("error", "complete_failure", { job_id: jobId, error: toErrorMessage(completionError) });
      }
    }

    return "worked";
  }

  async run(): Promise<void> {
    this.emit("info", "worker_start", { executor: this.cfg.executor });

    await this.bootstrapOrLoadNodeAccess();

    try {
      await this.sanityCheck();
    } catch (error) {
      const recovered = await this.recoverFromInvalidNodeToken(error);
      if (!recovered) {
        throw error;
      }
      await this.sanityCheck();
    }

    while (!this.stopped) {
      try {
        const outcome = await this.pollAndProcessOnce();
        if (outcome === "worked") {
          this.backoffMs = this.cfg.pollIntervalMs;
          continue;
        }
        await this.sleepWithBackoff(true);
      } catch (error) {
        const recovered = await this.recoverFromInvalidNodeToken(error);
        if (recovered) {
          this.backoffMs = this.cfg.pollIntervalMs;
          continue;
        }
        throw error;
      }
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
          ctx.logger.error(`[massivenet_provider_node] worker stopped: ${toErrorMessage(error)}`);
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
