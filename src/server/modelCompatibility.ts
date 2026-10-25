/**
 * ILLUMATRIX Model Compatibility & Pricing Classification Engine
 * Evaluates model capabilities, modality boundaries, and pricing veracity.
 */

import type { SupportedProvider, ModelCapability, ModelPricing, AccountLimitSnapshot, DiscoveredModel } from '../types/hud';

export type ModelPrimaryModality =
  | 'text'
  | 'multimodal'
  | 'image'
  | 'audio'
  | 'embedding'
  | 'reranker'
  | 'moderation'
  | 'unknown';

export interface ModelCompatibility {
  primaryModality: ModelPrimaryModality;
  isTextGenerationCapable: boolean; // Suitable for script / prompt generation workflow
  isImageGenerationCapable: boolean; // Suitable for thumbnail preview workflow
  supportsStructuredJson: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  compatibilityStatus: 'compatible' | 'incompatible' | 'unknown';
  reason?: string;
}

export interface ClassifiedPricing extends ModelPricing {
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
  isZeroPriced: boolean;
  pricingTier: 'free' | 'paid' | 'unknown';
  pricingNote?: string;
}

/**
 * OpenRouter Pricing Classifier
 * Enforces strict verification of input and output pricing fields.
 * - Zero-priced ($0.00 / 1M) requires prompt == 0 AND completion == 0.
 * - Missing or ambiguous values are strictly classified as 'unknown'.
 * - Never infers free tier from model names alone.
 * - Does not promise unlimited usage or guaranteed availability.
 */
export function classifyOpenRouterPricing(
  pricing: any,
  modelId: string
): ClassifiedPricing {
  if (!pricing || typeof pricing !== 'object') {
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'Pricing metadata missing or unprovided by provider catalog',
    };
  }

  const promptRaw = pricing.prompt;
  const completionRaw = pricing.completion;

  if (promptRaw === undefined || promptRaw === null || completionRaw === undefined || completionRaw === null) {
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'Incomplete pricing metadata (prompt or completion missing)',
    };
  }

  const promptNum = typeof promptRaw === 'number' ? promptRaw : parseFloat(String(promptRaw));
  const completionNum = typeof completionRaw === 'number' ? completionRaw : parseFloat(String(completionRaw));

  if (isNaN(promptNum) || isNaN(completionNum) || promptNum < 0 || completionNum < 0) {
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'Ambiguous or unparseable pricing values',
    };
  }

  // Exact verification: both prompt and completion must be zero
  if (promptNum === 0 && completionNum === 0) {
    return {
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
      isZeroPriced: true,
      pricingTier: 'free',
      pricingNote: 'Verified zero-priced catalog route ($0.00/1M tokens, subject to provider load and availability)',
    };
  }

  // Paid model with verified positive pricing
  const promptPerMillion = Math.round(promptNum * 1_000_000 * 100) / 100;
  const completionPerMillion = Math.round(completionNum * 1_000_000 * 100) / 100;

  return {
    promptPricePerMillion: promptPerMillion,
    completionPricePerMillion: completionPerMillion,
    isZeroPriced: false,
    pricingTier: 'paid',
    pricingNote: `$${promptPerMillion.toFixed(2)} prompt / $${completionPerMillion.toFixed(2)} completion per 1M tokens`,
  };
}

/**
 * Model Compatibility Evaluator
 * Segregates general text generation models from embeddings, rerankers, audio, speech,
 * image, multimodal, and moderation models.
 * Unknown compatibility remains explicitly 'unknown' and excluded from incompatible workflows.
 */
