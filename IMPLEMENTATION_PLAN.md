# ILLUMATRIX V.2 — Implementation Plan & Phase Roadmap

> **Document Status:** Active Implementation Roadmap  
> **Approach:** Strict risk-ordered, phased execution; one scoped task at a time; verification before progression.

---

## Phase Overview

- **Phase 0 — Baseline Audit & Security Triage (CURRENT)**
- **Phase 1 — Stabilize the Existing Workflow & Unresolved Invariants**
- **Phase 2 — Harden Provider & Model Manager & Credential Isolation**
- **Phase 3 — Establish Shared AI Execution Engine Interface**
- **Phase 4 — Cost-Policy Router & Bounded Failover**
- **Phase 5 — Truthful Telemetry & Jobs Dashboard**
- **Phase 6 — Production Release Readiness & Final Certification**

---

## Phase 0: Baseline Audit & Security Triage Tasks

### Task 0.1: Repository & Baseline State Audit (Completed & Verified)
- **Objective**: Inspect the real repository tree, scripts, dependencies, server setup, and test runner.
- **Scope**: Codebase audit, runtime environment verification.
- **Affected Files**: `README.md`, `package.json`, `server.ts`.
- **Deliverables**: Comprehensive audit report, running dev server, passing tests.
- **Verification**: `npm test` (84 tests passing), `npm run lint` (clean), `npm run build` (clean).
- **Status**: **Verified**.

### Task 0.2: Project Documentation Foundation (Completed & Verified)
- **Objective**: Create and update the seven root documentation files required by the V.2 brief.
- **Scope**: `README.md`, `PROJECT_REQUIREMENTS.md`, `ARCHITECTURE.md`, `FEATURES.md`, `IMPLEMENTATION_PLAN.md`, `DESIGN_SYSTEM.md`, `PROJECT_MEMORY.md`.
- **Deliverables**: 7 synchronized, evidence-based documentation files distinguishing verified facts from unverified/planned items.
- **Verification**: Cross-file consistency review and path verification.
- **Status**: **Verified**.

### Task 0.3: Credential Security & Gitignore Hardening (Completed & Verified)
- **Objective**: Eliminate risk of plaintext secrets being committed or exposed; create `.gitignore`; quarantine existing credentials in `.provider_connections.json`; dynamically inject environment credentials.
- **Scope**: Added root `.gitignore` ignoring `.env*`, `.provider_connections.json`, `dist/`, `node_modules/`, with `!.env.example` exception. Sanitized `.provider_connections.json`. Added dynamic `resolveEffectiveApiKey()` in `providerManager.ts`. Added test coverage for dynamic loading and zero on-disk persistence.
- **Affected Files**: `/.gitignore`, `/.provider_connections.json`, `src/server/providerManager.ts`, `tests/api-provider-manager.test.ts`.
- **Verification**: 90/90 tests passing (`npm test`), clean lint (`tsc --noEmit`), clean build (`vite build`).
- **Status**: **Verified**.

### Task 0.4: Custom Endpoint SSRF Protection (Completed & Verified)
- **Objective**: Protect server against SSRF attacks through user-configured custom OpenAI-compatible `baseUrl` values.
- **Scope**: Centralized URL safety validator (`src/server/urlSafetyValidator.ts`) enforcing `http:`/`https:` protocols, forbidding URL credentials, blocking loopback IPv4/IPv6, cloud metadata (`169.254.169.254`, `metadata.google.internal`), private RFC 1918 and CGNAT ranges, and resolving hostnames against all DNS answers. Enforced in `providerManager.ts` (`testConnection` and `executeTextGeneration`), in `server.ts` (`app.post('/api/providers')`), with manual redirect re-validation (`safeSsrfFetch`).
- **Affected Files**: `src/server/urlSafetyValidator.ts`, `src/server/providerManager.ts`, `server.ts`, `tests/api-provider-manager.test.ts`.
- **Verification**: 103/103 tests passing (`npm test`), clean lint (`tsc --noEmit`), clean build (`vite build`).
- **Status**: **Verified**.

---

## Phase 1: Stabilize Existing Workflow Tasks

### Task 1.1: Long-Form Duration Decision Resolution
- **Objective**: Confirm or formalize the duration options for 16:9 Long-Form (3-minute vs 4-minute minimum).
- **Scope**: Maintain existing `[3, 4, 5, 8, 10]` minutes or update if product decision is provided.
- **Prerequisite**: Product owner decision.
- **Status**: **Blocked on Decision DEC-01**.

### Task 1.2: End-to-End Workflow Regression Suite (Completed & Verified)
- **Objective**: Create or improve deterministic regression tests covering all seven workflow stages (Setup & Rules, Source Library, Script Studio, Scene Prompts, SEO Package, Thumbnail Studio, Review & Export).
- **Scope**:
  - Validates stage-to-stage navigation and state persistence across storage reloads.
  - Validates downstream stale marking and invalidation matrix on configuration, visual style, source story, and script edits.
  - Validates single-deliverable regeneration isolation (e.g. single scene prompt, single thumbnail option, title variant selection).
  - Validates missing required inputs and invalid workflow transitions across all stages.
  - Validates Review & Export readiness audit for blockers (missing source, scene count mismatch, unapproved script, incomplete scene packages) and warnings (stale deliverables, unapproved thumbnails).
  - Validates all 6 export formats (Master Markdown, JSON Backup, Google Flow batch, Teleprompter narration script, SEO metadata file, Thumbnail prompts file) and certifies zero secrets exposure.
  - Preserves long-form duration options `[3, 4, 5, 8, 10]` minutes and Devanagari Hindi language fidelity.
- **Affected Files**: `tests/e2e-workflow-regression.test.ts`, `src/services/storage.ts`, `PROJECT_MEMORY.md`, `IMPLEMENTATION_PLAN.md`.
- **Verification**: `npm test` (119/119 passing tests, 0 failures), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production build).
- **Status**: **Verified**.

### Task 1.3A: SSRF DNS Rebinding Risk Assessment (Completed & Verified)
- **Objective**: Conduct formal security audit of custom-provider endpoint handling (`src/server/urlSafetyValidator.ts`, `providerManager.ts`, `server.ts`) for DNS rebinding and TOCTOU vulnerabilities.
- **Scope**: Code trace, analysis of 7 security properties, transport connection evaluation, test plan design.
- **Findings**:
  - Found that `safeSsrfFetch` calls `validateCustomProviderUrl` at $T_0$, but then calls Node global `fetch` at $T_1$, which performs a second unpinned DNS lookup, enabling DNS rebinding bypass.
  - Designed pinned-socket transport using native Node `node:https`/`node:http` maintaining TLS certificate & SNI verification.
- **Status**: **Assessment Completed & Verified**.

