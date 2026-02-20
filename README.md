# MassiveNet OpenClaw Provider Node Plugin

Standalone public OpenClaw plugin that runs a MassiveNet provider-node worker loop.

The worker:
- validates startup identity with `GET /v1/nodes/me`
- sends heartbeats with `POST /v1/nodes/heartbeat`
- polls jobs with `POST /v1/nodes/poll`
- fetches payloads via `payload_ref` when present
- executes jobs via `stub` or `http` executor
- completes jobs with node-token auth at `POST /v1/nodes/jobs/{job_id}/complete`

## Install

### Local plugin install (recommended while developing)
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

### ClawHub-ready wording
This plugin follows OpenClaw plugin packaging (`openclaw.extensions` + `openclaw.plugin.json`) and is suitable for registry/ClawHub style installation once published.

## Environment Variables

Required:
- `MASSIVENET_BASE_URL`
- `MASSIVENET_NODE_TOKEN`

Optional:
- `MASSIVENET_POLL_INTERVAL_MS` (default `500`)
- `MASSIVENET_BACKOFF_MAX_MS` (default `5000`)
- `MASSIVENET_EXECUTOR` (default `stub`) values: `stub` or `http`
- `MASSIVENET_LOCAL_EXECUTOR_URL` (required when `MASSIVENET_EXECUTOR=http`)
- `MASSIVENET_LOG_JSON` (default `true`)

## Executors

`stub`:
- chat jobs return:
  - `result_text: "Stub response from MassiveNet provider node."`
- image jobs return:
  - `output_urls: ["https://example.com/stub-output.png"]`

`http`:
- sends `payload_json` (or direct job input) as JSON `POST` body to `MASSIVENET_LOCAL_EXECUTOR_URL`
- expects:
  - chat: `{ "result_text": "..." }`
  - image: `{ "output_urls": ["..."] }`

## Example Configuration

```bash
MASSIVENET_BASE_URL=https://api.massivenet.example
MASSIVENET_NODE_TOKEN=replace-with-node-token
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

## Security Note

- This repository intentionally does not include MassiveNet internal secrets.
- Job completion uses node-token bearer auth only:
  - `Authorization: Bearer {MASSIVENET_NODE_TOKEN}`
  - `POST {BASE_URL}/v1/nodes/jobs/{job_id}/complete`
