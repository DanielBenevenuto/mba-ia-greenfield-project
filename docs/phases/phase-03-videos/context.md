---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T17:34:49.905519+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T18:23:19.854150+00:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T17:34:49.902910+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T17:58:54.638841+00:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-20T17:34:49.904081+00:00"
  docs/phases/phase-02-auth/context.md: "2026-09-20T17:34:49.905187+00:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-20T17:34:49.904391+00:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-20T17:34:49.862071+00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — project-plan.md names no subproject paths for this phase; all nine capabilities are backend / storage / queue concerns.

**Deferred subprojects:**

- `next-frontend` — no capability bullet of Phase 03 describes a screen. The video UI (player page, upload screen, management panel) belongs to Phases 04 and 05.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — Depende de: Fase 01
- **Phase 04:** Gerenciamento de Vídeos e Canal — Depende de: Fase 02, Fase 03

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Client and Bucket/Key Organization | decided | A (AWS SDK v3, single bucket + prefixes) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | phase | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq, ioredis |
| └─ Last revision: 2026-09-20 — pinned `@nestjs/bullmq@^11.0.5` (12.x is ESM-only) and added `ioredis@^5.9.0` (optional peer of BullMQ 6). | | | | | | |
| phase-03-videos/TD-03 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB) | decided | C (multipart, presigned URL per part) | — |
| phase-03-videos/TD-04 | phase | Backend | Upload Session Lifecycle and Draft Pre-registration | decided | A (session state on the video row) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Runtime Topology | decided | A (separate process, same codebase) | — |
| phase-03-videos/TD-06 | phase | Backend | Metadata Extraction and Thumbnail Generation Toolchain | decided | A (execFile ffprobe/ffmpeg, presigned input) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Unique Video URL Identifier Strategy | decided | A (base62 11-char, unique column) | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming Delivery Strategy | decided | A (API proxies Range, responds 206) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Download Delivery Strategy | decided | A (302 to presigned URL, attachment) | — |
| phase-03-videos/TD-10 | phase | Backend | Video Status Lifecycle and Processing Failure Policy | decided | A (draft/processing/ready/failed + retry) | — |
| phase-03-videos/TD-11 | phase | Backend | Test Strategy for Storage, Queue and Worker | decided | A (pyramid on real Compose infra) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-11 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader; `**Decision:**` lines carried over verbatim because TD-04, TD-08, TD-09 and TD-11 encode the AMB-1 / AMB-2 / IC-1 resolutions applied by `/plan-resolve`)_

### phase-03-videos/TD-01