### Task 1.3B: SSRF Transport Hardening & Deterministic IP Pinning (Completed & Verified)
- **Objective**: Implement socket-level IP pinning transport for `safeSsrfFetch` using native `node:https`/`node:http`, preserving SNI and certificate validation, adding 10s default timeout and 5 MiB payload cap, and blocking IPv4-compatible IPv6 addresses.
- **Scope**:
  - Implemented `pinnedHttpRequest()` with socket-level IP pinning via custom DNS `lookup` callback on Node's native `node:https`/`node:http` client.
  - Strictly preserved `parsed.hostname` for Host header, SNI (`servername`), and TLS certificate validation (`rejectUnauthorized: true`).
  - Implemented 10-second default overall timeout returning `category: 'TIMEOUT'` (HTTP 504) and 5 MiB maximum response body size returning `category: 'PAYLOAD_TOO_LARGE'` (HTTP 413) with full stream/socket cleanup.
  - Validated and pinned each 3xx redirect hop independently (max 3 hops), stripping `Authorization` on cross-origin redirects.
  - Closed IPv6 classification gap for deprecated IPv4-compatible IPv6 addresses (`::127.0.0.1`, `::169.254.169.254`, `::10.0.0.1`) and IPv4-translated IPv6 addresses (`::ffff:0:a.b.c.d`).
  - Added 14 automated tests in `tests/api-provider-manager.test.ts`.
- **Affected Files**: `src/server/urlSafetyValidator.ts`, `tests/api-provider-manager.test.ts`, `PROJECT_MEMORY.md`, `IMPLEMENTATION_PLAN.md`.
- **Verification**: `npm test` (133/133 tests passing across 10 suites), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production build).
- **Status**: **Completed & Verified**.

### Task 1.4A: Provider Execution & Cost Policy Audit (Completed & Verified)
- **Objective**: Audit existing provider execution engine, backend cost policies, Auto Free selection, BYOK behavior, and fallback handling (assessment-only).
- **Scope**:
  - Inspected `providerManager.ts`, `modelCompatibility.ts`, `server.ts`, `WorkflowContext.tsx`, `ProviderManagerModal.tsx`, and test suites.
  - Verified 10 policy areas across Auto Free, BYOK, paid execution, server-side cost enforcement, credentials, retries/fallback, error categories, endpoints, connection testing, and secret leakage.
  - Documented findings: server-side cost policy engine is currently unimplemented; failover does not enforce cost tier parity; connection testing dispatches live generative inference; unrecognized connection ID silently falls back to default.
- **Affected Files**: `PROJECT_MEMORY.md`, `IMPLEMENTATION_PLAN.md`.
- **Verification**: `npm test` (133/133 passing), `npm run lint` (0 diagnostics), `npm run build` (clean Vite build).
- **Status**: **Assessment Completed & Verified**.

### Task 1.4B: Provider Execution & Cost Policy Remediation (Completed & Verified)
- **Objective**: Remediate the 4 cost policy, failover, connection testing, and routing findings identified in Task 1.4A (`COST-01`, `COST-02`, `COST-03`, `ROUTE-01`).
- **Scope & Implementation**:
  - **Strict Connection Resolution (`ROUTE-01`)**: Updated `src/server/providerManager.ts` (`getEffectiveCredentials` and `executeTextGeneration`) to fail closed with `CONNECTION_NOT_FOUND` (HTTP 404) whenever an explicitly requested `connectionId` does not exist. Silent fallback to default connections is permanently eliminated.
  - **Server-Side Cost Policy Enforcement (`COST-01`)**: Implemented and enforced strict backend cost policies across all execution paths (`free_only`, `prefer_free`, `manual`):
    - `free_only`: Positively verifies zero-cost status using trusted metadata. Immediately rejects paid, unverified, missing, or ambiguous pricing models with `PAYWALL_BLOCKED` (HTTP 402).
    - `prefer_free`: Prefers zero-cost models, but rejects paid model execution without explicit authorization (`allowPaidExecution: true`).
    - `manual`: Enforces connection validity and blocks paid execution without explicit authorization.
    - Server routes in `server.ts` (`/api/ai/generate-script`, `/api/ai/regenerate-scene`, `/api/ai/generate-scene-prompts`, `/api/ai/regenerate-style-prompts`, `/api/ai/regenerate-scene-prompt`, `/api/ai/generate-seo`, `/api/ai/generate-thumbnails`, `/api/ai/render-thumbnail-image`) pass cost parameters and handle errors via `handleGenerationError`.
  - **Failover Cost-Tier Isolation (`COST-02`)**: Updated `findEligibleFailoverConnection` in `src/server/providerManager.ts` to strictly prohibit `free_only` from failing over to paid or unverified connections. `prefer_free` failovers cannot cross into paid connections without explicit authorization (`allowPaidExecution: true`). Preserves complete credential and connection isolation.
  - **Safe Connection Testing (`COST-03`)**: Hardened `testConnection` in `src/server/providerManager.ts`:
    - Uses non-generative connectivity/key validation endpoints for supported providers (Google GenAI `/v1beta/models`, OpenRouter `/api/v1/auth/key`, Groq `/v1/models`).
    - For paid models or providers requiring generative tests, requires explicit authorization (`allowBillableTest: true`) or fails closed with `BILLABLE_TEST_REQUIRED` (HTTP 402).
  - **Comprehensive Regression Suite**: Implemented 10 deterministic test suites in `tests/cost-policy-remediation.test.ts`.
- **Affected Files**: `src/server/providerManager.ts`, `src/server/modelCompatibility.ts`, `server.ts`, `tests/cost-policy-remediation.test.ts`, `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md`.
- **Verification**: `npm test` (144/144 tests passing across 11 suites), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production build).
- **Status**: **Completed & Verified**.

---

## Phase 2: Harden Provider & Model Manager

