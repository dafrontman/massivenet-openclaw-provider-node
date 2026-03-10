# MassiveNet OpenClaw Provider Node Plugin

Standalone public OpenClaw plugin that runs a MassiveNet provider-node worker loop.

The worker now supports fresh-node bootstrap against MassiveNet:

- loads persisted node credentials when available
- otherwise registers with `POST /v1/nodes/register` using provider API key auth plus invite token
- persists returned `node_id`, `account_id`, `shard_id`, `status`, and `node_token`
- validates startup identity with `GET /v1/nodes/me`
- sends heartbeats with `POST /v1/nodes/heartbeat`
- polls jobs with `POST /v1/nodes/poll`
- fetches payloads via `payload_ref` when present
- executes jobs via `stub` or `http` executor
- completes jobs with node-token auth at `POST /v1/nodes/jobs/{job_id}/complete`

## Install

### Local plugin install
1. Clone this repo locally.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install the plugin into OpenClaw:
   ```bash
   openclaw plugins install <path-to-this-repo>
   ```
4. Enable plugin entry if needed:
   ```bash
   openclaw plugins enable massivenet_provider_node
   ```

## Bootstrap Flow

On startup the plugin resolves node credentials in this order:

1. persisted credential file at `MASSIVENET_NODE_CREDENTIALS_PATH`
2. `MASSIVENET_NODE_TOKEN` if explicitly supplied
3. bootstrap registration via `POST /v1/nodes/register`

If bootstrap registration is needed, the plugin sends this request shape to MassiveNet:

```json
{
  "name": "provider-node-01",
  "capabilities": {
    "gpu": true,
    "vram_gb": 24,
    "max_concurrency": 2,
    "models_supported": ["kimi-k2.5"],
    "backends_supported": ["vllm"]
  },
  "invite_token": "invite-token-here",
  "payout_address_solana": null,
  "payout_address_ethereum": null
}
```

Registration auth uses:

```text
Authorization: Bearer <MASSIVENET_PROVIDER_API_KEY>
```

If the runtime node token later becomes invalid and bootstrap credentials are configured, the plugin clears the persisted credentials and re-registers automatically. Hard bootstrap/auth failures such as invalid API key, bad invite token, or invalid node token are surfaced as worker stop errors instead of silent infinite retry.

## Environment Variables

Required in all modes:

- `MASSIVENET_BASE_URL`

Runtime token mode:

- `MASSIVENET_NODE_TOKEN`

Fresh bootstrap mode:

- `MASSIVENET_PROVIDER_API_KEY`
- `MASSIVENET_INVITE_TOKEN`
- `MASSIVENET_NODE_NAME`

Optional:

- `MASSIVENET_NODE_CREDENTIALS_PATH`
  - default: `<repo-or-process-cwd>/.massivenet-node-credentials.json`
- `MASSIVENET_NODE_CAPABILITIES_JSON`
  - JSON object sent as the registration `capabilities` field
- `MASSIVENET_PAYOUT_ADDRESS_SOLANA`
- `MASSIVENET_PAYOUT_ADDRESS_ETHEREUM`
- `MASSIVENET_POLL_INTERVAL_MS` default `500`
- `MASSIVENET_BACKOFF_MAX_MS` default `5000`
- `MASSIVENET_EXECUTOR` default `stub`, values: `stub` or `http`
- `MASSIVENET_LOCAL_EXECUTOR_URL` required when `MASSIVENET_EXECUTOR=http`
- `MASSIVENET_LOG_JSON` default `true`

## Persisted Credentials

After successful registration the plugin writes a JSON file containing:

```json
{
  "node_id": 12,
  "account_id": 34,
  "shard_id": 0,
  "status": "online",
  "node_token": "mnn.<payload>.<signature>",
  "saved_at": "2026-03-10T15:10:00.000Z"
}
```

This file is reused on later startups. If the token is rejected by MassiveNet and bootstrap credentials are present, the file is deleted and replaced with a newly registered node token.

## Executors

`stub`:

- chat jobs return `result_text: "Stub response from MassiveNet provider node."`
- image jobs return `output_urls: ["https://example.com/stub-output.png"]`

`http`:

- sends `payload_json` or inline job input as JSON `POST` body to `MASSIVENET_LOCAL_EXECUTOR_URL`
- expects:
  - chat: `{ "result_text": "..." }`
  - image: `{ "output_urls": ["..."] }`

## Example Bootstrap Configuration

```bash
MASSIVENET_BASE_URL=https://api.massivenet.example
MASSIVENET_PROVIDER_API_KEY=replace-with-provider-api-key
MASSIVENET_INVITE_TOKEN=replace-with-invite-token
MASSIVENET_NODE_NAME=provider-node-01
MASSIVENET_NODE_CAPABILITIES_JSON={"gpu":true,"vram_gb":24,"max_concurrency":2,"models_supported":["kimi-k2.5"],"backends_supported":["vllm"]}
MASSIVENET_NODE_CREDENTIALS_PATH=.massivenet-node-credentials.json
MASSIVENET_EXECUTOR=stub
MASSIVENET_POLL_INTERVAL_MS=500
MASSIVENET_BACKOFF_MAX_MS=5000
MASSIVENET_LOG_JSON=true
```

For HTTP executor:

```bash
MASSIVENET_EXECUTOR=http
MASSIVENET_LOCAL_EXECUTOR_URL=http://127.0.0.1:3001/execute
```

## Operational Notes

- Registration requires a valid provider API key from the same MassiveNet instance.
- Registration requires a valid invite token.
- Newly registered nodes begin in probation per the MassiveNet control-plane contract.
- Distributed polling can still work during probation, but routing eligibility may require admin promotion.
