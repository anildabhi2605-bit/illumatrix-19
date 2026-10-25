import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type {
  ModelCapability,
  ModelPricing,
  AccountLimitSnapshot,
  DiscoveredModel,
  SupportedProvider,
  ModelCompatibility,
  CostPolicy
} from '../types/hud';
import {
  classifyOpenRouterPricing,
  evaluateModelCompatibility,
  evaluateConnectionPricing,
  ClassifiedPricing
} from './modelCompatibility';
import {
  validateCustomProviderUrl,
  safeSsrfFetch,
  DnsResolver,
  UrlValidationResult
} from './urlSafetyValidator';
import {
  encryptAtRest,
  decryptAtRest,
  isEncryptedAtRest,
  getMasterKeyFromEnv,
  redactSecretString,
  redactHeaders,
  redactObject,
  validateProviderAccessOrigin,
  MasterKeyMissingError,
  DecryptionFailedError,
} from './credentialSecurity';

import {
  catalogCacheManager,
  CatalogCacheManager,
  type CatalogCacheOptions,
  type CatalogLookupResult,
  type CooldownRecord,
  type CatalogCacheKeyParams,
} from './catalogCache';
import {
  aiExecutionEngine,
  executeAI,
  AIExecutionError,
  type AIExecutionRequest,
  type AIExecutionResult,
  type AIExecutionTaskType,
  type AIExecutionModality,
  type AIExecutionUsage,
  type AIExecutionErrorCode,
  type ProviderExecutionAdapter,
  type ExecuteImageGenerationOptions,
  type AIImageExecutionResult,
} from './aiExecutionEngine';
import { costPolicyEngine } from './costPolicyEngine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONNECTIONS_FILE = path.resolve(__dirname, '../../.provider_connections.json');

export type {
  SupportedProvider,
  ModelCompatibility,
  ClassifiedPricing,
  DnsResolver,
  UrlValidationResult,
  CostPolicy,
  CatalogCacheOptions,
  CatalogLookupResult,
  CooldownRecord,
  CatalogCacheKeyParams,
  AIExecutionRequest,
  AIExecutionResult,
  AIExecutionTaskType,
  AIExecutionModality,
  AIExecutionUsage,
  AIExecutionErrorCode,
  ProviderExecutionAdapter,
  ExecuteImageGenerationOptions,
  AIImageExecutionResult,
};
export {
  classifyOpenRouterPricing,
  evaluateModelCompatibility,
  evaluateConnectionPricing,
  validateCustomProviderUrl,
  safeSsrfFetch,
  encryptAtRest,
  decryptAtRest,
  isEncryptedAtRest,
  getMasterKeyFromEnv,
  redactSecretString,
  redactHeaders,
  redactObject,
  validateProviderAccessOrigin,
  MasterKeyMissingError,
  DecryptionFailedError,
  catalogCacheManager,
  CatalogCacheManager,
  aiExecutionEngine,
  executeAI,
  AIExecutionError,
};

export interface ProviderMeta {
  id: SupportedProvider;
  displayName: string;
  defaultModel: string;
  recommendedModels: string[];
  defaultBaseUrl?: string;
  defaultQuotaPool: string;
  requiresKey: boolean;
  requiresAccountId?: boolean;
  description: string;
}

// User-supplied dashboard snapshots strictly labeled with provenance
export const USER_SUPPLIED_LIMITS: Record<string, AccountLimitSnapshot> = {
  'gemini-3.8-flash': {
    source: 'USER-SUPPLIED SNAPSHOT',
    asOfDate: 'Dashboard Snapshot',
    rpm: 5,
    tpm: 250000,
    rpd: 20,
    rawDetails: '5 RPM, 250,000 TPM, 20 RPD (Google AI Studio Tier)',
  },
  'qwen/qwen3.8-27b': {
    source: 'USER-SUPPLIED SNAPSHOT',
    asOfDate: 'Dashboard Snapshot',
    rpm: 30,
    rpd: 1000,
    tpm: 8000,
    tpd: 200000,
    rawDetails: '30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD (Groq Dashboard)',
  },
};