### Task 2.1: Secure Key Storage Migration (Completed & Verified)
- **Objective**: Audit and securely migrate provider API-key storage. Eliminate plaintext credentials at rest, enforce cryptographic encryption at rest, centralize secret redaction, and implement origin protection for provider management APIs.
- **Scope & Implementation**:
  - **Comprehensive Storage Audit**: Audited all 6 credential pathways (UI input, in-memory runtime, persistent file storage, outbound API responses, logging/errors, and backup exports). Identified at-rest plaintext risk in `.provider_connections.json` for BYOK keys.
  - **AES-256-GCM AEAD Encryption at Rest**: Implemented cryptographic storage engine (`src/server/credentialSecurity.ts`) using standard Node.js `node:crypto`.
    - Key derivation via RFC 5869 HKDF-SHA256.
    - 96-bit (12-byte) unique cryptographically secure random IV per encryption.
    - 128-bit (16-byte) authentication tag guaranteeing ciphertext authenticity and integrity.
    - Format: `enc:v1:<base64-iv>:<base64-tag>:<base64-ciphertext>`.
    - Tampering with ciphertext or auth tag fails closed with `DecryptionFailedError`.
  - **Server-Side Storage Boundary & Fail-Closed Behavior**:
    - Precedence: `ILLUMATRIX_ENCRYPTION_KEY` / `KEY_ENCRYPTION_SECRET` environment variables -> dedicated local single-user master key file (`.encryption_master_key` mode `0o600`).
    - If master key is disabled/missing (`ILLUMATRIX_DISABLE_FILE_KEY=true`), persistent disk encryption fails closed with `MasterKeyMissingError` (HTTP 500); BYOK keys are held strictly in memory for the active process without leaking plaintext to disk (`apiKey: ""` on disk).
    - Legacy plaintext auto-migration: When `.provider_connections.json` is loaded with legacy plaintext keys, it automatically encrypts them to `enc:v1:...` and overwrites disk with plaintext erased.
  - **Centralized Secret Redaction**: Centralized `redactSecretString`, `redactHeaders`, `redactObject`, and `sanitizeError` covering all provider prefixes (Google AI Studio, OpenAI, OpenRouter, Groq, Cerebras, Hugging Face, SambaNova), auth headers, and query parameters.
  - **Cross-Site & Origin Protection**: Implemented `validateProviderAccessOrigin` on `/api/providers` rejecting foreign web origins with HTTP 403 `FORBIDDEN`.
  - **Environment & Repository Hygiene**: Hardened `/.gitignore` to ignore `.provider_connections.json*`, `*.key`, `*.secret`, `.env*`. Updated `/.env.example` with placeholders for `ILLUMATRIX_ENCRYPTION_KEY` and optional provider keys.
  - **Automated Regression Suite**: Added 10 deterministic tests in `tests/secure-key-storage.test.ts`.
- **Affected Files**: `src/server/credentialSecurity.ts`, `src/server/providerManager.ts`, `server.ts`, `tests/secure-key-storage.test.ts`, `package.json`, `/.gitignore`, `/.env.example`, `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md`.
- **Verification**: `npm test` (155/155 tests passing across 11 suites), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production build).
- **Status**: **Completed & Verified**.

### Task 2.2: Live Catalog Discovery Caching & Cooldowns
- **Objective**: Implement reliable server-side caching, single-flight deduplication, and failure cooldowns for live provider/model catalog discovery.
- **Architectural Implementation**:
  - **Centralized In-Memory Catalog Cache (`src/server/catalogCache.ts`)**:
    - **Safe Key Fingerprinting**: Cache keys combine `<provider>|<connectionId>|<normalizedBaseUrl>|<keyFingerprint>` where the key fingerprint is derived via `crypto.createHash('sha256')` (16 chars). Zero raw API keys are ever stored in keys, logs, or diagnostics.
    - **Configurable TTL**: Documented default of 30 minutes (`1,800,000 ms`), fully configurable and mock-clock injectable.
    - **Single-Flight Deduplication**: In-flight Promise sharing ensures concurrent requests for identical discovery contexts trigger exactly one network call.
    - **Bounded Memory & Eviction**: Bounded to 100 catalog entries with LRU (least-recently-used) and expired-entry eviction.
    - **Defensive Immutability**: All writes and reads use `structuredClone` deep cloning to prevent internal cache corruption by caller mutations.
  - **Provider Failure Cooldowns & Exponential Backoff**:
    - Applied to transient network failures, timeouts, rate limits (HTTP 429), and server errors (HTTP 5xx).
    - Base cooldown: 5 seconds (`5,000 ms`), doubling exponentially on consecutive failures up to max cooldown of 300 seconds (`300,000 ms` / 5 minutes).
    - Valid `Retry-After` HTTP headers (seconds or date format) are parsed and honored, clamped safely to `maxCooldownMs`.
    - Distinct Auth Policy: Authentication failures (HTTP 401, 403, `INVALID_CREDENTIALS`) do not trigger exponential backoff suppression, allowing immediate re-tries upon key correction.
  - **Stale-If-Error Policy**:
    - Expired catalog entries within a 24-hour window are returned as stale fallbacks (`isStale: true`, `source: 'cached_catalog'`, with clear `staleReason`) when upstream refresh is throttled or offline.
    - Never presents stale data as live. If no prior catalog exists, fails closed with the provider error without fabricating models.
  - **Untrusted Remote Input Protection**:
    - 5 MiB maximum catalog response body cap (`checkPayloadSize`).
    - 2,000 model item limit per catalog (`validateAndSanitizeCatalogPayload`) to prevent memory/CPU exhaustion denial-of-service.
    - Type and structure validation ensuring required string IDs and clean truncated metadata.
  - **Custom Provider SSRF Preservation**: Custom endpoints enforce pre-flight SSRF validation via `validateCustomProviderUrl` and pinned socket transport via `safeSsrfFetch`.
- **Affected Files**:
  - `src/server/catalogCache.ts` (Created: core CatalogCacheManager engine).
  - `src/server/providerManager.ts` (Integrated: cache lookup, single-flight live fetch, cooldowns, invalidation on credential/URL edits).
  - `server.ts` (Updated: `forceRefresh` support on `/api/providers/models` and `/api/providers/:id/models`).
  - `tests/catalog-cache-cooldown.test.ts` (Created: 13 deterministic automated test suites).
  - `package.json` (Updated test runner script).
  - `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md` (Updated).
- **Verification**: `npm test` (169/169 tests passing across 12 suites), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production bundle).
- **Status**: **Completed & Verified**.

---

## Phase 3: Establish Shared AI Execution Interface

