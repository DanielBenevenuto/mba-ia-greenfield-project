---
kind: phase
name: phase-03-videos
test_specs_aware: true
affected_subprojects: [nestjs-project]
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-20T17:59:59.253833+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-20T17:58:54.638841+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-20T17:56:31.676718+00:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T17:34:49.902910+00:00"
  docs/project-plan.md: "2026-09-20T17:34:49.905519+00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de vídeos de até 10GB sem que o arquivo trafegue pela API — com pré-cadastro automático do vídeo como rascunho ao iniciar o envio, processamento automático em segundo plano (duração, metadados e thumbnail), URL única por vídeo, reprodução via streaming sem download completo e download do arquivo original.

---

## Step Implementations

### SI-03.1 — Instalar dependências e criar configuração de storage e fila

**Description:** Instala as bibliotecas de object storage e de fila e cria os namespaces de configuração tipada + validação de env que todos os SIs seguintes consomem.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1136.0`, `@aws-sdk/s3-request-presigner@^3.1136.0`, `bullmq@^6.3.8` e `@nestjs/bullmq@^12.0.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`; versões e matriz de compatibilidade em `library-refs.md`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` expondo `endpoint`, `publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket`, `forcePathStyle`, `uploadPartSizeBytes`, `uploadUrlExpirationSeconds` e `downloadUrlExpirationSeconds` (per `phase-03-videos/TD-01`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` expondo `host`, `port`, `videoProcessingAttempts` e `videoProcessingBackoffMs` (per `phase-03-videos/TD-02`)
4. Estender `src/config/env.validation.ts` com as chaves novas e registrar os dois factories no `load` do `ConfigModule` em `AppModule`
5. Atualizar `.env.example` usando nomes de serviço do Compose como host (`S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`), conforme a regra de Docker networking do `CLAUDE.md`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: novas chaves obrigatórias rejeitadas quando ausentes; defaults aplicados | `src/config/env.validation.integration-spec.ts` (estendido) |
| `storageConfig` | Unit: mapeamento env → config, defaults e coerção numérica | `src/config/storage.config.spec.ts` |
| `queueConfig` | Unit: mapeamento env → config e defaults | `src/config/queue.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- As quatro bibliotecas resolvem nas versões fixadas sem erro de peer dependency
- Subir a aplicação sem `S3_BUCKET` falha no boot com erro de validação nomeando a chave ausente
- `storageConfig()` devolve `endpoint` e `publicEndpoint` distintos quando as env vars correspondentes diferem
- `.env.example` não usa `localhost` como host de nenhum serviço de infraestrutura

---

### SI-03.2 — Subir MinIO, Redis e ffmpeg na infraestrutura Docker

**Description:** Adiciona ao Compose o object storage e o broker da fila e garante ffmpeg na imagem — a infraestrutura real que os SIs de storage, processamento e testes de integração exercitam.

**Technical actions:**

1. Adicionar `ffmpeg` ao `apt install` de `nestjs-project/Dockerfile.dev` — `ffprobe`/`ffmpeg` precisam existir tanto no worker quanto no container da API, que roda os testes de integração do extrator (per `phase-03-videos/TD-06`)
2. Adicionar o serviço `minio` ao `compose.yaml` — `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`, `command: server /data --console-address ":9001"`, portas `9000`/`9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` e healthcheck (per `phase-03-videos/TD-01`)
3. Adicionar o serviço `minio-init` — `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z`, executado uma vez quando `minio` fica healthy, criando o bucket de forma idempotente
4. Adicionar o serviço `redis` — `redis:8-alpine`, porta `6379`, healthcheck com `redis-cli ping` (per `phase-03-videos/TD-02`)
5. Declarar o volume nomeado `minio-data` e ligar `nestjs-api` aos novos serviços via `depends_on` com `condition: service_healthy`

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — as variáveis de ambiente dos serviços novos são definidas lá

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy` e `minio-init` concluído com código 0
- `docker compose exec nestjs-api ffprobe -version` responde com a versão do ffprobe
- `docker compose exec nestjs-api ffmpeg -protocols` lista `https` — requisito para ler a URL pré-assinada sem baixar o arquivo
- O bucket configurado existe no MinIO após o `up`
- Reexecutar `docker compose up -d` não falha por bucket já existente

---

### SI-03.3 — Criar entidade Video, enum de status e migration

**Description:** Materializa a tabela `videos` ligada ao canal, com o ciclo de status da fase, e deixa a suíte de migrations re-executável.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme `### Data Model → Video`, com o enum `VideoStatus` em `src/videos/video.constants.ts` (per `phase-03-videos/TD-10`)
2. Declarar o lado inverso da relação em `src/channels/entities/channel.entity.ts` (`@OneToMany(() => Video, (video) => video.channel)`), conforme `.claude/rules/nestjs-entities.md`
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule` (per `.claude/rules/nestjs-modules.md`)
4. Gerar a migration `CreateVideos` pelo CLI do TypeORM e conferir que o `down()` remove a tabela **e** o tipo `videos_status_enum`
5. Estender `src/database/migrations.integration-spec.ts` para cobrir a migration nova e dropar tipos enum órfãos no `beforeAll` (`DROP TYPE IF EXISTS ... CASCADE`), tornando a suíte re-executável (resolve `DG-1` de `validation.md`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, unicidade de `public_id`, FK para `channels` | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |
| migrations | Integration: aplica todas as migrations e reverte a de vídeos | `src/database/migrations.integration-spec.ts` (estendido) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique
- Inserir vídeo com `channel_id` inexistente viola a foreign key
- Vídeo inserido sem `status` explícito persiste com `draft`
- `size_bytes` armazena e devolve `10737418240` sem perda de precisão
- Reverter a migration de vídeos remove a tabela `videos` e o tipo `videos_status_enum`
- Rodar a suíte completa duas vezes seguidas contra o mesmo banco termina verde nas duas execuções

---

### SI-03.4 — Implementar o gerador de identificador público único

**Description:** Entrega a função pura que produz o identificador curto e não-adivinhável usado na URL de cada vídeo.

**Technical actions:**

1. Criar `src/videos/public-id.util.ts` — `generatePublicId(): string` produzindo 11 caracteres do alfabeto base62 a partir de `crypto.randomBytes`, sem dependência externa (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: comprimento, alfabeto, ausência de colisão em amostra grande e uso de todo o alfabeto | `src/videos/public-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `generatePublicId()` devolve sempre exatamente 11 caracteres
- Toda saída casa com `/^[0-9A-Za-z]{11}$/`
- 100.000 chamadas consecutivas não produzem nenhum valor repetido
- A função não depende de nenhum pacote de terceiros

---

### SI-03.5 — Implementar o StorageService com multipart e URLs pré-assinadas

**Description:** Entrega a camada de object storage — o ciclo completo de multipart upload, leitura por intervalo de bytes e assinatura de URLs — sobre a qual upload, streaming, download e worker se apoiam.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com **dois** `S3Client`: um no endpoint interno para chamadas servidor-a-servidor e outro no endpoint público, usado exclusivamente para assinar URLs entregues a clientes (per `phase-03-videos/TD-01`)
2. Implementar o ciclo de multipart — `createMultipartUpload`, `presignUploadPartUrls`, `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-03`)
3. Implementar leitura e entrega — `headObject`, `getObjectRange` (devolve stream + `ContentRange`/`ContentLength`), `presignReadUrl` e `presignDownloadUrl` com `ResponseContentDisposition` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
4. Implementar `putObject` para o thumbnail e `buildKeys(videoId, filename)` com o layout `videos/{videoId}/source/{filename}` e `thumbnails/{videoId}/poster.jpg` (per `phase-03-videos/TD-01`)
5. Criar `src/test/storage-test-utils.ts` com o helper que reescreve o host público para o hostname interno do Compose nas URLs assinadas usadas pelos testes (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` (multipart) | Integration: create → PUT de 2 partes via URL assinada → complete → head, contra o MinIO do Compose | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` (leitura) | Integration: `getObjectRange` devolve exatamente o intervalo; `presignDownloadUrl` produz URL com `Content-Disposition` | `src/storage/storage.service.integration-spec.ts` |
| `buildKeys` | Unit: layout das chaves e sanitização do filename | `src/storage/storage.service.spec.ts` |
| `StorageModule` | Unit: compilação do módulo | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Abrir uma multipart, enviar duas partes pelas URLs assinadas e concluir produz um objeto cujo tamanho é a soma das partes
- Uma URL assinada emitida para clientes carrega o host público configurado, não o host interno
- `getObjectRange(key, 0, 1023)` devolve 1024 bytes e `ContentRange` no formato `bytes 0-1023/<total>`
- Abortar uma multipart aberta faz o `complete` subsequente falhar
- Requisitar a URL de download devolve o header `Content-Disposition` com o filename original

---

### SI-03.6 — Expor lookup de canal por usuário no ChannelsService

**Description:** Dá ao módulo de vídeos uma forma sancionada de resolver o canal dono a partir do `sub` do JWT, sem que ele consulte a tabela `channels` diretamente.

**Technical actions:**

1. Adicionar `findByUserId(userId: string): Promise<Channel | null>` a `src/channels/channels.service.ts` — resolve `DG-2` de `validation.md` e mantém o acesso à tabela `channels` dentro do módulo dono, conforme o princípio de Single Responsibility do `CLAUDE.md`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: devolve o canal do usuário e `null` quando não existe | `src/channels/channels.service.integration-spec.ts` (estendido) |

**Dependencies:** none

**Acceptance criteria:**

- `findByUserId` com o id de um usuário que possui canal devolve o canal correspondente
- `findByUserId` com um uuid sem canal associado devolve `null`
- O canal devolvido não carrega a relação `user` carregada por padrão

---

### SI-03.7 — Implementar pré-cadastro em rascunho e abertura da sessão de upload

**Description:** Entrega o primeiro passo do handshake: criar o vídeo como rascunho e abrir a multipart no storage na mesma operação, devolvendo o plano de partes assinadas.

**Technical actions:**

1. Criar `src/videos/dto/create-upload.dto.ts` conforme `### API Contracts → POST /videos/uploads` e `#### Validation Rules — Upload`
2. Criar `src/videos/videos.service.ts` com `startUpload(userId, dto)` — resolve o canal via `ChannelsService.findByUserId`, valida tamanho e `content_type`, gera `public_id` e `storage_key`, abre a multipart e grava o vídeo com `status = draft` e `upload_id` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
3. Calcular o plano de partes — `total_parts = ceil(size_bytes / part_size_bytes)` — e emitir uma URL assinada de `UploadPart` por parte (per `phase-03-videos/TD-03`)
4. Criar `VideoTooLargeException`, `UnsupportedMediaTypeException` e `ChannelNotFoundException` em `src/common/exceptions/domain.exception.ts`, com os códigos e status do `### Error Catalog`
5. Registrar `ChannelsModule` e `StorageModule` nos imports de `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.startUpload` | Unit: ramos de erro (acima do teto, media type inválido, usuário sem canal) com colaboradores mockados | `src/videos/videos.service.spec.ts` |
| `VideosService` (plano de partes) | Unit: número de partes e tamanho da última parte para 10 GiB | `src/videos/videos.service.spec.ts` |
| `VideosService.startUpload` | Integration: grava o vídeo em `draft` com `upload_id` e abre multipart real no MinIO | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5, SI-03.6

**Acceptance criteria:**

- `startUpload` com 10 GiB e `video/mp4` cria o vídeo com `status = draft` e `upload_id` não-nulo
- `startUpload` com `size_bytes` acima de 10 GiB lança `VIDEO_TOO_LARGE` e não cria linha na tabela
- `startUpload` com `content_type` fora do allowlist lança `UNSUPPORTED_MEDIA_TYPE` e não abre multipart no storage
- `startUpload` para usuário sem canal lança `CHANNEL_NOT_FOUND`
- O plano de 10 GiB devolve `ceil(10737418240 / part_size_bytes)` partes, numeradas sequencialmente a partir de 1
- O `title` do rascunho é derivado do `filename` enviado

---

### SI-03.8 — Implementar conclusão e abort do upload com enfileiramento do processamento

**Description:** Fecha o handshake de upload: conclui ou aborta a multipart e, no caminho feliz, move o vídeo para `processing` e enfileira o job que o worker vai consumir.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` (conexão a partir de `queueConfig`) e `BullModule.registerQueue({ name: 'video-processing' })` em `VideosModule` (per `phase-03-videos/TD-02`)
2. Implementar `completeUpload(userId, videoId, uploadId, parts)` — valida posse e sessão aberta, chama `completeMultipartUpload`, limpa `upload_id`, move o status para `processing` e enfileira `process-video` com as opções de retry do `### Events/Messages` (per `phase-03-videos/TD-10`)
3. Implementar `abortUpload(userId, videoId, uploadId)` — aborta a multipart no storage e remove o rascunho (per `phase-03-videos/TD-04`)
4. Criar `VideoNotFoundException`, `NotVideoOwnerException` e `UploadSessionNotOpenException` com os códigos e status do `### Error Catalog`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos de posse e de sessão inexistente, com queue e storage mockados | `src/videos/videos.service.spec.ts` (estendido) |
| `VideosService.completeUpload` | Integration: conclui multipart real, persiste `processing` e enfileira o job na fila Redis real | `src/videos/videos.service.integration-spec.ts` (estendido) |
| `VideosService.abortUpload` | Integration: aborta a sessão no storage e remove o rascunho | `src/videos/videos.service.integration-spec.ts` (estendido) |

**Dependencies:** SI-03.7, SI-03.2

**Acceptance criteria:**

- Concluir o upload move o vídeo para `processing` e zera `upload_id`
- Concluir o upload enfileira exatamente um job `process-video` cujo payload é `{ videoId }`
- Concluir upload de vídeo de outro canal lança `NOT_VIDEO_OWNER` e não altera o storage
- Concluir upload de vídeo sem sessão aberta lança `UPLOAD_SESSION_NOT_OPEN`
- Abortar a sessão remove a linha do vídeo e a multipart deixa de existir no storage
- O job enfileirado carrega `attempts = 3` e backoff exponencial

---

### SI-03.9 — Expor os endpoints do handshake de upload

**Description:** Publica as três rotas autenticadas do ciclo de upload, documentadas em OpenAPI conforme a convenção do projeto.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` com `POST /videos/uploads`, `POST /videos/:id/uploads/:uploadId/complete` e `DELETE /videos/:id/uploads/:uploadId`, todos autenticados, usando `@CurrentUser()` (per `### API Contracts`, `### Authorization Matrix`)
2. Criar `src/videos/dto/complete-upload.dto.ts` com validação aninhada de `parts` (per `#### Validation Rules — Upload`)
3. Anotar cada handler com `@ApiTags('videos')`, `@ApiOperation`, um `@ApiResponse` por status previsto e `@ApiBearerAuth('access-token')`, referenciando `ApiErrorEnvelope` nos erros (per `openapi-docs-nestjs/TD-01` e `.claude/rules/nestjs-controllers.md`)
4. Registrar o controller em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos/uploads` | E2E: 201 com plano de partes; 401 sem token; 400 com corpo inválido; 413 acima do teto; 415 com media type inválido | `test/videos-upload.e2e-spec.ts` |
| `POST /videos/:id/uploads/:uploadId/complete` | E2E: 200 com `status: processing`; 403 para não-dono; 409 sem sessão aberta | `test/videos-upload.e2e-spec.ts` |
| `DELETE /videos/:id/uploads/:uploadId` | E2E: 204 e rascunho removido | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.7, SI-03.8

**Acceptance criteria:**

- `POST /videos/uploads` com payload válido e token retorna `201` com `public_id`, `status: "draft"` e a lista de partes assinadas
- `POST /videos/uploads` sem header `Authorization` retorna `401`
- `POST /videos/uploads` com `size_bytes` acima de 10 GiB retorna `413` com `error: "VIDEO_TOO_LARGE"`
- `POST /videos/uploads` com `content_type: "application/pdf"` retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`
- `POST /videos/{id}/uploads/{uploadId}/complete` com as partes corretas retorna `200` com `status: "processing"`
- `POST /videos/{id}/uploads/{uploadId}/complete` por usuário de outro canal retorna `403` com `error: "NOT_VIDEO_OWNER"`
- `DELETE /videos/{id}/uploads/{uploadId}` retorna `204` e o vídeo deixa de ser encontrado

---

### SI-03.10 — Implementar extração de metadados e geração de thumbnail

**Description:** Entrega o wrapper de `ffprobe`/`ffmpeg` que lê duração, metadados e um frame diretamente da URL pré-assinada, sem baixar o arquivo de origem.

**Technical actions:**

1. Criar `src/videos/processing/video-metadata.extractor.ts` — `probe(inputUrl)` roda `ffprobe -v error -print_format json -show_format -show_streams` via `execFile` (sem shell) e devolve duração + metadados tipados (per `phase-03-videos/TD-06`)
2. Implementar `extractThumbnail(inputUrl, timestampSeconds)` — `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 -vcodec mjpeg pipe:1`, devolvendo o buffer JPEG sem gravar em disco (per `phase-03-videos/TD-06`)
3. Aplicar timeout e limite de buffer nas duas invocações e mapear a saída de erro do processo para uma exceção com mensagem legível
4. Criar `src/test/video-fixture.ts` — gera um mp4 curto com `ffmpeg -f lavfi -i testsrc` para uso nos testes, sem versionar binário no repositório (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMetadataExtractor.probe` | Integration: ffprobe real sobre a fixture devolve duração, largura, altura e codec | `src/videos/processing/video-metadata.extractor.integration-spec.ts` |
| `VideoMetadataExtractor.extractThumbnail` | Integration: devolve buffer com assinatura JPEG | `src/videos/processing/video-metadata.extractor.integration-spec.ts` |
| `VideoMetadataExtractor` (erro) | Integration: input inacessível produz exceção com a saída de erro do ffprobe | `src/videos/processing/video-metadata.extractor.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.5

**Acceptance criteria:**

- `probe` sobre um mp4 de 3 segundos devolve `duration_seconds` entre 2,9 e 3,1
- `probe` devolve `width`, `height` e `video_codec` coerentes com a fixture gerada
- `extractThumbnail` devolve buffer cujos dois primeiros bytes são `0xFF 0xD8`
- `probe` de uma URL inacessível rejeita com erro contendo a saída de erro do ffprobe, sem travar até o timeout
- Nenhum arquivo de vídeo permanece no diretório de trabalho após a suíte

---

### SI-03.11 — Implementar o worker de vídeo em processo separado

**Description:** Entrega o consumidor da fila e o container que o hospeda — o componente que transforma um vídeo `processing` em `ready` (ou `failed`) sem competir com o processo HTTP.

**Technical actions:**

1. Criar `src/videos/processing/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`, executando a sequência do `### Events/Messages` e movendo o status para `ready` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`)
2. Implementar `@OnWorkerEvent('failed')` guardado por `job.attemptsMade >= (job.opts.attempts ?? 1)`, gravando `processing_error` e movendo o status para `failed` (per `phase-03-videos/TD-10`)
3. Criar `src/worker.module.ts` e `src/worker.main.ts` — contexto de aplicação Nest sem servidor HTTP, importando apenas config, TypeORM, storage e o processor (per `phase-03-videos/TD-05`)
4. Adicionar o script `start:worker` ao `package.json` e o serviço `video-worker` ao `compose.yaml`, reusando a mesma imagem e o mesmo volume do `nestjs-api`
5. Manter o processor fora do `AppModule` — a API apenas produz jobs, o worker apenas consome

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Integration: job real contra Redis/MinIO/Postgres leva o vídeo de `processing` a `ready` com duração, metadados e thumbnail | `src/videos/processing/video.processor.integration-spec.ts` |
| `VideoProcessor` (falha) | Integration: origem ilegível termina em `failed` com `processing_error` preenchido | `src/videos/processing/video.processor.integration-spec.ts` |
| `VideoProcessor` (idempotência) | Integration: job para vídeo já `ready` é no-op | `src/videos/processing/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compilação do módulo | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.3, SI-03.8, SI-03.10

**Acceptance criteria:**

- Processar um vídeo recém-enviado grava `duration_seconds`, `metadata` e `thumbnail_key` e move o status para `ready`
- O objeto de thumbnail existe no storage sob `thumbnails/{videoId}/poster.jpg` após o processamento
- Um vídeo cuja origem não pode ser lida termina em `failed` com `processing_error` não-vazio após esgotar as tentativas
- Reprocessar um vídeo já `ready` não altera a linha
- `docker compose up -d` deixa `video-worker` em execução, com log registrando a conexão com a fila
- Com o `video-worker` parado, um job enfileirado permanece em `waiting` — a API não o consome

---

### SI-03.12 — Expor metadados, streaming com Range e download

**Description:** Publica a superfície pública do vídeo — a URL única, a reprodução por streaming sem download completo e o download do arquivo original.

**Technical actions:**

1. Implementar `findByPublicId(publicId, requesterUserId?)` em `VideosService`, aplicando a regra de não-vazamento do `### Authorization Matrix` (não-`ready` responde `404` para quem não é dono)
2. Adicionar `GET /videos/:publicId` ao controller com `@Public()`, devolvendo o shape do `### API Contracts` com `thumbnail_url` assinada
3. Implementar `GET /videos/:publicId/stream` com `@Public()` — parse do header `Range` em `src/videos/range.util.ts`, `206` com `Content-Range`/`Accept-Ranges`/`Content-Length` e pipe do stream do storage; `200` sem `Range`; `416` quando o intervalo é inválido (per `phase-03-videos/TD-08`)
4. Implementar `GET /videos/:publicId/download` com `@Public()` — `302` para a URL assinada com `Content-Disposition: attachment` (per `phase-03-videos/TD-09`)
5. Anotar os três handlers com os decoradores OpenAPI, sem `@ApiBearerAuth` (são rotas `@Public()`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseRangeHeader` | Unit: `bytes=0-`, `bytes=0-1023`, `bytes=-500`, formas malformadas e fora dos limites | `src/videos/range.util.spec.ts` |
| `GET /videos/:publicId` | E2E: 200 anônimo para `ready`; 404 anônimo para `draft` | `test/videos-playback.e2e-spec.ts` |
| `GET /videos/:publicId/stream` | E2E: 206 com `Content-Range` e corpo do tamanho do intervalo; 200 sem `Range`; 416 para range inválido | `test/videos-playback.e2e-spec.ts` |
| `GET /videos/:publicId/download` | E2E: 302 com `Location` assinada; 404 para não-`ready` visto por anônimo | `test/videos-playback.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.9, SI-03.11

**Acceptance criteria:**

- `GET /videos/{publicId}` anônimo para vídeo `ready` retorna `200` com `public_id`, `title`, `duration_seconds` e `thumbnail_url`
- `GET /videos/{publicId}` anônimo para vídeo `draft` retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/{publicId}/stream` com `Range: bytes=0-1023` retorna `206`, `Content-Range: bytes 0-1023/<total>` e corpo de 1024 bytes
- `GET /videos/{publicId}/stream` sem `Range` retorna `200` com `Accept-Ranges: bytes`
- `GET /videos/{publicId}/stream` com `Range: bytes=999999999999-` retorna `416` com `error: "INVALID_RANGE"`
- `GET /videos/{publicId}/download` retorna `302` cujo `Location` aponta para o storage e carrega `response-content-disposition` na query
- O dono autenticado que pede streaming de um vídeo em `processing` recebe `409` com `error: "VIDEO_NOT_READY"`

---

### SI-03.13 — Atualizar OpenAPI e a documentação de IA

**Description:** Fecha a fase deixando a documentação coerente com o código: spec OpenAPI regenerado, CLAUDE.md com a seção de vídeos e o guia de testes alinhado ao storage realmente usado.

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` via `npm run openapi:export`, incorporando os seis endpoints de vídeo (per `openapi-docs-nestjs/TD-02`)
2. Atualizar o `CLAUDE.md` da raiz com a seção de vídeos — módulo, endpoints, fila, worker e storage — e substituir o "TBD" da fila pela tecnologia escolhida
3. Atualizar `nestjs-project/CLAUDE.md` com os serviços novos do Compose, o script `start:worker` e os comandos de verificação de MinIO e Redis
4. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — a seção "Object Storage" passa de filesystem local para MinIO real e a seção "Message Queue" fixa BullMQ + Redis (resolve `IC-1` de `validation.md`)
5. Atualizar `docs/diagrams/software-arch.mermaid` substituindo "Message Queue (TBD)" pela tecnologia decidida

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi-export` | Integration: o spec exportado contém os seis paths de vídeo com os status documentados | `src/openapi-export.integration-spec.ts` (estendido) |
| Swagger UI | E2E: a documentação continua servida e inclui a tag `videos` | `test/swagger.e2e-spec.ts` (estendido) |

**Dependencies:** SI-03.9, SI-03.12

**Acceptance criteria:**

- `openapi.json` contém os seis paths de vídeo definidos em `### API Contracts`
- Todo endpoint de vídeo documenta o envelope de erro compartilhado nos status de erro
- O `CLAUDE.md` da raiz descreve a fila escolhida e não contém mais "TBD" para a fila
- Todo arquivo, script e comando citado nos CLAUDE.md atualizados existe no repositório
- O guia de testes descreve MinIO como estratégia de object storage e BullMQ + Redis como estratégia de fila

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`. Entidade nova desta fase (per `phase-03-videos/TD-04`, `phase-03-videos/TD-07`, `phase-03-videos/TD-10`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')`) |
| public_id | varchar(11) | unique, not null — identificador da URL pública (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null — derivado do `filename` no pré-cadastro (per `phase-03-videos/TD-04`) |
| status | enum `videos_status_enum` | not null, default `'draft'` — valores `draft`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-10`) |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null |
| size_bytes | bigint | not null — tamanho declarado pelo cliente no pré-cadastro |
| storage_key | varchar(512) | not null — chave do objeto no storage (per `phase-03-videos/TD-01`) |
| upload_id | varchar(255) | nullable — `UploadId` da multipart aberta; `null` quando não há sessão em aberto (per `phase-03-videos/TD-04`) |
| thumbnail_key | varchar(512) | nullable — preenchido pelo worker |
| duration_seconds | numeric(10,3) | nullable — preenchido pelo worker (per `phase-03-videos/TD-06`) |
| metadata | jsonb | nullable — metadados extraídos do ffprobe (per `phase-03-videos/TD-06`) |
| processing_error | text | nullable — mensagem do erro final do processamento (per `phase-03-videos/TD-10`) |
| created_at | timestamp | `@CreateDateColumn()`, default now() |
| updated_at | timestamp | `@UpdateDateColumn()`, default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one, `@JoinColumn({ name: 'channel_id' })`). Ambos os lados são declarados, conforme `.claude/rules/nestjs-entities.md`.

**Indexes:** unique on `public_id`; index on `channel_id`; index on `status`.

**Notas de mapeamento:**

- `size_bytes` usa `bigint` porque 10 GiB (`10737418240`) não cabe em `int4`. O driver `pg` devolve `bigint` como `string`; a coluna declara um transformer (`from: (v) => v === null ? null : Number(v)`) para expor `number` no domínio — o valor máximo (1.07e10) está muito abaixo de `Number.MAX_SAFE_INTEGER`.
- `metadata` guarda o recorte do JSON do `ffprobe` que interessa ao domínio (`width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `format_name`) — não o JSON bruto inteiro.
- O enum de status é criado como tipo Postgres nomeado `videos_status_enum`; a migration `down()` precisa removê-lo explicitamente (`DROP TYPE`), do contrário o tipo órfão quebra a reaplicação das migrations — é exatamente o defeito registrado em `DG-1` de `validation.md`.

#### Channel (modificada)

Nenhuma coluna nova. A entidade passa a declarar o lado inverso da relação:

**Relations:** `@OneToMany(() => Video, (video) => video.channel)`.

---

### API Contracts

#### POST /videos/uploads (SI-03.9)

Abre a sessão de upload e faz o pré-cadastro do vídeo como rascunho na mesma operação (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- filename: string, required — max 255 caracteres
- size_bytes: integer, required — > 0
- content_type: string, required — MIME type do arquivo

**Response 201:**
- id: string (uuid)
- public_id: string — 11 caracteres base62
- title: string — derivado de `filename`
- status: string — sempre `"draft"`
- upload: object
  - upload_id: string
  - part_size_bytes: integer
  - total_parts: integer
  - expires_in_seconds: integer
  - parts: array de `{ part_number: integer, url: string }`

**Error responses:**
- 400 validation error: quando o corpo falha a validação de schema
- 401 (sem token / token inválido): endpoint autenticado
- 404 CHANNEL_NOT_FOUND: usuário autenticado sem canal associado
- 413 VIDEO_TOO_LARGE: `size_bytes` acima de 10 GiB (`10737418240`)
- 415 UNSUPPORTED_MEDIA_TYPE: `content_type` fora do allowlist de vídeo

---

#### POST /videos/{id}/uploads/{uploadId}/complete (SI-03.9)

Fecha a multipart no storage, muda o status para `processing` e enfileira o job de processamento (per `phase-03-videos/TD-03`, `phase-03-videos/TD-10`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array, required, min 1 — itens `{ part_number: integer (>= 1), etag: string }`

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — sempre `"processing"`

**Error responses:**
- 400 validation error: quando `parts` está ausente, vazio ou malformado
- 401: endpoint autenticado
- 403 NOT_VIDEO_OWNER: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: `id` inexistente
- 409 UPLOAD_SESSION_NOT_OPEN: `upload_id` nulo no registro ou diferente do informado na rota

---

#### DELETE /videos/{id}/uploads/{uploadId} (SI-03.9)

Aborta a sessão de multipart e descarta o rascunho (per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 401: endpoint autenticado
- 403 NOT_VIDEO_OWNER: o vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: `id` inexistente
- 409 UPLOAD_SESSION_NOT_OPEN: não há sessão aberta para abortar

---

#### GET /videos/{publicId} (SI-03.12)

Metadados públicos do vídeo pela URL única (per `phase-03-videos/TD-07`).

**Request headers:**
- Authorization: Bearer {access_token} — opcional; presente apenas quando o dono consulta um vídeo ainda não pronto

**Response 200:**
- public_id: string
- title: string
- status: string
- duration_seconds: number | null
- thumbnail_url: string | null — URL pré-assinada de leitura, curta duração
- metadata: object | null
- channel: object — `{ nickname: string, name: string }`
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, ou vídeo com `status != ready` consultado por quem não é o dono

---

#### GET /videos/{publicId}/stream (SI-03.12)

Reprodução por streaming. A API repassa o `Range` ao storage e devolve `206` (per `phase-03-videos/TD-08`).

**Request headers:**
- Range: string, optional — forma `bytes=<start>-<end>`; `<end>` pode ser omitido

**Response 206** _(quando `Range` está presente)_:
- Corpo: o intervalo de bytes solicitado, em stream
- Content-Range: `bytes <start>-<end>/<total>`
- Accept-Ranges: `bytes`
- Content-Length: tamanho do intervalo
- Content-Type: o `content_type` do vídeo

**Response 200** _(quando não há `Range`)_:
- Corpo: o arquivo completo, em stream
- Accept-Ranges: `bytes`
- Content-Length: tamanho total

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, ou não-`ready` para quem não é dono
- 409 VIDEO_NOT_READY: o dono pediu streaming de um vídeo com `status != ready`
- 416 INVALID_RANGE: `Range` malformado ou fora dos limites do objeto

---

#### GET /videos/{publicId}/download (SI-03.12)

Download do arquivo original. A API valida e redireciona para uma URL pré-assinada; os bytes não passam pela API (per `phase-03-videos/TD-09`).

**Response 302:**
- Location: URL pré-assinada de `GetObject` com `ResponseContentDisposition: attachment; filename="{original_filename}"` e validade de 300 segundos

**Error responses:**
- 404 VIDEO_NOT_FOUND: `public_id` inexistente, ou não-`ready` para quem não é dono
- 409 VIDEO_NOT_READY: o dono pediu download de um vídeo com `status != ready`

---

#### Validation Rules — Upload

- `filename`: required, string, 1..255 caracteres
- `size_bytes`: required, integer, `>= 1`; o teto de `10737418240` é regra de domínio e responde `413 VIDEO_TOO_LARGE`, não `400`
- `content_type`: required, string; allowlist `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` — fora dela responde `415 UNSUPPORTED_MEDIA_TYPE`
- `parts`: required, array com no mínimo 1 item; cada item `{ part_number: integer >= 1, etag: string não-vazia }`

---

### Authorization Matrix

O guard JWT é global (`APP_GUARD`), então todo endpoint é autenticado por padrão; rotas públicas usam `@Public()` (per `.claude/rules/nestjs-controllers.md`). A coluna **Owner** significa "usuário autenticado cujo canal é dono do vídeo". A regra de acesso público-quando-`ready` vem de `phase-03-videos/TD-08` e `phase-03-videos/TD-09` (resolve `AMB-1`).

| Endpoint | Anonymous | Authenticated (não-dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos/uploads | ✗ | ✓ (cria sempre no próprio canal) | ✓ |
| POST /videos/{id}/uploads/{uploadId}/complete | ✗ | ✗ (403 NOT_VIDEO_OWNER) | ✓ |
| DELETE /videos/{id}/uploads/{uploadId} | ✗ | ✗ (403 NOT_VIDEO_OWNER) | ✓ |
| GET /videos/{publicId} | ✓ se `status = ready`, senão 404 | ✓ se `status = ready`, senão 404 | ✓ em qualquer status |
| GET /videos/{publicId}/stream | ✓ se `status = ready`, senão 404 | ✓ se `status = ready`, senão 404 | ✓ se `ready`; 409 VIDEO_NOT_READY caso contrário |
| GET /videos/{publicId}/download | ✓ se `status = ready`, senão 404 | ✓ se `status = ready`, senão 404 | ✓ se `ready`; 409 VIDEO_NOT_READY caso contrário |

**Regra de não-vazamento:** para quem não é dono, um vídeo que não está `ready` é indistinguível de um vídeo inexistente — ambos respondem `404 VIDEO_NOT_FOUND`. O `409 VIDEO_NOT_READY` só é observável pelo dono.

---

### Error Catalog

Formato do envelope herdado de `phase-02-auth/TD-07` — `{ statusCode, error, message }`, emitido pelo `DomainExceptionFilter` a partir de subclasses de `DomainException`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 413 | `size_bytes` acima de 10 GiB no pré-cadastro |
| UNSUPPORTED_MEDIA_TYPE | 415 | `content_type` fora do allowlist de vídeo |
| CHANNEL_NOT_FOUND | 404 | usuário autenticado sem canal associado ao iniciar upload |
| VIDEO_NOT_FOUND | 404 | `id`/`public_id` inexistente, ou vídeo não-`ready` acessado por quem não é o dono |
| NOT_VIDEO_OWNER | 403 | operação de sessão de upload sobre vídeo de outro canal |
| UPLOAD_SESSION_NOT_OPEN | 409 | `complete`/`abort` quando `upload_id` é nulo ou diverge do informado |
| VIDEO_NOT_READY | 409 | dono pede stream/download de vídeo com `status != ready` |
| INVALID_RANGE | 416 | header `Range` malformado ou fora dos limites do objeto |

---

### Events/Messages

Fila BullMQ sobre Redis (per `phase-03-videos/TD-02`), consumida por um processo worker separado (per `phase-03-videos/TD-05`).

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`) — enfileira dentro de `completeUpload`, depois que o `CompleteMultipartUpload` retorna com sucesso e o status vai para `processing`.

**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-05`) — `@Processor('video-processing')` estendendo `WorkerHost`, rodando no serviço `video-worker` do Compose.

**Trigger:** conclusão bem-sucedida da multipart upload. O payload carrega apenas o `videoId`; todo o resto o consumer relê do banco, o que torna o job idempotente e mantém a mensagem pequena.

**Delivery semantics:** at-least-once (per `phase-03-videos/TD-02`, `phase-03-videos/TD-10`). Opções do job: `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { count: 100 }`, `removeOnFail: false`.

**Efeitos do consumer, em ordem:**

1. Lê a linha do vídeo; se `status != processing`, encerra sem fazer nada (idempotência / job duplicado).
2. Gera uma URL pré-assinada de leitura do objeto de origem (validade curta) e a usa como **input** do `ffprobe`/`ffmpeg` — o arquivo nunca é baixado para o disco do worker (per `phase-03-videos/TD-06`).
3. `ffprobe` extrai duração e metadados; `ffmpeg` extrai um frame e o worker o envia para `thumbnails/{videoId}/poster.jpg`.
4. Persiste `duration_seconds`, `metadata`, `thumbnail_key` e move o status para `ready`.

**Política de falha:** uma exceção lançada pelo processor devolve o job para retry conforme o backoff. Quando a última tentativa falha, o handler `@OnWorkerEvent('failed')` — guardado por `job.attemptsMade >= (job.opts.attempts ?? 1)` — grava `processing_error` e move o status para `failed`. O objeto de origem **não** é apagado: o vídeo permanece auditável e reprocessável reenfileirando o mesmo `videoId`.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root) — dependências, config de storage/fila e env
├── SI-03.2 — depends on SI-03.1 (o Compose consome as env vars definidas lá)
│   ├── SI-03.5 — depends on SI-03.1 + SI-03.2 (MinIO precisa estar no ar para o teste de multipart real)
│   │   ├── SI-03.7 — depends on SI-03.3, SI-03.4, SI-03.5, SI-03.6 (entidade + public_id + storage + canal)
│   │   │   └── SI-03.8 — depends on SI-03.7 + SI-03.2 (Redis precisa estar no ar para enfileirar)
│   │   │       ├── SI-03.9 — depends on SI-03.7, SI-03.8 (controller expõe os dois passos)
│   │   │       └── SI-03.11 — depends on SI-03.3, SI-03.8, SI-03.10 (consome o job que SI-03.8 produz)
│   │   │           └── SI-03.12 — depends on SI-03.5, SI-03.9, SI-03.11 (streaming exige vídeo ready)
│   │   │               └── SI-03.13 — depends on SI-03.9, SI-03.12 (documenta os seis endpoints)
│   │   └── SI-03.10 — depends on SI-03.2, SI-03.5 (ffmpeg na imagem + URL assinada como input)
│   └── (Redis do SI-03.2 também habilita SI-03.8)
└── SI-03.3 — depends on SI-03.1 (entidade, enum e migration)

SI-03.4 (root, independent) — gerador de public_id, função pura sem colaboradores
SI-03.6 (root, independent) — ChannelsService.findByUserId, isolado no módulo de canais
```

**Ordem de execução sugerida** (ordenação topológica): SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13.

---

## Deliverables

- [ ] SI-03.1 — Instalar dependências e criar configuração de storage e fila
- [ ] SI-03.2 — Subir MinIO, Redis e ffmpeg na infraestrutura Docker
- [ ] SI-03.3 — Criar entidade Video, enum de status e migration
- [ ] SI-03.4 — Implementar o gerador de identificador público único
- [ ] SI-03.5 — Implementar o StorageService com multipart e URLs pré-assinadas
- [ ] SI-03.6 — Expor lookup de canal por usuário no ChannelsService
- [ ] SI-03.7 — Implementar pré-cadastro em rascunho e abertura da sessão de upload
- [ ] SI-03.8 — Implementar conclusão e abort do upload com enfileiramento do processamento
- [ ] SI-03.9 — Expor os endpoints do handshake de upload
- [ ] SI-03.10 — Implementar extração de metadados e geração de thumbnail
- [ ] SI-03.11 — Implementar o worker de vídeo em processo separado
- [ ] SI-03.12 — Expor metadados, streaming com Range e download
- [ ] SI-03.13 — Atualizar OpenAPI e a documentação de IA

**Entregáveis da fase** _(do `docs/project-plan.md` § Fase 03)_:

- [ ] Upload de até 10GB funcional, sem que o arquivo passe pela API
- [ ] Processamento automático do vídeo após o upload (duração, metadados e thumbnail)
- [ ] Streaming funcionando, sem exigir download completo
- [ ] URLs únicas geradas, sem conflito entre vídeos
- [ ] Object storage, fila e worker subindo via `docker compose up -d` junto com o backend
- [ ] Migration cria a tabela `videos`, com a entidade ligada ao canal

**Full test suites:**

- [ ] Testes unitários e de integração passam (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa com código 0 (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] A suíte completa roda duas vezes seguidas contra o mesmo banco e termina verde nas duas (regressão de `DG-1`)
