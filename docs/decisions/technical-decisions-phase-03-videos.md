---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-20
scope_description: "Upload de vídeos de até 10GB sem passar pela API, object storage S3-compatível, fila de processamento em segundo plano, worker de vídeo (ffprobe/ffmpeg) para metadados e thumbnail, URL única por vídeo, streaming com Range/206 e download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend que entrega o módulo de vídeos (pré-cadastro, sessão de upload, conclusão, streaming, download), o serviço de object storage, o produtor da fila e o processo worker de vídeo. Todas as TDs deste documento recaem sobre ele.
- `next-frontend/` — **sem decisão em aberto nesta fase.** A Fase 03 do `docs/project-plan.md` não declara nenhuma capability de tela; o player e a tela de upload pertencem às Fases 04/05. As TDs marcadas `Cross-layer` aqui existem porque definem o contrato que o frontend vai consumir depois (handshake de upload, formato da URL única, transporte de streaming/download) — não porque haja código de frontend nesta fase.

---

## TD-01: Object Storage Client and Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O storage em si não é escolha em aberto — `docs/project-plan.md` e `docs/diagrams/software-arch.mermaid` já fixam "Object Storage (S3/MinIO)". O que precisa ser decidido é **como** usá-lo: qual client Node, como organizar buckets e chaves, e como resolver o fato de que a URL assinada entregue a um cliente externo não pode apontar para o hostname interno do Compose (`minio`), enquanto as operações servidor-a-servidor precisam apontar exatamente para ele (regra de Docker networking do `CLAUDE.md`). Isso é contrato cross-component: `compose.yaml` + `env.validation.ts` + `.env.example` + o serviço de storage precisam concordar.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, bucket único com prefixos por tipo
- SDK oficial AWS modular. Um único bucket (`streamtube`) com prefixos: `videos/{videoId}/source/{filename}` e `thumbnails/{videoId}/poster.jpg`. Endpoint configurável (`forcePathStyle: true` para MinIO). Dois endpoints em config: interno (`http://minio:9000`) para chamadas do servidor e público (`S3_PUBLIC_ENDPOINT`) usado apenas para assinar URLs entregues a clientes.
- **Pros:** SDK oficial, mesma API para MinIO e S3 — trocar de um para o outro é mudar env vars. Suporte nativo a multipart e a presign de qualquer command (`UploadPart`, `GetObject`). Bucket único simplifica bootstrap e política de acesso. Prefixo por `videoId` mantém vídeo e thumbnail correlacionados e facilita apagar tudo de um vídeo com um único prefixo.
- **Cons:** Superfície de API grande (vários packages `@aws-sdk/*`). A separação endpoint interno/público é um conceito extra que precisa ser documentado, senão gera URLs assinadas inutilizáveis.

### Option B: `minio` (SDK oficial do MinIO)
- Client JS mantido pela MinIO, com API mais enxuta (`presignedPutObject`, `presignedGetObject`).
- **Pros:** API menor e mais direta para os casos comuns. Menos pacotes.
- **Cons:** Acopla o código ao MinIO — migrar para S3 em produção exigiria reescrever a camada de storage, contrariando a intenção declarada no plano ("trocaria por S3 em produção"). Cobertura de multipart com URLs pré-assinadas por parte é menos idiomática que no SDK AWS.

### Option C: Buckets separados por tipo (`streamtube-videos`, `streamtube-thumbnails`)
- Mesmo SDK da Option A, mas um bucket por tipo de asset.
- **Pros:** Permite políticas de acesso e lifecycle distintas por tipo (ex.: thumbnails públicas, vídeos privados) sem depender de prefixo.
- **Cons:** Dobra o bootstrap (criar/verificar dois buckets) e espalha o ciclo de vida de um mesmo vídeo em dois lugares. Nesta fase todo acesso é mediado pela API, então a vantagem de política por bucket não se materializa.

**Recommendation:** **Option A** — o SDK oficial AWS mantém a promessa de "MinIO em dev, S3 em prod" sem reescrita, e `forcePathStyle` já é o modo que o MinIO espera. Bucket único com prefixo `videos/{videoId}/...` cobre a necessidade desta fase; separar buckets é reversível depois se surgir política divergente. A dupla de endpoints (interno para o servidor, público para assinar) é obrigatória para que o upload direto funcione fora da rede do Compose.