### Task 3.1: Shared AI Execution Interface & Orchestration Engine
- **Objective**: Design and implement a shared, typed AI execution interface across all provider integrations (`Google GenAI`, `Groq`, `OpenRouter`, and `OpenAI Compatible` family). Reduce duplicated execution logic across endpoints while strictly preserving provider-specific behavior, security controls (`ROUTE-01` strict routing, SSRF validation, `COST-01`/`COST-02` cost policy enforcement), failover isolation, and backward compatibility.
- **Implementation Architecture**:
  - **Typed Execution Contracts (`src/server/aiExecutionEngine.ts`)**:
    - `AIExecutionTaskType`: Unified categorization (`script_generation`, `scene_prompts`, `style_regeneration`, `single_scene_prompt`, `thumbnail_prompts`, `single_thumbnail`, `seo_generation`, `general_text`, `connectivity_test`).
    - `AIExecutionRequest`: Strict typed inputs including `connectionId`, `modelId`, `prompt`, `systemInstruction`, `responseMimeType`, `responseSchema`, `temperature`, `maxTokens`, `costPolicy`, `allowPaidExecution`, `timeoutMs`, `signal`, `customResolver`, `allowFailover`.
    - `AIExecutionResult`: Normalized success output with `text`, `data`, `model`, `provider`, `connectionId`, `latencyMs`, `isFallback`, `failoverOccurred`, `originalConnectionId`, `usage` (`promptTokens`, `completionTokens`, `totalTokens`), and `rawResponse`.
    - `AIExecutionError`: Structured, sanitized error class extending `Error` with `category`, `status`, `code`, `connectionId`, `provider`, `modelId`, and safe `toJSON()` serialization that redacts secrets and cleartext keys.
  - **Modular Provider Adapters (`ProviderExecutionAdapter`)**:
    - `GoogleGenAIAdapter`: Native `@google/genai` client, `ThinkingLevel.LOW` for `gemini-3.8-flash`, JSON schemas via `Type`, transient 503 backoff retries, usage metadata extraction.
    - `GroqAdapter`: Bearer auth, OpenAI format JSON schema, auto-retry on 400 without `response_format: { type: 'json_object' }`, usage tokens.
    - `OpenRouterAdapter`: Headers `HTTP-Referer: https://illumatrix.internal`, `X-Title: ILLUMATRIX Content Workspace`, Bearer auth, usage extraction.
    - `OpenAICompatibleAdapter`: Universal adapter for OpenAI, Cerebras, Cloudflare Workers AI (with Account ID validation), Hugging Face, Mistral AI, SambaNova, Ollama, and custom OpenAI Compatible providers. Uses `safeSsrfFetch` on custom endpoints.
  - **Shared Orchestration Layer (`AIExecutionEngine.execute()`)**:
    - Step 1: Strict Connection Resolution (`ROUTE-01`: unknown `connectionId` fails closed with HTTP 404 `CONNECTION_NOT_FOUND`).
    - Step 2: Connection Status Check (`DISABLED` HTTP 400 if disabled).
    - Step 3: Credential Resolution (resolves key inside server boundary; HTTP 401 `KEY_UNCONFIGURED` if missing).
    - Step 4: Model Resolution (explicit override or connection baseline).
    - Step 5: Cost Policy Pre-Flight (`COST-01`: `free_only` and `prefer_free` fail closed with HTTP 402 `PAYWALL_BLOCKED` on paid or unverified models without `allowPaidExecution: true`).
    - Step 6: Modality & Compatibility Pre-Flight (checks `isTextGenerationCapable`, HTTP 400 `UNSUPPORTED_MODALITY`).
    - Step 7: SSRF Pre-Flight (validates custom endpoints via `validateCustomProviderUrl`, HTTP 400 `SSRF_BLOCKED` / `UNSUPPORTED_PROTOCOL`).
    - Step 8: Adapter Selection & Execution (tracks latency, updates connection stats, defensive copy).
    - Step 9: Failover Handling (`COST-02`: on 429/quota, if `allowFailover === true`, searches eligible failover obeying cost policy parity; fails over with `isFallback: true` and `failoverOccurred: true`).
    - Step 10: Seamless Backward-Compatibility: `providerManager.executeTextGeneration` delegates to `aiExecutionEngine.executeTextGeneration`.
- **Affected Files**:
  - `src/server/aiExecutionEngine.ts` (Created: full typed engine, contracts, adapters, orchestrator).
  - `src/server/providerManager.ts` (Updated: method visibilities made public, `executeTextGeneration` delegated to engine, exports updated).
  - `package.json` (Updated: test script includes `tests/shared-execution-interface.test.ts`).
  - `tests/shared-execution-interface.test.ts` (Created: 12 comprehensive automated test suites).
  - `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md` (Updated).
- **Verification**: `npm test` (182/182 tests passing across 13 suites, 0 failures), `npm run lint` (0 diagnostics), `npm run build` (clean Vite production bundle).
- **Status**: **Completed & Verified**.

### Task 3.2: Execution Engine Integration & Legacy Path Elimination (Completed & Verified)
- **Objective**: Audit and complete the integration of the shared `AIExecutionEngine` across all AI-generation workflows and provider execution paths. Eliminate unsafe or redundant legacy execution paths.
- **Route Integration Matrix**:
  | Route | Handler / Endpoint | Task Type | Modality | Integration Status | Justification / Notes |
  |---|---|---|---|---|---|
  | `POST /api/ai/generate-script` | Script breakdown & narration | `script_generation` | `text` | **Integrated (Shared Engine)** | Uses `providerManager.executeTextGeneration`, enforces ROUTE-01, COST-01, credential isolation. |
  | `POST /api/ai/regenerate-scene` | Single scene beat regeneration | `script_generation` | `text` | **Integrated (Shared Engine)** | Isolated scene beat execution through shared adapter pipeline. |
  | `POST /api/ai/generate-scene-prompts` | Google Flow scene prompt packages | `scene_prompts` | `text` | **Integrated (Shared Engine)** | Dispatches through engine + post-generation `PromptSafetyEngine.reviewAndRepairScenePackages`. |
  | `POST /api/ai/regenerate-style-prompts` | Visual style regeneration | `style_regeneration` | `text` | **Integrated (Shared Engine)** | Visual prompt rewrite strictly preserving script beat & narration byte-for-byte. |
  | `POST /api/ai/regenerate-scene-prompt` | Single scene prompt regeneration | `single_scene_prompt` | `text` | **Integrated (Shared Engine)** | Isolated prompt package regeneration through shared engine. |
  | `POST /api/ai/repair-flow-rejection` | Google Flow rejection repair | N/A (Policy) | N/A | **Retained Local Engine** | Deterministic local safety synthesis (`PromptSafetyEngine`); no external provider call required. |
  | `POST /api/ai/generate-seo` | SEO metadata, titles, chapters | `seo_generation` | `text` | **Integrated (Shared Engine)** | Structured JSON schema generation via shared engine. |
  | `POST /api/ai/generate-thumbnails` | Dual thumbnail prompts (A/B) | `thumbnail_prompts` | `text` | **Integrated (Shared Engine)** | Dual concept generation (Enigma vs Observer) through shared engine. |
  | `POST /api/ai/regenerate-single-thumbnail` | Single thumbnail option regen | `single_thumbnail` | `text` | **Integrated (Shared Engine)** | Isolated single thumbnail prompt generation through shared engine. |
  | `POST /api/ai/render-thumbnail-image` | High-fidelity image rendering | N/A | `image` | **Integrated (Shared Engine)** | Migrated from legacy direct SDK instantiation to `aiExecutionEngine.executeImageGeneration` (`GoogleGenAIAdapter`, `gemini-3.1-flash-lite-image`). |
  | `POST /api/providers/test` | Connection connectivity test | `connectivity_test` | `text` | **Retained Direct Probe** | Non-generative credential validation (models API/auth key) to prevent billable token usage; SSRF-protected probe when billable test authorized. |
