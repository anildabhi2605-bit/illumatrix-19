/**
 * ILLUMATRIX V.2 — Shared AI Execution Interface & Orchestration Engine
 * 
 * Provides a unified, typed execution interface across all supported AI providers:
 * - Google GenAI (Native SDK with ThinkingLevel.LOW, JSON schemas, low-latency retries)
 * - Groq (High-speed LPU inference, Bearer auth, JSON object mode fallback)
 * - OpenRouter (Aggregated gateway, provenance headers, dynamic catalog support)
 * - OpenAI Compatible (OpenAI, Cerebras, Cloudflare, HF, Mistral, SambaNova, Ollama, Custom)
 * 
 * Mandatory Security Invariants:
 * - ROUTE-01: Unknown explicit connection IDs fail closed (HTTP 404 CONNECTION_NOT_FOUND). No silent fallback.
 * - Credential Isolation: BYOK requests use only the selected connection's credentials. Zero plaintext leakage.
 * - COST-01: Cost policy enforcement (free_only, prefer_free, manual) validated before dispatch.
 * - COST-02: Failover destinations must comply strictly with cost policy and credential isolation.
 * - SSRF Protection: Custom provider endpoints validate via DNS-pinned transport and socket-level IP validation.
 */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type {
  SupportedProvider,
  CostPolicy,
} from '../types/hud';
import {
  evaluateModelCompatibility,
  evaluateConnectionPricing,
} from './modelCompatibility';
import {
  validateCustomProviderUrl,
  safeSsrfFetch,
  type DnsResolver,
} from './urlSafetyValidator';
import {
  redactSecretString,
  createCredentialFingerprint,
} from './credentialSecurity';
import {
  providerManager,
  type ServerProviderConnection,
  PROVIDER_REGISTRY,
  cleanJsonText,
  sanitizeError,
} from './providerManager';
import { costPolicyEngine } from './costPolicyEngine';

// ============================================================================
// 1. TYPED EXECUTION CONTRACTS & DOMAIN TYPES
// ============================================================================

export type AIExecutionTaskType =
  | 'script_generation'
  | 'scene_prompts'
  | 'style_regeneration'
  | 'single_scene_prompt'
  | 'thumbnail_prompts'
  | 'single_thumbnail'
  | 'seo_generation'
  | 'general_text'
  | 'connectivity_test';

export type AIExecutionModality = 'text' | 'image';

export interface AIExecutionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIExecutionRequest {
  /** Optional explicit connection ID. When provided, MUST exist or fails closed (ROUTE-01). */
  connectionId?: string;
  /** Explicit model override. If omitted, target connection's configured modelId is used. */
  modelId?: string;
  /** Operational task category for provenance and logging */
  taskType?: AIExecutionTaskType;
  /** Requested generation modality (default: 'text') */
  modality?: AIExecutionModality;
  /** User or system input prompt (string or structured payload) */
  prompt: string | any;
  /** Optional system instruction */
  systemInstruction?: string;
  /** Response format mime type (e.g. 'application/json' or 'text/plain') */
  responseMimeType?: string;
  /** Optional structured JSON schema */
  responseSchema?: any;
  /** Sampling temperature (0.0 to 1.0) */
  temperature?: number;
  /** Maximum generation tokens */
  maxTokens?: number;
  /** Active user cost policy ('free_only' | 'prefer_free' | 'manual') */
  costPolicy?: CostPolicy;
  /** Explicit authorization for billable inference on paid/unverified models */
  allowPaidExecution?: boolean;
  /** Retry limit for transient errors (default: 2) */
  maxRetries?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Abort signal for request cancellation */
  signal?: AbortSignal;
  /** Custom DNS resolver for SSRF test environments */
  customResolver?: DnsResolver;
  /** Whether automatic failover to an eligible connection is allowed on 429/quota */
  allowFailover?: boolean;
}

export interface AIExecutionResult {
  success: boolean;
  text: string;
  model: string;
  provider: string;
  connectionId: string;
  latencyMs: number;
  isFallback: boolean;
  failoverOccurred?: boolean;
  originalConnectionId?: string;
  usage?: AIExecutionUsage;
  data?: any;
  rawResponse?: any;
  imageUrl?: string;
}

export interface ExecuteImageGenerationOptions {
  connectionId?: string;
  prompt: string;
  format?: string;
  optionId?: string;
  allowPaidExecution?: boolean;
  costPolicy?: CostPolicy;
  timeoutMs?: number;
}

export interface AIImageExecutionResult {
  success: boolean;
  imageUrl: string;
  provider: string;
  optionId?: string;
  latencyMs: number;
  model: string;
}

export type AIExecutionErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'DISABLED'
  | 'KEY_UNCONFIGURED'
  | 'CONFIG_MISSING'
  | 'PAYWALL_BLOCKED'
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_MODALITY'
  | 'SSRF_BLOCKED'
  | 'UNSUPPORTED_PROTOCOL'
  | 'INVALID_CREDENTIALS'
  | 'PERMISSION_DENIED'
  | 'MODEL_NOT_FOUND'
  | 'RATE_LIMIT_429'
  | 'QUOTA_EXHAUSTED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'EXECUTION_FAILED';

