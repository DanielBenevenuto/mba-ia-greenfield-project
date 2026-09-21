# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ + Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Videos (Phase 03)

Upload, background processing and playback live in `nestjs-project/src/videos/`, with the object-storage adapter in `nestjs-project/src/storage/`. Full decision record: [docs/decisions/technical-decisions-phase-03-videos.md](docs/decisions/technical-decisions-phase-03-videos.md); plan: [docs/phases/phase-03-videos/phase-03-videos.md](docs/phases/phase-03-videos/phase-03-videos.md).

### Upload never passes through the API

A single S3 `PUT` caps at 5GB, so the 10GB requirement is met with **multipart upload + one presigned URL per part**. The handshake is three steps:

1. `POST /videos/uploads` — pre-registers the video as a **draft**, opens the multipart session and returns `upload_id` plus one presigned URL per part.
2. The client `PUT`s each part **straight to object storage**. The bytes never reach this API.
3. `POST /videos/{id}/uploads/{uploadId}/complete` — sends the parts' ETags, closes the multipart, flips the video to `processing` and enqueues the job. `DELETE /videos/{id}/uploads/{uploadId}` aborts instead.

### Video status lifecycle

`draft` → `processing` → `ready` | `failed`, persisted on `videos.status`. Jobs retry three times with exponential backoff; only after the last attempt fails does the video move to `failed`, with the reason stored in `videos.processing_error`. The source object is kept so the video stays auditable and can be reprocessed.

### Endpoints

| Method | Path | Auth |
|---|---|---|
| POST | `/videos/uploads` | authenticated |
| POST | `/videos/{id}/uploads/{uploadId}/complete` | owner channel |
| DELETE | `/videos/{id}/uploads/{uploadId}` | owner channel |
| GET | `/videos/{publicId}` | public when `ready`, else owner only |
| GET | `/videos/{publicId}/stream` | public when `ready`, else owner only |
| GET | `/videos/{publicId}/download` | public when `ready`, else owner only |

A video that is not `ready` answers `404` to anyone but its owning channel, so the endpoint does not leak its existence; the owner gets `409 VIDEO_NOT_READY`.

### Unique URL

Each video gets an 11-character base62 `public_id` generated with `node:crypto` (`src/videos/public-id.util.ts`) and backed by a unique index — that index, not the odds, is the guarantee of "never conflicts". `nanoid` is deliberately **not** used: it is ESM-only and this project builds as CommonJS.

### Streaming vs download

- **Streaming** (`/stream`) is proxied by the API: it forwards the `Range` header to storage and answers `206 Partial Content` with `Content-Range`, piping the stream so memory stays flat. Playback starts without downloading the whole file, and authorization is re-checked on every request.
- **Download** (`/download`) answers `302` to a short-lived presigned URL carrying `Content-Disposition: attachment`. The bulk transfer is offloaded to storage.

### Queue and worker

BullMQ over Redis (`@nestjs/bullmq`). The API only **produces** jobs; the `video-worker` Compose service is the only **consumer**, running the same codebase from a different entrypoint (`src/worker.main.ts` + `src/worker.module.ts`) so ffmpeg never competes with the HTTP event loop. Job `process-video` on queue `video-processing` carries only `{ videoId }` — the worker re-reads the row, which makes redelivery idempotent.

The worker feeds a **presigned URL** to `ffprobe`/`ffmpeg` instead of a local path, so even a 10GB source is read over HTTP Range and never lands on the worker's disk.

### Object storage

One bucket, prefixed keys: `videos/{videoId}/source/{filename}` and `thumbnails/{videoId}/poster.jpg`. MinIO locally, S3 in production — only env vars change.

**Two endpoints, deliberately.** `S3_ENDPOINT` is used for server-to-server calls and must be the Compose service name (`http://minio:9000`). `S3_PUBLIC_ENDPOINT` is used **only** to sign URLs handed to clients; SigV4 signs the Host header, so a URL signed with the internal endpoint is rejected when the caller resolves a different host. Set it to a host-reachable address (e.g. `http://localhost:9000`) when a browser outside the Compose network must follow the presigned URLs.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.