- **Legacy Paths Eliminated**:
  - `cachedAiClient`, `lastApiKey`, and `getAiClient()` in `server.ts` completely removed.
  - `generateWithModelFallback()` in `server.ts` completely removed.
  - Direct `new GoogleGenAI()` instantiation inside `render-thumbnail-image` route eliminated in favor of `aiExecutionEngine.executeImageGeneration()`.
- **Security & Cost Invariants Enforced**:
  - `ROUTE-01`: Explicit unknown `connectionId` fails closed with HTTP 404 `CONNECTION_NOT_FOUND`.
  - `COST-01`: Restrictive cost policies (`free_only`, `prefer_free`) block paid/unverified models before dispatch with HTTP 402 `PAYWALL_BLOCKED`.
  - `COST-02`: Multi-connection failover maintains cost-tier parity and credential isolation.
  - BYOK credential isolation: Credentials resolved server-side per connection; zero cleartext key leakage in responses, logs, or error dumps.
  - Disabled connections blocked before dispatch with HTTP 400 `DISABLED`.
  - Modality validation: Mismatched modalities (e.g., image model for text gen, or non-Google provider for image rendering) blocked before dispatch with HTTP 400 `UNSUPPORTED_MODALITY`.
  - Custom endpoint SSRF validation: Socket-level IP pinning and DNS validation enforced on custom endpoints.
- **Affected Files**:
  - `/server.ts` (Eliminated legacy fallback functions, exported `app`, passed `taskType` across all routes, routed `render-thumbnail-image` through `aiExecutionEngine.executeImageGeneration`, guarded `startServer` against test runners).
  - `/src/server/aiExecutionEngine.ts` (Added unshift registration for mock adapters, added `unregisterAdapter()`, verified SSRF and modality routing).
  - `/src/server/providerManager.ts` (Added `taskType` to `executeTextGeneration` signature, enhanced `handleGenerationError` with `KEY_UNCONFIGURED` HTTP 401, `TIMEOUT` HTTP 504, and `UNSUPPORTED_PROVIDER` HTTP 400).
  - `/src/server/modelCompatibility.ts` (Classified `gemini-3.1-flash-lite-image` and `-image` suffixed models under primaryModality `image`).
  - `/package.json` (Added `NODE_ENV=test` and `tests/execution-engine-integration.test.ts` to test script).
  - `/tests/execution-engine-integration.test.ts` (Created comprehensive route-level integration test suite with 19 test cases across 9 sections).