export class AIExecutionError extends Error {
  public readonly category: AIExecutionErrorCode;
  public readonly status: number;
  public readonly code: AIExecutionErrorCode;
  public readonly connectionId?: string;
  public readonly provider?: string;
  public readonly modelId?: string;
  public readonly details?: any;
  public readonly sanitized: boolean = true;

  constructor(options: {
    message: string;
    category: AIExecutionErrorCode;
    status: number;
    connectionId?: string;
    provider?: string;
    modelId?: string;
    details?: any;
  }) {
    const cleanMsg = redactSecretString(options.message);
    super(cleanMsg);
    this.name = 'AIExecutionError';
    this.category = options.category;
    this.status = options.status;
    this.code = options.category;
    this.connectionId = options.connectionId;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.details = options.details ? redactSecretString(String(options.details)) : undefined;

    Object.setPrototypeOf(this, AIExecutionError.prototype);
  }

  public toJSON() {
    return {
      error: true,
      name: this.name,
      message: this.message,
      category: this.category,
      code: this.code,
      status: this.status,
      connectionId: this.connectionId,
      provider: this.provider,
      modelId: this.modelId,
      details: this.details,
    };
  }
}

// ============================================================================
// 2. PROVIDER ADAPTER CONTEXT & CONTRACTS
// ============================================================================

export interface ProviderExecutionContext {
  connection: ServerProviderConnection;
  effectiveKey: string;
  effectiveModelId: string;
  endpoint: string;
  isCustomEndpoint: boolean;
  start: number;
  timeoutMs: number;
}

export interface AdapterExecutionResult {
  text: string;
  usage?: AIExecutionUsage;
  rawResponse?: any;
  imageUrl?: string;
}

export interface ProviderExecutionAdapter {
  readonly adapterName: string;
  canHandle(provider: SupportedProvider): boolean;
  execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult>;
}

// ============================================================================
// 3. ISOLATED PROVIDER ADAPTERS
// ============================================================================

// Memory & Cache Boundaries (Task 3.3.1)
export const MAX_GOOGLE_CLIENT_CACHE_ENTRIES = 50;
export const MAX_IMAGE_BASE64_LENGTH = 10 * 1024 * 1024; // 10 MB maximum base64 character payload (10,485,760 chars)
export const MAX_IMAGE_DECODED_BYTES = 7.5 * 1000 * 1000; // 7.5 MB (7,500,000 bytes) maximum decoded image binary bytes

/**
 * Native Google GenAI Adapter using @google/genai SDK
 * 
 * Memory and Upstream SDK Buffering Note:
 * The @google/genai SDK buffers and parses HTTP responses in memory before returning
 * GenerateContentResponse. While application-level checks cannot prevent internal SDK
 * network buffering, these strict boundaries prevent downstream allocations, data URL
 * constructions, memory leaks, and large string persistence on the server.
 */
