/**
 * ILLUMATRIX Cost Policy Engine (Task 4.1)
 *
 * Centralized, deterministic authority for cost policy decisions, pricing verification,
 * and billable inference authorization across all generation workflows and failover routes.
 *
 * Invariants:
 * 1. 'free_only': Strictly permits only positively verified zero-cost ($0.00/1M) models.
 *    Rejects paid, unknown, missing, contradictory, or malformed pricing (HTTP 402 PAYWALL_BLOCKED).
 *    Explicit authorization (allowPaidExecution: true) NEVER overrides 'free_only'.
 * 2. 'prefer_free': Prefers zero-cost models; requires explicit, validated boolean authorization
 *    (allowPaidExecution: true) for billable or unknown models. Fails closed without it (HTTP 402).
 * 3. 'manual': Allows explicitly selected provider/model; direct manual execution represents user
 *    consent unless explicit opt-out (allowPaidExecution: false) is supplied. Non-boolean values fail
 *    closed (HTTP 400). Failover from a free connection to a paid candidate strictly requires allowPaidExecution: true.
 * 4. Invalid policy strings or non-boolean allowPaidExecution fail closed with HTTP 400 INVALID_PAYLOAD.
 * 5. Redacts all sensitive credentials, keys, and tokens from error messages and logs.
 */

import type { CostPolicy, ModelPricing, SupportedProvider } from '../types/hud';
import type { ClassifiedPricing } from './modelCompatibility';
import { redactSecretString } from './credentialSecurity';
import type { ServerProviderConnection } from './providerManager';

export type CostPolicyDecisionReasonCode =
  | 'ALLOWED_ZERO_COST'
  | 'ALLOWED_PAID_AUTHORIZED'
  | 'ALLOWED_MANUAL'
  | 'BLOCKED_FREE_ONLY'
  | 'BLOCKED_PAID_UNAUTHORIZED'
  | 'BLOCKED_UNKNOWN_PRICING'
  | 'INVALID_POLICY'
  | 'INVALID_AUTHORIZATION';

export interface CostPolicyDecision {
  allowed: boolean;
  reasonCode: CostPolicyDecisionReasonCode;
  status: number; // 200, 400, or 402
  message: string;
  pricingTier: 'free' | 'paid' | 'unknown';
  isZeroPriced: boolean;
  promptPricePerMillion?: number;
  completionPricePerMillion?: number;
}

export interface CostPolicyEvaluationContext {
  costPolicy?: CostPolicy | string | null;
  allowPaidExecution?: boolean | null | any;
  pricing?: ClassifiedPricing | ModelPricing | null;
  modelId: string;
  provider?: SupportedProvider | string;
  connectionName?: string;
  connectionId?: string;
  isFailover?: boolean;
  sourceWasZeroCost?: boolean;
}

export interface PolicyValidationResult {
  valid: boolean;
  normalizedPolicy: CostPolicy;
  normalizedAllowPaid?: boolean;
  error?: {
    message: string;
    category: 'INVALID_PAYLOAD';
    status: 400;
  };
}

export class CostPolicyEngine {
  public static readonly ALLOWED_POLICIES: readonly CostPolicy[] = [
    'free_only',
    'prefer_free',
    'manual',
  ];

  /**
   * Validates and normalizes request payload cost policy and authorization parameters.
   * Fails closed with HTTP 400 INVALID_PAYLOAD on any malformed or unexpected input.
   */
  public validatePolicyInput(
    rawPolicy?: any,
    rawAllowPaid?: any
  ): PolicyValidationResult {
    // 1. Validate costPolicy
    let normalizedPolicy: CostPolicy = 'manual';

    if (rawPolicy !== undefined && rawPolicy !== null) {
      if (typeof rawPolicy !== 'string') {
        return {
          valid: false,
          normalizedPolicy: 'manual',
          error: {
            message:
              'Invalid cost policy parameter format. Allowed values are "free_only", "prefer_free", or "manual".',
            category: 'INVALID_PAYLOAD',
            status: 400,
          },
        };
      }

      const trimmed = rawPolicy.trim().toLowerCase();
      if (!CostPolicyEngine.ALLOWED_POLICIES.includes(trimmed as CostPolicy)) {
        return {
          valid: false,
          normalizedPolicy: 'manual',
          error: {
            message: `Invalid cost policy "${redactSecretString(rawPolicy)}". Allowed values are "free_only", "prefer_free", or "manual".`,
            category: 'INVALID_PAYLOAD',
            status: 400,
          },
        };
      }
      normalizedPolicy = trimmed as CostPolicy;
    }

    // 2. Validate allowPaidExecution
    let normalizedAllowPaid: boolean | undefined = undefined;

    if (rawAllowPaid !== undefined && rawAllowPaid !== null) {
      if (typeof rawAllowPaid !== 'boolean') {
        return {
          valid: false,
          normalizedPolicy,
          error: {
            message: 'Invalid allowPaidExecution parameter: must be a boolean.',
            category: 'INVALID_PAYLOAD',
            status: 400,
          },
        };
      }
      normalizedAllowPaid = rawAllowPaid;
    }

    return {
      valid: true,
      normalizedPolicy,
      normalizedAllowPaid,
    };
  }