- **Verification Commands & Real Results**:
  - `npm test`: **201/201 tests passing across 14 suites, 0 failures, 0 skipped** (~7.6s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.3: AI Execution Security & Reliability Audit (Completed & Verified)
- **Objective**: Perform a focused security and reliability audit of the shared AI execution architecture after Tasks 3.1 and 3.2. Fix verified defects with minimal, targeted changes.
- **Audit Findings & Remediations**:
  1. **Image Generation Modality & Cost Isolation**:
     - Audited `aiExecutionEngine.executeImageGeneration()`, `GoogleGenAIAdapter`, and `POST /api/ai/render-thumbnail-image`.
     - Verified strict connection resolution (404 on unknown connection ID), BYOK credential isolation, and disabled connection rejection (HTTP 400).
     - Verified server-side cost policy enforcement: `gemini-3.1-flash-lite-image` is classified as `pricingTier: 'paid'`, requiring `allowPaidExecution: true` under `prefer_free`, and failing closed with HTTP 402 `PAYWALL_BLOCKED` under `free_only`.
     - Modality validation fails closed (HTTP 400 `UNSUPPORTED_MODALITY`) if non-Google provider or incompatible model is selected.
     - Added 10 MB payload size upper bound check (HTTP 413) on returned base64 image bytes.
     - Added cancellation pre-flight check before image generation dispatch.
     - Ensured endpoint returns strictly `{ success, provider, isFallback, imageUrl, optionId, timestamp }` with zero secrets, headers, or internal debugging dumps.
  2. **Bounded Retries & Replay Protection**:
     - Verified retry counts and delays are strictly bounded: `GoogleGenAIAdapter` only retries transient HTTP 503 high-demand errors once after a 700ms delay.
     - Groq and OpenAICompatible adapters only retry once on HTTP 400 when omitting unsupported `response_format: { type: 'json_object' }` (0 tokens generated).
     - Potentially billable errors (HTTP 500, mid-generation failures) are never replayed.
     - Authentication (401/403), validation (400), SSRF (400), and paywall (402) errors fail closed immediately with zero retries.
  3. **Cost Policy Pre-Flight & Payload Formatting**:
     - Fixed payload validation ordering: malformed `costPolicy` values (`invalid_policy`, `FREE`, `unlimited`, non-strings) now fail closed at Step 0 with HTTP 400 `INVALID_PAYLOAD` before connection resolution.
     - Unverified, missing, or ambiguous pricing does not qualify as zero-cost ($0.00/1M positive verification required).
  4. **Adapter Client Caching & Invalidation**:
     - Updated `GoogleGenAIAdapter.getClient` to cache clients using composite key `${connId}:${apiKey}:${timeoutMs}`.
     - Added `invalidateCache(connId?: string)` on `GoogleGenAIAdapter` and `aiExecutionEngine.invalidateClientCache()`.
     - Integrated cache invalidation into `providerManager.addOrUpdateConnection` and `deleteConnection`, ensuring credentials changes or connection deletions immediately purge cached client instances.
  5. **Pre-Flight Cancellation**:
     - Added `req.signal?.aborted` pre-flight check at Step 0 of `AIExecutionEngine.execute()`, aborting with HTTP 499 before any provider dispatch or adapter lookup occurs.
- **Affected Files**:
  - `/src/server/aiExecutionEngine.ts` (Composite key caching, `invalidateClientCache()`, Step 0 cancellation and cost policy validation, image payload size limit).
  - `/src/server/providerManager.ts` (Integrated client cache invalidation on update and deletion).
  - `/.gitignore` (Restored root `.gitignore` ignoring `.env*`, `.provider_connections.json`, `dist/`, `node_modules/` while allowing `!.env.example`).
  - `/.env.example` (Created with `GEMINI_API_KEY=` and provider configuration).
  - `/tests/security-reliability-audit.test.ts` (Expanded to 23 automated tests covering all 12 security regression requirements).
- **Verification Commands & Real Results**:
  - `npm test`: **225/225 tests passing across 15 suites, 0 failures, 0 skipped** (~9.1s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.3.1: Credential Cache & Execution Boundary Hardening (Completed & Verified)
- **Objective**: Perform focused security hardening on credential-safe SDK caching, multi-candidate image-response memory limits, and server-side authorization boundaries for billable execution.
- **Architectural Implementation**:
  1. **Credential-Safe SDK Client Caching (`src/server/aiExecutionEngine.ts` & `src/server/credentialSecurity.ts`)**:
     - **Non-Reversible Cryptographic Fingerprint**: Implemented and exported `createCredentialFingerprint(apiKey)` deriving a deterministic 16-character SHA-256 hash prefix (`k:<sha256(16)>` or `k:none`). Keyed `GoogleGenAIAdapter`'s `clientCache` by `${connId}:${fingerprint}:${timeoutMs}`, completely eliminating raw API keys from cache map keys, memory objects, and error traces.
     - **LRU Eviction & Capacity Bound**: Capped client cache to `MAX_GOOGLE_CLIENT_CACHE_ENTRIES = 50`. Automatically evicts the oldest cached instance when capacity is reached, preventing unbounded memory accumulation during credential rotations.
     - **Safe Diagnostics Inspection**: Implemented `GoogleGenAIAdapter.getCacheDiagnostics()` and `AIExecutionEngine.getGoogleClientCacheDiagnostics()`, exposing total entries, connection IDs, fingerprints, and timeouts with ZERO raw secret keys or bearer tokens.
     - **Connection Invalidation**: Preserved targeted invalidation by connection ID (`key.startsWith('${connId}:')`) and full cache clearing, integrated into provider lifecycle hooks.
  2. **Multi-Part Image-Response Memory Limits & Validation (`GoogleGenAIAdapter` & `executeImageGeneration`)**:
     - **Explicit Capacity Bounds**:
       - `MAX_IMAGE_BASE64_LENGTH = 10 * 1024 * 1024` (10 MB maximum base64 character payload).
       - `MAX_IMAGE_DECODED_BYTES = 7.5 * 1000 * 1000` (7.5 MB maximum decoded image binary bytes).
     - **Aggregate Candidate Traversal**: Iterates across all candidates and parts in the SDK response, accumulating `inlineData.data.length` into `aggregateBase64Length`. Rejects multi-part payloads exceeding 10 MB with HTTP 413 `INVALID_PAYLOAD`, preventing multi-part bypasses.
     - **Malformed Base64 Validation**: Verifies modulo-4 length and regex character set `^[A-Za-z0-9+/]+={0,2}$`. Rejects corrupted or non-base64 payloads with HTTP 400 `INVALID_PAYLOAD`.
     - **Decoded Binary Calculation**: Accurately computes decoded byte size `(length * 3 / 4) - padding`. Rejects payloads whose decoded binary exceeds 7.5 MB with HTTP 413 `INVALID_PAYLOAD`.
     - **Deferred Data URL Allocation**: Constructs `data:${mimeType};base64,...` only *after* all aggregate size, format, and decoded limit checks have passed.
     - **Dedicated Wrapper Enforcement**: Re-validates data URL size and decoded limits in `executeImageGeneration()`.
     - **Documented Upstream SDK Buffering**: Documented that while `@google/genai` performs in-memory network buffering prior to returning `GenerateContentResponse`, application boundaries prevent downstream allocations, URL retention, and serialization bloat.
  3. **Server-Side Authorization Boundaries for Billable Execution**:
     - **Type-Strict Parameter Pre-Flight**: Added Step 0 validation in `AIExecutionEngine.execute()` enforcing that `req.allowPaidExecution`, when provided, must be strictly of type `boolean`. Malformed values (strings, numbers, objects) fail closed with HTTP 400 `INVALID_PAYLOAD`.
     - **Uncoerced Transport**: Removed automatic `allowPaidExecution === true` coercion in `server.ts` `/api/ai/render-thumbnail-image` route so invalid parameters trigger Step 0 payload validation.
     - **Strict `free_only` Cost Policy Invariant**: Enforced that `free_only` unconditionally rejects paid/unverified models with HTTP 402 `PAYWALL_BLOCKED` regardless of whether `allowPaidExecution: true` is passed.
  4. **Comprehensive Automated Test Coverage (`tests/security-reliability-audit.test.ts`)**:
     - Test 24: Client cache reuse for identical connection, credential, and timeout.
     - Test 25: Cache miss and isolated client creation upon credential rotation/change.
     - Test 26: Distinct client caching across different timeout configurations.
     - Test 27: Cache LRU capacity enforcement (`MAX_GOOGLE_CLIENT_CACHE_ENTRIES = 50`) and eviction of oldest entries.
     - Test 28: Targeted cache invalidation by connection ID without disturbing other connections.
     - Test 29: Full cache invalidation clearing all entries.
     - Test 30: Cache diagnostics returning fingerprints and connection IDs with ZERO raw keys.
     - Test 31: Multi-part image aggregate base64 length > 10 MB failing closed with HTTP 413.
     - Test 32: Decoded image binary bytes > 7.5 MB failing closed with HTTP 413.
     - Test 33: Malformed base64 image data failing closed with HTTP 400 `INVALID_PAYLOAD`.
     - Test 34: `free_only` cost policy unconditionally blocking paid models even with `allowPaidExecution: true`.
     - Test 35: Non-boolean `allowPaidExecution` parameter failing closed with HTTP 400 `INVALID_PAYLOAD` in both engine and HTTP endpoint.
- **Affected Files**:
  - `src/server/credentialSecurity.ts` (Added `createCredentialFingerprint`).
  - `src/server/catalogCache.ts` (Updated to delegate `createCredentialFingerprint` to `credentialSecurity.ts`).
  - `src/server/aiExecutionEngine.ts` (Imported fingerprint helper, defined memory & cache constants, updated `GoogleGenAIAdapter` caching, eviction, diagnostics, multi-part image base64 & decoded byte limits, added Step 0 boolean validation for `allowPaidExecution`, added `getGoogleClientCacheDiagnostics()`).
  - `server.ts` (Updated `POST /api/ai/render-thumbnail-image` to pass `allowPaidExecution` uncoerced).
  - `tests/security-reliability-audit.test.ts` (Added tests 24-35 covering all 12 Task 3.3.1 requirements).
  - `IMPLEMENTATION_PLAN.md`, `PROJECT_MEMORY.md` (Updated).
- **Verification Commands & Real Results**:
  - `npm test`: **237/237 tests passing across 15 suites, 0 failures, 0 skipped** (~9.7s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.4A: Complete UI Operational Readiness Audit (Completed & Verified)
- **Objective**: Conduct a comprehensive product-completeness audit across all 7 workflow stages, global controls, AI execution settings, cost policies, and provider management to identify any backend capabilities lacking UI controls, disconnected UI handlers, or broken end-to-end user journeys.
- **Scope**: Comprehensive audit of the entire codebase and architecture without modifying source code. Formulated a 10-part report with classified findings (A through F) and prioritized remediation backlog (REM-01 through REM-07).
- **Status**: **Completed & Approved**.

### Task 3.4B: Complete Setup UI Inputs for Target Audience & Call to Action (REM-01) (Completed & Verified)
- **Objective**: Implement remediation item REM-01 from Task 3.4A audit. Add user-facing Target Audience and Call to Action controls to Stage 01 Setup, connect them to existing project settings state and persistence, and verify they flow into script and SEO generation without altering invariants or workflow rules.
- **Scope**:
  1. Added collapsible section titled "Audience & Conversion" in `src/components/stages/SetupWorkspace.tsx` using the HUD design system (`#0B0F19` card, `#1E293B` borders, `#00F0FF` / `#FFE600` accents).
  2. Implemented `targetAudience` (placeholder: "Curious science and astronomy enthusiasts", max 150 chars, character counter) and `callToAction` (placeholder: "Subscribe for weekly deep-space explainers", max 150 chars, character counter).
  3. Bound both inputs directly to `project.targetAudience` and `project.callToAction` via `updateProject({ targetAudience })` and `updateProject({ callToAction })`.
  4. Preserved state across toggle expand/collapse, page transitions, and local storage persistence.
  5. Validated persistence and backward-compatibility in `src/services/storage.ts` (`loadProject` and `importProjectBackupJson` ensure strings are preserved and older backups without these fields safely default without crashing).
  6. Verified script and SEO generation data flow through `WorkflowContext.tsx`, `aiService.ts`, and `server.ts` prompt construction (`String(...).slice(0, 200)` ensures prompt bounding and safety).
  7. Added comprehensive automated regression suite `tests/rem01-setup-audience-cta.test.ts` covering 9 dedicated verification checks.
- **Affected Files**:
  - `src/components/stages/SetupWorkspace.tsx`
  - `src/services/storage.ts`
  - `src/context/WorkflowContext.tsx`
  - `src/server/providerManager.ts`
  - `server.ts`
  - `src/components/stages/ReviewExportWorkspace.tsx`
  - `package.json`
  - `tests/rem01-setup-audience-cta.test.ts`
- **Verification Commands & Real Results**:
  - `npm test`: **246/246 tests passing across 16 test suites, 0 failures, 0 skipped** (~10.4s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.44s).
- **Status**: **Completed & Verified**.

### Task 3.4C: Connect Custom Model Selection to Single-Model Lookup API (REM-02) (Completed & Verified)
- **Objective**: Implement remediation item REM-02 from the Task 3.4A audit. Connect the custom model selection flow in `ProviderManagerModal.tsx` to the existing `POST /api/providers/single-model` backend endpoint, replacing client-side model metadata fabrication with genuine API-grounded verification, conservative fallbacks, and strict cost-policy enforcement.
- **Scope**:
  1. **Backend Integration (`src/server/providerManager.ts` & `server.ts`)**:
     - Enhanced `fetchSingleModelInfo(provider, modelId, apiKey, connectionId)` to resolve stored connections and their effective keys securely.
     - Checks connection saved models, provider catalog cache, and official OpenRouter single-model lookup endpoint (`/api/v1/models/:id`).
     - Grounded pricing in `classifyOpenRouterPricing(pricing, modelId)` to strictly enforce that zero-pricing requires both prompt == 0 AND completion == 0, and missing/incomplete prices are classified as `unknown`.
     - Grounded capabilities in `evaluateModelCompatibility(...)`.
     - Updated `POST /api/providers/single-model` in `server.ts` to support `connectionId` and resolve effective keys without client-side cleartext leakage.
  2. **Client Service (`src/services/aiService.ts`)**:
     - Added `AIService.fetchSingleModelInfo({ provider, modelId, apiKey, connectionId })` with input validation, 12s timeout controller, and error sanitization.
     - Kept `AIService.lookupSingleModel` alias for backward-compatibility.
  3. **Context Layer (`src/context/WorkflowContext.tsx`)**:
     - Exposed `fetchSingleModelInfo` in `WorkflowContextType` and `WorkflowProvider` for unified lookup across components.
  4. **Modal Component (`src/components/layout/ProviderManagerModal.tsx`)**:
     - Added loading state `isLookingUpCustomModel` to disable inputs and prevent duplicate submissions with a "Verifying..." spinner.
     - Validates model ID (length <= 200, no illegal control characters).
     - On successful lookup: populates verified model record with real capabilities, pricing, and context length while preserving provider/connection identity.
     - On lookup failure: displays an informative HUD notice (`#1C0F1A` card with `#FB7185` border and text) without silently marking the model as verified.
     - Safe fallback action: provides `handleProceedWithUnverifiedCustomModel` ("Use Unverified Identifier Anyway") assigning conservative unverified defaults (`pricingTier: 'unknown'`, `isZeroPriced: false`), which fails closed under `free_only` cost policy.
     - Cancellation: provides `handleCancelCustomLookup` and model browser cancel that resets error and candidate state without mutating active connections or settings.
  5. **Regression Test Suite (`tests/rem02-custom-model-lookup.test.ts`)**:
     - 7 comprehensive tests covering payload dispatch, error/timeout handling, cached/connection resolution, pricing classification invariants, modal wiring, backend connection resolution, and context integration.
- **Affected Files**:
  - `src/server/providerManager.ts`
  - `server.ts`
  - `src/services/aiService.ts`
  - `src/context/WorkflowContext.tsx`
  - `src/components/layout/ProviderManagerModal.tsx`
  - `package.json`
  - `tests/rem02-custom-model-lookup.test.ts`
- **Verification Commands & Real Results**:
  - `npm test`: **253/253 tests passing across 17 test suites, 0 failures, 0 skipped** (~24.3s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `compile_applet`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 3.4D: Clarify UI-Only Provider Simulation Controls (REM-03) (Completed & Verified)
- **Objective**: Implement remediation item REM-03 from the Task 3.4A audit. Explicitly identify provider rate-limit and quota-exhaustion simulation controls as UI-only tests without implying that they change actual server-side provider state or remote quota pools.
- **Scope**:
  1. **Pre-Edit Audit**: Inspected `src/components/layout/ControlCenter.tsx` and `src/context/WorkflowContext.tsx`. Confirmed both `simulateRateLimitTest` and `simulateQuotaExhaustedTest` are client-side in-memory mock actions (`setJobs`, `setConnections`, `addActivityEvent`, `showToast`) with zero backend calls, zero database writes, and zero remote provider impact.
  2. **ControlCenter UI Updates (`src/components/layout/ControlCenter.tsx`)**:
     - Updated visible button labels to `SIMULATE RATE LIMIT (UI TEST)` and `SIMULATE QUOTA EXHAUSTED (UI TEST)` with accessible `aria-label` attributes.
     - Added "UI SIMULATION SANDBOX" container header with "UI TEST ONLY" badge.
     - Added explicit helper description: *"Changes simulated UI/test state only. Does not change actual provider cooldowns, quota, credentials, or remote provider state."*
     - Added button tooltips clarifying that the action simulates client UI state only without changing actual provider cooldowns, quota, credentials, or remote state.
     - Added truthful status badge and connection item tooltips: *"Simulated rate limit — UI test cooldown (server provider state unchanged)"*.
  3. **WorkflowContext Truthful Messaging (`src/context/WorkflowContext.tsx`)**:
     - Updated job error message to *"Simulated rate limit — UI test (client-side simulation only; server provider state unchanged)."*
     - Updated activity log events to explicitly begin with *"Simulated rate limit — UI test:"* and *"Simulated quota exhausted — UI test:"*.
     - Updated toasts to explicitly say *"Simulated rate limit — UI test: Connection placed in simulated cooldown."* and *"Simulated quota exhausted — UI test: Keys in same project share quota pool."*
  4. **Regression Test Suite (`tests/rem03-ui-simulation-controls.test.ts`)**:
     - Added 7 automated tests verifying button labels, aria-labels, sandbox header/badge, helper text, tooltips, WorkflowContext job and event strings, and the server-state isolation invariant (zero disk mutations, zero providerManager mutations).
- **Affected Files**:
  - `src/components/layout/ControlCenter.tsx`
  - `src/context/WorkflowContext.tsx`
  - `package.json`
  - `tests/rem03-ui-simulation-controls.test.ts`
  - `PROJECT_MEMORY.md`
  - `IMPLEMENTATION_PLAN.md`
- **Verification Commands & Real Results**:
  - `npm test`: **260/260 tests passing across 18 test suites, 0 failures, 0 skipped** (~22.9s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.24s).
- **Status**: **Completed & Verified**.

### Task 3.4E: Remediation Closure & End-to-End Readiness Gate (Completed & Verified)
- **Objective**: Conduct comprehensive closure audit of Task 3.4A remediation items REM-01, REM-02, and REM-03, verify 7-stage workflow invariants, establish manual browser check status, and execute full test/build verification before Phase 4 begins.
- **Scope**:
  1. **REM-01 Closure**: Verified Target Audience and Call to Action inputs, schema validation, localStorage and JSON export/import compatibility, prompt bounding, and empty-value safety.
  2. **REM-02 Closure**: Verified custom model lookup path (`ProviderManagerModal` -> `AIService` -> `POST /api/providers/single-model` -> `providerManager`), key isolation, origin validation, conservative unverified fallbacks, and strict `free_only` enforcement.
  3. **REM-03 Closure**: Verified UI test labeling, disclaimers, status badges, and server-side isolation invariant.
  4. **7-Stage Workflow Audit**: Confirmed stage navigation, gating, invalidation, pacing (Shorts 8s blocks, Long-form 30s blocks), byte-for-byte narration preservation, and zero-secret export.
  5. **Manual Browser Verification**: Cataloged 4 pending manual browser checks (High-DPI, Clipboard, Modal Focus Trapping, Devanagari font rendering) with reproduction steps.
  6. **Test Coverage Audit**: Confirmed all 18 configured test suites in `package.json` pass. Identified orphan unconfigured test file `backend-to-ui-execution-management.test.ts`.
- **Verification Commands & Real Results**:
  - `npm test`: **260/260 tests passing across 18 test suites, 0 failures, 0 skipped** (~23.0s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build` in 1.28s).
- **Status**: **Completed & Verified**.

---

## Phase 4: Cost-Policy Router & Bounded Failover

### Task 4.1: Cost Policy Engine (Completed & Verified)
- **Objective**: Implement a centralized, deterministic Cost Policy Engine providing authoritative decisions on whether a proposed provider/model execution is permitted under the active project policy (`free_only`, `prefer_free`, `manual`).
- **Scope & Delivery**:
  - Implemented `CostPolicyEngine` (`src/server/costPolicyEngine.ts`) with typed contracts (`CostPolicyDecision`, `CostPolicyEvaluationContext`, `PolicyValidationResult`).
  - Integrated `costPolicyEngine.validatePolicyInput()` into Step 0 and `costPolicyEngine.evaluate()` into Step 5 of `aiExecutionEngine.execute()` (`src/server/aiExecutionEngine.ts`).
  - Integrated `costPolicyEngine.evaluateFailoverCandidate()` into `findEligibleFailoverConnection()` in `src/server/providerManager.ts`.
  - Enforced strict invariants:
    1. `free_only`: Strictly permits only positively verified zero-cost ($0.00/1M) models. Rejects paid, unknown, missing, contradictory, or malformed pricing with HTTP 402 `PAYWALL_BLOCKED`. Paid authorization (`allowPaidExecution: true`) never overrides `free_only`.
    2. `prefer_free`: Prefers zero-cost models; requires explicit, validated boolean authorization (`allowPaidExecution: true`) for billable or unknown models. Rejects paid models without authorization (HTTP 402).
    3. `manual`: Permits explicitly selected model; direct manual selection represents direct user consent unless explicit opt-out (`allowPaidExecution: false`) is provided. Failover from a free connection to a paid candidate strictly requires `allowPaidExecution: true`.
    4. Invalid policy strings or non-boolean `allowPaidExecution` fail closed with HTTP 400 `INVALID_PAYLOAD`.
    5. Secrets scrubbing: All decision messages run through `redactSecretString` to guarantee zero cleartext key or token exposure.
  - Created dedicated test suite `tests/cost-policy-engine.test.ts` (35 tests).
- **Affected Files**:
  - `src/server/costPolicyEngine.ts` (new)
  - `src/server/aiExecutionEngine.ts`
  - `src/server/providerManager.ts`
  - `tests/cost-policy-engine.test.ts` (new)
  - `package.json`
  - `IMPLEMENTATION_PLAN.md`
  - `PROJECT_MEMORY.md`
- **Verification Commands & Real Results**:
  - `npx tsx --test tests/cost-policy-engine.test.ts`: **35/35 passing tests, 0 failures** (953ms).
  - `npm test`: **295/295 tests passing across 19 test suites, 0 failures, 0 skipped** (23.5s).
  - `npm run lint`: **0 diagnostics** (`tsc --noEmit`).
  - `npm run build`: **Build succeeded** (`vite build`).
- **Status**: **Completed & Verified**.

### Task 4.2: Two-Pool Model Management (Verified Free vs BYOK)
- **Objective**: Keep user BYOK pool cleanly isolated from auto-verified free routes.
- **Status**: **Planned**.

---

## Phase 5: Truthful Telemetry & Jobs Dashboard

### Task 5.1: Observability & Jobs Console
- **Objective**: Provide detailed job history showing task type, status, duration, retries, and honest data source attribution.
- **Status**: **Planned**.

---

## Phase 6: Production Release Readiness

### Task 6.1: Full Release Checklist & Master Audit Certification
- **Objective**: Execute end-to-end certification, secret audit, bundle size checks, and build readiness.
- **Status**: **Planned**.