export function evaluateModelCompatibility(model: {
  id: string;
  provider: SupportedProvider;
  displayName?: string;
  description?: string;
  architecture?: any;
  supportedParameters?: string[];
  supportedGenerationMethods?: string[];
}): ModelCompatibility {
  const idLower = model.id.toLowerCase();
  const descLower = (model.description || '').toLowerCase();
  const modalityLower = String(model.architecture?.modality || '').toLowerCase();
  const params = model.supportedParameters || [];

  // 1. Check for Embeddings
  if (
    idLower.includes('embedding') ||
    idLower.includes('bge-') ||
    idLower.includes('e5-') ||
    idLower.startsWith('text-embedding-') ||
    (model.supportedGenerationMethods &&
      model.supportedGenerationMethods.includes('embedContent') &&
      !model.supportedGenerationMethods.includes('generateContent'))
  ) {
    return {
      primaryModality: 'embedding',
      isTextGenerationCapable: false,
      isImageGenerationCapable: false,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsTools: false,
      compatibilityStatus: 'incompatible',
      reason: 'Embedding models output vector representations, not generative narrative text.',
    };
  }

  // 2. Check for Rerankers
  if (idLower.includes('rerank') || idLower.includes('bge-reranker') || descLower.includes('rerank')) {
    return {
      primaryModality: 'reranker',
      isTextGenerationCapable: false,
      isImageGenerationCapable: false,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsTools: false,
      compatibilityStatus: 'incompatible',
      reason: 'Reranker models score document pairs and do not support conversational generation.',
    };
  }

  // 3. Check for Content Safety / Moderation
  if (
    idLower.includes('guard') ||
    idLower.includes('moderation') ||
    idLower.includes('llama-guard') ||
    idLower.includes('aqa')
  ) {
    return {
      primaryModality: 'moderation',
      isTextGenerationCapable: false,
      isImageGenerationCapable: false,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsTools: false,
      compatibilityStatus: 'incompatible',
      reason: 'Safety/moderation classifier model not intended for narrative script synthesis.',
    };
  }

  // 4. Check for Audio / Speech models
  if (
    idLower.includes('whisper') ||
    idLower.includes('tts') ||
    idLower.includes('audio') ||
    modalityLower.includes('audio') ||
    modalityLower.startsWith('audio->') ||
    modalityLower.endsWith('->audio')
  ) {
    return {
      primaryModality: 'audio',
      isTextGenerationCapable: false,
      isImageGenerationCapable: false,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsTools: false,
      compatibilityStatus: 'incompatible',
      reason: 'Audio/speech model not compatible with text-based script generation.',
    };
  }

  // 5. Check for Image generation models
  if (
    idLower.includes('imagen') ||
    idLower.includes('image-preview') ||
    idLower.includes('image-only') ||
    idLower.includes('stable-diffusion') ||
    idLower.includes('flux') ||
    idLower.includes('midjourney') ||
    idLower.includes('dall-e') ||
    modalityLower.endsWith('->image') ||
    idLower.endsWith('-image') ||
    idLower.includes('flash-lite-image')
  ) {
    return {
      primaryModality: 'image',
      isTextGenerationCapable: false,
      isImageGenerationCapable: true,
      supportsStructuredJson: false,
      supportsStreaming: false,
      supportsTools: false,
      compatibilityStatus: 'incompatible',
      reason: 'Image generation model cannot output structured narrative JSON scripts.',
    };
  }

  // 6. Check for Multimodal / Vision models (text+image -> text)
  if (
    modalityLower.includes('text+image') ||
    modalityLower.includes('multimodal') ||
    idLower.includes('vision') ||
    idLower.includes('vl-') ||
    idLower.includes('omni')
  ) {
    return {
      primaryModality: 'multimodal',
      isTextGenerationCapable: true,
      isImageGenerationCapable: false,
      supportsStructuredJson: params.includes('response_format') || model.provider === 'Google GenAI',
      supportsStreaming: true,
      supportsTools: params.includes('tools') || model.provider === 'Google GenAI',
      compatibilityStatus: 'compatible',
      reason: 'Multimodal model capable of text narrative and visual understanding.',
    };
  }

  // 7. General text generation models
  const isLikelyTextLlm =
    modalityLower.includes('text->text') ||
    idLower.includes('gemini') ||
    idLower.includes('llama') ||
    idLower.includes('qwen') ||
    idLower.includes('mistral') ||
    idLower.includes('mixtral') ||
    idLower.includes('deepseek') ||
    idLower.includes('claude') ||
    idLower.includes('gpt') ||
    idLower.includes('gemma') ||
    idLower.includes('phi') ||
    idLower.includes('chat') ||
    idLower.includes('instruct') ||
    idLower.includes('llm') ||
    model.provider === 'Local Mock Engine' ||
    ((model.provider === 'External Provider' || model.provider === 'OpenAI Compatible') &&
      modalityLower !== 'unknown');

  if (isLikelyTextLlm) {
    return {
      primaryModality: 'text',
      isTextGenerationCapable: true,
      isImageGenerationCapable: false,
      supportsStructuredJson:
        params.includes('response_format') || model.provider === 'Google GenAI' || model.provider === 'Groq',
      supportsStreaming: true,
      supportsTools: params.includes('tools') || model.provider === 'Google GenAI' || model.provider === 'Groq',
      compatibilityStatus: 'compatible',
      reason: 'General text generation model compatible with ILLUMATRIX script engine.',
    };
  }

  // 8. Unknown compatibility fallback - strictly classified as unknown and excluded from incompatible workflows
  return {
    primaryModality: 'unknown',
    isTextGenerationCapable: false,
    isImageGenerationCapable: false,
    supportsStructuredJson: false,
    supportsStreaming: false,
    supportsTools: false,
    compatibilityStatus: 'unknown',
    reason: 'Model architecture/modality is unconfirmed. Excluded from script workflows until validated.',
  };
}

