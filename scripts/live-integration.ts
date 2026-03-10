import path from "node:path";
import {
  completeNodeJob,
  executeStubJob,
  fetchNodeIdentity,
  pollNodeJob,
  prepareNodeRuntimeAccess,
  resolveJobInput,
  resolveMassiveNetProviderNodeConfig,
  sendHeartbeat,
} from "../src/service.js";

type StepStatus = "passed" | "skipped";

type StepResult = {
  step: string;
  status: StepStatus;
  detail: string;
};

function ensureEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the live integration script`);
  }
  return value;
}

function printStep(result: StepResult): void {
  const label = result.status === "passed" ? "PASS" : "SKIP";
  console.log(`[${label}] ${result.step}: ${result.detail}`);
}

function normalizeJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Assigned job is missing a string id");
  }
  return value.trim();
}

function normalizeJobKind(value: unknown): "chat" | "image" {
  if (typeof value !== "string") {
    throw new Error("Assigned job is missing kind");
  }
  const kind = value.trim().toLowerCase();
  if (kind === "chat") {
    return "chat";
  }
  if (kind === "image" || kind.includes("image")) {
    return "image";
  }
  throw new Error(`Unsupported job kind in integration script: ${kind}`);
}

async function main(): Promise<void> {
  ensureEnv("MASSIVENET_BASE_URL");
  ensureEnv("MASSIVENET_PROVIDER_API_KEY");
  ensureEnv("MASSIVENET_INVITE_TOKEN");

  if (!process.env.MASSIVENET_NODE_NAME?.trim()) {
    process.env.MASSIVENET_NODE_NAME = `provider-node-integration-${process.pid}`;
  }

  if (!process.env.MASSIVENET_NODE_CREDENTIALS_PATH?.trim()) {
    process.env.MASSIVENET_NODE_CREDENTIALS_PATH = path.join(
      process.cwd(),
      ".massivenet-node-credentials.integration.json",
    );
  }

  if (!process.env.MASSIVENET_EXECUTOR?.trim()) {
    process.env.MASSIVENET_EXECUTOR = "stub";
  }

  const cfg = resolveMassiveNetProviderNodeConfig(process.env);
  const results: StepResult[] = [];

  console.log("MassiveNet live integration target:");
  console.log(`- base URL: ${cfg.baseUrl}`);
  console.log(`- node name: ${cfg.nodeName ?? "(unset)"}`);
  console.log(`- credentials file: ${cfg.credentialPath}`);
  console.log(`- executor: ${cfg.executor}`);
  console.log("- expected control plane mode: dev/local, not Smooth-5K load-test mode");

  const runtimeAccess = await prepareNodeRuntimeAccess({
    fetchFn: fetch,
    cfg,
  });
  results.push({
    step: "register_or_load",
    status: "passed",
    detail: `node credentials ready from ${runtimeAccess.source}; node_id=${runtimeAccess.credentials.node_id}, shard_id=${runtimeAccess.credentials.shard_id}`,
  });

  const nodeToken = runtimeAccess.credentials.node_token;
  const profile = await fetchNodeIdentity({
    fetchFn: fetch,
    baseUrl: cfg.baseUrl,
    nodeToken,
  });
  results.push({
    step: "node_identity",
    status: "passed",
    detail: `GET /v1/nodes/me succeeded; status=${JSON.stringify(profile.status ?? "unknown")}`,
  });

  await sendHeartbeat({
    fetchFn: fetch,
    baseUrl: cfg.baseUrl,
    nodeToken,
  });
  results.push({
    step: "heartbeat",
    status: "passed",
    detail: "POST /v1/nodes/heartbeat succeeded",
  });

  const job = await pollNodeJob({
    fetchFn: fetch,
    baseUrl: cfg.baseUrl,
    nodeToken,
  });

  if (!job) {
    results.push({
      step: "poll",
      status: "passed",
      detail: 'POST /v1/nodes/poll succeeded and returned {"job": null}',
    });
    results.push({
      step: "job_input_fetch",
      status: "skipped",
      detail: "No job was assigned by the dev control plane",
    });
    results.push({
      step: "job_complete",
      status: "skipped",
      detail: "No job was assigned by the dev control plane",
    });
  } else {
    const jobId = normalizeJobId(job.id);
    const jobKind = normalizeJobKind(job.kind);
    results.push({
      step: "poll",
      status: "passed",
      detail: `POST /v1/nodes/poll assigned job ${jobId} (${jobKind})`,
    });

    const input = await resolveJobInput({
      fetchFn: fetch,
      baseUrl: cfg.baseUrl,
      nodeToken,
      job,
    });
    results.push({
      step: "job_input_fetch",
      status: "passed",
      detail: `Resolved assigned job input keys: ${Object.keys(input).join(", ") || "(empty object)"}`,
    });

    const result = executeStubJob(jobKind);
    await completeNodeJob({
      fetchFn: fetch,
      baseUrl: cfg.baseUrl,
      nodeToken,
      jobId,
      body: {
        status: "succeeded",
        ...(jobKind === "chat" && "result_text" in result ? { result_text: result.result_text } : {}),
        ...(jobKind === "image" && "output_urls" in result ? { output_urls: result.output_urls } : {}),
        metrics: {
          executor: "stub",
          integration_script: "live-integration.ts",
        },
      },
    });
    results.push({
      step: "job_complete",
      status: "passed",
      detail: `POST /v1/nodes/jobs/${jobId}/complete succeeded using stub output`,
    });
  }

  console.log("");
  console.log("MassiveNet provider live integration results:");
  for (const result of results) {
    printStep(result);
  }

  console.log("");
  console.log("Control-plane contract summary:");
  console.log(`- registration/bootstrap: satisfied via ${runtimeAccess.source}`);
  console.log("- node auth sanity check: satisfied");
  console.log("- heartbeat: satisfied");
  console.log("- poll: satisfied");
  console.log(`- input fetch: ${job ? "satisfied" : "not exercised (no job assigned)"}`);
  console.log(`- completion: ${job ? "satisfied" : "not exercised (no job assigned)"}`);
}

void main().catch((error: unknown) => {
  let message = error instanceof Error ? error.stack ?? error.message : String(error);
  if (error instanceof TypeError && error.message.includes("fetch failed")) {
    message = `${message}\n\nEnsure MASSIVENET_BASE_URL points to a reachable MassiveNet dev/local control plane and that Smooth-5K load-test mode is disabled.`;
  }
  console.error("MassiveNet live integration failed:");
  console.error(message);
  process.exitCode = 1;
});