**Decision:** A (`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, bucket único com prefixos, endpoint interno + público)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O `docs/project-plan.md` deixa a fila explicitamente em aberto e `docs/diagrams/software-arch.mermaid` a marca como "Message Queue (TBD)". É a principal decisão de stack da fase: define uma infraestrutura nova no `compose.yaml`, o modelo de retry/idempotência do worker e o acoplamento do backend. O volume é baixo (um job por upload concluído) mas cada job é longo (ffprobe + extração de frame sobre arquivo grande).

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Fila baseada em Redis com integração oficial NestJS (`BullModule.forRootAsync`, `@InjectQueue`, `@Processor`/`WorkerHost`). Retry com backoff exponencial, concorrência configurável, eventos de worker, jobs atrasados e delayed/repeat nativos.
- **Pros:** Integração NestJS oficial e documentada — DI, decorators e ciclo de vida do módulo funcionam sem cola manual. Retry/backoff/DLQ (`failed` set) prontos. `Job.updateProgress` útil para vídeo longo. Adiciona um serviço leve ao Compose (Redis alpine ~15MB). Ecossistema maduro, é o default de fato para jobs em Node.
- **Cons:** Introduz Redis como dependência de infraestrutura nova (mais um serviço para operar). Durabilidade depende da configuração de persistência do Redis — um job pode ser perdido num crash sem AOF. Não é um broker com roteamento (sem exchanges/topics).

### Option B: pg-boss (fila sobre o PostgreSQL já existente)
- Job queue implementada em cima do Postgres usando `SKIP LOCKED`. Sem novo serviço de infraestrutura.
- **Pros:** Zero infraestrutura nova — reaproveita o `db` que já está no Compose. Jobs são transacionais com os dados do domínio: dá para inserir o vídeo e enfileirar o job na mesma transação, eliminando a janela "vídeo gravado mas job perdido". Durabilidade e backup herdados do Postgres.
- **Cons:** Sem integração NestJS oficial — exige provider/módulo customizado e um bootstrap manual do worker. Carga de polling no mesmo banco que serve as requisições HTTP. Ferramental de observabilidade mais pobre (não há Bull Board equivalente). Menos material de referência para o padrão NestJS.

### Option C: RabbitMQ (via `@nestjs/microservices` ou `@golevelup/nestjs-rabbitmq`)
- Broker AMQP dedicado, com exchanges, filas duráveis, DLX nativo e ack manual.
- **Pros:** Broker de verdade: roteamento, dead-letter exchange nativo, ack/nack explícito, durabilidade forte. Escala para múltiplos tipos de consumidor nas fases seguintes.
- **Cons:** Peso operacional maior (serviço Erlang, ~200MB, config de exchange/binding). Retry com backoff não é nativo — exige DLX + TTL montados à mão. Complexidade desproporcional a uma fila com um único tipo de job. O transporte NestJS de RabbitMQ é orientado a request/reply de microserviços, não a jobs longos.

**Recommendation:** **Option A (BullMQ + Redis)** — é a única opção com integração NestJS de primeira classe, o que mantém o worker dentro dos padrões que o projeto já usa (módulos, DI, decorators) em vez de exigir cola manual. Retry com backoff exponencial e conjunto de jobs falhos vêm prontos, que é exatamente o que TD-10 precisa para o ciclo de status. O custo — um serviço Redis alpine no Compose — é pequeno perto do ganho. A perda transacional do pg-boss é mitigada pelo fato de que o job é enfileirado **depois** da conclusão do upload, e um vídeo preso em `processing` é recuperável reenfileirando.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

**Revisions:**
- 2026-09-20 — Versões fixadas em `@nestjs/bullmq@^11.0.5` (em vez de `^12.0.0`) e `ioredis@^5.9.0` adicionado explicitamente. Rationale: incompatibilidade de formato de módulo detectada na implementação — `@nestjs/bullmq@12.0.0` é publicado com `"type": "module"` e sua condição `require` aponta para o mesmo bundle ESM, o que quebra o build CommonJS do projeto (`SyntaxError: Unexpected token 'export'`); a `11.0.5` é CJS e seu `peerDependencies` já aceita `bullmq ^6`, preservando a Option A sem downgrade do BullMQ. O `ioredis` passou a ser peer **opcional** no BullMQ 6, então precisa ser instalado explicitamente, senão a fila falha em runtime com "BullMQ could not load the optional 'ioredis' package". A escolha da Option A permanece inalterada — mudaram apenas os parâmetros de versão.

---

## TD-03: Large-File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** É a restrição não-funcional central da fase. Um dado da documentação oficial da AWS decide boa parte da questão: **um `PUT` único aceita no máximo 5 GB**; acima disso a multipart upload API é obrigatória (partes de 5 MiB a 5 GiB, até 10.000 partes). Ou seja, 10GB **não cabe** em uma URL pré-assinada simples. O contrato definido aqui é consumido pelo frontend nas fases seguintes.

**Options:**

### Option A: Upload atravessando a API (multipart/form-data)
- O cliente envia o arquivo para um endpoint Nest, que faz stream para o storage.
- **Pros:** Um único endpoint; o servidor controla tudo (validação, autorização, antivírus futuro).
- **Cons:** **Inviável para o requisito.** Prende um worker HTTP do Node por horas por upload, consome banda e disco do container da API e derruba a garantia de "sem impacto na performance". É explicitamente o caminho reprovado no enunciado da fase.

### Option B: URL pré-assinada única (`PutObject`)
- A API devolve uma URL assinada e o cliente faz um `PUT` direto no storage.
- **Pros:** Simples: um handshake, uma URL. Os bytes nunca passam pela API.
- **Cons:** **Teto de 5 GB por `PUT`** na especificação do S3 — não atende os 10GB exigidos. Sem retomada: uma falha de rede aos 4GB obriga a reenviar tudo.

### Option C: Multipart upload com URL pré-assinada por parte
- Handshake em três passos: (1) `POST /videos/uploads` cria o vídeo em rascunho, abre um `CreateMultipartUpload` no storage e devolve `uploadId` + N URLs assinadas de `UploadPart`; (2) o cliente faz `PUT` de cada parte direto no storage, em paralelo, e coleta os `ETag`; (3) `POST /videos/{id}/uploads/{uploadId}/complete` envia a lista de partes, a API chama `CompleteMultipartUpload` e enfileira o processamento. Um `DELETE` correspondente aborta a sessão.
- **Pros:** Único caminho que atende 10GB dentro da especificação (10GB em partes de 64 MiB = 160 partes, muito abaixo do limite de 10.000). Bytes nunca tocam a API. Partes em paralelo aumentam a vazão. Retomada natural: só as partes que falharam são reenviadas. Suportado identicamente por MinIO e S3.
- **Cons:** Handshake de três passos é mais complexo no cliente. A API precisa lidar com sessões abandonadas (multipart incompleta ocupa espaço até ser abortada). Exige CORS no bucket quando o cliente for um browser.

### Option D: Protocolo tus (upload resumível)
- Protocolo aberto de upload resumível com servidor dedicado (`tus-node-server`).
- **Pros:** Retomada de primeira classe, padronizada, com cliente JS maduro.
- **Cons:** Introduz um servidor/rota tus e sua própria semântica de armazenamento; os bytes voltam a passar por um processo Node nosso. Dependência nova e significativa para resolver um problema que a multipart do S3 já resolve com a infraestrutura que a fase já vai subir de qualquer forma.

**Recommendation:** **Option C** — é a única alternativa que satisfaz simultaneamente o limite de 10GB, a exigência de não passar o arquivo pela API e a infraestrutura de storage já fixada pelo projeto. O custo é um handshake de três passos, que fica documentado como contrato em API Contracts e é consumido pelo frontend na Fase 04/05.

**Decision:** C (multipart upload com URL pré-assinada por parte)

---

## TD-04: Upload Session Lifecycle and Draft Pre-registration

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O vídeo precisa existir como rascunho **no início** do upload, não no fim. A questão é onde guardar o estado da sessão de multipart (`uploadId`, chave no storage, partes) e o que acontece com sessões abandonadas. Depende de TD-03.

**Options:**

### Option A: Estado da sessão na própria linha do vídeo
- A tabela `videos` carrega `storage_key` e `upload_id` (nulável). `POST /videos/uploads` cria a linha com `status = draft` e abre a multipart na mesma operação. O `complete` limpa `upload_id`. Sessões abandonadas ficam como vídeos `draft` com `upload_id` preenchido.
- **Pros:** Uma tabela só; o vídeo rascunho e sua sessão de upload são a mesma entidade, que é literalmente o que a capability pede. Retomar um upload é ler a linha. Limpeza futura é uma query simples (`draft` + `upload_id not null` + `created_at` antigo).
- **Cons:** Mistura estado transitório de transporte com dados de domínio. Se um dia houver múltiplos uploads por vídeo (re-upload), o modelo precisa mudar.

### Option B: Tabela dedicada `upload_sessions` com FK para `videos`
- Entidade separada guardando `upload_id`, `storage_key`, `part_size`, `total_parts`, `expires_at`.
- **Pros:** Separação limpa entre domínio e transporte. Suporta múltiplas sessões por vídeo e expiração explícita.
- **Cons:** Uma tabela e uma migration a mais para um relacionamento que é 1:1 nesta fase. Toda leitura de vídeo em upload vira um join. Complexidade sem demanda — a fase não prevê re-upload.

### Option C: Estado da sessão apenas no storage (sem persistir `uploadId`)
- Recuperar sessões via `ListMultipartUploads` quando necessário.
- **Pros:** Zero estado duplicado; o storage é a fonte da verdade.
- **Cons:** Cada `complete` precisa listar uploads no storage para achar o `uploadId` correto, o que é lento e ambíguo com uploads concorrentes. Impossível correlacionar a sessão ao vídeo sem convenção frágil de nomes.

**Recommendation:** **Option A** — o pré-cadastro como rascunho e a sessão de upload são a mesma coisa nesta fase, e modelá-los como uma linha só mantém a migration e as queries triviais. A saída para o cenário de múltiplos uploads (Option B) continua disponível numa fase futura sem retrabalho destrutivo.

**Decision:** A (estado da sessão na própria linha do vídeo) — o pré-cadastro recebe `filename`, `size_bytes` e `content_type`; o título é derivado do filename e passa a ser editável na Fase 04 (resolve AMB-2 de `validation.md`)

---

## TD-05: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O diagrama de arquitetura trata o "Video Worker (FFmpeg)" como um container separado da API. Falta decidir se ele é um projeto separado, um processo separado do mesmo código, ou um consumidor embutido na API. A decisão define o `compose.yaml`, o `package.json` (scripts) e o layout de `src/`.

**Options:**

### Option A: Processo separado, mesmo codebase, entrypoint próprio
- Um segundo serviço no Compose (`video-worker`) usando a **mesma imagem** e o mesmo `src/`, iniciado por um entrypoint distinto (`src/worker.main.ts`) que dá `NestFactory.createApplicationContext()` de um `WorkerModule` enxuto (config + TypeORM + storage + processor), sem servidor HTTP.
- **Pros:** Atende ao diagrama (container separado, escala independente da API) sem duplicar código, entidades ou config. Reaproveita DI, TypeORM e o serviço de storage. Um único `npm install` e um único `tsc`. O container da API não carrega o processor, então um vídeo pesado não compete com requisições HTTP.
- **Cons:** O `WorkerModule` precisa ser mantido em sincronia com o que o processor consome. A imagem passa a precisar de ffmpeg mesmo para a API (mitigado: os testes de integração do extrator rodam no container da API e precisam de ffmpeg de qualquer jeito).

### Option B: Consumidor embutido no processo da API
- O `@Processor` vive dentro do `AppModule`; API e worker no mesmo processo.
- **Pros:** Mais simples: um serviço, um entrypoint, nada novo no Compose.
- **Cons:** Contraria o diagrama de arquitetura. ffmpeg competindo com o event loop que serve HTTP é exatamente o "processamento pesado bloqueando o usuário" que o plano lista em Pontos de Atenção. Impossível escalar worker e API separadamente.

### Option C: Subprojeto independente (`video-worker/` na raiz do monorepo)
- Projeto Node próprio, com `package.json`, entidades e config próprios.
- **Pros:** Isolamento total; poderia até usar outra stack.
- **Cons:** Duplica entidades TypeORM, config e migrations ou exige um package compartilhado — trabalho grande de tooling de monorepo que a fase não pede. O enunciado ainda determina não alterar a estrutura base do repositório.

**Recommendation:** **Option A** — entrega o container separado que o diagrama prevê pelo preço de um entrypoint adicional, mantendo entidades, config e storage em um lugar só. É também a topologia que os testes conseguem exercitar de verdade: um teste de integração pode instanciar o `WorkerModule` e rodar o processor contra Redis, MinIO e Postgres reais do Compose.

**Decision:** A (processo separado, mesmo codebase, entrypoint próprio)

---

## TD-06: Metadata Extraction and Thumbnail Generation Toolchain

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Duração, resolução, codec, bitrate e o frame que vira thumbnail saem todos do toolchain FFmpeg. A decisão é como invocá-lo a partir do Node e como o binário entra na imagem — e, principalmente, se o worker baixa o arquivo inteiro (10GB) para o disco antes de analisar.

**Options:**

### Option A: `child_process.execFile` direto sobre `ffprobe`/`ffmpeg` do sistema
- `ffprobe -v error -print_format json -show_format -show_streams <input>` devolve JSON parseável; `ffmpeg -ss <t> -i <input> -frames:v 1 ...` extrai o frame. Binários instalados via `apt install ffmpeg` na imagem. Entrada é uma **URL pré-assinada de leitura**, não um arquivo local — tanto ffprobe quanto ffmpeg leem HTTP com Range e puxam só os bytes necessários.
- **Pros:** Zero dependências npm. Saída JSON do ffprobe é estável e tipável. `execFile` (sem shell) evita injeção de comando. Passar URL assinada em vez de path local evita baixar 10GB: o ffprobe lê só os headers e o ffmpeg só o trecho do frame. Controle total de flags e timeout.
- **Cons:** É preciso escrever o wrapper (spawn, timeout, parse, tratamento de stderr) à mão. Sem tipos prontos para o JSON do ffprobe.

### Option B: `fluent-ffmpeg`
- Wrapper com API fluente (`ffmpeg(input).screenshots({...})`, `ffmpeg.ffprobe(...)`).
- **Pros:** API legível; `screenshots()` cobre o caso de thumbnail com poucas linhas. Tipos via `@types/fluent-ffmpeg`.
- **Cons:** Projeto em manutenção mínima (última publicação 2.1.3, sem release relevante há anos) e com issues abertas de compatibilidade em Node moderno. Continua exigindo o binário ffmpeg instalado — não elimina a dependência de sistema, só adiciona uma camada por cima dela. Abstração escondendo as flags dificulta controlar exatamente o que é lido do input remoto.

### Option C: `ffmpeg-static` / `ffprobe-static` (binário via npm) + `execFile`
- Mesma invocação da Option A, mas com o binário vindo de um pacote npm em vez do apt.
- **Pros:** Versão do binário fixada pelo `package-lock.json`; não depende do repositório da distro.
- **Cons:** Binário baixado no `npm install` (mais lento, e sensível à arquitetura do host — o projeto roda em arm64 e amd64). Builds estáticas costumam vir com menos codecs/protocolos habilitados, e precisamos especificamente do protocolo HTTPS para ler a URL assinada.

**Recommendation:** **Option A** — invocar `ffprobe`/`ffmpeg` direto por `execFile`, com os binários instalados via apt na imagem e **a URL pré-assinada como input**. É o único arranjo que garante que um vídeo de 10GB não seja baixado para o disco do worker: o ffprobe lê apenas metadados e o ffmpeg apenas o trecho do frame, via Range HTTP. O wrapper manual é pequeno e o JSON do ffprobe é um contrato estável.

**Decision:** A (`execFile` direto em `ffprobe`/`ffmpeg`, input por URL pré-assinada)

---

## TD-07: Unique Video URL Identifier Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de uma URL curta, única e não-adivinhável, que nunca colida. O `id` interno já é UUID v4, mas UUID em URL é longo (36 chars) e revela que é um identificador de banco. O formato escolhido vira rota pública consumida pelo frontend. Uma restrição de stack importa: o projeto compila em CommonJS (`module: nodenext`, ts-jest CJS) e o `nanoid` é ESM-only desde a v4 — a v6 atual não tem entrypoint CJS.

**Options:**

### Option A: `public_id` base62 de 11 chars gerado por `crypto.randomBytes`, coluna única
- `randomBytes(8)` mapeado no alfabeto `[0-9A-Za-z]`, truncado em 11 caracteres, gravado em coluna `varchar(11) unique`. Rota pública `/videos/{publicId}`.
- **Pros:** Zero dependências — `node:crypto` é builtin, sem problema de ESM/CJS. 62^11 ≈ 5.2×10^19 combinações: colisão desprezível, e a constraint `unique` do Postgres é a garantia final (retry na colisão). Não-adivinhável, o que já prepara o terreno para vídeos unlisted na Fase 04. Formato familiar (é o formato de ID do YouTube).
- **Cons:** Precisa da função de encoding escrita à mão (pequena, testável). Requer índice único adicional.

### Option B: `nanoid`
- Gerador pronto, alfabeto URL-safe configurável.
- **Pros:** Biblioteca consolidada, colisão bem caracterizada, API de uma linha.
- **Cons:** **Incompatível com a build atual:** `nanoid@6` é ESM-only (`"type": "module"`, sem export CJS) e quebraria em ts-jest/CommonJS. Usar `nanoid@3` significa fixar um major antigo deliberadamente. Dependência nova para ~15 linhas de código.

### Option C: Usar o próprio UUID como identificador público
- A rota vira `/videos/{uuid}`.
- **Pros:** Zero trabalho — a coluna já existe, unicidade garantida pelo PK.
- **Cons:** URL de 36 caracteres, contrariando o "URL curta e única" listado em Pontos de Atenção do plano. Expõe o identificador interno nas rotas públicas, acoplando a chave primária ao contrato externo.

### Option D: Slug do título + sufixo aleatório
- `meu-video-a1b2c3`.
- **Pros:** URL legível e melhor para SEO.
- **Cons:** O título é editável na Fase 04 — ou a URL muda (quebrando links) ou o slug descola do título. No pré-cadastro (TD-04) o título pode nem existir ainda. Complexidade de normalização (acentos, duplicatas) sem ganho nesta fase.

**Recommendation:** **Option A** — resolve a URL curta e não-adivinhável sem adicionar dependência e sem esbarrar na incompatibilidade ESM/CJS do nanoid. A coluna `unique` no Postgres é a garantia real de "sem conflito", e o gerador é uma função pura de fácil teste unitário.

**Decision:** A (base62 de 11 chars via `crypto.randomBytes`, coluna única)

---

## TD-08: Streaming Delivery Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** O player precisa começar a tocar sem baixar o arquivo inteiro e precisa poder pular para qualquer ponto — o que em HTTP significa requisições com header `Range` respondidas com `206 Partial Content`. A decisão é quem serve esses bytes: a API ou o storage. Afeta autorização (vídeos em `draft`/`failed` não podem ser servidos) e carga da API.

**Options:**

### Option A: API faz proxy do Range para o storage
- `GET /videos/{publicId}/stream` valida o vídeo (existe, `status = ready`), repassa o header `Range` num `GetObjectCommand` e faz pipe do stream retornado direto para a resposta, devolvendo `206` com `Content-Range`, `Accept-Ranges` e `Content-Length`. Sem Range, responde `200` com o stream completo.
- **Pros:** Devolve `206` a partir da nossa própria origem — verificável direto no endpoint e sem depender de redirect. Autorização aplicada a cada requisição (essencial quando a Fase 04 introduzir visibilidade unlisted/draft). Uma origem só, sem CORS nem expiração de URL para o player lidar. Memória limitada: é pipe de stream, nada é bufferizado.
- **Cons:** Os bytes do vídeo atravessam a API, consumindo banda e conexões do container — é o custo que a Option B evita. Escalar exige escalar a API.

### Option B: Redirect 302 para URL pré-assinada de leitura
- O endpoint valida e responde `302` com `Location` apontando para uma URL assinada de curta duração; o storage serve o Range/206.
- **Pros:** Zero bytes pela API — o caminho mais escalável, e o que se usaria com CloudFront/CDN na frente.
- **Cons:** O endpoint da API nunca devolve `206` (devolve `302`), então "streaming funcionando" só é observável seguindo o redirect. Uma vez emitida, a URL vale até expirar, independentemente de mudanças de visibilidade. Exige CORS no bucket para o player do browser.

### Option C: Empacotar em HLS/DASH no worker
- O worker gera segmentos `.ts` + manifesto `.m3u8`.
- **Pros:** Streaming adaptativo de verdade, padrão da indústria para vídeo em escala.
- **Cons:** Muito além do escopo: a capability pede reprodução sem download completo, não bitrate adaptativo. Transcodificação multiplica tempo de processamento e armazenamento. A Fase 03 não lista transcodificação entre suas capabilities.

**Recommendation:** **Option A** — o proxy com Range é o que torna a capability diretamente observável (a nossa rota responde `206` de verdade) e mantém a autorização por requisição, que a Fase 04 vai exigir para vídeos unlisted. O custo de banda é aceitável na escala do projeto, e a migração para a Option B (ou para um CDN) depois é trocar o corpo de um handler — o contrato da rota não muda. Emparelha com TD-09, que joga o tráfego pesado de download para fora da API.

**Decision:** A (API faz proxy do Range e responde 206) — acesso público (`@Public()`) quando `status = ready`; vídeos em qualquer outro status são visíveis apenas para o canal dono (resolve AMB-1 de `validation.md`)

---

## TD-09: Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Download do vídeo pelo usuário

**Context:** Download é transferência sequencial do arquivo inteiro — o oposto do padrão de acesso do streaming. Vale decidir separadamente de TD-08 porque as restrições são diferentes: aqui não há seek nem player, e o volume de bytes por requisição é máximo.

**Options:**

### Option A: Redirect 302 para URL pré-assinada com `Content-Disposition: attachment`
- `GET /videos/{publicId}/download` valida o vídeo e responde `302` com `Location` para uma URL assinada de curta duração (~5 min) gerada com `ResponseContentDisposition=attachment; filename="..."` e `ResponseContentType`.
- **Pros:** Os 10GB não passam pela API — exatamente onde o offload mais importa. O storage já sabe servir download resumível. O nome do arquivo e o cabeçalho de attachment são controlados na assinatura, sem precisar de proxy. Validação de status/propriedade continua acontecendo na API antes do redirect.
- **Cons:** A URL assinada segue válida até expirar. O cliente precisa seguir redirects (todo browser e `curl -L` seguem).

### Option B: API faz proxy do arquivo inteiro
- Mesmo mecanismo de pipe da TD-08 Option A, sem Range.
- **Pros:** Uma origem só; controle total; simétrico com o streaming.
- **Cons:** Prende uma conexão da API por todo o download de 10GB — é o pior caso de uso de recurso da fase, e vizinho demais do anti-padrão que o enunciado reprova.

**Recommendation:** **Option A** — download é justamente o caso em que o offload para o storage paga mais, e o `Content-Disposition` na assinatura entrega a semântica de "salvar arquivo" sem proxy. A API continua sendo o ponto de autorização: o redirect só é emitido depois de validar o vídeo.

**Decision:** A (302 para URL pré-assinada com `Content-Disposition: attachment`) — mesma regra de acesso da TD-08: público quando `status = ready`, caso contrário apenas o canal dono (resolve AMB-1 de `validation.md`)

---

## TD-10: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O enunciado pede o ciclo "rascunho → processando → pronto/erro" refletido no banco. Falta fixar o conjunto exato de estados, quem faz cada transição, e o que acontece quando o ffmpeg falha (arquivo corrompido, formato não suportado, timeout). Depende de TD-02 (a política de retry é a da fila).

**Options:**

### Option A: Quatro estados + retry da fila + `processing_error` persistido
- Enum `draft | processing | ready | failed`. `draft` na criação da sessão (TD-04); `processing` quando o `complete` fecha a multipart e enfileira o job; `ready` quando o worker grava duração/metadados/thumbnail; `failed` quando o job esgota as tentativas. Job com `attempts: 3` e backoff exponencial; a mensagem do erro final vai para a coluna `processing_error`. Falha não apaga o arquivo — o vídeo fica `failed` e auditável.
- **Pros:** Mapeia exatamente o ciclo pedido, sem estados inventados. Retry cobre falhas transitórias (storage indisponível) sem marcar `failed` cedo demais. `processing_error` torna o diagnóstico possível sem ler log de container. Reprocessar é reenfileirar o mesmo `videoId` — o job é idempotente porque lê o estado do banco.
- **Cons:** Um vídeo pode ficar preso em `processing` se o worker morrer entre o `active` e o `completed` (mitigável com o mecanismo de stalled job da fila).

### Option B: Estados mínimos (`draft | ready`) com erro só em log
- Sem `processing` nem `failed` explícitos.
- **Pros:** Modelo mais enxuto, menos transições para testar.
- **Cons:** Não atende ao enunciado, que exige o ciclo com processando e erro refletidos no banco. Usuário não teria como distinguir "ainda processando" de "falhou".

### Option C: Máquina de estados estendida (`draft | uploading | uploaded | processing | ready | failed`)
- Estados adicionais para cada etapa do transporte.
- **Pros:** Rastreabilidade granular de onde o upload parou.
- **Cons:** `uploading` e `uploaded` descrevem transporte, não domínio, e já são dedutíveis de `upload_id` (TD-04). Mais transições para manter e testar sem capability pedindo.

**Recommendation:** **Option A** — é o conjunto mínimo que satisfaz literalmente o ciclo exigido, com retry e mensagem de erro persistida. Deixa o caminho aberto para um endpoint de reprocessamento numa fase futura sem mudar o enum.

**Decision:** A (`draft | processing | ready | failed` + retry com backoff + `processing_error`)

---

## TD-11: Test Strategy for Storage, Queue and Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A fase introduz três dependências externas novas (object storage, fila, ffmpeg) e o enunciado é explícito: "não mocke o que dá para testar de verdade com a infra do Compose". Precisa ficar decidido qual camada testa o quê, de onde sai o arquivo de vídeo usado nos testes, e como o teste alcança uma URL assinada que foi gerada para um endpoint público. Isso é contrato cross-component: `compose.yaml` + `package.json` (jest) + helpers de teste precisam concordar.

**Options:**

### Option A: Pirâmide com infra real do Compose e fixture gerada por ffmpeg
- **Unit** (`*.spec.ts`): lógica pura com colaboradores mockados — gerador de `public_id`, parser do JSON do ffprobe, montagem do plano de partes. **Integração** (`*.integration-spec.ts`): MinIO, Redis, Postgres e ffmpeg reais do Compose — serviço de storage (multipart real ponta a ponta), produtor/consumidor da fila, processor do worker. **E2E** (`*.e2e-spec.ts`): contrato HTTP via supertest, incluindo o handshake de upload completo e uma requisição `Range` retornando `206`. O vídeo de fixture é **gerado por ffmpeg no setup** (`testsrc` de poucos segundos), não versionado. URLs assinadas geradas para o endpoint público são reescritas para o hostname interno do Compose por um helper de teste.
- **Pros:** Exercita a infra de verdade, como o enunciado exige. Fixture gerada evita binário no git e é determinística. Reusa a convenção de sufixos e o `--runInBand` que o projeto já adota. O helper de reescrita de host documenta explicitamente a dualidade de endpoints da TD-01.
- **Cons:** Suíte mais lenta (subir o `WorkerModule`, processar vídeo real). Testes passam a depender de Redis e MinIO no ar — quem rodar sem `docker compose up` vê falha.

### Option B: Mockar storage e fila em todas as camadas
- Stubs em memória para S3 e BullMQ.
- **Pros:** Suíte rápida e sem dependência de infra.
- **Cons:** Contraria diretamente a instrução do enunciado. O que mais pode dar errado nesta fase é exatamente a integração (assinatura de multipart, ETags, `Range`, invocação do ffmpeg) — e é justamente isso que o mock esconde.

### Option C: Testcontainers (subir MinIO/Redis por suíte)
- Cada suíte sobe seus próprios containers.
- **Pros:** Isolamento total entre execuções; não exige Compose no ar.
- **Cons:** Dependência nova e pesada; Docker-in-Docker a partir do container da API é problema conhecido. O projeto já estabeleceu "Compose no ar + `--runInBand`" como estratégia de integração na Fase 02 — trocar de modelo agora é inconsistência sem ganho.

**Recommendation:** **Option A** — segue a instrução explícita de testar contra a infra real, mantém a convenção de testes já estabelecida na Fase 02 e evita versionar binário de vídeo. O helper de reescrita de host é pequeno e torna visível uma armadilha real de rede Docker em vez de escondê-la.

**Decision:** A (pirâmide com infra real do Compose, fixture gerada por ffmpeg) — esta TD prevalece sobre a seção "Object Storage — Local Filesystem" do `testing-guide-nestjs-project`, que será atualizada para MinIO nesta fase (resolve IC-1 de `validation.md`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object Storage Client and Bucket/Key Organization | A (`@aws-sdk/client-s3` v3, bucket único com prefixos, endpoint interno + público) | A (AWS SDK v3, bucket único) |
| TD-02 | Backend | Background Processing Queue Technology | A (BullMQ + Redis via `@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-03 | Cross-layer | Large-File Upload Protocol (up to 10GB) | C (multipart com URL pré-assinada por parte) | C (multipart pré-assinada) |
| TD-04 | Backend | Upload Session Lifecycle and Draft Pre-registration | A (estado da sessão na própria linha do vídeo) | A (sessão na linha do vídeo) |
| TD-05 | Backend | Video Worker Runtime Topology | A (processo separado, mesmo codebase, entrypoint próprio) | A (worker em processo separado) |
| TD-06 | Backend | Metadata Extraction and Thumbnail Generation Toolchain | A (`execFile` direto em ffprobe/ffmpeg, input por URL assinada) | A (execFile ffprobe/ffmpeg) |
| TD-07 | Cross-layer | Unique Video URL Identifier Strategy | A (base62 de 11 chars via `crypto.randomBytes`, coluna única) | A (base62 via crypto) |
| TD-08 | Cross-layer | Streaming Delivery Strategy | A (API faz proxy do Range, responde 206) | A (proxy de Range, 206) |
| TD-09 | Cross-layer | Download Delivery Strategy | A (302 para URL assinada com `Content-Disposition: attachment`) | A (302 + Content-Disposition) |
| TD-10 | Backend | Video Status Lifecycle and Processing Failure Policy | A (`draft \| processing \| ready \| failed` + retry + `processing_error`) | A (4 estados + retry) |
| TD-11 | Backend | Test Strategy for Storage, Queue and Worker | A (pirâmide com infra real do Compose, fixture gerada por ffmpeg) | A (infra real do Compose) |