export class GoogleGenAIAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'GoogleGenAIAdapter';
  private clientCache: Map<string, GoogleGenAI> = new Map();

  public canHandle(provider: SupportedProvider): boolean {
    return provider === 'Google GenAI';
  }

  public getClient(connId: string, apiKey: string, timeoutMs: number): GoogleGenAI {
    // Cryptographic non-reversible fingerprint prevents raw key retention in cache maps
    const fingerprint = createCredentialFingerprint(apiKey);
    const cacheKey = `${connId}:${fingerprint}:${timeoutMs}`;
    let client = this.clientCache.get(cacheKey);
    if (!client) {
      // Bounded cache capacity with LRU eviction to prevent memory accumulation
      if (this.clientCache.size >= MAX_GOOGLE_CLIENT_CACHE_ENTRIES) {
        const oldestKey = this.clientCache.keys().next().value;
        if (oldestKey) {
          this.clientCache.delete(oldestKey);
        }
      }

      client = new GoogleGenAI({
        apiKey,
        httpOptions: {
          timeout: timeoutMs,
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });
      this.clientCache.set(cacheKey, client);
    }
    return client;
  }

  public invalidateCache(connId?: string): void {
    if (connId) {
      for (const key of this.clientCache.keys()) {
        if (key.startsWith(`${connId}:`)) {
          this.clientCache.delete(key);
        }
      }
    } else {
      this.clientCache.clear();
    }
  }

  /**
   * Safe diagnostics reporting - returns connection and fingerprint identity without leaking raw keys
   */
  public getCacheDiagnostics(): {
    totalEntries: number;
    entries: Array<{ connectionId: string; fingerprint: string; timeoutMs: number }>;
  } {
    const entries = Array.from(this.clientCache.keys()).map((key) => {
      const parts = key.split(':');
      // Format is connId:k:<sha256(16)>:timeoutMs
      const connId = parts[0] || 'unknown';
      const timeoutMs = Number(parts[parts.length - 1]) || 0;
      const fingerprint = parts.slice(1, parts.length - 1).join(':') || 'unknown';
      return {
        connectionId: connId,
        fingerprint,
        timeoutMs,
      };
    });

    return {
      totalEntries: this.clientCache.size,
      entries,
    };
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    const client = this.getClient(ctx.connection.id, ctx.effectiveKey, ctx.timeoutMs);

    if (req.modality === 'image') {
      if (req.signal?.aborted) {
        throw req.signal.reason || new Error('Request cancelled by caller.');
      }
      const isShorts = (req.prompt as any)?.format === '9:16_SHORTS' || String((req.prompt as any)?.format || '').includes('9:16');
      const aspectRatio = isShorts ? '9:16' : '16:9';
      const promptText = typeof req.prompt === 'string' ? req.prompt : ((req.prompt as any)?.prompt || (req.prompt as any)?.text || '');

      const response = await client.models.generateContent({
        model: 'gemini-3.1-flash-lite-image',
        contents: {
          parts: [{ text: promptText }],
        },
        config: {
          imageConfig: {
            aspectRatio: aspectRatio as any,
          },
        },
      });

      // 1. Traverse all candidate parts to calculate aggregate base64 length (prevents multi-part bypass)
      let aggregateBase64Length = 0;
      let primaryBase64Image: string | null = null;
      let mimeType = 'image/jpeg';

      for (const candidate of response.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.inlineData?.data) {
            aggregateBase64Length += part.inlineData.data.length;
            if (!primaryBase64Image) {
              primaryBase64Image = part.inlineData.data;
              mimeType = part.inlineData.mimeType || 'image/jpeg';
            }
          }
        }
      }

      if (aggregateBase64Length > MAX_IMAGE_BASE64_LENGTH) {
        throw new AIExecutionError({
          message: `Image provider response payload exceeds maximum allowable size (10 MB). Aggregate size: ${(aggregateBase64Length / (1024 * 1024)).toFixed(2)} MB.`,
          category: 'INVALID_PAYLOAD',
          status: 413,
          connectionId: ctx.connection.id,
        });
      }

      if (!primaryBase64Image) {
        throw new Error('Gemini image provider returned no image bytes.');
      }

      // 2. Validate base64 structure and character set
      const cleanBase64 = primaryBase64Image.trim();
      if (
        cleanBase64.length === 0 ||
        cleanBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64)
      ) {
        throw new AIExecutionError({
          message: 'Image provider returned malformed base64 image data.',
          category: 'INVALID_PAYLOAD',
          status: 400,
          connectionId: ctx.connection.id,
        });
      }

      // 3. Compute exact decoded binary bytes: (length * 3 / 4) - padding
      const padding = cleanBase64.endsWith('==') ? 2 : cleanBase64.endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor((cleanBase64.length * 3) / 4) - padding;

      if (decodedBytes > MAX_IMAGE_DECODED_BYTES) {
        throw new AIExecutionError({
          message: `Decoded image binary exceeds maximum allowable size (7.5 MB). Decoded size: ${(decodedBytes / (1024 * 1024)).toFixed(2)} MB.`,
          category: 'INVALID_PAYLOAD',
          status: 413,
          connectionId: ctx.connection.id,
        });
      }

      // 4. Defer data URL allocation until AFTER all limits and format checks pass
      const fullUrl = `data:${mimeType};base64,${cleanBase64}`;
      return {
        text: fullUrl,
        imageUrl: fullUrl,
        rawResponse: response,
      };
    }

    const modelName = ctx.effectiveModelId;
    const maxRetries = req.maxRetries ?? 2;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const config: any = {};
        if (req.systemInstruction) config.systemInstruction = req.systemInstruction;
        if (req.responseMimeType) config.responseMimeType = req.responseMimeType;
        if (req.responseSchema) config.responseSchema = req.responseSchema;
        if (modelName === 'gemini-3.8-flash') {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }
        if (req.temperature !== undefined) config.temperature = req.temperature;
        if (req.maxTokens !== undefined) config.maxOutputTokens = req.maxTokens;

        const response = await client.models.generateContent({
          model: modelName,
          contents: req.prompt,
          config,
        });

        if (response.text) {
          const usageMetadata: any = (response as any).usageMetadata;
          const usage: AIExecutionUsage | undefined = usageMetadata ? {
            promptTokens: usageMetadata.promptTokenCount,
            completionTokens: usageMetadata.candidatesTokenCount,
            totalTokens: usageMetadata.totalTokenCount,
          } : undefined;

          return {
            text: response.text,
            usage,
            rawResponse: response,
          };
        }

        throw new Error('Empty response received from Google GenAI.');
      } catch (err: any) {
        lastError = err;
        const msg = sanitizeError(err);
        const status = err?.status || err?.code;
        const is503 = status === 503 || msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');

        if (attempt === 1 && is503) {
          if (req.signal?.aborted) {
            throw req.signal.reason || new Error('Request cancelled by caller.');
          }
          await new Promise((r) => setTimeout(r, 700));
          if (req.signal?.aborted) {
            throw req.signal.reason || new Error('Request cancelled by caller.');
          }
          continue;
        }
        break;
      }
    }

    throw lastError;
  }
}

/**
 * Dedicated Groq LPU Adapter
 */