export const PRIMARY_PROVIDER_IDS: SupportedProvider[] = ['Google GenAI', 'Groq', 'OpenRouter'];

export function detectOpenRouterModality(rawModel: any): ModelPrimaryModality {
  const comp = evaluateModelCompatibility({
    id: rawModel?.id || '',
    provider: 'OpenRouter',
    displayName: rawModel?.name,
    description: rawModel?.description,
    architecture: rawModel?.architecture,
    supportedParameters: rawModel?.supported_parameters,
  });
  return comp.primaryModality;
}

/**
 * Evaluates the effective pricing tier and zero-cost eligibility for a connection and model.
 * Enforces:
 * - Ollama and Local Mock Engine are verified zero-cost ($0.00).
 * - Google GenAI: Standard developer models ('gemini-3.1-flash-lite', 'gemini-3.8-flash') are verified zero-cost Developer tier.
 *   Frontier/paid models ('gemini-4-argon', 'gemini-3.1-flash-lite-image') are classified as paid.
 * - Groq: Standard developer tier models ('llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3.8-27b', 'mixtral-8x7b-32768')
 *   are verified zero-cost developer quota.
 * - OpenRouter: Strictly uses catalog pricing via classifyOpenRouterPricing. If pricing is missing/ambiguous, classified as unknown.
 *   A model with ":free" in ID is NOT assumed free unless prompt == 0 AND completion == 0.
 * - OpenAI: Paid only (no official free API tier).
 * - Other providers: If connection.pricing is explicitly configured, respects it; otherwise classified as unknown (never assumed free).
 */