**Recommendation:** o SDK oficial AWS mantém a promessa de "MinIO em dev, S3 em prod" sem reescrita, e `forcePathStyle` já é o modo que o MinIO espera. Bucket único com prefixo `videos/{videoId}/...` cobre a necessidade desta fase; separar buckets é reversível depois se surgir política divergente. A dupla de endpoints (interno para o servidor, público para assinar) é obrigatória para que o upload direto funcione fora da rede do Compose.
**Decision:** A (`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, bucket único com prefixos, endpoint interno + público)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-02

**Recommendation:** é a única opção com integração NestJS de primeira classe, o que mantém o worker dentro dos padrões que o projeto já usa (módulos, DI, decorators) em vez de exigir cola manual. Retry com backoff exponencial e conjunto de jobs falhos vêm prontos, que é exatamente o que TD-10 precisa para o ciclo de status. O custo — um serviço Redis alpine no Compose — é pequeno perto do ganho. A perda transacional do pg-boss é mitigada pelo fato de que o job é enfileirado **depois** da conclusão do upload, e um vídeo preso em `processing` é recuperável reenfileirando.
**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** bullmq, @nestjs/bullmq, ioredis
**Revisions:**
- 2026-09-20 — Versões fixadas em `@nestjs/bullmq@^11.0.5` (12.x é ESM-only e quebra o build CommonJS) e `ioredis@^5.9.0` adicionado explicitamente (peer opcional do BullMQ 6). Rationale: incompatibilidade de formato de módulo detectada na implementação; a Option A permanece inalterada.

### phase-03-videos/TD-03

**Recommendation:** é a única alternativa que satisfaz simultaneamente o limite de 10GB, a exigência de não passar o arquivo pela API e a infraestrutura de storage já fixada pelo projeto. O custo é um handshake de três passos, que fica documentado como contrato em API Contracts e é consumido pelo frontend na Fase 04/05.
**Decision:** C (multipart upload com URL pré-assinada por parte)
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** o pré-cadastro como rascunho e a sessão de upload são a mesma coisa nesta fase, e modelá-los como uma linha só mantém a migration e as queries triviais. A saída para o cenário de múltiplos uploads (Option B) continua disponível numa fase futura sem retrabalho destrutivo.
**Decision:** A (estado da sessão na própria linha do vídeo) — o pré-cadastro recebe `filename`, `size_bytes` e `content_type`; o título é derivado do filename e passa a ser editável na Fase 04 (resolve AMB-2 de `validation.md`)
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** entrega o container separado que o diagrama prevê pelo preço de um entrypoint adicional, mantendo entidades, config e storage em um lugar só. É também a topologia que os testes conseguem exercitar de verdade: um teste de integração pode instanciar o `WorkerModule` e rodar o processor contra Redis, MinIO e Postgres reais do Compose.
**Decision:** A (processo separado, mesmo codebase, entrypoint próprio)
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** invocar `ffprobe`/`ffmpeg` direto por `execFile`, com os binários instalados via apt na imagem e **a URL pré-assinada como input**. É o único arranjo que garante que um vídeo de 10GB não seja baixado para o disco do worker: o ffprobe lê apenas metadados e o ffmpeg apenas o trecho do frame, via Range HTTP. O wrapper manual é pequeno e o JSON do ffprobe é um contrato estável.
**Decision:** A (`execFile` direto em `ffprobe`/`ffmpeg`, input por URL pré-assinada)
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** resolve a URL curta e não-adivinhável sem adicionar dependência e sem esbarrar na incompatibilidade ESM/CJS do nanoid. A coluna `unique` no Postgres é a garantia real de "sem conflito", e o gerador é uma função pura de fácil teste unitário.
**Decision:** A (base62 de 11 chars via `crypto.randomBytes`, coluna única)
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** o proxy com Range é o que torna a capability diretamente observável (a nossa rota responde `206` de verdade) e mantém a autorização por requisição, que a Fase 04 vai exigir para vídeos unlisted. O custo de banda é aceitável na escala do projeto, e a migração para a Option B (ou para um CDN) depois é trocar o corpo de um handler — o contrato da rota não muda. Emparelha com TD-09, que joga o tráfego pesado de download para fora da API.
**Decision:** A (API faz proxy do Range e responde 206) — acesso público (`@Public()`) quando `status = ready`; vídeos em qualquer outro status são visíveis apenas para o canal dono (resolve AMB-1 de `validation.md`)
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** download é justamente o caso em que o offload para o storage paga mais, e o `Content-Disposition` na assinatura entrega a semântica de "salvar arquivo" sem proxy. A API continua sendo o ponto de autorização: o redirect só é emitido depois de validar o vídeo.
**Decision:** A (302 para URL pré-assinada com `Content-Disposition: attachment`) — mesma regra de acesso da TD-08: público quando `status = ready`, caso contrário apenas o canal dono (resolve AMB-1 de `validation.md`)
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** é o conjunto mínimo que satisfaz literalmente o ciclo exigido, com retry e mensagem de erro persistida. Deixa o caminho aberto para um endpoint de reprocessamento numa fase futura sem mudar o enum.
**Decision:** A (`draft | processing | ready | failed` + retry com backoff + `processing_error`)
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** segue a instrução explícita de testar contra a infra real, mantém a convenção de testes já estabelecida na Fase 02 e evita versionar binário de vídeo. O helper de reescrita de host é pequeno e torna visível uma armadilha real de rede Docker em vez de escondê-la.
**Decision:** A (pirâmide com infra real do Compose, fixture gerada por ffmpeg) — esta TD prevalece sobre a seção "Object Storage — Local Filesystem" do `testing-guide-nestjs-project`, que será atualizada para MinIO nesta fase (resolve IC-1 de `validation.md`)
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — from phases-reader, plus correlator-confirmed docs; dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) **Single cookie to manage** simplifies logout and avoids the orphan-cookie failure mode. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions. (2) **Aligned with shadcn's canonical form primitive** — `npx shadcn@latest add form` produces react-hook-form wrappers. (3) **Zod-first developer ergonomics match the rest of the FE foundation.**
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** (1) **Strict-BFF alignment.** Route Handlers are the BFF surface; every mutation stays visible under `app/api/**`. (2) **Test scaffold already exists** for Route-Handlers-as-functions. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** (1) **First-paint-correct** — the user sees the right outcome on the first paint. (2) **Single integration pattern across both flows.** (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI").
**Libraries:** —

## Inherited Conventions

_(from phases-reader — compact list; sourced from prior phases)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 02, originally phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions })`. _(from phase 02, originally phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 02, originally phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 02, originally phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 02, originally phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 02, originally phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — reset-password destination screen absent from Figma; documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

_(from the `testing-guide-nestjs-project` skill, § 3 Feature Implementation Checklist)_

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, queue) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service (Mailpit) or real adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Pipe (custom transformation/validation) | Unit |
| Interceptor | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

**External system strategies inherited from the guide (`references/external-systems.md`):**

- **PostgreSQL** — real database via the Compose `db` service; clean tables with `dataSource.query('DELETE FROM "table"')`, never `repository.delete({})`.
- **Message Queue** — real broker in Docker. The guide leaves the technology TBD and gives a BullMQ/Redis setup pattern (`BullModule.forRoot` + `registerQueue`, assert enqueued jobs via `getQueueToken`).
- **Email** — Mailpit real SMTP capture.
- **Object Storage** — the guide currently prescribes a **local filesystem adapter** in dev and tests, with S3 only in production. This contradicts `docs/project-plan.md` / `docs/diagrams/software-arch.mermaid` (S3/MinIO) and the Phase 03 scope. Flagged for `/plan-validate`.

### next-frontend

_Deferred subproject — Phase 03 declares no frontend capability; no testing requirement applies._
