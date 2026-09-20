---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T17:59:59.253833+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T17:56:31.676718+00:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-filesystem storage; project-plan fixes S3/MinIO"
    resolved_by: phase-03-videos/TD-11
  - id: AMB-1
    status: resolved
    summary: "Stream/download endpoints: anonymous access or authenticated only?"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration: which fields does the client supply and is title required?"
    resolved_by: phase-03-videos/TD-04
  - id: DG-1
    status: resolved
    summary: "migrations.integration-spec.ts is not re-runnable (orphan enum type)"
    resolved_by: clarification
  - id: DG-2
    status: resolved
    summary: "ChannelsService has no lookup by user id; videos need the owner channel"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Object Storage Client and Bucket/Key Organization"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Background Processing Queue Technology"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Large-File Upload Protocol (up to 10GB)"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Upload Session Lifecycle and Draft Pre-registration"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Metadata Extraction and Thumbnail Generation Toolchain"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Unique Video URL Identifier Strategy"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming Delivery Strategy"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Download Delivery Strategy"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle and Processing Failure Policy"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Test Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-11
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ — every capability bullet in `## Capability Coverage` maps to at least one TD, and the HTTP error-response contract is already fixed by the inherited `phase-02-auth/TD-07`.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent from context.md (no capability bullet of Phase 03 matches UI phrasing), so `UIG-N` is not a concept for this phase.

## Resolved Issues

_(audit trail — never removed)_

- **IC-1** _(resolved_by phase-03-videos/TD-11)_ — The testing guide's "Object Storage — Local Filesystem" section contradicted `docs/project-plan.md` and the architecture diagram. Resolution: the Phase 03 TDs prevail — MinIO runs in Compose and is exercised by integration/E2E tests, because presigned multipart upload has no local-filesystem equivalent and the phase brief forbids mocking what the Compose infra can test for real. TD-11's `**Decision:**` records the override, and the guide's Object Storage section is updated to MinIO as a deliverable of this phase.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — Authorization for the playback/download surface. Resolution: `GET /videos/{publicId}`, `GET /videos/{publicId}/stream` and `GET /videos/{publicId}/download` are `@Public()` when the video's `status = ready`; a video in any other status is visible only to its owning channel. Recorded in the `**Decision:**` fields of TD-08 and TD-09. Matches the platform statement "Usuários anônimos podem assistir livremente" while leaving the público/unlisted visibility model to Fase 04.
- **AMB-2** _(resolved_by phase-03-videos/TD-04)_ — Payload of the draft pre-registration. Resolution: the client sends `filename`, `size_bytes` and `content_type`; the title is derived from the filename so a draft is never unlabelled, and becomes editable in Fase 04. Recorded in TD-04's `**Decision:**`.
- **DG-1** _(resolved_by clarification)_ — `src/database/migrations.integration-spec.ts` is not re-runnable because its teardown leaves the orphan `verification_tokens_type_enum`. Resolution: the SI of Phase 03 that adds the videos migration also extends that spec's setup to drop enum types (`DROP TYPE IF EXISTS ... CASCADE`), making the suite repeatably green. No TD needed — this is an implementation obligation carried into the plan's Step Implementations and Deliverables.
- **DG-2** _(resolved_by clarification)_ — `ChannelsService` exposes no lookup by user id, so the videos module could not resolve the owner channel from the JWT `sub`. Resolution: Phase 03 adds `findByUserId(userId)` to `ChannelsService` and `VideosModule` imports `ChannelsModule`, keeping channel access inside the channels module per the Single Responsibility principle in `CLAUDE.md`. No TD needed — implementation obligation carried into the plan.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: A (`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, single bucket with prefixes, internal + public endpoint).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: A (BullMQ + Redis via `@nestjs/bullmq`).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: C (multipart upload with one presigned URL per part).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: A (upload-session state on the video row).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: A (separate process, same codebase, own entrypoint).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: A (`execFile` straight to `ffprobe`/`ffmpeg`, presigned URL as input).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: A (11-char base62 via `crypto.randomBytes`, unique column).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: A (API proxies the Range and answers 206).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: A (302 to a presigned URL carrying `Content-Disposition: attachment`).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided: A (`draft | processing | ready | failed` + retry with backoff + `processing_error`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: A (test pyramid against the real Compose infra, ffmpeg-generated fixture).