export function evaluateConnectionPricing(
  conn: {
    provider: SupportedProvider;
    modelId: string;
    pricing?: ModelPricing;
    discoveredModels?: DiscoveredModel[];
  },
  modelId?: string
): ClassifiedPricing {
  const effectiveModel = (modelId || conn.modelId || '').trim();
  const lowerModel = effectiveModel.toLowerCase();

  // 1. In-memory / local offline engines
  if (conn.provider === 'Local Mock Engine') {
    return {
      isZeroPriced: true,
      pricingTier: 'free',
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
      pricingNote: 'Local in-memory deterministic engine ($0.00)',
    };
  }

  if (conn.provider === 'Ollama') {
    return {
      isZeroPriced: true,
      pricingTier: 'free',
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
      pricingNote: 'Local offline Ollama instance ($0.00)',
    };
  }

  // 2. Google GenAI
  if (conn.provider === 'Google GenAI') {
    if (lowerModel === 'gemini-4-argon' || lowerModel.includes('argon')) {
      return {
        isZeroPriced: false,
        pricingTier: 'paid',
        pricingNote: 'Google GenAI frontier tier (paid billing required)',
      };
    }
    if (lowerModel.includes('image')) {
      return {
        isZeroPriced: false,
        pricingTier: 'paid',
        pricingNote: 'Google GenAI image generation (requires active billing/quota)',
      };
    }
    if (
      lowerModel === 'gemini-3.1-flash-lite' ||
      lowerModel === 'gemini-3.8-flash' ||
      lowerModel.startsWith('gemini-2.0') ||
      lowerModel.startsWith('gemini-1.5')
    ) {
      return {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        pricingNote: 'Google AI Studio standard free tier quota',
      };
    }
    if (conn.pricing) {
      return {
        isZeroPriced: Boolean(conn.pricing.isZeroPriced),
        pricingTier: conn.pricing.pricingTier || (conn.pricing.isZeroPriced ? 'free' : 'paid'),
        promptPricePerMillion: conn.pricing.promptPricePerMillion,
        completionPricePerMillion: conn.pricing.completionPricePerMillion,
        pricingNote: conn.pricing.pricingNote,
      };
    }
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'Google model pricing unverified',
    };
  }

  // 3. Groq Console Developer Tier
  if (conn.provider === 'Groq') {
    if (conn.pricing) {
      return {
        isZeroPriced: Boolean(conn.pricing.isZeroPriced),
        pricingTier: conn.pricing.pricingTier || (conn.pricing.isZeroPriced ? 'free' : 'paid'),
        promptPricePerMillion: conn.pricing.promptPricePerMillion,
        completionPricePerMillion: conn.pricing.completionPricePerMillion,
        pricingNote: conn.pricing.pricingNote,
      };
    }
    const standardGroqFree = [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'qwen/qwen3.8-27b',
      'mixtral-8x7b-32768',
    ];
    if (standardGroqFree.includes(effectiveModel)) {
      return {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        pricingNote: 'Groq developer console tier (free rate-limited quota)',
      };
    }
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'Groq model pricing unverified',
    };
  }

  // 4. OpenRouter Gateway
  if (conn.provider === 'OpenRouter') {
    // Check discovered model catalog first
    const matchedModel = conn.discoveredModels?.find((m) => m.id === effectiveModel);
    if (matchedModel?.pricing) {
      return classifyOpenRouterPricing(matchedModel.pricing, effectiveModel);
    }
    if (conn.pricing) {
      return classifyOpenRouterPricing(conn.pricing, effectiveModel);
    }
    return {
      isZeroPriced: false,
      pricingTier: 'unknown',
      pricingNote: 'OpenRouter pricing unprovided or catalog unloaded',
    };
  }

  // 5. OpenAI
  if (conn.provider === 'OpenAI') {
    return {
      isZeroPriced: false,
      pricingTier: 'paid',
      pricingNote: 'OpenAI API does not offer a free tier (billable inference)',
    };
  }

  // 6. Generic/Custom connections
  if (conn.pricing) {
    const isFree = conn.pricing.isZeroPriced === true && conn.pricing.pricingTier === 'free';
    return {
      isZeroPriced: isFree,
      pricingTier: conn.pricing.pricingTier || (isFree ? 'free' : 'unknown'),
      promptPricePerMillion: conn.pricing.promptPricePerMillion,
      completionPricePerMillion: conn.pricing.completionPricePerMillion,
      pricingNote: conn.pricing.pricingNote || (isFree ? 'Verified zero-cost' : 'Configured pricing'),
    };
  }

  return {
    isZeroPriced: false,
    pricingTier: 'unknown',
    pricingNote: 'No pricing metadata configured for this provider/model',
  };
}

