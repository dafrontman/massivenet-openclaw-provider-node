# MassiveNet Compatibility Audit

Date: 2026-03-10

Assessment: mostly ready

## Implemented

- Bootstrap registration via `POST /v1/nodes/register` with provider API key bearer auth.
- Invite token support via request body field `invite_token`.
- Persistence of returned `node_id`, `account_id`, `shard_id`, `status`, and `node_token`.
- Startup credential resolution in this order:
  1. persisted credential file
  2. explicit `MASSIVENET_NODE_TOKEN`
  3. bootstrap registration
- Startup sanity check with `GET /v1/nodes/me`.
- Runtime heartbeat, poll, input fetch, and completion flow using node-token auth.
- Automatic re-bootstrap when MassiveNet clearly rejects the stored runtime token and bootstrap credentials are available.
- Hard bootstrap and node-auth failures stop the worker clearly instead of retrying forever.

## Current Protocol Alignment

- `POST /v1/nodes/register`: implemented with exact field names used by the control-plane contract.
- `POST /v1/nodes/heartbeat`: implemented with valid empty JSON body.
- `POST /v1/nodes/poll`: implemented.
- `GET /v1/nodes/jobs/{job_id}/input`: implemented through `payload_ref` resolution.
- `POST /v1/nodes/jobs/{job_id}/complete`: implemented.

## Remaining Gaps

- Heartbeat still sends `{}` and does not report dynamic `capabilities` or `rtt_ms`. This is protocol-valid but minimal.
- Completion still ignores the `already_finalized` response field.
- Shutdown still does not actively cancel in-flight fetch or sleep operations.
- No end-to-end integration test exists against a live or mocked MassiveNet control plane; current coverage is focused unit coverage.

## Readiness Verdict

This repo now has the minimum provider-side bootstrap and runtime behavior required to connect as a fresh MassiveNet node under the documented protocol. Remaining items are operational polish rather than protocol blockers, so the repo is best described as mostly ready pending live integration validation.