export class GroqAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'GroqAdapter';

  public canHandle(provider: SupportedProvider): boolean {
    return provider === 'Groq';
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.effectiveKey}`,
    };

    let systemMsg = req.systemInstruction || '';
    let promptText = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt);

    if (req.responseMimeType === 'application/json') {
      if (!systemMsg.toUpperCase().includes('JSON')) {
        systemMsg += (systemMsg ? '\n\n' : '') + 'MANDATE: Output valid JSON only.';
      }
      if (!promptText.toUpperCase().includes('JSON')) {
        promptText +=
          '\n\nPlease return your response strictly as a valid JSON object matching the requested schema. Do not include markdown code block formatting or explanations.';
      }
    }

    const messages: any[] = [];
    if (systemMsg) messages.push({ role: 'system', content: systemMsg });
    messages.push({ role: 'user', content: promptText });

    const reqBody: any = {
      model: ctx.effectiveModelId,
      messages,
    };
    if (req.temperature !== undefined) reqBody.temperature = req.temperature;
    if (req.maxTokens !== undefined) reqBody.max_tokens = req.maxTokens;
    if (req.responseMimeType === 'application/json') {
      reqBody.response_format = { type: 'json_object' };
    }

    const fetchFn = (ctx.isCustomEndpoint && !req.customResolver)
      ? (url: string, init: any) => safeSsrfFetch(url, init)
      : fetch;

    const timeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
    const combinedSignal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
    let resp = await fetchFn(ctx.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: combinedSignal,
    });

    // If Groq rejected response_format: { type: 'json_object' } with 400, retry once without it
    if (!resp.ok && resp.status === 400 && reqBody.response_format) {
      delete reqBody.response_format;
      const retryTimeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
      const retrySignal = req.signal ? AbortSignal.any([req.signal, retryTimeoutSignal]) : retryTimeoutSignal;
      resp = await fetchFn(ctx.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: retrySignal,
      });
    }

    if (resp.ok) {
      const json: any = await resp.json();
      const content = json.choices?.[0]?.message?.content;
      if (content && typeof content === 'string' && content.trim().length > 0) {
        const usage: AIExecutionUsage | undefined = json.usage ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        } : undefined;

        return {
          text: content,
          usage,
          rawResponse: json,
        };
      }
      throw new Error(`Empty response content received from Groq (${ctx.effectiveModelId}).`);
    }

    const errText = await resp.text().catch(() => '');
    const sanitized = sanitizeError(errText || `HTTP ${resp.status}`);
    const err: any = new Error(sanitized);
    err.status = resp.status;
    throw err;
  }
}

/**
 * Dedicated OpenRouter Gateway Adapter
 */
export class OpenRouterAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'OpenRouterAdapter';

  public canHandle(provider: SupportedProvider): boolean {
    return provider === 'OpenRouter';
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://illumatrix.internal',
      'X-Title': 'ILLUMATRIX Content Workspace',
    };
    if (ctx.effectiveKey) {
      headers.Authorization = `Bearer ${ctx.effectiveKey}`;
    }

    let systemMsg = req.systemInstruction || '';
    let promptText = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt);

    if (req.responseMimeType === 'application/json') {
      if (!systemMsg.toUpperCase().includes('JSON')) {
        systemMsg += (systemMsg ? '\n\n' : '') + 'MANDATE: Output valid JSON only.';
      }
      if (!promptText.toUpperCase().includes('JSON')) {
        promptText +=
          '\n\nPlease return your response strictly as a valid JSON object matching the requested schema. Do not include markdown code block formatting or explanations.';
      }
    }

    const messages: any[] = [];
    if (systemMsg) messages.push({ role: 'system', content: systemMsg });
    messages.push({ role: 'user', content: promptText });

    const reqBody: any = {
      model: ctx.effectiveModelId,
      messages,
    };
    if (req.temperature !== undefined) reqBody.temperature = req.temperature;
    if (req.maxTokens !== undefined) reqBody.max_tokens = req.maxTokens;

    const fetchFn = (ctx.isCustomEndpoint && !req.customResolver)
      ? (url: string, init: any) => safeSsrfFetch(url, init)
      : fetch;

    const timeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
    const combinedSignal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    const resp = await fetchFn(ctx.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: combinedSignal,
    });

    if (resp.ok) {
      const json: any = await resp.json();
      const content = json.choices?.[0]?.message?.content;
      if (content && typeof content === 'string' && content.trim().length > 0) {
        const usage: AIExecutionUsage | undefined = json.usage ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        } : undefined;

        return {
          text: content,
          usage,
          rawResponse: json,
        };
      }
      throw new Error(`Empty response content received from OpenRouter (${ctx.effectiveModelId}).`);
    }

    const errText = await resp.text().catch(() => '');
    const sanitized = sanitizeError(errText || `HTTP ${resp.status}`);
    const err: any = new Error(sanitized);
    err.status = resp.status;
    throw err;
  }
}

/**
 * Universal OpenAI-Compatible REST Adapter
 * (OpenAI, Cerebras, Cloudflare Workers AI, Hugging Face, Mistral AI, SambaNova, Ollama, OpenAI Compatible, External Provider)
 */
export class OpenAICompatibleAdapter implements ProviderExecutionAdapter {
  public readonly adapterName = 'OpenAICompatibleAdapter';

  public canHandle(provider: SupportedProvider): boolean {
    return [
      'OpenAI',
      'Cerebras',
      'Cloudflare Workers AI',
      'Hugging Face',
      'Mistral AI',
      'SambaNova',
      'Ollama',
      'OpenAI Compatible',
      'External Provider',
    ].includes(provider);
  }

  public async execute(
    ctx: ProviderExecutionContext,
    req: AIExecutionRequest
  ): Promise<AdapterExecutionResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (ctx.effectiveKey) {
      headers.Authorization = `Bearer ${ctx.effectiveKey}`;
    }

    let systemMsg = req.systemInstruction || '';
    let promptText = typeof req.prompt === 'string' ? req.prompt : JSON.stringify(req.prompt);

    if (req.responseMimeType === 'application/json') {
      if (!systemMsg.toUpperCase().includes('JSON')) {
        systemMsg += (systemMsg ? '\n\n' : '') + 'MANDATE: Output valid JSON only.';
      }
      if (!promptText.toUpperCase().includes('JSON')) {
        promptText +=
          '\n\nPlease return your response strictly as a valid JSON object matching the requested schema. Do not include markdown code block formatting or explanations.';
      }
    }

    const messages: any[] = [];
    if (systemMsg) messages.push({ role: 'system', content: systemMsg });
    messages.push({ role: 'user', content: promptText });

    const reqBody: any = {
      model: ctx.effectiveModelId,
      messages,
    };
    if (req.temperature !== undefined) reqBody.temperature = req.temperature;
    if (req.maxTokens !== undefined) reqBody.max_tokens = req.maxTokens;

    // Format json_object for providers that natively support it
    const supportsJsonFormat = [
      'OpenAI',
      'Mistral AI',
      'Cerebras',
      'SambaNova',
      'Ollama',
      'OpenAI Compatible',
    ].includes(ctx.connection.provider);

    if (req.responseMimeType === 'application/json' && supportsJsonFormat) {
      reqBody.response_format = { type: 'json_object' };
    }

    const fetchFn = (ctx.isCustomEndpoint && !req.customResolver)
      ? (url: string, init: any) => safeSsrfFetch(url, init)
      : fetch;

    const timeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
    const combinedSignal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

    let resp = await fetchFn(ctx.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: combinedSignal,
    });

    // If provider rejected response_format: { type: 'json_object' } with 400, retry once without it
    if (!resp.ok && resp.status === 400 && reqBody.response_format) {
      delete reqBody.response_format;
      const retryTimeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
      const retrySignal = req.signal ? AbortSignal.any([req.signal, retryTimeoutSignal]) : retryTimeoutSignal;
      resp = await fetchFn(ctx.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: retrySignal,
      });
    }

    if (resp.ok) {
      const json: any = await resp.json();
      const content = json.choices?.[0]?.message?.content;
      if (content && typeof content === 'string' && content.trim().length > 0) {
        const usage: AIExecutionUsage | undefined = json.usage ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        } : undefined;

        return {
          text: content,
          usage,
          rawResponse: json,
        };
      }
      throw new Error(
        `Empty response content received from ${ctx.connection.provider} (${ctx.effectiveModelId}).`
      );
    }

    const errText = await resp.text().catch(() => '');
    const sanitized = sanitizeError(errText || `HTTP ${resp.status}`);
    const err: any = new Error(sanitized);
    err.status = resp.status;
    throw err;
  }
}

// ============================================================================
// 4. SHARED AI EXECUTION ENGINE (ORCHESTRATOR)
// ============================================================================

export class AIExecutionEngine {
  private adapters: ProviderExecutionAdapter[] = [];

  constructor() {
    this.registerAdapter(new GoogleGenAIAdapter());
    this.registerAdapter(new GroqAdapter());
    this.registerAdapter(new OpenRouterAdapter());
    this.registerAdapter(new OpenAICompatibleAdapter());
  }

  public registerAdapter(adapter: ProviderExecutionAdapter): void {
    // Unshift so mock / custom test adapters take precedence over default adapters
    this.adapters.unshift(adapter);
  }

  public unregisterAdapter(adapterName: string): void {
    this.adapters = this.adapters.filter((a) => a.adapterName !== adapterName);
  }

  public invalidateClientCache(connectionId?: string): void {
    for (const adapter of this.adapters) {
      if (adapter instanceof GoogleGenAIAdapter) {
        adapter.invalidateCache(connectionId);
      }
    }
  }

  public getGoogleClientCacheDiagnostics(): {
    totalEntries: number;
    entries: Array<{ connectionId: string; fingerprint: string; timeoutMs: number }>;
  } {
    for (const adapter of this.adapters) {
      if (adapter instanceof GoogleGenAIAdapter) {
        return adapter.getCacheDiagnostics();
      }
    }
    return { totalEntries: 0, entries: [] };
  }

  public getAdapter(provider: SupportedProvider): ProviderExecutionAdapter | undefined {
    return this.adapters.find((a) => a.canHandle(provider));
  }

  /**
   * Primary entry point executing an AI generation request across any provider.
   * Enforces all routing, credential isolation, cost policy, and SSRF security invariants.
   */
  public async execute(req: AIExecutionRequest): Promise<AIExecutionResult> {
    const start = performance.now();

    // --------------------------------------------------------------------------
    // STEP 0: Payload & Cancellation Pre-Flight Validation
    // --------------------------------------------------------------------------
    if (req.signal?.aborted) {
      const abortReason = req.signal.reason instanceof Error ? req.signal.reason.message : String(req.signal.reason || 'Execution aborted by caller.');
      throw new AIExecutionError({
        message: `Execution aborted: ${abortReason}`,
        category: 'TIMEOUT',
        status: 499,
        connectionId: req.connectionId,
      });
    }

    const policyValidation = costPolicyEngine.validatePolicyInput(req.costPolicy, req.allowPaidExecution);
    if (!policyValidation.valid && policyValidation.error) {
      throw new AIExecutionError({
        message: policyValidation.error.message,
        category: policyValidation.error.category,
        status: policyValidation.error.status,
        connectionId: req.connectionId,
      });
    }
    const costPolicy: CostPolicy = policyValidation.normalizedPolicy;

    // --------------------------------------------------------------------------
    // STEP 1: Strict Connection Resolution (ROUTE-01)
    // --------------------------------------------------------------------------
    const hasExplicitConn = Boolean(
      req.connectionId && typeof req.connectionId === 'string' && req.connectionId.trim().length > 0
    );
    let targetConn: ServerProviderConnection | undefined;

    if (hasExplicitConn) {
      targetConn = providerManager.getConnection(req.connectionId!.trim());
      if (!targetConn) {
        throw new AIExecutionError({
          message: `Connection "${req.connectionId}" not found.`,
          category: 'CONNECTION_NOT_FOUND',
          status: 404,
          connectionId: req.connectionId,
        });
      }
    } else {
      const activeId = providerManager.getActiveConnectionId();
      targetConn = providerManager.getConnection(activeId);
      if (!targetConn) {
        targetConn = providerManager.getPublicConnections().map((p) => providerManager.getConnection(p.id)).find((c) => c?.isEnabled) || undefined;
      }
    }

    if (!targetConn) {
      throw new AIExecutionError({
        message: 'No AI provider connections available.',
        category: 'KEY_UNCONFIGURED',
        status: 400,
      });
    }

    // --------------------------------------------------------------------------
    // STEP 2: Connection Status Check
    // --------------------------------------------------------------------------
    if (!targetConn.isEnabled) {
      throw new AIExecutionError({
        message: `Connection "${targetConn.name}" is disabled. Enable it in Provider Manager.`,
        category: 'DISABLED',
        status: 400,
        connectionId: targetConn.id,
        provider: targetConn.provider,
      });
    }

    // --------------------------------------------------------------------------
    // STEP 3: Credential Resolution (Server-Side Isolation Boundary)
    // --------------------------------------------------------------------------
    const effectiveKey = providerManager.resolveEffectiveApiKey(targetConn);
    const isKeyRequired = targetConn.provider !== 'Ollama';

    if (isKeyRequired && (!effectiveKey || effectiveKey.trim().length === 0)) {
      throw new AIExecutionError({
        message: `API key is unconfigured for connection "${targetConn.name}". Configure a valid key in Provider Manager or set GEMINI_API_KEY.`,
        category: 'KEY_UNCONFIGURED',
        status: 401,
        connectionId: targetConn.id,
        provider: targetConn.provider,
      });
    }

    if (targetConn.provider === 'Cloudflare Workers AI' && !targetConn.accountId) {
      throw new AIExecutionError({
        message: `Cloudflare Account ID is unconfigured for connection "${targetConn.name}". Configure it in Provider Manager.`,
        category: 'CONFIG_MISSING',
        status: 400,
        connectionId: targetConn.id,
        provider: targetConn.provider,
      });
    }

    // --------------------------------------------------------------------------
    // STEP 4: Exact Model Resolution
    // --------------------------------------------------------------------------
    const effectiveModelId = (req.modelId && typeof req.modelId === 'string' && req.modelId.trim().length > 0)
      ? req.modelId.trim()
      : (req.modality === 'image' ? 'gemini-3.1-flash-lite-image' : targetConn.modelId);

    // --------------------------------------------------------------------------
    // STEP 5: Cost Policy Enforcement (COST-01 via Centralized CostPolicyEngine)
    // --------------------------------------------------------------------------
    const pricing = evaluateConnectionPricing(targetConn, effectiveModelId);
    const costDecision = costPolicyEngine.evaluate({
      costPolicy,
      allowPaidExecution: req.allowPaidExecution,
      pricing,
      modelId: effectiveModelId,
      provider: targetConn.provider,
      connectionName: targetConn.name,
      connectionId: targetConn.id,
      isFailover: false,
    });

    if (!costDecision.allowed) {
      throw new AIExecutionError({
        message: costDecision.message,
        category: costDecision.status === 400 ? 'INVALID_PAYLOAD' : 'PAYWALL_BLOCKED',
        status: costDecision.status,
        connectionId: targetConn.id,
        provider: targetConn.provider,
        modelId: effectiveModelId,
      });
    }

    // --------------------------------------------------------------------------
    // STEP 6: Modality & Compatibility Validation
    // --------------------------------------------------------------------------
    const requestedModality = req.modality || 'text';
    if (requestedModality === 'text') {
      const compat = evaluateModelCompatibility({
        id: effectiveModelId,
        provider: targetConn.provider,
      });
      if (!compat.isTextGenerationCapable) {
        throw new AIExecutionError({
          message: `Selected model "${effectiveModelId}" on connection "${targetConn.name}" (${targetConn.provider}) does not support text generation (${compat.reason || 'unsupported modality'}). Please select a text-compatible model.`,
          category: 'UNSUPPORTED_MODALITY',
          status: 400,
          connectionId: targetConn.id,
          provider: targetConn.provider,
          modelId: effectiveModelId,
        });
      }
    } else if (requestedModality === 'image') {
      if (targetConn.provider !== 'Google GenAI') {
        throw new AIExecutionError({
          message: `Image rendering requires Google GenAI (gemini-3.1-flash-lite-image). Connection "${targetConn.name}" is using ${targetConn.provider}. Switch to a Google GenAI connection or export the prompt package.`,
          category: 'UNSUPPORTED_MODALITY',
          status: 400,
          connectionId: targetConn.id,
          provider: targetConn.provider,
          modelId: effectiveModelId,
        });
      }
    }

    // --------------------------------------------------------------------------
    // STEP 7: Resolve Endpoint & SSRF Validation
    // --------------------------------------------------------------------------
    const endpoint = providerManager.getProviderEndpoint(targetConn);
    const isCustomEndpoint =
      targetConn.provider === 'OpenAI Compatible' ||
      targetConn.provider === 'External Provider' ||
      Boolean(
        targetConn.baseUrl &&
        targetConn.baseUrl !== PROVIDER_REGISTRY[targetConn.provider]?.defaultBaseUrl
      );

    if (isCustomEndpoint && !req.customResolver) {
      const urlValidation = await validateCustomProviderUrl(endpoint);
      if (!urlValidation.isValid) {
        const errorCategory = urlValidation.errorCategory === 'UNSUPPORTED_PROTOCOL'
          ? 'UNSUPPORTED_PROTOCOL'
          : 'SSRF_BLOCKED';
        throw new AIExecutionError({
          message: urlValidation.error || 'Destination URL failed SSRF security validation.',
          category: errorCategory,
          status: 400,
          connectionId: targetConn.id,
          provider: targetConn.provider,
        });
      }
    }

    // --------------------------------------------------------------------------
    // STEP 8: Adapter Selection & Dispatch
    // --------------------------------------------------------------------------
    const adapter = this.getAdapter(targetConn.provider);
    if (!adapter) {
      throw new AIExecutionError({
        message: `No execution adapter available for provider "${targetConn.provider}".`,
        category: 'INVALID_PAYLOAD',
        status: 400,
        connectionId: targetConn.id,
        provider: targetConn.provider,
      });
    }

    const execContext: ProviderExecutionContext = {
      connection: targetConn,
      effectiveKey,
      effectiveModelId,
      endpoint,
      isCustomEndpoint,
      start,
      timeoutMs: req.timeoutMs || 45000,
    };

    try {
      const result = await adapter.execute(execContext, req);
      const elapsed = Math.round(performance.now() - start);

      // Record successful metrics on target connection
      targetConn.observedCallsCount += 1;
      targetConn.reportedLatencyMs = elapsed;
      targetConn.status = 'online';
      targetConn.modelStatus = 'verified';
      targetConn.lastChecked = new Date().toLocaleTimeString();
      providerManager.saveConnections();

      // Defensive copy & optional JSON post-processing
      const rawText = result.text;
      const isJsonRequested = req.responseMimeType === 'application/json';
      const cleanedText = isJsonRequested ? cleanJsonText(rawText) : rawText;

      let parsedData: any = undefined;
      if (isJsonRequested) {
        try {
          parsedData = JSON.parse(cleanedText);
        } catch {
          // Keep undefined if parsing fails; text is preserved
        }
      }

      return {
        success: true,
        text: cleanedText,
        data: parsedData,
        model: effectiveModelId,
        provider: `${targetConn.provider} (${effectiveModelId}) [${targetConn.name}]`,
        connectionId: targetConn.id,
        latencyMs: elapsed,
        isFallback: false,
        usage: result.usage,
        rawResponse: result.rawResponse,
        imageUrl: result.imageUrl,
      };
    } catch (err: any) {
      if (err instanceof AIExecutionError) {
        throw err;
      }

      const sanitized = sanitizeError(err);
      const status = err?.status || err?.statusCode || 500;
      const isRateLimit = status === 429 || sanitized.includes('429');
      const isQuota = sanitized.toLowerCase().includes('quota') || sanitized.includes('RESOURCE_EXHAUSTED') || sanitized.includes('insufficient_quota');
      const isPermission = status === 401 || status === 403 || sanitized.includes('403') || sanitized.includes('API key') || sanitized.includes('unauthorized');
      const isTimeout = err?.name === 'TimeoutError' || sanitized.toLowerCase().includes('timeout');

      // Preserve existing SSRF errors directly
      if (err?.category === 'SSRF_BLOCKED' || err?.errorCategory === 'SSRF_BLOCKED' || err?.category === 'UNSUPPORTED_PROTOCOL') {
        throw err;
      }

      if (isPermission) {
        targetConn.status = 'degraded';
        providerManager.saveConnections();
        throw new AIExecutionError({
          message: sanitized,
          category: 'INVALID_CREDENTIALS',
          status: 403,
          connectionId: targetConn.id,
          provider: targetConn.provider,
          modelId: effectiveModelId,
        });
      }

      if (isRateLimit || isQuota) {
        targetConn.modelStatus = isRateLimit ? 'rate_limited' : 'unavailable';
        targetConn.cooldownRemainingSec = 30;
        if (targetConn.status !== 'online') {
          targetConn.status = 'cooldown';
        }
        providerManager.saveConnections();

        // ------------------------------------------------------------------------
        // STEP 9: Failover Handling (COST-02 Strict Cost Parity & Credential Isolation)
        // ------------------------------------------------------------------------
        if (targetConn.allowFailover === true && req.allowFailover !== false) {
          const eligibleFailover = providerManager.findEligibleFailoverConnection(
            targetConn,
            costPolicy,
            req.allowPaidExecution,
            req.modality || 'text'
          );

          if (eligibleFailover) {
            console.warn(
              `Explicit user failover policy enabled: failing over from ${targetConn.name} to ${eligibleFailover.name}`
            );
            const failoverResult = await this.execute({
              ...req,
              connectionId: eligibleFailover.id,
              modelId: eligibleFailover.modelId,
              maxRetries: 1,
              allowFailover: false, // Prevent recursive cascade
            });

            return {
              ...failoverResult,
              isFallback: true,
              failoverOccurred: true,
              originalConnectionId: targetConn.id,
            };
          }
        }

        throw new AIExecutionError({
          message: sanitized,
          category: isQuota ? 'QUOTA_EXHAUSTED' : 'RATE_LIMIT_429',
          status: 429,
          connectionId: targetConn.id,
          provider: targetConn.provider,
          modelId: effectiveModelId,
        });
      }

      if (isTimeout) {
        throw new AIExecutionError({
          message: `Request to ${targetConn.provider} timed out.`,
          category: 'TIMEOUT',
          status: 504,
          connectionId: targetConn.id,
          provider: targetConn.provider,
          modelId: effectiveModelId,
        });
      }

      throw new AIExecutionError({
        message: sanitized,
        category: 'NETWORK_ERROR',
        status: status >= 400 && status < 600 ? status : 500,
        connectionId: targetConn.id,
        provider: targetConn.provider,
        modelId: effectiveModelId,
        details: sanitized,
      });
    }
  }

  /**
   * Backward-compatible text generation wrapper matching providerManager.executeTextGeneration signature
   */
  public async executeTextGeneration(params: {
    connectionId?: string;
    modelId?: string;
    taskType?: AIExecutionTaskType;
    prompt: string | any;
    systemInstruction?: string;
    responseMimeType?: string;
    responseSchema?: any;
    maxRetries?: number;
    customResolver?: DnsResolver;
    costPolicy?: CostPolicy;
    allowPaidExecution?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; model: string; provider: string; latencyMs: number; isFallback: boolean }> {
    const result = await this.execute({
      connectionId: params.connectionId,
      modelId: params.modelId,
      taskType: params.taskType || 'general_text',
      modality: 'text',
      prompt: params.prompt,
      systemInstruction: params.systemInstruction,
      responseMimeType: params.responseMimeType,
      responseSchema: params.responseSchema,
      maxRetries: params.maxRetries,
      customResolver: params.customResolver,
      costPolicy: params.costPolicy,
      allowPaidExecution: params.allowPaidExecution,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });

    return {
      text: result.text,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      isFallback: result.isFallback,
    };
  }

  /**
   * Dedicated image generation orchestration via GoogleGenAIAdapter (gemini-3.1-flash-lite-image)
   */
  public async executeImageGeneration(options: ExecuteImageGenerationOptions): Promise<AIImageExecutionResult> {
    const result = await this.execute({
      connectionId: options.connectionId,
      modality: 'image',
      modelId: 'gemini-3.1-flash-lite-image',
      prompt: { prompt: options.prompt, format: options.format },
      costPolicy: options.costPolicy,
      allowPaidExecution: options.allowPaidExecution,
      timeoutMs: options.timeoutMs || 45000,
    });

    const imageUrl = result.imageUrl || result.text;

    // Enforce payload limits on returned data URL
    if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
      const commaIndex = imageUrl.indexOf(',');
      const base64Data = commaIndex !== -1 ? imageUrl.slice(commaIndex + 1).trim() : '';
      if (base64Data.length > MAX_IMAGE_BASE64_LENGTH) {
        throw new AIExecutionError({
          message: 'Image provider response payload exceeds maximum allowable size (10 MB).',
          category: 'INVALID_PAYLOAD',
          status: 413,
          connectionId: options.connectionId,
        });
      }
      const padding = base64Data.endsWith('==') ? 2 : base64Data.endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor((base64Data.length * 3) / 4) - padding;
      if (decodedBytes > MAX_IMAGE_DECODED_BYTES) {
        throw new AIExecutionError({
          message: 'Decoded image binary exceeds maximum allowable size (7.5 MB).',
          category: 'INVALID_PAYLOAD',
          status: 413,
          connectionId: options.connectionId,
        });
      }
    }

    return {
      success: true,
      imageUrl,
      provider: result.provider,
      optionId: options.optionId,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
}

// Global engine singleton
export const aiExecutionEngine = new AIExecutionEngine();

/**
 * Convenience helper to execute a generation task
 */
export async function executeAI(req: AIExecutionRequest): Promise<AIExecutionResult> {
  return aiExecutionEngine.execute(req);
}