  /**
   * Deterministically verifies whether a model pricing classification represents
   * an established, non-contradictory zero-cost tier ($0.00/1M tokens).
   */
  public isZeroCostModel(
    pricing?: ClassifiedPricing | ModelPricing | null
  ): boolean {
    if (!pricing || typeof pricing !== 'object') {
      return false;
    }

    // Must be positively flagged as zero priced and in free pricing tier
    if (pricing.isZeroPriced !== true || pricing.pricingTier !== 'free') {
      return false;
    }

    // Verify consistency: non-zero, negative, or NaN rates contradict zero-cost claims
    if (
      pricing.promptPricePerMillion !== undefined &&
      (typeof pricing.promptPricePerMillion !== 'number' ||
        isNaN(pricing.promptPricePerMillion) ||
        pricing.promptPricePerMillion !== 0)
    ) {
      return false;
    }

    if (
      pricing.completionPricePerMillion !== undefined &&
      (typeof pricing.completionPricePerMillion !== 'number' ||
        isNaN(pricing.completionPricePerMillion) ||
        pricing.completionPricePerMillion !== 0)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Authoritative deterministic decision engine evaluating execution admissibility.
   */
  public evaluate(context: CostPolicyEvaluationContext): CostPolicyDecision {
    const {
      costPolicy: rawPolicy,
      allowPaidExecution,
      pricing,
      modelId,
      provider = 'Unknown',
      connectionName = 'Provider Connection',
    } = context;

    // 1. Validate policy and authorization types
    const validation = this.validatePolicyInput(rawPolicy, allowPaidExecution);
    if (!validation.valid && validation.error) {
      return {
        allowed: false,
        reasonCode:
          validation.error.message.includes('allowPaidExecution')
            ? 'INVALID_AUTHORIZATION'
            : 'INVALID_POLICY',
        status: 400,
        message: validation.error.message,
        pricingTier: pricing?.pricingTier || 'unknown',
        isZeroPriced: Boolean(pricing?.isZeroPriced),
      };
    }

    const effectivePolicy = validation.normalizedPolicy;
    const isZeroCost = this.isZeroCostModel(pricing);
    const pricingTier: 'free' | 'paid' | 'unknown' = pricing?.pricingTier || 'unknown';
    const isPaid = pricingTier === 'paid';

    // 2. Policy: 'free_only'
    if (effectivePolicy === 'free_only') {
      // Invariant: Paid authorization must NEVER override 'free_only'
      if (!isZeroCost) {
        const rejectionDetail = isPaid
          ? 'Model requires billable paid inference.'
          : 'Pricing metadata is unknown, missing, or unverified.';
        const cleanMsg = redactSecretString(
          `Execution blocked by "free_only" cost policy for model "${modelId}" on connection "${connectionName}". ${rejectionDetail} Positively verified zero-cost metadata ($0.00/1M) is required.`
        );

        return {
          allowed: false,
          reasonCode: 'BLOCKED_FREE_ONLY',
          status: 402,
          message: cleanMsg,
          pricingTier,
          isZeroPriced: false,
          promptPricePerMillion: pricing?.promptPricePerMillion,
          completionPricePerMillion: pricing?.completionPricePerMillion,
        };
      }

      return {
        allowed: true,
        reasonCode: 'ALLOWED_ZERO_COST',
        status: 200,
        message: `Execution permitted under "free_only" policy (verified zero-cost model "${modelId}").`,
        pricingTier: 'free',
        isZeroPriced: true,
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
      };
    }

    // 3. Policy: 'prefer_free'
    if (effectivePolicy === 'prefer_free') {
      if (isZeroCost) {
        return {
          allowed: true,
          reasonCode: 'ALLOWED_ZERO_COST',
          status: 200,
          message: `Execution permitted under "prefer_free" policy (verified zero-cost model "${modelId}").`,
          pricingTier: 'free',
          isZeroPriced: true,
          promptPricePerMillion: 0,
          completionPricePerMillion: 0,
        };
      }

      // Model is billable or unknown: requires explicit boolean allowPaidExecution === true
      if (allowPaidExecution === true) {
        return {
          allowed: true,
          reasonCode: 'ALLOWED_PAID_AUTHORIZED',
          status: 200,
          message: `Execution permitted under "prefer_free" policy with explicit user authorization for billable/unverified model "${modelId}".`,
          pricingTier,
          isZeroPriced: false,
          promptPricePerMillion: pricing?.promptPricePerMillion,
          completionPricePerMillion: pricing?.completionPricePerMillion,
        };
      }

      const cleanMsg = redactSecretString(
        `Execution blocked by "prefer_free" cost policy for model "${modelId}" on connection "${connectionName}". Model is ${
          isPaid ? 'paid' : 'unknown/unverified pricing'
        } and explicit authorization (allowPaidExecution: true) was not provided.`
      );

      return {
        allowed: false,
        reasonCode: isPaid ? 'BLOCKED_PAID_UNAUTHORIZED' : 'BLOCKED_UNKNOWN_PRICING',
        status: 402,
        message: cleanMsg,
        pricingTier,
        isZeroPriced: false,
        promptPricePerMillion: pricing?.promptPricePerMillion,
        completionPricePerMillion: pricing?.completionPricePerMillion,
      };
    }

    // 4. Policy: 'manual'
    // Failover context: if the original connection was zero-cost, failover to a paid or unknown candidate
    // cannot happen without explicit authorization (allowPaidExecution: true)
    if (context.isFailover) {
      if (context.sourceWasZeroCost && !isZeroCost && allowPaidExecution !== true) {
        return {
          allowed: false,
          reasonCode: 'BLOCKED_PAID_UNAUTHORIZED',
          status: 402,
          message: `Failover to candidate model "${modelId}" blocked under "manual" policy: source connection was free and candidate is billable without explicit allowPaidExecution: true.`,
          pricingTier,
          isZeroPriced: false,
        };
      }
    }

    // Direct manual execution:
    // If the user explicitly provided allowPaidExecution: false, fail closed
    if (allowPaidExecution === false && !isZeroCost) {
      return {
        allowed: false,
        reasonCode: 'BLOCKED_PAID_UNAUTHORIZED',
        status: 402,
        message: `Execution blocked under "manual" policy: model "${modelId}" is billable and allowPaidExecution is explicitly false.`,
        pricingTier,
        isZeroPriced: false,
      };
    }

    if (isZeroCost) {
      return {
        allowed: true,
        reasonCode: 'ALLOWED_ZERO_COST',
        status: 200,
        message: `Execution permitted under "manual" policy (verified zero-cost model "${modelId}").`,
        pricingTier: 'free',
        isZeroPriced: true,
      };
    }

    if (allowPaidExecution === true) {
      return {
        allowed: true,
        reasonCode: 'ALLOWED_PAID_AUTHORIZED',
        status: 200,
        message: `Execution permitted under "manual" policy with explicit user authorization for model "${modelId}".`,
        pricingTier,
        isZeroPriced: false,
        promptPricePerMillion: pricing?.promptPricePerMillion,
        completionPricePerMillion: pricing?.completionPricePerMillion,
      };
    }

    // Manual direct execution of an explicitly selected connection/model without explicit allowPaidExecution flag
    return {
      allowed: true,
      reasonCode: 'ALLOWED_MANUAL',
      status: 200,
      message: `Execution permitted under "manual" policy: explicit user selection of connection "${connectionName}" (${modelId}).`,
      pricingTier,
      isZeroPriced: false,
      promptPricePerMillion: pricing?.promptPricePerMillion,
      completionPricePerMillion: pricing?.completionPricePerMillion,
    };
  }

  /**
   * Helper specifically evaluating candidate suitability for failover routing.
   */
  public evaluateFailoverCandidate(
    candidatePricing: ClassifiedPricing | ModelPricing | null,
    sourcePricing: ClassifiedPricing | ModelPricing | null,
    costPolicy: CostPolicy,
    allowPaidExecution?: boolean,
    candidateModelId: string = 'candidate',
    candidateConnName: string = 'Candidate Connection'
  ): CostPolicyDecision {
    const sourceWasZeroCost = this.isZeroCostModel(sourcePricing);
    return this.evaluate({
      costPolicy,
      allowPaidExecution,
      pricing: candidatePricing,
      modelId: candidateModelId,
      connectionName: candidateConnName,
      isFailover: true,
      sourceWasZeroCost,
    });
  }
}

// Global engine singleton
export const costPolicyEngine = new CostPolicyEngine();

/**
 * Functional convenience export
 */
export function evaluateCostPolicy(
  context: CostPolicyEvaluationContext
): CostPolicyDecision {
  return costPolicyEngine.evaluate(context);
}

/**
 * Functional convenience export
 */
export function isModelZeroCost(
  pricing?: ClassifiedPricing | ModelPricing | null
): boolean {
  return costPolicyEngine.isZeroCostModel(pricing);
}