export const PROVIDER_REGISTRY: Record<SupportedProvider, ProviderMeta> = {
  'Google GenAI': {
    id: 'Google GenAI',
    displayName: 'Google Gemini (Google AI Studio)',
    defaultModel: 'gemini-3.1-flash-lite',
    recommendedModels: ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon'],
    defaultQuotaPool: 'GCP_PROJECT_DEFAULT_QUOTA',
    requiresKey: true,
    description: 'Direct Google AI Studio integration for fast generation and image previews.',
  },
  'Groq': {
    id: 'Groq',
    displayName: 'Groq Console',
    defaultModel: 'qwen/qwen3.8-27b',
    recommendedModels: [
      'qwen/qwen3.8-27b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
    ],
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultQuotaPool: 'GROQ_CONSOLE_POOL',
    requiresKey: true,
    description: 'Ultra-low-latency LPU inference via Groq OpenAI-compatible API.',
  },
  'OpenRouter': {
    id: 'OpenRouter',
    displayName: 'OpenRouter',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    recommendedModels: [
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-exp:free',
      'deepseek/deepseek-r1:free',
      'anthropic/claude-3.5-sonnet',
      'mistralai/mistral-large-2407',
    ],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultQuotaPool: 'OPENROUTER_POOL',
    requiresKey: true,
    description: 'Unified multi-model routing gateway with open public model catalog.',
  },
  'Cerebras': {
    id: 'Cerebras',
    displayName: 'Cerebras',
    defaultModel: 'llama-3.3-70b',
    recommendedModels: ['llama-3.3-70b', 'llama3.1-70b', 'llama3.1-8b'],
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    defaultQuotaPool: 'CEREBRAS_CS3_POOL',
    requiresKey: true,
    description: 'Wafer-scale high-throughput inference for Llama models.',
  },
  'Cloudflare Workers AI': {
    id: 'Cloudflare Workers AI',
    displayName: 'Cloudflare Workers AI',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct',
    recommendedModels: [
      '@cf/meta/llama-3.3-70b-instruct',
      '@cf/meta/llama-3.1-8b-instruct',
      '@cf/mistral/mistral-7b-instruct-v0.2',
    ],
    defaultQuotaPool: 'CLOUDFLARE_WORKERS_AI_POOL',
    requiresKey: true,
    requiresAccountId: true,
    description: 'Serverless GPU inference at Cloudflare edge with Account ID routing.',
  },
  'Hugging Face': {
    id: 'Hugging Face',
    displayName: 'Hugging Face Inference',
    defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
    recommendedModels: [
      'meta-llama/Llama-3.2-3B-Instruct',
      'mistralai/Mistral-7B-Instruct-v0.3',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    defaultBaseUrl: 'https://router.huggingface.co/hf-inference/v1',
    defaultQuotaPool: 'HUGGINGFACE_INFERENCE_POOL',
    requiresKey: true,
    description: 'OpenAI-compatible serverless inference router for Hugging Face Hub models.',
  },
  'Mistral AI': {
    id: 'Mistral AI',
    displayName: 'Mistral AI',
    defaultModel: 'mistral-small-latest',
    recommendedModels: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultQuotaPool: 'MISTRAL_AI_POOL',
    requiresKey: true,
    description: 'Native frontier European LLM inference via Mistral API.',
  },
  'SambaNova': {
    id: 'SambaNova',
    displayName: 'SambaNova Cloud',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    recommendedModels: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct', 'Qwen2.5-72B-Instruct'],
    defaultBaseUrl: 'https://api.sambanova.ai/v1',
    defaultQuotaPool: 'SAMBANOVA_CLOUD_POOL',
    requiresKey: true,
    description: 'Reconfigurable Dataflow Unit (RDU) inference for open models.',
  },
  'Ollama': {
    id: 'Ollama',
    displayName: 'Ollama (Local / Self-Hosted)',
    defaultModel: 'llama3.2',
    recommendedModels: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5', 'phi3'],
    defaultBaseUrl: 'http://localhost:11434',
    defaultQuotaPool: 'OLLAMA_LOCAL_MACHINE',
    requiresKey: false,
    description: 'Local private inference runtime. Key optional; verifies installed models via /api/tags.',
  },
  'OpenAI': {
    id: 'OpenAI',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    recommendedModels: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultQuotaPool: 'OPENAI_API_POOL',
    requiresKey: true,
    description: 'Standard OpenAI platform models.',
  },
  'OpenAI Compatible': {
    id: 'OpenAI Compatible',
    displayName: 'Custom OpenAI-Compatible Endpoint',
    defaultModel: 'gpt-4o-mini',
    recommendedModels: ['gpt-4o-mini', 'llama-3-8b', 'custom-model'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultQuotaPool: 'CUSTOM_3P_POOL',
    requiresKey: true,
    description: 'Any self-hosted or third-party OpenAI-compatible API.',
  },
  'External Provider': {
    id: 'External Provider',
    displayName: 'External Provider (Legacy)',
    defaultModel: 'default-model',
    recommendedModels: ['default-model'],
    defaultQuotaPool: 'EXTERNAL_POOL',
    requiresKey: true,
    description: 'Legacy external provider connection.',
  },
  'Local Mock Engine': {
    id: 'Local Mock Engine',
    displayName: 'Local Mock / Fallback Engine',
    defaultModel: 'local-deterministic',
    recommendedModels: ['local-deterministic'],
    defaultQuotaPool: 'LOCAL_OFFLINE_POOL',
    requiresKey: false,
    description: 'In-memory deterministic fallback engine for offline workflow execution.',
  },
};

export interface ServerProviderConnection {
  id: string;
  name: string;
  provider: SupportedProvider;
  modelId: string;
  modelDisplayName?: string;
  baseUrl?: string;
  accountId?: string; // For Cloudflare Workers AI
  status: 'online' | 'unconfigured' | 'cooldown' | 'degraded' | 'disabled' | 'untested';
  modelStatus?: 'verified' | 'rate_limited' | 'unavailable' | 'untested';
  catalogStatus?: 'loaded' | 'refresh_required' | 'failed' | 'untested';
  catalogFetchedAt?: string;
  quotaPool: string;
  isDefault: boolean;
  isEnabled: boolean;
  supportsStreaming: boolean;
  supportsStructuredJson: boolean;
  allowFailover?: boolean;
  lastChecked: string;
  lastTestStatus?: 'success' | 'failed' | 'untested';
  lastTestError?: string;
  lastTestedAt?: string;
  reportedLatencyMs: number | null;
  observedCallsCount: number;
  quotaReported: boolean;
  cooldownRemainingSec?: number;
  accountLimits?: AccountLimitSnapshot;
  pricing?: ModelPricing;
  capabilities?: ModelCapability;
  supportedParameters?: string[];
  discoveredModels?: DiscoveredModel[];
  // In-memory active credential; NEVER serialized in plaintext to disk
  apiKey?: string;
  // Encrypted-at-rest ciphertext serialized to disk (enc:v1:...)
  encryptedApiKey?: string;
}

export interface PublicProviderConnection {
  id: string;
  name: string;
  provider: SupportedProvider;
  modelId: string;
  modelDisplayName?: string;
  baseUrl?: string;
  accountId?: string;
  status: 'online' | 'unconfigured' | 'cooldown' | 'degraded' | 'disabled' | 'untested';
  modelStatus?: 'verified' | 'rate_limited' | 'unavailable' | 'untested';
  catalogStatus?: 'loaded' | 'refresh_required' | 'failed' | 'untested';
  catalogFetchedAt?: string;
  quotaPool: string;
  isDefault: boolean;
  isEnabled: boolean;
  supportsStreaming: boolean;
  supportsStructuredJson: boolean;
  allowFailover?: boolean;
  lastChecked: string;
  lastTestStatus?: 'success' | 'failed' | 'untested';
  lastTestError?: string;
  lastTestedAt?: string;
  reportedLatencyMs: number | null;
  observedCallsCount: number;
  quotaReported: boolean;
  cooldownRemainingSec?: number;
  hasKey: boolean;
  maskedKey: string;
  accountLimits?: AccountLimitSnapshot;
  pricing?: ModelPricing;
  capabilities?: ModelCapability;
  supportedParameters?: string[];
  discoveredModels?: DiscoveredModel[];
}

export interface ProviderDetectionResult {
  detectedProvider: SupportedProvider | null;
  confidence: 'reliable' | 'ambiguous' | 'none';
  reason: string;
  suggestedModel?: string;
  suggestedBaseUrl?: string;
  suggestedQuotaPool?: string;
  ambiguousOptions?: SupportedProvider[];
}

export interface ConnectionTestResult {
  success: boolean;
  status: 'online' | 'degraded' | 'unconfigured' | 'untested';
  latencyMs?: number;
  model?: string;
  error?: string;
  errorCategory?:
    | 'SUCCESS'
    | 'AUTH_FAILED'
    | 'INSUFFICIENT_CREDITS'
    | 'PERMISSION_DENIED'
    | 'MODEL_NOT_FOUND'
    | 'CONFIG_MISSING'
    | 'INVALID_PAYLOAD'
    | 'RATE_LIMITED'
    | 'QUOTA_EXHAUSTED'
    | 'TIMEOUT'
    | 'NETWORK_ERROR'
    | 'UNSUPPORTED_PROTOCOL'
    | 'SSRF_BLOCKED'
    | 'CONNECTION_NOT_FOUND'
    | 'BILLABLE_TEST_REQUIRED'
    | 'PAYWALL_BLOCKED';
  testedAt: string;
  accountLimits?: AccountLimitSnapshot;
  pricing?: ModelPricing;
}

// Regex secret scrubber helper - never leaks cleartext keys or bearer tokens
export function sanitizeError(err: any): string {
  const raw = String(err?.message || err || 'Unknown error');
  return redactSecretString(raw);
}

export function maskApiKey(key?: string): string {
  if (!key || key.trim().length === 0) return 'None configured';
  const clean = key.trim();
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

// Safely clean JSON markdown wrapping from LLM output
export function cleanJsonText(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  return cleaned;
}

// Centralized AI Generation Error Handler Enforcing Strict Policy Status Codes
export function handleGenerationError(apiError: any, res: any): boolean {
  const sanitized = sanitizeError(apiError);
  const status = apiError?.status || apiError?.statusCode;
  const category = apiError?.category || apiError?.errorCategory;

  if (category === 'CONNECTION_NOT_FOUND' || status === 404) {
    res.status(404).json({
      error: true,
      category: 'CONNECTION_NOT_FOUND',
      message: sanitized,
    });
    return true;
  }

  if (category === 'PAYWALL_BLOCKED' || status === 402) {
    res.status(402).json({
      error: true,
      category: 'PAYWALL_BLOCKED',
      message: sanitized,
    });
    return true;
  }

  if (
    category === 'INVALID_PAYLOAD' ||
    status === 400 ||
    category === 'UNSUPPORTED_MODALITY' ||
    category === 'UNSUPPORTED_PROVIDER' ||
    category === 'SSRF_BLOCKED' ||
    category === 'UNSUPPORTED_PROTOCOL' ||
    category === 'CONFIG_MISSING' ||
    category === 'DISABLED'
  ) {
    res.status(400).json({
      error: true,
      category: category || 'INVALID_PAYLOAD',
      message: sanitized,
    });
    return true;
  }

  if (category === 'KEY_UNCONFIGURED' || status === 401) {
    res.status(401).json({
      error: true,
      category: 'KEY_UNCONFIGURED',
      message: sanitized,
    });
    return true;
  }

  const isRateLimit = status === 429 || category === 'RATE_LIMIT_429' || sanitized.includes('429');
  const isQuota = category === 'QUOTA_EXHAUSTED' || sanitized.toLowerCase().includes('quota') || sanitized.includes('RESOURCE_EXHAUSTED');
  const is503 = status === 503 || sanitized.includes('503') || sanitized.includes('high demand');
  const isPermission =
    status === 403 ||
    category === 'INVALID_CREDENTIALS' ||
    category === 'AUTH_FAILED' ||
    category === 'PERMISSION_DENIED' ||
    sanitized.includes('403') ||
    sanitized.includes('API key');
  const isTimeout = category === 'TIMEOUT' || status === 504 || sanitized.toLowerCase().includes('timeout');

  if (isRateLimit || isQuota || is503 || isPermission || isTimeout) {
    res.status(isRateLimit ? 429 : isPermission ? 403 : is503 ? 503 : isTimeout ? 504 : isQuota ? 429 : 500).json({
      error: true,
      category: isRateLimit
        ? 'RATE_LIMIT_429'
        : isQuota
        ? 'QUOTA_EXHAUSTED'
        : isPermission
        ? 'INVALID_CREDENTIALS'
        : isTimeout
        ? 'TIMEOUT'
        : is503
        ? 'SERVICE_UNAVAILABLE_503'
        : 'TRANSIENT_5XX',
      message: sanitized,
    });
    return true;
  }

  return false;
}

// Task 2: Provider Auto-Detection (never sends secrets to 3P services)
export function detectProvider(key?: string, baseUrl?: string, accountId?: string): ProviderDetectionResult {
  const cleanKey = (key || '').trim();
  const cleanUrl = (baseUrl || '').trim().toLowerCase();
  const cleanAccount = (accountId || '').trim();

  // 1. Google Gemini (Google AI Studio)
  if (cleanKey.startsWith('AIzaSy') || cleanKey.startsWith('AIza')) {
    return {
      detectedProvider: 'Google GenAI',
      confidence: 'reliable',
      reason: 'Key starts with Google AI Studio prefix "AIzaSy"',
      suggestedModel: 'gemini-3.1-flash-lite',
      suggestedQuotaPool: 'GCP_PROJECT_DEFAULT_QUOTA',
    };
  }

  // 2. Groq Console
  if (cleanKey.startsWith('gsk_')) {
    return {
      detectedProvider: 'Groq',
      confidence: 'reliable',
      reason: 'Key starts with Groq API key prefix "gsk_"',
      suggestedModel: 'llama-3.3-70b-versatile',
      suggestedBaseUrl: 'https://api.groq.com/openai/v1',
      suggestedQuotaPool: 'GROQ_CONSOLE_POOL',
    };
  }

  // 3. OpenRouter
  if (cleanKey.startsWith('sk-or-v1-') || cleanKey.startsWith('sk-or-')) {
    return {
      detectedProvider: 'OpenRouter',
      confidence: 'reliable',
      reason: 'Key starts with OpenRouter API key prefix "sk-or-v1-"',
      suggestedModel: 'meta-llama/llama-3.3-70b-instruct',
      suggestedBaseUrl: 'https://openrouter.ai/api/v1',
      suggestedQuotaPool: 'OPENROUTER_POOL',
    };
  }

  // 4. Cerebras
  if (cleanKey.startsWith('csk-')) {
    return {
      detectedProvider: 'Cerebras',
      confidence: 'reliable',
      reason: 'Key starts with Cerebras API key prefix "csk-"',
      suggestedModel: 'llama-3.3-70b',
      suggestedBaseUrl: 'https://api.cerebras.ai/v1',
      suggestedQuotaPool: 'CEREBRAS_CS3_POOL',
    };
  }

  // 5. Hugging Face
  if (cleanKey.startsWith('hf_')) {
    return {
      detectedProvider: 'Hugging Face',
      confidence: 'reliable',
      reason: 'Key starts with Hugging Face user access token prefix "hf_"',
      suggestedModel: 'meta-llama/Llama-3.2-3B-Instruct',
      suggestedBaseUrl: 'https://router.huggingface.co/hf-inference/v1',
      suggestedQuotaPool: 'HUGGINGFACE_INFERENCE_POOL',
    };
  }

  // 6. SambaNova Cloud (UUID format: 8-4-4-4-12 hex)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey)) {
    return {
      detectedProvider: 'SambaNova',
      confidence: 'reliable',
      reason: 'Key matches SambaNova Cloud UUID format (8-4-4-4-12 hex)',
      suggestedModel: 'Meta-Llama-3.3-70B-Instruct',
      suggestedBaseUrl: 'https://api.sambanova.ai/v1',
      suggestedQuotaPool: 'SAMBANOVA_CLOUD_POOL',
    };
  }

  // 7. Cloudflare Workers AI
  if (cleanAccount.length > 0 || cleanUrl.includes('cloudflare.com')) {
    return {
      detectedProvider: 'Cloudflare Workers AI',
      confidence: 'reliable',
      reason: 'Config contains Cloudflare Account ID or endpoint URL',
      suggestedModel: '@cf/meta/llama-3.3-70b-instruct',
      suggestedQuotaPool: 'CLOUDFLARE_WORKERS_AI_POOL',
    };
  }

  // 8. Ollama (URL detection: localhost:11434, 127.0.0.1:11434, or containing "ollama")
  if (cleanUrl.includes('11434') || cleanUrl.includes('ollama')) {
    return {
      detectedProvider: 'Ollama',
      confidence: 'reliable',
      reason: 'Endpoint URL matches Ollama port 11434 or host',
      suggestedModel: 'llama3.2',
      suggestedBaseUrl: cleanUrl || 'http://localhost:11434',
      suggestedQuotaPool: 'OLLAMA_LOCAL_MACHINE',
    };
  }

  // 9. OpenAI Project key prefix "sk-proj-"
  if (cleanKey.startsWith('sk-proj-')) {
    return {
      detectedProvider: 'OpenAI',
      confidence: 'reliable',
      reason: 'Key starts with OpenAI Project key prefix "sk-proj-"',
      suggestedModel: 'gpt-4o-mini',
      suggestedBaseUrl: 'https://api.openai.com/v1',
      suggestedQuotaPool: 'OPENAI_API_POOL',
    };
  }

  // 10. Ambiguous "sk-" prefix (OpenAI, Mistral AI, or generic 3P)
  if (cleanKey.startsWith('sk-')) {
    return {
      detectedProvider: null,
      confidence: 'ambiguous',
      reason: 'Key prefix "sk-" is shared by multiple providers (OpenAI, Mistral, etc.). Please select your provider manually.',
      ambiguousOptions: ['OpenAI', 'Mistral AI', 'OpenAI Compatible'],
    };
  }

  // 11. Generic unclassified keys
  if (cleanKey.length >= 10) {
    return {
      detectedProvider: null,
      confidence: 'ambiguous',
      reason: 'Key format is not uniquely identifiable. Please select your provider from the list.',
      ambiguousOptions: [
        'Google GenAI',
        'Groq',
        'OpenRouter',
        'Cerebras',
        'Cloudflare Workers AI',
        'Hugging Face',
        'Mistral AI',
        'SambaNova',
        'Ollama',
        'OpenAI',
        'OpenAI Compatible',
      ],
    };
  }

  return {
    detectedProvider: null,
    confidence: 'none',
    reason: 'Enter an API key or endpoint URL to detect provider.',
  };
}

// Initial baseline provider connections
const DEFAULT_CONNECTIONS: ServerProviderConnection[] = [
  {
    id: 'conn_gemini_primary',
    name: 'Google GenAI (Fast Runtime)',
    provider: 'Google GenAI',
    modelId: 'gemini-3.1-flash-lite',
    modelDisplayName: 'Gemini 3.1 Flash Lite',
    status: process.env.GEMINI_API_KEY ? 'untested' : 'unconfigured',
    modelStatus: 'untested',
    catalogStatus: 'loaded',
    quotaPool: 'GCP_PROJECT_DEFAULT_QUOTA',
    isDefault: true,
    isEnabled: true,
    supportsStreaming: true,
    supportsStructuredJson: true,
    lastChecked: 'Startup (Untested)',
    lastTestStatus: 'untested',
    reportedLatencyMs: null,
    observedCallsCount: 0,
    quotaReported: false,
    apiKey: '',
    accountLimits: { source: 'UNKNOWN', rawDetails: 'Quotas vary by GCP project / billing tier' },
  },
  {
    id: 'conn_gemini_flash',
    name: 'Google AI Studio (Gemini 3.8 Flash)',
    provider: 'Google GenAI',
    modelId: 'gemini-3.8-flash',
    modelDisplayName: 'Gemini 3.8 Flash',
    status: process.env.GEMINI_FLASH_API_KEY ? 'untested' : 'unconfigured',
    modelStatus: 'untested',
    catalogStatus: 'loaded',
    quotaPool: 'GCP_PROJECT_DEFAULT_QUOTA', // Shares same quota pool
    isDefault: false,
    isEnabled: true,
    supportsStreaming: true,
    supportsStructuredJson: true,
    lastChecked: 'Startup (Untested)',
    lastTestStatus: 'untested',
    reportedLatencyMs: null,
    observedCallsCount: 0,
    quotaReported: false,
    apiKey: '',
    accountLimits: USER_SUPPLIED_LIMITS['gemini-3.8-flash'],
  },
  {
    id: 'conn_groq_qwen',
    name: 'Groq (Qwen 3.8 27B / LPU)',
    provider: 'Groq',
    modelId: 'qwen/qwen3.8-27b',
    modelDisplayName: 'Qwen 3.8 27B',
    baseUrl: 'https://api.groq.com/openai/v1',
    status: 'unconfigured',
    modelStatus: 'untested',
    catalogStatus: 'loaded',
    quotaPool: 'GROQ_CONSOLE_POOL',
    isDefault: false,
    isEnabled: false,
    supportsStreaming: true,
    supportsStructuredJson: true,
    lastChecked: 'Never',
    lastTestStatus: 'untested',
    reportedLatencyMs: null,
    observedCallsCount: 0,
    quotaReported: false,
    apiKey: '',
    accountLimits: USER_SUPPLIED_LIMITS['qwen/qwen3.8-27b'],
  },
  {
    id: 'conn_openrouter_default',
    name: 'OpenRouter Gateway',
    provider: 'OpenRouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    modelDisplayName: 'Meta: Llama 3.3 70B Instruct',
    baseUrl: 'https://openrouter.ai/api/v1',
    status: 'unconfigured',
    modelStatus: 'untested',
    catalogStatus: 'loaded',
    quotaPool: 'OPENROUTER_POOL',
    isDefault: false,
    isEnabled: false,
    supportsStreaming: true,
    supportsStructuredJson: true,
    lastChecked: 'Never',
    lastTestStatus: 'untested',
    reportedLatencyMs: null,
    observedCallsCount: 0,
    quotaReported: false,
    apiKey: '',
    accountLimits: { source: 'UNKNOWN', rawDetails: 'OpenRouter accounts use deposit credits' },
    pricing: { promptPricePerMillion: 0.12, completionPricePerMillion: 0.30, isZeroPriced: false, pricingTier: 'paid', pricingNote: '$0.12 prompt / $0.30 completion per 1M tokens' },
  },
  {
    id: 'conn_openai_custom',
    name: 'OpenAI-Compatible Custom Endpoint',
    provider: 'OpenAI Compatible',
    modelId: 'gpt-4o-mini',
    modelDisplayName: 'GPT-4o Mini',
    baseUrl: 'https://api.openai.com/v1',
    status: 'unconfigured',
    modelStatus: 'untested',
    catalogStatus: 'untested',
    quotaPool: 'INDEPENDENT_3P_POOL',
    isDefault: false,
    isEnabled: false,
    supportsStreaming: false,
    supportsStructuredJson: true,
    lastChecked: 'Never',
    lastTestStatus: 'untested',
    reportedLatencyMs: null,
    observedCallsCount: 0,
    quotaReported: false,
    apiKey: '',
    accountLimits: { source: 'UNKNOWN' },
  },
];

class ProviderManager {
  private connections: ServerProviderConnection[] = [];
  private activeConnectionId: string = 'conn_gemini_primary';
  private cachedGenAiClients: Map<string, GoogleGenAI> = new Map();
  private cachedDiscoveredModels: Map<string, DiscoveredModel[]> = new Map();

  constructor() {
    this.loadConnections();
  }

  public resolveEffectiveApiKey(conn?: ServerProviderConnection): string {
    if (!conn) return '';
    // If an explicit API key was manually set for this connection and is not empty, use it
    if (conn.apiKey && conn.apiKey.trim().length > 0) {
      return conn.apiKey.trim();
    }
    // Default Google GenAI connection reads from GEMINI_API_KEY
    if (conn.isDefault) {
      return (process.env.GEMINI_API_KEY || '').trim();
    }
    // Dedicated Google AI Studio connection (conn_gemini_flash) optionally reads GEMINI_FLASH_API_KEY
    if (conn.provider === 'Google GenAI' && conn.id === 'conn_gemini_flash') {
      return (process.env.GEMINI_FLASH_API_KEY || '').trim();
    }
    // Groq connection optionally reads GROQ_API_KEY
    if (conn.provider === 'Groq') {
      return (process.env.GROQ_API_KEY || '').trim();
    }
    // OpenRouter connection optionally reads OPENROUTER_API_KEY
    if (conn.provider === 'OpenRouter') {
      return (process.env.OPENROUTER_API_KEY || '').trim();
    }
    return '';
  }

  public reloadConnections(): void {
    this.loadConnections();
  }

  private loadConnections(): void {
    try {
      if (fs.existsSync(CONNECTIONS_FILE)) {
        const raw = fs.readFileSync(CONNECTIONS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        let list: any[] = [];
        if (Array.isArray(parsed) && parsed.length > 0) {
          list = parsed;
        } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.connections) && parsed.connections.length > 0) {
          list = parsed.connections;
          if (typeof parsed.activeConnectionId === 'string' && parsed.activeConnectionId.trim().length > 0) {
            this.activeConnectionId = parsed.activeConnectionId.trim();
          }
        }
        if (list.length > 0) {
          const masterKey = getMasterKeyFromEnv();
          let needsMigrationSave = false;

          this.connections = list.map((c: any) => {
            let activeApiKey = '';
            const encryptedKey = c.encryptedApiKey;

            // 1. If encrypted key exists at rest:
            if (encryptedKey && isEncryptedAtRest(encryptedKey)) {
              if (masterKey) {
                try {
                  activeApiKey = decryptAtRest(encryptedKey, masterKey);
                } catch (decErr) {
                  console.warn(
                    `[CredentialSecurity] Decryption failed for connection "${c.id}". Check ILLUMATRIX_ENCRYPTION_KEY:`,
                    sanitizeError(decErr)
                  );
                  activeApiKey = '';
                }
              } else {
                console.warn(
                  `[CredentialSecurity] Connection "${c.id}" has encrypted credentials, but ILLUMATRIX_ENCRYPTION_KEY is not configured in environment. Connection marked unconfigured.`
                );
                activeApiKey = '';
              }
            } else if (c.apiKey && typeof c.apiKey === 'string' && c.apiKey.trim().length > 0) {
              // 2. Legacy plaintext migration path:
              activeApiKey = c.apiKey.trim();
              if (masterKey) {
                needsMigrationSave = true; // Auto-migrate to encrypted-at-rest format immediately
              } else {
                console.warn(
                  `[CredentialSecurity] SECURITY WARNING: Legacy plaintext credentials detected for connection "${c.id}" in .provider_connections.json, but ILLUMATRIX_ENCRYPTION_KEY is not set. Set ILLUMATRIX_ENCRYPTION_KEY in .env to enable encryption at rest.`
                );
              }
            }

            const modelId = c.isDefault && c.modelId === 'gemini-2.0-flash' ? 'gemini-3.1-flash-lite' : c.modelId;
            const tempConn: ServerProviderConnection = {
              ...c,
              modelId,
              modelDisplayName: c.modelDisplayName || modelId,
              apiKey: activeApiKey,
              encryptedApiKey: encryptedKey,
            };

            const effectiveKey = this.resolveEffectiveApiKey(tempConn);
            const hasKey = Boolean(effectiveKey && effectiveKey.trim().length > 0) || c.provider === 'Ollama';

            return {
              ...tempConn,
              // Saved health status must NOT be treated as proof of current connectivity after reload
              status: !c.isEnabled ? 'disabled' : !hasKey ? 'unconfigured' : 'untested',
              modelStatus: 'untested' as const,
              catalogStatus: c.catalogStatus || (c.discoveredModels && c.discoveredModels.length > 0 ? 'loaded' : 'untested'),
              catalogFetchedAt: c.catalogFetchedAt,
              lastTestStatus: 'untested' as const,
              lastTestError: undefined,
              accountLimits: c.accountLimits || USER_SUPPLIED_LIMITS[modelId] || { source: 'UNKNOWN', rawDetails: 'Limits unverified for this account/model' },
            };
          });

          if (needsMigrationSave) {
            this.saveConnections();
          }

          return;
        }
      }
    } catch (e) {
      console.warn('Failed to read provider connections file, initializing defaults:', sanitizeError(e));
    }
    this.connections = [...DEFAULT_CONNECTIONS];
  }

  public saveConnections(): void {
    try {
      const envKey = (process.env.GEMINI_API_KEY || '').trim();
      const flashKey = (process.env.GEMINI_FLASH_API_KEY || '').trim();
      const groqKey = (process.env.GROQ_API_KEY || '').trim();
      const orKey = (process.env.OPENROUTER_API_KEY || '').trim();
      const masterKey = getMasterKeyFromEnv();

      const sanitizedConnections = this.connections.map((c) => {
        let keyToSave = c.apiKey || '';
        // Never serialize environment variable keys to the stored configuration file
        if (c.isDefault && envKey && keyToSave === envKey) {
          keyToSave = '';
        }
        if (flashKey && keyToSave === flashKey) {
          keyToSave = '';
        }
        if (groqKey && keyToSave === groqKey) {
          keyToSave = '';
        }
        if (orKey && keyToSave === orKey) {
          keyToSave = '';
        }

        let encryptedKeyToSave: string | undefined = undefined;

        // If a non-environment API key exists, encrypt it at rest if master key is available
        if (keyToSave && keyToSave.trim().length > 0) {
          if (masterKey) {
            try {
              encryptedKeyToSave = encryptAtRest(keyToSave, masterKey);
            } catch (err) {
              console.warn(`[CredentialSecurity] Failed to encrypt key for connection "${c.id}":`, sanitizeError(err));
            }
          } else {
            console.warn(
              `[CredentialSecurity] Notice: ILLUMATRIX_ENCRYPTION_KEY is not set. Persistent BYOK key for connection "${c.id}" is kept in-memory for active session only; plaintext will NOT be written to disk.`
            );
          }
        } else if (c.encryptedApiKey && isEncryptedAtRest(c.encryptedApiKey) && (!c.apiKey || c.apiKey.trim().length === 0)) {
          // Preserve existing encrypted ciphertext if in-memory key is unconfigured due to missing master key
          encryptedKeyToSave = c.encryptedApiKey;
        }

        return {
          ...c,
          apiKey: '', // Plaintext apiKey is strictly EMPTY STRING on disk
          encryptedApiKey: encryptedKeyToSave,
        };
      });

      const payload = {
        activeConnectionId: this.activeConnectionId,
        connections: sanitizedConnections,
      };
      fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(payload, null, 2), {
        encoding: 'utf-8',
        mode: 0o600, // Restrict file permissions to server process only
      });
    } catch (e) {
      console.error('Failed to write provider connections file:', sanitizeError(e));
    }
  }

  public getActiveConnectionId(): string {
    const active = this.connections.find((c) => c.id === this.activeConnectionId && c.isEnabled);
    if (!active) {
      const firstEnabledWithKey = this.connections.find(
        (c) => c.isEnabled && (Boolean(this.resolveEffectiveApiKey(c)) || c.provider === 'Ollama')
      );
      if (firstEnabledWithKey) {
        this.activeConnectionId = firstEnabledWithKey.id;
      } else {
        const fallback = this.connections.find((c) => c.isEnabled) || this.connections[0];
        if (fallback) this.activeConnectionId = fallback.id;
      }
    }
    return this.activeConnectionId;
  }

  public setActiveConnectionId(id: string): boolean {
    const target = this.connections.find((c) => c.id === id);
    if (!target) return false;
    this.activeConnectionId = id;
    this.saveConnections();
    return true;
  }

  public getPublicConnections(): PublicProviderConnection[] {
    return this.connections.map((c) => {
      const effectiveKey = this.resolveEffectiveApiKey(c);
      const hasKey = Boolean(effectiveKey && effectiveKey.trim().length > 0) || c.provider === 'Ollama';
      
      // Honest status: green ONLY if online (passed real live test). Untested is neutral/untested.
      let computedStatus: PublicProviderConnection['status'] = c.status;
      if (!c.isEnabled) {
        computedStatus = 'disabled';
      } else if (!hasKey && c.provider !== 'Ollama') {
        computedStatus = 'unconfigured';
      } else if (c.status === 'online') {
        computedStatus = 'online';
      } else if (c.status === 'degraded') {
        computedStatus = 'degraded';
      } else if (c.status === 'cooldown') {
        computedStatus = 'cooldown';
      } else {
        computedStatus = 'untested';
      }

      // Resolve account limits provenance
      const resolvedLimits: AccountLimitSnapshot = c.accountLimits || USER_SUPPLIED_LIMITS[c.modelId] || {
        source: 'UNKNOWN',
        rawDetails: 'Account limits not supplied or unverified for this model',
      };

      return {
        id: c.id,
        name: c.name,
        provider: c.provider,
        modelId: c.modelId,
        modelDisplayName: c.modelDisplayName || c.modelId,
        baseUrl: c.baseUrl,
        accountId: c.accountId,
        status: computedStatus,
        quotaPool: c.quotaPool,
        isDefault: c.isDefault,
        isEnabled: c.isEnabled,
        supportsStreaming: c.supportsStreaming,
        supportsStructuredJson: c.supportsStructuredJson,
        lastChecked: c.lastChecked,
        lastTestStatus: c.lastTestStatus || 'untested',
        lastTestError: c.lastTestError,
        lastTestedAt: c.lastTestedAt,
        reportedLatencyMs: c.reportedLatencyMs,
        observedCallsCount: c.observedCallsCount,
        quotaReported: c.quotaReported,
        cooldownRemainingSec: c.cooldownRemainingSec,
        hasKey,
        maskedKey: maskApiKey(effectiveKey),
        accountLimits: resolvedLimits,
        pricing: c.pricing,
        capabilities: c.capabilities,
        supportedParameters: c.supportedParameters,
        discoveredModels: c.discoveredModels,
        modelStatus: c.modelStatus || (computedStatus === 'online' ? 'verified' : 'untested'),
        catalogStatus: c.catalogStatus || (c.discoveredModels && c.discoveredModels.length > 0 ? 'loaded' : 'untested'),
        catalogFetchedAt: c.catalogFetchedAt,
      };
    });
  }

  public getConnection(id: string): ServerProviderConnection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  public listConnections(): ServerProviderConnection[] {
    return this.connections;
  }

  public addOrUpdateConnection(data: {
    id?: string;
    name: string;
    provider: SupportedProvider;
    modelId: string;
    modelDisplayName?: string;
    baseUrl?: string;
    accountId?: string;
    apiKey?: string;
    quotaPool?: string;
    isEnabled?: boolean;
    accountLimits?: AccountLimitSnapshot;
    pricing?: ModelPricing;
    capabilities?: ModelCapability;
    supportedParameters?: string[];
  }): PublicProviderConnection {
    const existingIndex = data.id ? this.connections.findIndex((c) => c.id === data.id) : -1;
    const providerMeta = PROVIDER_REGISTRY[data.provider] || PROVIDER_REGISTRY['OpenAI Compatible'];

    if (existingIndex >= 0) {
      const existing = this.connections[existingIndex];
      const updatedApiKey =
        data.apiKey !== undefined && data.apiKey !== null
          ? data.apiKey.trim()
          : existing.apiKey;

      const hasKey = Boolean(updatedApiKey && updatedApiKey.length > 0) || data.provider === 'Ollama';
      const isEnabled = data.isEnabled !== undefined ? Boolean(data.isEnabled) : existing.isEnabled;

      // Key changed or model changed invalidates prior test pass
      const keyChanged = data.apiKey !== undefined && data.apiKey.trim() !== (existing.apiKey || '');
      const modelChanged = data.modelId !== undefined && data.modelId !== existing.modelId;
      const shouldResetTest = keyChanged || modelChanged;

      const targetModelId = data.modelId?.trim() || existing.modelId;
      const updatedLimits = data.accountLimits || (modelChanged ? USER_SUPPLIED_LIMITS[targetModelId] : existing.accountLimits);

      const updated: ServerProviderConnection = {
        ...existing,
        name: data.name?.trim() || existing.name,
        provider: data.provider || existing.provider,
        modelId: targetModelId,
        modelDisplayName: data.modelDisplayName?.trim() || (modelChanged ? targetModelId : existing.modelDisplayName || targetModelId),
        baseUrl: data.baseUrl ? data.baseUrl.trim() : (data.provider === existing.provider ? existing.baseUrl : providerMeta.defaultBaseUrl),
        accountId: data.accountId !== undefined ? data.accountId.trim() : existing.accountId,
        quotaPool: data.quotaPool ? data.quotaPool.trim() : existing.quotaPool,
        isEnabled,
        apiKey: updatedApiKey,
        status: !isEnabled ? 'disabled' : !hasKey ? 'unconfigured' : shouldResetTest ? 'untested' : existing.status,
        lastTestStatus: shouldResetTest ? 'untested' : existing.lastTestStatus,
        lastTestError: shouldResetTest ? undefined : existing.lastTestError,
        accountLimits: updatedLimits,
        pricing: data.pricing !== undefined ? data.pricing : existing.pricing,
        capabilities: data.capabilities !== undefined ? data.capabilities : existing.capabilities,
        supportedParameters: data.supportedParameters !== undefined ? data.supportedParameters : existing.supportedParameters,
      };

      this.connections[existingIndex] = updated;
      this.saveConnections();
      this.cachedGenAiClients.delete(updated.id);
      aiExecutionEngine.invalidateClientCache(updated.id);
      if (keyChanged || data.apiKey !== undefined || data.baseUrl !== undefined || data.provider !== undefined) {
        catalogCacheManager.invalidateByConnection(updated.id);
      }
      return this.getPublicConnections().find((c) => c.id === updated.id)!;
    } else {
      const newId =
        data.id && data.id.trim().length > 0
          ? data.id.trim()
          : `conn_${data.provider.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
      const newKey = data.apiKey ? data.apiKey.trim() : '';
      const isEnabled = data.isEnabled !== undefined ? Boolean(data.isEnabled) : true;
      const hasKey = Boolean(newKey && newKey.length > 0) || data.provider === 'Ollama';
      const targetModelId = data.modelId?.trim() || providerMeta.defaultModel;

      const newConn: ServerProviderConnection = {
        id: newId,
        name: data.name?.trim() || `${data.provider} Connection`,
        provider: data.provider || 'Google GenAI',
        modelId: targetModelId,
        modelDisplayName: data.modelDisplayName?.trim() || targetModelId,
        baseUrl: data.baseUrl ? data.baseUrl.trim() : providerMeta.defaultBaseUrl,
        accountId: data.accountId ? data.accountId.trim() : undefined,
        status: !isEnabled ? 'disabled' : !hasKey ? 'unconfigured' : 'untested',
        quotaPool: data.quotaPool ? data.quotaPool.trim() : providerMeta.defaultQuotaPool,
        isDefault: false,
        isEnabled,
        supportsStreaming: true,
        supportsStructuredJson: true,
        lastChecked: 'Never',
        lastTestStatus: 'untested',
        reportedLatencyMs: null,
        observedCallsCount: 0,
        quotaReported: false,
        apiKey: newKey,
        modelStatus: 'untested',
        catalogStatus: 'untested',
        accountLimits: data.accountLimits || USER_SUPPLIED_LIMITS[targetModelId] || { source: 'UNKNOWN' },
        pricing: data.pricing,
        capabilities: data.capabilities,
        supportedParameters: data.supportedParameters,
      };

      this.connections.push(newConn);
      this.saveConnections();
      return this.getPublicConnections().find((c) => c.id === newConn.id)!;
    }
  }

  public parseProviderError(
    err: any,
    provider: SupportedProvider
  ): { category: string; message: string; details: string } {
    const status = err?.status || err?.statusCode || 0;
    const rawMsg = err?.message || String(err || '');
    const sanitized = sanitizeError(rawMsg);
    const lower = sanitized.toLowerCase();

    if (
      status === 401 ||
      lower.includes('invalid api key') ||
      lower.includes('invalid_api_key') ||
      lower.includes('unauthorized') ||
      lower.includes('incorrect api key')
    ) {
      return {
        category: 'AUTH_ERROR',
        message: `Authentication failed (HTTP 401). Verify that your ${provider} API key is valid.`,
        details: sanitized,
      };
    }
    if (
      status === 402 ||
      lower.includes('insufficient_credits') ||
      lower.includes('payment_required') ||
      lower.includes('insufficient_balance')
    ) {
      return {
        category: 'INSUFFICIENT_CREDITS',
        message: `Payment Required (HTTP 402). Your ${provider} account lacks active credits or balance.`,
        details: sanitized,
      };
    }
    if (status === 403 || lower.includes('permission_denied') || lower.includes('forbidden')) {
      return {
        category: 'PERMISSION_DENIED',
        message: `Permission denied (HTTP 403). Your key does not have permission for this resource.`,
        details: sanitized,
      };
    }
    if (
      status === 404 ||
      lower.includes('model not found') ||
      lower.includes('model_not_found') ||
      lower.includes('does not exist')
    ) {
      return {
        category: 'MODEL_NOT_FOUND',
        message: `Model not found on ${provider} (HTTP 404).`,
        details: sanitized,
      };
    }
    if (lower.includes('quota') || lower.includes('insufficient_quota')) {
      return {
        category: 'QUOTA_EXHAUSTED',
        message: `Quota exhausted for this ${provider} account or project.`,
        details: sanitized,
      };
    }
    if (status === 429 || lower.includes('rate limit') || lower.includes('requests per minute')) {
      return {
        category: 'RATE_LIMIT_429',
        message: `Rate limit reached (HTTP 429). Wait for cooldown before retrying.`,
        details: sanitized,
      };
    }
    if (err?.name === 'TimeoutError' || lower.includes('timeout')) {
      return {
        category: 'TIMEOUT',
        message: `Request to ${provider} timed out.`,
        details: sanitized,
      };
    }
    if (status >= 500) {
      return {
        category: 'SERVER_ERROR',
        message: `Upstream server error (HTTP ${status}) from ${provider}.`,
        details: sanitized,
      };
    }

    return {
      category: 'NETWORK_ERROR',
      message: `Request to ${provider} failed.`,
      details: sanitized,
    };
  }

  public toggleConnection(id: string): { success: boolean; isEnabled: boolean } {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn) return { success: false, isEnabled: false };
    conn.isEnabled = !conn.isEnabled;
    const effectiveKey = conn.apiKey || (conn.isDefault ? process.env.GEMINI_API_KEY : '');
    const hasKey = Boolean(effectiveKey && effectiveKey.length > 0) || conn.provider === 'Ollama';
    conn.status = conn.isEnabled ? (hasKey ? (conn.lastTestStatus === 'success' ? 'online' : 'untested') : 'unconfigured') : 'disabled';
    this.saveConnections();
    return { success: true, isEnabled: conn.isEnabled };
  }

  // Task 1: Safe deletion preventing deleting active connection without replacement
  public deleteConnection(id: string): { success: boolean; message?: string; switchedActiveTo?: string } {
    const conn = this.connections.find((c) => c.id === id);
    if (!conn) {
      return { success: false, message: 'Connection not found.' };
    }
    if (conn.isDefault) {
      return { success: false, message: 'Default baseline connection cannot be deleted.' };
    }

    let switchedTo: string | undefined = undefined;
    if (this.activeConnectionId === id) {
      const replacement =
        this.connections.find((c) => c.id !== id && c.isEnabled && (c.apiKey || c.isDefault || c.provider === 'Ollama')) ||
        this.connections.find((c) => c.id !== id && c.isEnabled) ||
        this.connections[0];
      if (replacement) {
        this.activeConnectionId = replacement.id;
        switchedTo = replacement.id;
      }
    }

    this.connections = this.connections.filter((c) => c.id !== id);
    this.cachedGenAiClients.delete(id);
    aiExecutionEngine.invalidateClientCache(id);
    catalogCacheManager.invalidateByConnection(id);
    this.saveConnections();

    return { success: true, switchedActiveTo: switchedTo };
  }

  // Public access to catalog cache manager
  public getCatalogCache(): CatalogCacheManager {
    return catalogCacheManager;
  }

  // Dynamic Model Discovery & Live Catalog Fetch with Caching, Cooldowns, Single-Flight & Stale Fallback
  public async fetchAvailableModels(params: {
    connectionId?: string;
    provider?: SupportedProvider;
    apiKey?: string;
    baseUrl?: string;
    forceRefresh?: boolean;
  }): Promise<{
    success: boolean;
    provider: SupportedProvider;
    models: DiscoveredModel[];
    source: 'live_api' | 'cached_catalog';
    message?: string;
    isStale?: boolean;
    staleReason?: string;
    cooldownRemainingSec?: number;
    errorCategory?: string;
    cacheStatus?: 'hit' | 'miss' | 'stale_fallback' | 'refreshed' | 'cooldown_blocked';
    cachedAt?: string;
  }> {
    const conn = params.connectionId ? this.connections.find((c) => c.id === params.connectionId) : undefined;
    const provider = params.provider || conn?.provider || 'Google GenAI';
    const envKey = process.env.GEMINI_API_KEY || '';
    const effectiveKey = params.apiKey || (conn ? this.resolveEffectiveApiKey(conn) : '') || (provider === 'Google GenAI' ? envKey : '');
    const effectiveBaseUrl = (params.baseUrl !== undefined ? params.baseUrl : conn?.baseUrl) || PROVIDER_REGISTRY[provider]?.defaultBaseUrl || '';

    // 1. Stable Cache Key & Cooldown Key Generation (Safe Credential Fingerprint)
    const cacheKey = catalogCacheManager.generateCacheKey({
      provider,
      connectionId: conn?.id || params.connectionId,
      baseUrl: effectiveBaseUrl,
      apiKey: effectiveKey,
    });
    const cooldownKey = catalogCacheManager.generateCooldownKey({
      provider,
      connectionId: conn?.id || params.connectionId,
      baseUrl: effectiveBaseUrl,
    });

    // 2. Cache Hit Check (unless forceRefresh is requested)
    if (!params.forceRefresh) {
      const cached = catalogCacheManager.get(cacheKey);
      if (cached.hit && cached.data) {
        return {
          success: true,
          provider,
          models: cached.data,
          source: 'cached_catalog',
          isStale: false,
          cacheStatus: 'hit',
          cachedAt: cached.cachedAt ? new Date(cached.cachedAt).toISOString() : undefined,
          message: `Loaded ${cached.data.length} models from server catalog cache.`,
        };
      }
    }

    // 3. Provider Failure Cooldown Check
    const cooldown = catalogCacheManager.isCooldownActive(cooldownKey);
    if (cooldown.active) {
      // Cooldown is active: Attempt Stale-If-Error fallback
      const staleFallback = catalogCacheManager.getStaleFallback(
        cacheKey,
        `Live refresh blocked by active cooldown (${cooldown.remainingSec}s remaining). Upstream error: ${cooldown.reason || 'temporary failure'}`
      );
      if (staleFallback.hit && staleFallback.data) {
        return {
          success: true,
          provider,
          models: staleFallback.data,
          source: 'cached_catalog',
          isStale: true,
          staleReason: staleFallback.staleReason,
          cooldownRemainingSec: cooldown.remainingSec,
          cacheStatus: 'stale_fallback',
          cachedAt: staleFallback.cachedAt ? new Date(staleFallback.cachedAt).toISOString() : undefined,
          message: staleFallback.staleReason,
        };
      }

      // Check saved connection models as fallback
      if (conn?.discoveredModels && conn.discoveredModels.length > 0) {
        return {
          success: true,
          provider,
          models: conn.discoveredModels.map((m) => ({ ...m, source: 'cached_catalog' as const })),
          source: 'cached_catalog',
          isStale: true,
          staleReason: `Live refresh blocked by active cooldown (${cooldown.remainingSec}s remaining). Showing previously saved models.`,
          cooldownRemainingSec: cooldown.remainingSec,
          cacheStatus: 'stale_fallback',
          cachedAt: conn.catalogFetchedAt,
          message: `Cooldown active (${cooldown.remainingSec}s remaining). Showing previously saved models.`,
        };
      }

      // No prior successful catalog exists -> Fail closed with provider error
      return {
        success: false,
        provider,
        models: [],
        source: 'cached_catalog',
        isStale: false,
        cooldownRemainingSec: cooldown.remainingSec,
        errorCategory: cooldown.errorCategory || 'COOLDOWN_ACTIVE',
        cacheStatus: 'cooldown_blocked',
        message: `Live discovery cooldown active (${cooldown.remainingSec}s remaining): ${cooldown.reason || 'Temporary upstream failure'}.`,
      };
    }

    // 4. Single-Flight Wrapped Discovery Execution
    return await catalogCacheManager.executeSingleFlight(cacheKey, async () => {
      // 1. Google GenAI Live Model Listing
      if (provider === 'Google GenAI') {
        if (effectiveKey && effectiveKey.trim().length > 0) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(effectiveKey.trim())}`;
            const res = await fetch(url, {
              signal: AbortSignal.timeout(12000),
            });
            const retryAfterHeader = res.headers.get('retry-after');

            if (res.ok) {
              const text = await res.text();
              catalogCacheManager.checkPayloadSize(Buffer.byteLength(text, 'utf-8'), 'Google GenAI');
              const json = JSON.parse(text);
              const rawModels = catalogCacheManager.validateAndSanitizeCatalogPayload(json, 'Google GenAI');

              const mapped: DiscoveredModel[] = rawModels.map((m: any) => {
                const cleanId = String(m.name || '').replace(/^models\//, '');
                const compat = evaluateModelCompatibility({
                  id: cleanId,
                  provider: 'Google GenAI',
                  displayName: m.displayName,
                  description: m.description,
                  supportedGenerationMethods: m.supportedGenerationMethods,
                });

                return {
                  id: cleanId,
                  displayName: m.displayName || cleanId,
                  provider: 'Google GenAI' as SupportedProvider,
                  description: m.description ? String(m.description).slice(0, 300) : undefined,
                  contextLength: m.inputTokenLimit,
                  capabilities: {
                    supportsText: compat.isTextGenerationCapable,
                    supportsImageGeneration: compat.isImageGenerationCapable,
                    supportsStructuredJson: m.supportedGenerationMethods?.includes('generateContent') ?? true,
                    supportsStreaming: true,
                    supportsTools: true,
                  },
                  compatibility: compat,
                  accountLimits: USER_SUPPLIED_LIMITS[cleanId] || {
                    source: 'UNKNOWN',
                    rawDetails: 'Google account quotas vary by GCP project and tier',
                  },
                  isAvailable: true,
                  source: 'live_api' as const,
                  fetchedAt: new Date().toISOString(),
                };
              });

              if (mapped.length > 0) {
                catalogCacheManager.recordSuccess(cooldownKey);
                catalogCacheManager.set(cacheKey, mapped, {
                  provider: 'Google GenAI',
                  connectionId: conn?.id,
                  baseUrl: effectiveBaseUrl,
                  apiKey: effectiveKey,
                });
                this.cachedDiscoveredModels.set('Google GenAI', mapped);
                if (conn) {
                  conn.discoveredModels = mapped;
                  conn.catalogStatus = 'loaded';
                  conn.catalogFetchedAt = new Date().toISOString();
                  this.saveConnections();
                }
                return {
                  success: true,
                  provider: 'Google GenAI',
                  models: mapped,
                  source: 'live_api' as const,
                  isStale: false,
                  cacheStatus: 'refreshed' as const,
                  message: `Discovered ${mapped.length} active models from Google AI Studio.`,
                };
              }
            } else {
              const errText = await res.text().catch(() => '');
              const sanitizedErr = sanitizeError(errText || `HTTP ${res.status}`);
              const errCategory =
                res.status === 400 || res.status === 401 || res.status === 403
                  ? 'INVALID_CREDENTIALS'
                  : res.status === 429
                  ? 'RATE_LIMIT_429'
                  : res.status >= 500
                  ? 'SERVER_ERROR'
                  : 'NETWORK_ERROR';

              catalogCacheManager.recordFailure(cooldownKey, {
                category: errCategory,
                message: sanitizedErr,
                status: res.status,
                retryAfterHeader,
              });

              // Stale-if-error check
              const stale = catalogCacheManager.getStaleFallback(
                cacheKey,
                `Live Google discovery failed (${res.status}); returning cached catalog.`
              );
              if (stale.hit && stale.data) {
                return {
                  success: true,
                  provider: 'Google GenAI',
                  models: stale.data,
                  source: 'cached_catalog' as const,
                  isStale: true,
                  staleReason: stale.staleReason,
                  cacheStatus: 'stale_fallback' as const,
                  cachedAt: stale.cachedAt ? new Date(stale.cachedAt).toISOString() : undefined,
                  message: stale.staleReason,
                };
              }

              if (conn?.discoveredModels && conn.discoveredModels.length > 0) {
                return {
                  success: true,
                  provider: 'Google GenAI',
                  models: conn.discoveredModels.map((m) => ({ ...m, source: 'cached_catalog' as const })),
                  source: 'cached_catalog' as const,
                  isStale: true,
                  staleReason: `Live Google discovery failed (${res.status}); showing previously saved models.`,
                  cacheStatus: 'stale_fallback' as const,
                  cachedAt: conn.catalogFetchedAt,
                  message: `Live Google discovery failed; showing previously saved models.`,
                };
              }

              return {
                success: false,
                provider: 'Google GenAI',
                models: [],
                source: 'cached_catalog' as const,
                errorCategory: errCategory,
                message: `Google AI Studio model listing failed: ${sanitizedErr}`,
              };
            }
          } catch (e: any) {
            const sanitizedMsg = sanitizeError(e);
            const errCategory = e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
            catalogCacheManager.recordFailure(cooldownKey, {
              category: errCategory,
              message: sanitizedMsg,
            });

            const stale = catalogCacheManager.getStaleFallback(
              cacheKey,
              `Live Google discovery error (${sanitizedMsg}); returning cached catalog.`
            );
            if (stale.hit && stale.data) {
              return {
                success: true,
                provider: 'Google GenAI',
                models: stale.data,
                source: 'cached_catalog' as const,
                isStale: true,
                staleReason: stale.staleReason,
                cacheStatus: 'stale_fallback' as const,
                cachedAt: stale.cachedAt ? new Date(stale.cachedAt).toISOString() : undefined,
                message: stale.staleReason,
              };
            }

            return {
              success: false,
              provider: 'Google GenAI',
              models: [],
              source: 'cached_catalog' as const,
              errorCategory: errCategory,
              message: `Google AI Studio connection error: ${sanitizedMsg}`,
            };
          }
        }

        // Verified Fallback Catalog for Google GenAI when unconfigured
        const fallbackGoogle: DiscoveredModel[] = [
          {
            id: 'gemini-3.1-flash-lite',
            displayName: 'Gemini 3.1 Flash Lite',
            provider: 'Google GenAI',
            description: 'High-throughput, lowest-latency model for high-frequency video generation.',
            contextLength: 1048576,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'gemini-3.1-flash-lite', provider: 'Google GenAI' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Quotas vary by GCP project' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'gemini-3.8-flash',
            displayName: 'Gemini 3.8 Flash',
            provider: 'Google GenAI',
            description: 'Flagship model for high-retention video scriptwriting and structured reasoning.',
            contextLength: 1048576,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'gemini-3.8-flash', provider: 'Google GenAI' }),
            accountLimits: USER_SUPPLIED_LIMITS['gemini-3.8-flash'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'gemini-4-argon',
            displayName: 'Gemini 4 Argon',
            provider: 'Google GenAI',
            description: 'Frontier reasoning model for advanced synthesis and narrative planning.',
            contextLength: 1048576,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'gemini-4-argon', provider: 'Google GenAI' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Paid billing required' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'gemini-3.1-flash-lite-image',
            displayName: 'Gemini 3.1 Flash Lite Image Preview',
            provider: 'Google GenAI',
            description: 'Native visual preview rendering for storyboard and thumbnail mockups.',
            contextLength: 32768,
            capabilities: { supportsText: false, supportsImageGeneration: true, supportsStructuredJson: false, supportsStreaming: false, supportsTools: false },
            compatibility: evaluateModelCompatibility({ id: 'gemini-3.1-flash-lite-image', provider: 'Google GenAI' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Image generation requires active quota' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
        ];

        return {
          success: true,
          provider: 'Google GenAI',
          models: fallbackGoogle,
          source: 'cached_catalog' as const,
          isStale: false,
          cacheStatus: 'miss' as const,
          message: effectiveKey ? 'Loaded verified baseline Google models (live API unreachable).' : 'Google AI Studio key not configured; showing baseline verified catalog.',
        };
      }

      // 2. Groq Live Model Listing
      if (provider === 'Groq') {
        if (effectiveKey && effectiveKey.trim().length > 0) {
          try {
            const url = `${(effectiveBaseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '')}/models`;
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${effectiveKey.trim()}` },
              signal: AbortSignal.timeout(12000),
            });
            const retryAfterHeader = res.headers.get('retry-after');

            if (res.ok) {
              const text = await res.text();
              catalogCacheManager.checkPayloadSize(Buffer.byteLength(text, 'utf-8'), 'Groq');
              const json = JSON.parse(text);
              const rawModels = catalogCacheManager.validateAndSanitizeCatalogPayload(json, 'Groq');

              const mapped: DiscoveredModel[] = rawModels.map((m: any) => {
                const exactId = String(m.id || '');
                const compat = evaluateModelCompatibility({
                  id: exactId,
                  provider: 'Groq',
                  description: `Owned by ${m.owned_by || 'groq'}`,
                });

                let displayName = exactId;
                if (exactId === 'qwen/qwen3.8-27b') displayName = 'Qwen 3.8 27B';
                else if (exactId === 'openai/gpt-oss-120b') displayName = 'OpenAI GPT-OSS 120B';
                else if (exactId === 'llama-3.3-70b-versatile') displayName = 'Llama 3.3 70B Versatile';
                else if (exactId === 'llama-3.1-8b-instant') displayName = 'Llama 3.1 8B Instant';
                else if (exactId.includes('/')) {
                  const parts = exactId.split('/');
                  displayName = `${parts[0].toUpperCase()}: ${parts[1]}`;
                }

                return {
                  id: exactId,
                  displayName,
                  provider: 'Groq' as SupportedProvider,
                  description: `Owned by ${m.owned_by || 'groq'}`,
                  contextLength: m.context_window || 8192,
                  capabilities: {
                    supportsText: compat.isTextGenerationCapable,
                    supportsImageGeneration: compat.isImageGenerationCapable,
                    supportsStructuredJson: compat.supportsStructuredJson,
                    supportsStreaming: compat.supportsStreaming,
                    supportsTools: compat.supportsTools,
                  },
                  compatibility: compat,
                  accountLimits: USER_SUPPLIED_LIMITS[exactId] || {
                    source: 'UNKNOWN',
                    rawDetails: 'Groq account limits unverified for this model',
                  },
                  isAvailable: m.active !== false,
                  source: 'live_api' as const,
                  fetchedAt: new Date().toISOString(),
                };
              });

              if (mapped.length > 0) {
                catalogCacheManager.recordSuccess(cooldownKey);
                catalogCacheManager.set(cacheKey, mapped, {
                  provider: 'Groq',
                  connectionId: conn?.id,
                  baseUrl: effectiveBaseUrl,
                  apiKey: effectiveKey,
                });
                this.cachedDiscoveredModels.set('Groq', mapped);
                if (conn) {
                  conn.discoveredModels = mapped;
                  conn.catalogStatus = 'loaded';
                  conn.catalogFetchedAt = new Date().toISOString();
                  this.saveConnections();
                }
                return {
                  success: true,
                  provider: 'Groq',
                  models: mapped,
                  source: 'live_api' as const,
                  isStale: false,
                  cacheStatus: 'refreshed' as const,
                  message: `Discovered ${mapped.length} active models from Groq account.`,
                };
              }
            } else {
              const errText = await res.text().catch(() => '');
              const sanitized = sanitizeError(errText || `HTTP ${res.status}`);
              const errCategory =
                res.status === 401 || res.status === 403
                  ? 'INVALID_CREDENTIALS'
                  : res.status === 429
                  ? 'RATE_LIMIT_429'
                  : res.status >= 500
                  ? 'SERVER_ERROR'
                  : 'NETWORK_ERROR';

              catalogCacheManager.recordFailure(cooldownKey, {
                category: errCategory,
                message: sanitized,
                status: res.status,
                retryAfterHeader,
              });

              const stale = catalogCacheManager.getStaleFallback(
                cacheKey,
                `Live Groq discovery failed (${res.status}); returning cached catalog.`
              );
              if (stale.hit && stale.data) {
                return {
                  success: true,
                  provider: 'Groq',
                  models: stale.data,
                  source: 'cached_catalog' as const,
                  isStale: true,
                  staleReason: stale.staleReason,
                  cacheStatus: 'stale_fallback' as const,
                  cachedAt: stale.cachedAt ? new Date(stale.cachedAt).toISOString() : undefined,
                  message: stale.staleReason,
                };
              }

              if (conn?.discoveredModels && conn.discoveredModels.length > 0) {
                return {
                  success: true,
                  provider: 'Groq',
                  models: conn.discoveredModels.map((m) => ({ ...m, source: 'cached_catalog' as const })),
                  source: 'cached_catalog' as const,
                  isStale: true,
                  staleReason: `Live Groq discovery failed (${res.status}); showing previously saved models.`,
                  cacheStatus: 'stale_fallback' as const,
                  cachedAt: conn.catalogFetchedAt,
                  message: `Live Groq discovery failed; showing previously saved models.`,
                };
              }

              return {
                success: false,
                provider: 'Groq',
                models: [],
                source: 'cached_catalog' as const,
                errorCategory: errCategory,
                message: `Groq models list error: ${sanitized}`,
              };
            }
          } catch (e: any) {
            const sanitized = sanitizeError(e);
            const errCategory = e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
            catalogCacheManager.recordFailure(cooldownKey, {
              category: errCategory,
              message: sanitized,
            });

            const stale = catalogCacheManager.getStaleFallback(
              cacheKey,
              `Live Groq discovery exception (${sanitized}); returning cached catalog.`
            );
            if (stale.hit && stale.data) {
              return {
                success: true,
                provider: 'Groq',
                models: stale.data,
                source: 'cached_catalog' as const,
                isStale: true,
                staleReason: stale.staleReason,
                cacheStatus: 'stale_fallback' as const,
                cachedAt: stale.cachedAt ? new Date(stale.cachedAt).toISOString() : undefined,
                message: stale.staleReason,
              };
            }

            return {
              success: false,
              provider: 'Groq',
              models: [],
              source: 'cached_catalog' as const,
              errorCategory: errCategory,
              message: `Groq dynamic model fetch exception: ${sanitized}`,
            };
          }
        }

        const fallbackGroq: DiscoveredModel[] = [
          {
            id: 'qwen/qwen3.8-27b',
            displayName: 'Qwen 3.8 27B',
            provider: 'Groq',
            description: 'Official high-throughput LPU model connected in user workspace.',
            contextLength: 32768,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'qwen/qwen3.8-27b', provider: 'Groq' }),
            accountLimits: USER_SUPPLIED_LIMITS['qwen/qwen3.8-27b'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'llama-3.3-70b-versatile',
            displayName: 'Llama 3.3 70B Versatile',
            provider: 'Groq',
            description: 'High-capability 128k context Llama 3.3 running on Groq LPUs.',
            contextLength: 131072,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'llama-3.3-70b-versatile', provider: 'Groq' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Groq limits unverified' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'llama-3.1-8b-instant',
            displayName: 'Llama 3.1 8B Instant',
            provider: 'Groq',
            description: 'Ultra-fast lightweight Llama 3.1 8B inference.',
            contextLength: 131072,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'llama-3.1-8b-instant', provider: 'Groq' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Groq limits unverified' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'mixtral-8x7b-32768',
            displayName: 'Mixtral 8x7B 32k',
            provider: 'Groq',
            description: 'MoE architecture with 32,768 token context window.',
            contextLength: 32768,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'mixtral-8x7b-32768', provider: 'Groq' }),
            accountLimits: { source: 'UNKNOWN', rawDetails: 'Groq limits unverified' },
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
        ];

        return {
          success: true,
          provider: 'Groq',
          models: fallbackGroq,
          source: 'cached_catalog' as const,
          isStale: false,
          cacheStatus: 'miss' as const,
          message: effectiveKey ? 'Loaded verified baseline Groq models (live API unreachable).' : 'Groq API key not configured; showing baseline verified catalog.',
        };
      }

      // 3. OpenRouter Live Model Listing
      if (provider === 'OpenRouter') {
        try {
          const headers: Record<string, string> = {
            'HTTP-Referer': 'https://illumatrix.internal',
            'X-Title': 'ILLUMATRIX Content Workspace',
          };
          if (effectiveKey && effectiveKey.trim().length > 0) {
            headers.Authorization = `Bearer ${effectiveKey.trim()}`;
          }

          const url = `${(effectiveBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/models`;
          const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15000),
          });
          const retryAfterHeader = res.headers.get('retry-after');

          if (res.ok) {
            const text = await res.text();
            catalogCacheManager.checkPayloadSize(Buffer.byteLength(text, 'utf-8'), 'OpenRouter');
            const json = JSON.parse(text);
            const rawModels = catalogCacheManager.validateAndSanitizeCatalogPayload(json, 'OpenRouter');

            const mapped: DiscoveredModel[] = rawModels
              .filter((m: any) => m && typeof m.id === 'string' && m.id.length > 0)
              .map((m: any) => {
                const exactId = String(m.id);
                const paramsList: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
                const pricing = classifyOpenRouterPricing(m.pricing, exactId);
                const compat = evaluateModelCompatibility({
                  id: exactId,
                  provider: 'OpenRouter',
                  displayName: m.name,
                  description: m.description,
                  architecture: m.architecture,
                  supportedParameters: paramsList,
                });

                return {
                  id: exactId,
                  displayName: m.name || exactId,
                  provider: 'OpenRouter' as SupportedProvider,
                  description: m.description ? String(m.description).slice(0, 300) : undefined,
                  contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
                  capabilities: {
                    supportsText: compat.isTextGenerationCapable,
                    supportsImageGeneration: compat.isImageGenerationCapable,
                    supportsStructuredJson: compat.supportsStructuredJson,
                    supportsStreaming: compat.supportsStreaming,
                    supportsTools: compat.supportsTools,
                  },
                  compatibility: compat,
                  pricing,
                  accountLimits: {
                    source: 'UNKNOWN',
                    rawDetails: 'OpenRouter accounts use deposit credits; per-account limits not published in catalog',
                  },
                  supportedParameters: paramsList,
                  isAvailable: true,
                  source: 'live_api' as const,
                  fetchedAt: new Date().toISOString(),
                };
              });

            if (mapped.length > 0) {
              catalogCacheManager.recordSuccess(cooldownKey);
              catalogCacheManager.set(cacheKey, mapped, {
                provider: 'OpenRouter',
                connectionId: conn?.id,
                baseUrl: effectiveBaseUrl,
                apiKey: effectiveKey,
              });
              this.cachedDiscoveredModels.set('OpenRouter', mapped);
              if (conn) {
                conn.discoveredModels = mapped;
                conn.catalogStatus = 'loaded';
                conn.catalogFetchedAt = new Date().toISOString();
                this.saveConnections();
              }
              return {
                success: true,
                provider: 'OpenRouter',
                models: mapped,
                source: 'live_api' as const,
                isStale: false,
                cacheStatus: 'refreshed' as const,
                message: `Discovered ${mapped.length} models from OpenRouter catalog.`,
              };
            }
          } else {
            const errText = await res.text().catch(() => '');
            const sanitized = sanitizeError(errText || `HTTP ${res.status}`);
            const errCategory =
              res.status === 401 || res.status === 403
                ? 'INVALID_CREDENTIALS'
                : res.status === 429
                ? 'RATE_LIMIT_429'
                : res.status >= 500
                ? 'SERVER_ERROR'
                : 'NETWORK_ERROR';

            catalogCacheManager.recordFailure(cooldownKey, {
              category: errCategory,
              message: sanitized,
              status: res.status,
              retryAfterHeader,
            });
          }
        } catch (e: any) {
          const sanitized = sanitizeError(e);
          catalogCacheManager.recordFailure(cooldownKey, {
            category: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
            message: sanitized,
          });
        }

        // Stale-if-error check for OpenRouter
        const stale = catalogCacheManager.getStaleFallback(
          cacheKey,
          `Live OpenRouter discovery unreachable; returning cached catalog.`
        );
        if (stale.hit && stale.data) {
          return {
            success: true,
            provider: 'OpenRouter',
            models: stale.data,
            source: 'cached_catalog' as const,
            isStale: true,
            staleReason: stale.staleReason,
            cacheStatus: 'stale_fallback' as const,
            cachedAt: stale.cachedAt ? new Date(stale.cachedAt).toISOString() : undefined,
            message: stale.staleReason,
          };
        }

        if (conn?.discoveredModels && conn.discoveredModels.length > 0) {
          return {
            success: true,
            provider: 'OpenRouter',
            models: conn.discoveredModels.map((m) => ({ ...m, source: 'cached_catalog' as const })),
            source: 'cached_catalog' as const,
            isStale: true,
            staleReason: 'Showing cached OpenRouter models (live refresh unreachable).',
            cacheStatus: 'stale_fallback' as const,
            cachedAt: conn.catalogFetchedAt,
            message: 'Showing cached OpenRouter models (live refresh unreachable).',
          };
        }

        const fallbackOpenRouter: DiscoveredModel[] = [
          {
            id: 'meta-llama/llama-3.3-70b-instruct',
            displayName: 'Meta: Llama 3.3 70B Instruct',
            provider: 'OpenRouter',
            description: 'High-capability open weights model for structured narrative generation.',
            contextLength: 131072,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'meta-llama/llama-3.3-70b-instruct', provider: 'OpenRouter' }),
            pricing: classifyOpenRouterPricing({ prompt: '0.00000012', completion: '0.00000030' }, 'meta-llama/llama-3.3-70b-instruct'),
            accountLimits: { source: 'UNKNOWN' },
            supportedParameters: ['tools', 'response_format'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'google/gemini-2.0-flash-exp:free',
            displayName: 'Google: Gemini 2.0 Flash Experimental (free)',
            provider: 'OpenRouter',
            description: 'Experimental free tier route on OpenRouter (availability subject to provider load).',
            contextLength: 1048576,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'google/gemini-2.0-flash-exp:free', provider: 'OpenRouter' }),
            pricing: classifyOpenRouterPricing({ prompt: 0, completion: 0 }, 'google/gemini-2.0-flash-exp:free'),
            accountLimits: { source: 'UNKNOWN' },
            supportedParameters: ['tools', 'response_format'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'deepseek/deepseek-r1:free',
            displayName: 'DeepSeek: R1 (free)',
            provider: 'OpenRouter',
            description: 'High-reasoning open model with free tier routing on OpenRouter.',
            contextLength: 65536,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: false, supportsStreaming: true, supportsTools: false },
            compatibility: evaluateModelCompatibility({ id: 'deepseek/deepseek-r1:free', provider: 'OpenRouter' }),
            pricing: classifyOpenRouterPricing({ prompt: 0, completion: 0 }, 'deepseek/deepseek-r1:free'),
            accountLimits: { source: 'UNKNOWN' },
            supportedParameters: ['temperature'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'anthropic/claude-3.5-sonnet',
            displayName: 'Anthropic: Claude 3.5 Sonnet',
            provider: 'OpenRouter',
            description: 'State of the art reasoning and creative coding intelligence.',
            contextLength: 200000,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'anthropic/claude-3.5-sonnet', provider: 'OpenRouter' }),
            pricing: classifyOpenRouterPricing({ prompt: '0.000003', completion: '0.000015' }, 'anthropic/claude-3.5-sonnet'),
            accountLimits: { source: 'UNKNOWN' },
            supportedParameters: ['tools', 'response_format'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
          {
            id: 'mistralai/mistral-large-2407',
            displayName: 'Mistral: Mistral Large',
            provider: 'OpenRouter',
            description: 'Flagship European LLM with 128k context and fluent multilingual capacity.',
            contextLength: 128000,
            capabilities: { supportsText: true, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
            compatibility: evaluateModelCompatibility({ id: 'mistralai/mistral-large-2407', provider: 'OpenRouter' }),
            pricing: classifyOpenRouterPricing({ prompt: '0.000002', completion: '0.000006' }, 'mistralai/mistral-large-2407'),
            accountLimits: { source: 'UNKNOWN' },
            supportedParameters: ['tools', 'response_format'],
            isAvailable: true,
            source: 'cached_catalog',
            fetchedAt: new Date().toISOString(),
          },
        ];

        return {
          success: true,
          provider: 'OpenRouter',
          models: fallbackOpenRouter,
          source: 'cached_catalog' as const,
          isStale: false,
          cacheStatus: 'miss' as const,
          message: 'Loaded verified baseline OpenRouter models (public catalog offline or throttled).',
        };
      }

      // 4. OpenAI Compatible / Custom endpoints with baseUrl
      if (effectiveBaseUrl && effectiveBaseUrl.trim().length > 0 && provider === 'OpenAI Compatible') {
        const cleanBase = effectiveBaseUrl.trim();
        const urlValidation = await validateCustomProviderUrl(cleanBase);
        if (!urlValidation.isValid) {
          return {
            success: false,
            provider,
            models: [],
            source: 'cached_catalog' as const,
            errorCategory: 'SSRF_BLOCKED',
            message: `Custom provider URL blocked by SSRF security validation: ${urlValidation.error}`,
          };
        }

        try {
          const targetUrl = `${cleanBase.replace(/\/+$/, '')}/models`;
          const customHeaders: Record<string, string> = {};
          if (effectiveKey && effectiveKey.trim().length > 0) {
            customHeaders.Authorization = `Bearer ${effectiveKey.trim()}`;
          }

          const ssrfRes = await safeSsrfFetch(targetUrl, {
            headers: customHeaders,
            timeoutMs: 12000,
          });

          if (ssrfRes.ok) {
            const bodyText = await ssrfRes.text();
            catalogCacheManager.checkPayloadSize(Buffer.byteLength(bodyText, 'utf-8'), provider);
            const json = JSON.parse(bodyText);
            const rawModels = catalogCacheManager.validateAndSanitizeCatalogPayload(json, provider);

            const mapped: DiscoveredModel[] = rawModels.map((m: any) => {
              const exactId = String(m.id || m.name || '');
              const compat = evaluateModelCompatibility({ id: exactId, provider });
              return {
                id: exactId,
                displayName: m.name || exactId,
                provider: provider as SupportedProvider,
                description: m.description ? String(m.description).slice(0, 300) : undefined,
                capabilities: {
                  supportsText: compat.isTextGenerationCapable,
                  supportsImageGeneration: compat.isImageGenerationCapable,
                  supportsStructuredJson: compat.supportsStructuredJson,
                  supportsStreaming: compat.supportsStreaming,
                  supportsTools: compat.supportsTools,
                },
                compatibility: compat,
                accountLimits: { source: 'UNKNOWN' },
                isAvailable: true,
                source: 'live_api' as const,
                fetchedAt: new Date().toISOString(),
              };
            });

            if (mapped.length > 0) {
              catalogCacheManager.recordSuccess(cooldownKey);
              catalogCacheManager.set(cacheKey, mapped, {
                provider,
                connectionId: conn?.id,
                baseUrl: effectiveBaseUrl,
                apiKey: effectiveKey,
              });
              if (conn) {
                conn.discoveredModels = mapped;
                conn.catalogStatus = 'loaded';
                conn.catalogFetchedAt = new Date().toISOString();
                this.saveConnections();
              }
              return {
                success: true,
                provider,
                models: mapped,
                source: 'live_api' as const,
                isStale: false,
                cacheStatus: 'refreshed' as const,
                message: `Discovered ${mapped.length} models from custom endpoint.`,
              };
            }
          } else {
            const errBody = await ssrfRes.text().catch(() => '');
            const sanitized = sanitizeError(errBody || `HTTP ${ssrfRes.status}`);
            catalogCacheManager.recordFailure(cooldownKey, {
              category: ssrfRes.status === 401 || ssrfRes.status === 403 ? 'INVALID_CREDENTIALS' : 'NETWORK_ERROR',
              message: sanitized,
              status: ssrfRes.status,
            });
          }
        } catch (e: any) {
          const sanitized = sanitizeError(e);
          catalogCacheManager.recordFailure(cooldownKey, {
            category: e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
            message: sanitized,
          });
        }
      }

      // Generic fallback for any other provider
      const meta = PROVIDER_REGISTRY[provider] || PROVIDER_REGISTRY['OpenAI Compatible'];
      const genericModels: DiscoveredModel[] = meta.recommendedModels.map((m) => {
        const compat = evaluateModelCompatibility({ id: m, provider });
        return {
          id: m,
          displayName: m,
          provider,
          capabilities: { supportsText: compat.isTextGenerationCapable, supportsImageGeneration: false, supportsStructuredJson: true, supportsStreaming: true, supportsTools: true },
          compatibility: compat,
          accountLimits: { source: 'UNKNOWN' },
          isAvailable: true,
          source: 'cached_catalog' as const,
          fetchedAt: new Date().toISOString(),
        };
      });

      return {
        success: true,
        provider,
        models: genericModels,
        source: 'cached_catalog' as const,
        isStale: false,
        cacheStatus: 'miss' as const,
        message: `Showing standard models for ${provider}.`,
      };
    });
  }

  // Refresh models for a specific connection and persist state
  public async refreshModelsForConnection(connectionId: string): Promise<{
    success: boolean;
    provider: SupportedProvider;
    models: DiscoveredModel[];
    source: 'live_api' | 'cached_catalog';
    message?: string;
    catalogStatus: 'loaded' | 'refresh_required' | 'failed';
    catalogFetchedAt?: string;
    isStale?: boolean;
    cooldownRemainingSec?: number;
  }> {
    const conn = this.connections.find((c) => c.id === connectionId);
    if (!conn) {
      throw new Error(`Connection "${connectionId}" not found.`);
    }

    const result = await this.fetchAvailableModels({
      connectionId: conn.id,
      provider: conn.provider,
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl,
      forceRefresh: true,
    });

    const isLive = result.source === 'live_api' && result.success;
    conn.catalogStatus = isLive ? 'loaded' : conn.discoveredModels && conn.discoveredModels.length > 0 ? 'refresh_required' : 'failed';
    if (isLive) {
      conn.catalogFetchedAt = new Date().toISOString();
      conn.discoveredModels = result.models;
    }
    this.saveConnections();

    return {
      ...result,
      catalogStatus: conn.catalogStatus,
      catalogFetchedAt: conn.catalogFetchedAt,
      isStale: result.isStale,
      cooldownRemainingSec: result.cooldownRemainingSec,
    };
  }

  // Support single-model lookup when needed
  public async fetchSingleModelInfo(
    provider: SupportedProvider,
    modelId: string,
    apiKey?: string,
    connectionId?: string
  ): Promise<{ success: boolean; model?: DiscoveredModel; message?: string }> {
    const cleanModelId = (modelId || '').trim();
    if (!cleanModelId) {
      return { success: false, message: 'Model ID is required.' };
    }

    const conn = connectionId ? this.connections.find((c) => c.id === connectionId) : undefined;
    const effectiveKey = apiKey || (conn ? this.resolveEffectiveApiKey(conn) : undefined);

    // Check in connection's saved discoveredModels first
    if (conn?.discoveredModels && conn.discoveredModels.length > 0) {
      const foundInConn = conn.discoveredModels.find((m) => m.id === cleanModelId);
      if (foundInConn) {
        return { success: true, model: foundInConn };
      }
    }

    // Check in discovered cache next
    const cachedList = this.cachedDiscoveredModels.get(provider);
    if (cachedList) {
      const found = cachedList.find((m) => m.id === cleanModelId);
      if (found) {
        return { success: true, model: found };
      }
    }

    // If OpenRouter, try official single model endpoint
    if (provider === 'OpenRouter') {
      try {
        const headers: Record<string, string> = {
          'HTTP-Referer': 'https://illumatrix.internal',
          'X-Title': 'ILLUMATRIX Content Workspace',
        };
        if (effectiveKey) {
          headers.Authorization = `Bearer ${effectiveKey.trim()}`;
        }
        const res = await fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(cleanModelId)}`, {
          headers,
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const json: any = await res.json();
          const m = json.data || json;
          if (m && m.id) {
            const exactId = String(m.id);
            const paramsList: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
            const compat = evaluateModelCompatibility({
              id: exactId,
              provider: 'OpenRouter',
              displayName: m.name,
              description: m.description,
            });
            const classifiedPricing = classifyOpenRouterPricing(m.pricing, exactId);

            const modelInfo: DiscoveredModel = {
              id: exactId,
              displayName: m.name || exactId,
              provider: 'OpenRouter',
              description: m.description ? String(m.description).slice(0, 300) : undefined,
              contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
              capabilities: {
                supportsText: compat.isTextGenerationCapable,
                supportsImageGeneration: compat.isImageGenerationCapable,
                supportsStructuredJson: compat.supportsStructuredJson || paramsList.includes('response_format'),
                supportsStreaming: compat.supportsStreaming,
                supportsTools: compat.supportsTools || paramsList.includes('tools'),
              },
              compatibility: compat,
              pricing: classifiedPricing,
              accountLimits: {
                source: 'UNKNOWN',
                rawDetails: 'OpenRouter accounts use deposit credits',
              },
              supportedParameters: paramsList,
              isAvailable: true,
              source: 'live_api',
            };
            return { success: true, model: modelInfo };
          }
        }
      } catch (e) {
        console.warn('Single OpenRouter model lookup error:', sanitizeError(e));
      }
    }

    // Fall back to general catalog fetch (uses cached catalog or live discovery)
    const catalog = await this.fetchAvailableModels({ connectionId, provider, apiKey: effectiveKey });
    const match = catalog.models.find((m) => m.id === cleanModelId);
    if (match) {
      return { success: true, model: match };
    }

    return {
      success: false,
      message: `Model "${cleanModelId}" not found in ${provider} catalog.`,
    };
  }

  // Task 3: Real Connection Testing with error classification
  public async testConnection(
    id: string,
    options?: { allowBillableTest?: boolean; customResolver?: DnsResolver }
  ): Promise<ConnectionTestResult> {
    const conn = this.connections.find((c) => c.id === id);
    const nowIso = new Date().toISOString();

    if (!conn) {
      return {
        success: false,
        status: 'unconfigured',
        errorCategory: 'CONNECTION_NOT_FOUND',
        error: `Connection "${id}" not found.`,
        testedAt: nowIso,
      };
    }

    // Provider specific configuration checks
    if (conn.provider === 'Cloudflare Workers AI' && (!conn.accountId || conn.accountId.trim().length === 0)) {
      conn.status = 'degraded';
      conn.lastTestStatus = 'failed';
      conn.lastTestError = 'Cloudflare Account ID is required.';
      conn.lastTestedAt = nowIso;
      this.saveConnections();
      return {
        success: false,
        status: 'degraded',
        errorCategory: 'CONFIG_MISSING',
        error: 'Cloudflare Account ID is required. Find it in your Cloudflare dashboard URL or Workers AI settings.',
        testedAt: nowIso,
      };
    }

    const effectiveKey = this.resolveEffectiveApiKey(conn);
    const isKeyRequired = conn.provider !== 'Ollama';

    if (isKeyRequired && (!effectiveKey || effectiveKey.trim().length === 0)) {
      conn.status = 'unconfigured';
      conn.lastTestStatus = 'failed';
      conn.lastTestError = 'No API key configured for this connection. Configure an API key or provide it via environment variable.';
      conn.lastTestedAt = nowIso;
      this.saveConnections();
      return {
        success: false,
        status: 'unconfigured',
        errorCategory: 'CONFIG_MISSING',
        error: 'No API key configured for this connection. Configure an API key or provide it via environment variable.',
        testedAt: nowIso,
      };
    }

    const start = performance.now();
    const pricing = evaluateConnectionPricing(conn, conn.modelId);
    const isPaid = pricing.pricingTier === 'paid' || (!pricing.isZeroPriced && pricing.pricingTier !== 'free');

    // 1. Google GenAI native test
    if (conn.provider === 'Google GenAI') {
      try {
        // If model is paid (e.g. gemini-4-argon or image) and billable test is NOT explicitly authorized,
        // use the non-generative models API check to avoid billable generative token charges.
        if (isPaid && options?.allowBillableTest !== true) {
          const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${effectiveKey.trim()}`, {
            signal: AbortSignal.timeout(15000),
          });
          const listElapsed = Math.round(performance.now() - start);
          if (listRes.ok) {
            conn.status = 'online';
            conn.modelStatus = 'verified';
            conn.lastTestStatus = 'success';
            conn.lastTestError = undefined;
            conn.reportedLatencyMs = listElapsed;
            conn.lastTestedAt = nowIso;
            conn.lastChecked = new Date().toLocaleTimeString();
            if (!conn.accountLimits || conn.accountLimits.source === 'UNKNOWN') {
              conn.accountLimits = USER_SUPPLIED_LIMITS[conn.modelId] || {
                source: 'UNKNOWN',
                rawDetails: 'Google account quotas vary by GCP project and tier',
              };
            }
            this.saveConnections();
            return {
              success: true,
              status: 'online',
              errorCategory: 'SUCCESS',
              latencyMs: listElapsed,
              model: conn.modelId,
              testedAt: nowIso,
              accountLimits: conn.accountLimits,
              pricing: conn.pricing,
            };
          } else {
            const errBody = await listRes.text().catch(() => '');
            const sanitized = sanitizeError(errBody || `HTTP ${listRes.status}`);
            const isAuth = listRes.status === 400 || listRes.status === 403 || sanitized.includes('API key not valid');
            conn.status = 'degraded';
            conn.lastTestStatus = 'failed';
            conn.lastTestError = sanitized;
            conn.lastTestedAt = nowIso;
            this.saveConnections();
            return {
              success: false,
              status: 'degraded',
              errorCategory: isAuth ? 'AUTH_FAILED' : 'NETWORK_ERROR',
              error: sanitized,
              latencyMs: listElapsed,
              testedAt: nowIso,
            };
          }
        }

        const client = new GoogleGenAI({
          apiKey: effectiveKey,
          httpOptions: { timeout: 30000, headers: { 'User-Agent': 'aistudio-build' } },
        });

        const res = await client.models.generateContent({
          model: conn.modelId,
          contents: 'Respond with the single word: OK',
        });

        const elapsed = Math.round(performance.now() - start);
        if (res.text) {
          conn.status = 'online';
          conn.modelStatus = 'verified';
          conn.lastTestStatus = 'success';
          conn.lastTestError = undefined;
          conn.reportedLatencyMs = elapsed;
          conn.lastTestedAt = nowIso;
          conn.lastChecked = new Date().toLocaleTimeString();

          // Assign verified or user-supplied limits
          if (!conn.accountLimits || conn.accountLimits.source === 'UNKNOWN') {
            conn.accountLimits = USER_SUPPLIED_LIMITS[conn.modelId] || {
              source: 'UNKNOWN',
              rawDetails: 'Google account quotas vary by GCP project and tier',
            };
          }

          this.saveConnections();
          return {
            success: true,
            status: 'online',
            errorCategory: 'SUCCESS',
            latencyMs: elapsed,
            model: conn.modelId,
            testedAt: nowIso,
            accountLimits: conn.accountLimits,
          };
        }

        conn.status = 'degraded';
        conn.modelStatus = 'untested';
        conn.lastTestStatus = 'failed';
        conn.lastTestError = 'Empty response returned from Google GenAI.';
        this.saveConnections();
        return {
          success: false,
          status: 'degraded',
          errorCategory: 'UNSUPPORTED_PROTOCOL',
          error: 'Empty response returned from Google GenAI.',
          testedAt: nowIso,
        };
      } catch (err: any) {
        const elapsed = Math.round(performance.now() - start);
        const sanitized = sanitizeError(err);
        const status = err?.status || err?.code;
        const msg = (err?.message || '').toLowerCase();

        let category: ConnectionTestResult['errorCategory'] = 'NETWORK_ERROR';
        if (status === 401 || msg.includes('api key not valid') || msg.includes('unauthenticated')) {
          category = 'AUTH_FAILED';
        } else if (status === 403 || msg.includes('permission_denied') || msg.includes('forbidden')) {
          category = 'PERMISSION_DENIED';
        } else if (status === 404 || msg.includes('not found') || msg.includes('model not found')) {
          category = 'MODEL_NOT_FOUND';
        } else if (status === 429 || msg.includes('rate limit')) {
          category = 'RATE_LIMITED';
        } else if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          category = 'QUOTA_EXHAUSTED';
        } else if (
          err.name === 'TimeoutError' ||
          msg.includes('timeout') ||
          status === 504 ||
          msg.includes('deadline_exceeded') ||
          msg.includes('deadline expired') ||
          msg.includes('deadline is too short')
        ) {
          category = 'TIMEOUT';
        }

        if (category === 'RATE_LIMITED') {
          conn.modelStatus = 'rate_limited';
        } else if (category === 'MODEL_NOT_FOUND') {
          conn.modelStatus = 'unavailable';
          conn.status = 'degraded';
        } else {
          conn.status = 'degraded';
          conn.modelStatus = 'untested';
        }

        conn.lastTestStatus = 'failed';
        conn.lastTestError = sanitized;
        conn.lastTestedAt = nowIso;
        this.saveConnections();

        return {
          success: false,
          status: 'degraded',
          errorCategory: category,
          error: sanitized,
          latencyMs: elapsed,
          testedAt: nowIso,
        };
      }
    }

    // 2. Ollama Native Reachability & Model Verification Test
    if (conn.provider === 'Ollama') {
      const endpoint = (conn.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');
      try {
        const tagsRes = await fetch(`${endpoint}/api/tags`, {
          signal: AbortSignal.timeout(6000),
        });

        if (!tagsRes.ok) {
          const elapsed = Math.round(performance.now() - start);
          conn.status = 'degraded';
          conn.lastTestStatus = 'failed';
          conn.lastTestError = `Ollama server returned HTTP ${tagsRes.status}`;
          conn.lastTestedAt = nowIso;
          this.saveConnections();
          return {
            success: false,
            status: 'degraded',
            errorCategory: 'NETWORK_ERROR',
            error: `Ollama endpoint returned HTTP ${tagsRes.status}. Ensure Ollama is running and accessible at ${endpoint}.`,
            latencyMs: elapsed,
            testedAt: nowIso,
          };
        }

        const tagsData: any = await tagsRes.json().catch(() => ({}));
        const models: string[] = (tagsData.models || []).map((m: any) => String(m.name || m.model || ''));
        const modelMatch = models.some(
          (m) => m === conn.modelId || m.startsWith(conn.modelId + ':') || conn.modelId.startsWith(m)
        );

        if (!modelMatch && models.length > 0) {
          const elapsed = Math.round(performance.now() - start);
          const errorMsg = `Ollama server is reachable, but model "${conn.modelId}" is not installed. Installed models: ${models.slice(0, 5).join(', ')}. Run: "ollama pull ${conn.modelId}" to install it.`;
          conn.status = 'degraded';
          conn.lastTestStatus = 'failed';
          conn.lastTestError = errorMsg;
          conn.lastTestedAt = nowIso;
          this.saveConnections();
          return {
            success: false,
            status: 'degraded',
            errorCategory: 'MODEL_NOT_FOUND',
            error: errorMsg,
            latencyMs: elapsed,
            testedAt: nowIso,
          };
        }

        const chatRes = await fetch(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: conn.modelId,
            messages: [{ role: 'user', content: 'Say OK' }],
            max_tokens: 5,
          }),
          signal: AbortSignal.timeout(12000),
        });

        const elapsed = Math.round(performance.now() - start);
        if (chatRes.ok) {
          conn.status = 'online';
          conn.lastTestStatus = 'success';
          conn.lastTestError = undefined;
          conn.reportedLatencyMs = elapsed;
          conn.lastTestedAt = nowIso;
          conn.lastChecked = new Date().toLocaleTimeString();
          this.saveConnections();
          return {
            success: true,
            status: 'online',
            errorCategory: 'SUCCESS',
            latencyMs: elapsed,
            model: conn.modelId,
            testedAt: nowIso,
          };
        } else {
          const errBody = await chatRes.text().catch(() => '');
          const sanitized = sanitizeError(errBody || `HTTP ${chatRes.status}`);
          conn.status = 'degraded';
          conn.lastTestStatus = 'failed';
          conn.lastTestError = sanitized;
          conn.lastTestedAt = nowIso;
          this.saveConnections();
          return {
            success: false,
            status: 'degraded',
            errorCategory: chatRes.status === 404 ? 'MODEL_NOT_FOUND' : 'NETWORK_ERROR',
            error: `Ollama chat test failed: ${sanitized}`,
            latencyMs: elapsed,
            testedAt: nowIso,
          };
        }
      } catch (ollamaErr: any) {
        const elapsed = Math.round(performance.now() - start);
        const isTimeout = ollamaErr.name === 'TimeoutError' || String(ollamaErr.message).includes('timeout');
        const errMessage = isTimeout
          ? `Ollama connection timed out at ${endpoint}. Check server workload.`
          : `Cannot connect to Ollama at ${endpoint}. Ensure the Ollama daemon is running and reachable.`;

        conn.status = 'degraded';
        conn.lastTestStatus = 'failed';
        conn.lastTestError = errMessage;
        conn.lastTestedAt = nowIso;
        this.saveConnections();

        return {
          success: false,
          status: 'degraded',
          errorCategory: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          error: errMessage,
          latencyMs: elapsed,
          testedAt: nowIso,
        };
      }
    }

    // 3. OpenAI-Compatible & REST Providers (Groq, OpenRouter, etc.)
    try {
      const endpoint = this.getProviderEndpoint(conn);
      const isCustomEndpoint =
        conn.provider === 'OpenAI Compatible' ||
        conn.provider === 'External Provider' ||
        Boolean(conn.baseUrl && conn.baseUrl !== PROVIDER_REGISTRY[conn.provider]?.defaultBaseUrl);

      if (isCustomEndpoint) {
        const urlValidation = await validateCustomProviderUrl(endpoint, options?.customResolver);
        if (!urlValidation.isValid) {
          const ssrfMsg = urlValidation.error || 'Destination URL failed SSRF security validation.';
          conn.status = 'degraded';
          conn.lastTestStatus = 'failed';
          conn.lastTestError = ssrfMsg;
          conn.lastTestedAt = nowIso;
          this.saveConnections();
          return {
            success: false,
            status: 'degraded',
            errorCategory: urlValidation.errorCategory === 'UNSUPPORTED_PROTOCOL' ? 'UNSUPPORTED_PROTOCOL' : 'SSRF_BLOCKED',
            error: ssrfMsg,
            testedAt: nowIso,
          };
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveKey}`,
      };

      if (conn.provider === 'OpenRouter') {
        headers['HTTP-Referer'] = 'https://illumatrix.internal';
        headers['X-Title'] = 'ILLUMATRIX Content Workspace';
      }

      // Safe connection testing for OpenRouter: if paid and billable test is NOT explicitly authorized,
      // run a non-generative key/account verification check against OpenRouter's official auth endpoint
      if (conn.provider === 'OpenRouter' && isPaid && options?.allowBillableTest !== true) {
        const authRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
          headers: {
            Authorization: `Bearer ${effectiveKey}`,
            'HTTP-Referer': 'https://illumatrix.internal',
            'X-Title': 'ILLUMATRIX Content Workspace',
          },
          signal: AbortSignal.timeout(15000),
        });
        const elapsed = Math.round(performance.now() - start);
        if (authRes.ok) {
          conn.status = 'online';
          conn.modelStatus = 'verified';
          conn.lastTestStatus = 'success';
          conn.lastTestError = undefined;
          conn.reportedLatencyMs = elapsed;
          conn.lastTestedAt = nowIso;
          conn.lastChecked = new Date().toLocaleTimeString();
          this.saveConnections();
          return {
            success: true,
            status: 'online',
            errorCategory: 'SUCCESS',
            latencyMs: elapsed,
            model: conn.modelId,
            testedAt: nowIso,
            accountLimits: conn.accountLimits,
            pricing: conn.pricing,
          };
        } else {
          const errBody = await authRes.text().catch(() => '');
          const sanitized = sanitizeError(errBody || `HTTP ${authRes.status}`);
          const isAuth = authRes.status === 401 || sanitized.includes('invalid_api_key');
          conn.status = 'degraded';
          conn.lastTestStatus = 'failed';
          conn.lastTestError = sanitized;
          conn.lastTestedAt = nowIso;
          this.saveConnections();
          return {
            success: false,
            status: 'degraded',
            errorCategory: isAuth ? 'AUTH_FAILED' : 'NETWORK_ERROR',
            error: sanitized,
            latencyMs: elapsed,
            testedAt: nowIso,
          };
        }
      }

      // Safe connection testing for Groq: if paid model and billable test is not authorized,
      // run a non-generative models list check
      if (conn.provider === 'Groq' && isPaid && options?.allowBillableTest !== true) {
        const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        const elapsed = Math.round(performance.now() - start);
        if (modelsRes.ok) {
          conn.status = 'online';
          conn.modelStatus = 'verified';
          conn.lastTestStatus = 'success';
          conn.lastTestError = undefined;
          conn.reportedLatencyMs = elapsed;
          conn.lastTestedAt = nowIso;
          conn.lastChecked = new Date().toLocaleTimeString();
          this.saveConnections();
          return {
            success: true,
            status: 'online',
            errorCategory: 'SUCCESS',
            latencyMs: elapsed,
            model: conn.modelId,
            testedAt: nowIso,
            accountLimits: conn.accountLimits,
            pricing: conn.pricing,
          };
        }
      }

      // If connection/model is paid and no non-generative check exists, fail closed unless allowBillableTest is true
      if (isPaid && options?.allowBillableTest !== true) {
        return {
          success: false,
          status: 'untested',
          errorCategory: 'BILLABLE_TEST_REQUIRED',
          error: `Testing connection "${conn.name}" with paid model "${conn.modelId}" requires billable generative inference. Explicit authorization (allowBillableTest: true) is required.`,
          testedAt: nowIso,
        };
      }

      const fetchFn = isCustomEndpoint
        ? (url: string, init: any) => safeSsrfFetch(url, init, options?.customResolver)
        : fetch;

      const res = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: conn.modelId,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(15000),
      });

      const elapsed = Math.round(performance.now() - start);

      // Parse live response headers for rate limits
      const liveLimits: AccountLimitSnapshot | undefined = (() => {
        const limitReq = res.headers.get('x-ratelimit-limit-requests') || res.headers.get('x-ratelimit-limit');
        const remReq = res.headers.get('x-ratelimit-remaining-requests') || res.headers.get('x-ratelimit-remaining');
        const limitTokens = res.headers.get('x-ratelimit-limit-tokens');
        const remTokens = res.headers.get('x-ratelimit-remaining-tokens');
        const resetReq = res.headers.get('x-ratelimit-reset-requests');
        if (limitReq || remReq || limitTokens || remTokens) {
          return {
            source: 'LIVE PROVIDER RESPONSE',
            asOfDate: new Date().toISOString(),
            rpm: remReq ? `${remReq} remaining (limit: ${limitReq || '?'})` : limitReq || undefined,
            tpm: remTokens ? `${remTokens} remaining (limit: ${limitTokens || '?'})` : limitTokens || undefined,
            rawDetails: `Captured from live ${conn.provider} response headers${resetReq ? ` (resets in ${resetReq})` : ''}`,
          };
        }
        return undefined;
      })();

      if (liveLimits) {
        conn.accountLimits = liveLimits;
      } else if (!conn.accountLimits || conn.accountLimits.source === 'UNKNOWN') {
        conn.accountLimits = USER_SUPPLIED_LIMITS[conn.modelId] || {
          source: 'UNKNOWN',
          rawDetails: `${conn.provider} limits unverified for this account/model`,
        };
      }

      if (res.ok) {
        conn.status = 'online';
        conn.modelStatus = 'verified';
        conn.lastTestStatus = 'success';
        conn.lastTestError = undefined;
        conn.reportedLatencyMs = elapsed;
        conn.lastTestedAt = nowIso;
        conn.lastChecked = new Date().toLocaleTimeString();
        this.saveConnections();
        return {
          success: true,
          status: 'online',
          errorCategory: 'SUCCESS',
          latencyMs: elapsed,
          model: conn.modelId,
          testedAt: nowIso,
          accountLimits: conn.accountLimits,
          pricing: conn.pricing,
        };
      } else {
        const errBody = await res.text().catch(() => '');
        const sanitized = sanitizeError(errBody || `HTTP ${res.status}`);
        const lower = sanitized.toLowerCase();

        let category: ConnectionTestResult['errorCategory'] = 'NETWORK_ERROR';
        let userActionMsg = sanitized;

        if (res.status === 401 || lower.includes('invalid_api_key') || lower.includes('unauthorized')) {
          category = 'AUTH_FAILED';
          userActionMsg = `Authentication failed (HTTP 401). Verify that your ${conn.provider} API key is valid.`;
        } else if (res.status === 402 || lower.includes('insufficient_credits') || lower.includes('payment_required') || lower.includes('insufficient_balance')) {
          category = 'INSUFFICIENT_CREDITS';
          userActionMsg = `Payment Required (HTTP 402). Your ${conn.provider} account lacks active credits or billing entitlement for model "${conn.modelId}". Add credits in your provider console.`;
        } else if (res.status === 403 || lower.includes('permission_denied') || lower.includes('forbidden')) {
          category = 'PERMISSION_DENIED';
          userActionMsg = `Permission denied (HTTP 403). Ensure your account has access to model "${conn.modelId}".`;
        } else if (res.status === 404 || lower.includes('model_not_found') || lower.includes('does not exist') || lower.includes('decommissioned')) {
          category = 'MODEL_NOT_FOUND';
          userActionMsg = `Model "${conn.modelId}" was not found by ${conn.provider} (HTTP 404). Check the model ID or use Model Discovery to select an active model.`;
        } else if (res.status === 400 || lower.includes('bad_request') || lower.includes('unsupported_parameter')) {
          category = 'INVALID_PAYLOAD';
          userActionMsg = `Bad Request (HTTP 400) from ${conn.provider}: ${sanitized}`;
        } else if (res.status === 429 || lower.includes('rate limit')) {
          category = 'RATE_LIMITED';
          userActionMsg = `Rate limit exceeded (HTTP 429) for ${conn.provider}. Try again shortly.`;
        } else if (lower.includes('quota') || lower.includes('insufficient_quota')) {
          category = 'QUOTA_EXHAUSTED';
          userActionMsg = `Quota exhausted for this ${conn.provider} account or key. Check your provider billing/credits.`;
        }

        // A model cooldown/rate limit must not disconnect the provider connection
        if (category === 'RATE_LIMITED') {
          conn.modelStatus = 'rate_limited';
        } else if (category === 'MODEL_NOT_FOUND') {
          conn.modelStatus = 'unavailable';
          conn.status = 'degraded';
        } else {
          conn.status = 'degraded';
          conn.modelStatus = 'untested';
        }

        conn.lastTestStatus = 'failed';
        conn.lastTestError = userActionMsg;
        conn.lastTestedAt = nowIso;
        this.saveConnections();

        return {
          success: false,
          status: 'degraded',
          errorCategory: category,
          error: userActionMsg,
          latencyMs: elapsed,
          testedAt: nowIso,
          accountLimits: conn.accountLimits,
        };
      }
    } catch (netErr: any) {
      const elapsed = Math.round(performance.now() - start);
      const isTimeout = netErr.name === 'TimeoutError' || String(netErr.message).includes('timeout');
      const isSsrf = netErr.category === 'SSRF_BLOCKED' || netErr.errorCategory === 'SSRF_BLOCKED';
      const sanitized = sanitizeError(netErr);

      const errorCategory: ConnectionTestResult['errorCategory'] = isSsrf
        ? 'SSRF_BLOCKED'
        : isTimeout
        ? 'TIMEOUT'
        : 'NETWORK_ERROR';
      const errorMsg = isSsrf
        ? (netErr.message || 'Destination URL failed SSRF security validation.')
        : isTimeout
        ? `Request to ${conn.provider} timed out after 15 seconds.`
        : `Network connection to ${conn.provider} failed: ${sanitized}`;

      conn.status = 'degraded';
      conn.lastTestStatus = 'failed';
      conn.lastTestError = errorMsg;
      conn.lastTestedAt = nowIso;
      this.saveConnections();

      return {
        success: false,
        status: 'degraded',
        errorCategory,
        error: errorMsg,
        latencyMs: elapsed,
        testedAt: nowIso,
      };
    }
  }

  // Resolve endpoint URL per provider
  public getProviderEndpoint(conn: ServerProviderConnection): string {
    if (conn.provider === 'Groq') {
      return (conn.baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'OpenRouter') {
      return (conn.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'Cerebras') {
      return (conn.baseUrl || 'https://api.cerebras.ai/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'Cloudflare Workers AI') {
      const acc = conn.accountId?.trim();
      if (!acc) throw new Error('Cloudflare Account ID is required');
      return `https://api.cloudflare.com/client/v4/accounts/${acc}/ai/v1/chat/completions`;
    }
    if (conn.provider === 'Hugging Face') {
      return (conn.baseUrl || 'https://router.huggingface.co/hf-inference/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'Mistral AI') {
      return (conn.baseUrl || 'https://api.mistral.ai/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'SambaNova') {
      return (conn.baseUrl || 'https://api.sambanova.ai/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    if (conn.provider === 'Ollama') {
      return (conn.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/v1/chat/completions';
    }
    if (conn.provider === 'OpenAI') {
      return (conn.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
    }
    return (conn.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  }

  public getEffectiveCredentials(id?: string): {
    id: string;
    name: string;
    provider: SupportedProvider;
    modelId: string;
    apiKey?: string;
    hasKey: boolean;
    quotaPool: string;
    isEnabled: boolean;
  } {
    if (id !== undefined && id !== null && id.trim().length > 0) {
      const explicitConn = this.connections.find((c) => c.id === id.trim());
      if (!explicitConn) {
        const err: any = new Error(`Connection "${id}" not found.`);
        err.category = 'CONNECTION_NOT_FOUND';
        err.status = 404;
        throw err;
      }
      const effectiveKey = this.resolveEffectiveApiKey(explicitConn);
      return {
        id: explicitConn.id,
        name: explicitConn.name,
        provider: explicitConn.provider,
        modelId: explicitConn.modelId,
        apiKey: effectiveKey || undefined,
        hasKey: Boolean(effectiveKey && effectiveKey.trim().length > 0) || explicitConn.provider === 'Ollama',
        quotaPool: explicitConn.quotaPool,
        isEnabled: explicitConn.isEnabled ?? true,
      };
    }

    const connId = this.getActiveConnectionId();
    const conn = this.connections.find((c) => c.id === connId) || this.connections[0];
    const effectiveKey = this.resolveEffectiveApiKey(conn);
    return {
      id: conn?.id || 'conn_gemini_primary',
      name: conn?.name || 'Default Runtime',
      provider: conn?.provider || 'Google GenAI',
      modelId: conn?.modelId || 'gemini-3.1-flash-lite',
      apiKey: effectiveKey || undefined,
      hasKey: Boolean(effectiveKey && effectiveKey.trim().length > 0) || conn?.provider === 'Ollama',
      quotaPool: conn?.quotaPool || 'GCP_PROJECT_DEFAULT_QUOTA',
      isEnabled: conn?.isEnabled ?? true,
    };
  }

  // Find failover connection adhering strictly to cost policy, tier isolation, and modality compatibility
  public findEligibleFailoverConnection(
    currentConn: ServerProviderConnection,
    costPolicy: CostPolicy,
    allowPaidExecution?: boolean,
    requiredModality: AIExecutionModality = 'text'
  ): ServerProviderConnection | undefined {
    return this.connections.find((c) => {
      if (!c.isEnabled || c.id === currentConn.id || c.quotaPool === currentConn.quotaPool || c.allowFailover !== true) {
        return false;
      }
      const hasCreds = Boolean(this.resolveEffectiveApiKey(c) || c.provider === 'Ollama');
      if (!hasCreds) return false;

      // Modality compatibility check
      if (requiredModality === 'image') {
        if (c.provider !== 'Google GenAI') return false;
      } else {
        const compat = evaluateModelCompatibility({ id: c.modelId, provider: c.provider });
        if (!compat.isTextGenerationCapable) return false;
      }

      // Evaluate candidate pricing via Cost Policy Engine
      const candidatePricing = evaluateConnectionPricing(c, c.modelId);
      const currentPricing = evaluateConnectionPricing(currentConn, currentConn.modelId);

      const decision = costPolicyEngine.evaluateFailoverCandidate(
        candidatePricing,
        currentPricing,
        costPolicy,
        allowPaidExecution,
        c.modelId,
        c.name
      );

      if (!decision.allowed) {
        return false;
      }

      return true;
    });
  }

  // Task 3.1: Shared AI Execution Orchestration across all providers
  public async executeAI(req: AIExecutionRequest): Promise<AIExecutionResult> {
    return aiExecutionEngine.execute(req);
  }

  // Central Request Dispatcher for all text operations across all providers (delegates to shared AI execution engine)
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
    return aiExecutionEngine.executeTextGeneration(params);
  }
}

export const providerManager = new ProviderManager();
