/**
 * ILLUMATRIX V.2 — Task 4.1 Cost Policy Engine Test Suite
 *
 * Validates deterministic cost policy enforcement, zero-cost positive verification,
 * failover cost tier parity, payload validation, and secret scrubbing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CostPolicyEngine,
  costPolicyEngine,
  evaluateCostPolicy,
  isModelZeroCost,
} from '../src/server/costPolicyEngine';
import { aiExecutionEngine, AIExecutionError } from '../src/server/aiExecutionEngine';
import { providerManager } from '../src/server/providerManager';
import type { ClassifiedPricing } from '../src/server/modelCompatibility';

test('Task 4.1: Cost Policy Engine Suite', async (suite) => {
  // --------------------------------------------------------------------------
  // 1. Payload & Policy Input Validation
  // --------------------------------------------------------------------------
  await suite.test('1. Payload & Policy Input Validation (fail closed on malformed input)', async (t) => {
    await t.test('1a. Normalizes valid policy strings with whitespace and casing', () => {
      const res1 = costPolicyEngine.validatePolicyInput('  free_only  ');
      assert.equal(res1.valid, true);
      assert.equal(res1.normalizedPolicy, 'free_only');

      const res2 = costPolicyEngine.validatePolicyInput('PREFER_FREE');
      assert.equal(res2.valid, true);
      assert.equal(res2.normalizedPolicy, 'prefer_free');

      const res3 = costPolicyEngine.validatePolicyInput('Manual');
      assert.equal(res3.valid, true);
      assert.equal(res3.normalizedPolicy, 'manual');
    });

    await t.test('1b. Omitted policy defaults deterministically to "manual"', () => {
      const resUndefined = costPolicyEngine.validatePolicyInput(undefined);
      assert.equal(resUndefined.valid, true);
      assert.equal(resUndefined.normalizedPolicy, 'manual');

      const resNull = costPolicyEngine.validatePolicyInput(null);
      assert.equal(resNull.valid, true);
      assert.equal(resNull.normalizedPolicy, 'manual');
    });

    await t.test('1c. Invalid or unrecognized policy strings fail closed with HTTP 400 INVALID_PAYLOAD', () => {
      const invalidStrings = ['unlimited_paid', 'free', 'paid', 'enterprise', '', '   '];
      for (const invalid of invalidStrings) {
        const res = costPolicyEngine.validatePolicyInput(invalid);
        assert.equal(res.valid, false, `Should fail for "${invalid}"`);
        assert.equal(res.error?.status, 400);
        assert.equal(res.error?.category, 'INVALID_PAYLOAD');
        assert.ok(res.error?.message.includes('Invalid cost policy'));
      }
    });

    await t.test('1d. Non-string policy values fail closed with HTTP 400 INVALID_PAYLOAD', () => {
      const nonStrings: any[] = [123, true, false, {}, [], () => {}];
      for (const item of nonStrings) {
        const res = costPolicyEngine.validatePolicyInput(item);
        assert.equal(res.valid, false);
        assert.equal(res.error?.status, 400);
        assert.equal(res.error?.category, 'INVALID_PAYLOAD');
        assert.ok(res.error?.message.includes('Invalid cost policy parameter format'));
      }
    });

    await t.test('1e. allowPaidExecution must be boolean if provided; non-booleans fail closed (400)', () => {
      const validBooleans = [true, false, undefined, null];
      for (const val of validBooleans) {
        const res = costPolicyEngine.validatePolicyInput('manual', val);
        assert.equal(res.valid, true);
      }

      const invalidBooleans: any[] = ['true', 'false', 1, 0, {}, [], 'yes'];
      for (const val of invalidBooleans) {
        const res = costPolicyEngine.validatePolicyInput('manual', val);
        assert.equal(res.valid, false, `Should fail for non-boolean allowPaidExecution: ${JSON.stringify(val)}`);
        assert.equal(res.error?.status, 400);
        assert.equal(res.error?.category, 'INVALID_PAYLOAD');
        assert.ok(res.error?.message.includes('Invalid allowPaidExecution'));
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Zero-Cost Positive Pricing Verification Invariants
  // --------------------------------------------------------------------------
  await suite.test('2. Zero-Cost Positive Pricing Verification Invariants', async (t) => {
    await t.test('2a. Positively verified zero-cost requires isZeroPriced: true AND pricingTier: "free"', () => {
      const verifiedFree: ClassifiedPricing = {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
      };
      assert.equal(isModelZeroCost(verifiedFree), true);
    });

    await t.test('2b. Contradictory pricing is rejected (isZeroPriced true with positive rates)', () => {
      const contradictoryA: ClassifiedPricing = {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: 0.5,
        completionPricePerMillion: 0,
      };
      assert.equal(isModelZeroCost(contradictoryA), false);

      const contradictoryB: ClassifiedPricing = {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: 0,
        completionPricePerMillion: 2.0,
      };
      assert.equal(isModelZeroCost(contradictoryB), false);

      const contradictoryTier: ClassifiedPricing = {
        isZeroPriced: true,
        pricingTier: 'paid',
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
      };
      assert.equal(isModelZeroCost(contradictoryTier), false);
    });

    await t.test('2c. Missing, null, negative, or NaN prices are rejected', () => {
      assert.equal(isModelZeroCost(null), false);
      assert.equal(isModelZeroCost(undefined), false);

      const nanPrice: any = {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: NaN,
      };
      assert.equal(isModelZeroCost(nanPrice), false);

      const negativePrice: any = {
        isZeroPriced: true,
        pricingTier: 'free',
        promptPricePerMillion: -1,
      };
      assert.equal(isModelZeroCost(negativePrice), false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. "free_only" Policy Enforcement Invariants
  // --------------------------------------------------------------------------
  await suite.test('3. "free_only" Policy Invariants', async (t) => {
    const verifiedFreePricing: ClassifiedPricing = {
      isZeroPriced: true,
      pricingTier: 'free',
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
    };

    const paidPricing: ClassifiedPricing = {
      isZeroPriced: false,
      pricingTier: 'paid',
      promptPricePerMillion: 5.0,
      completionPricePerMillion: 15.0,
    };

    const unknownPricing: ClassifiedPricing = {
      isZeroPriced: false,
      pricingTier: 'unknown',
    };

    await t.test('3a. Permits positively verified zero-cost models', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        pricing: verifiedFreePricing,
        modelId: 'gemini-3.1-flash-lite',
        connectionName: 'Free Node',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_ZERO_COST');
    });

    await t.test('3b. Blocks paid models with HTTP 402 PAYWALL_BLOCKED', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        pricing: paidPricing,
        modelId: 'gpt-4o',
        connectionName: 'Paid Frontier Node',
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 402);
      assert.equal(decision.reasonCode, 'BLOCKED_FREE_ONLY');
      assert.ok(decision.message.includes('free_only'));
      assert.ok(decision.message.includes('Model requires billable paid inference'));
    });

    await t.test('3c. Blocks unknown or unverified pricing with HTTP 402 PAYWALL_BLOCKED', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        pricing: unknownPricing,
        modelId: 'custom-unverified-llm',
        connectionName: 'Custom Unverified Node',
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 402);
      assert.equal(decision.reasonCode, 'BLOCKED_FREE_ONLY');
      assert.ok(decision.message.includes('unknown, missing, or unverified'));
    });

    await t.test('3d. Blocks missing pricing with HTTP 402 PAYWALL_BLOCKED', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        pricing: null,
        modelId: 'bare-model',
        connectionName: 'Bare Node',
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 402);
      assert.equal(decision.reasonCode, 'BLOCKED_FREE_ONLY');
    });

    await t.test('3e. Paid authorization (allowPaidExecution: true) CANNOT override free_only', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        allowPaidExecution: true, // Attempted override
        pricing: paidPricing,
        modelId: 'gpt-4o',
        connectionName: 'Paid Frontier Node',
      });
      assert.equal(decision.allowed, false, 'Paid authorization must never override free_only');
      assert.equal(decision.status, 402);
      assert.equal(decision.reasonCode, 'BLOCKED_FREE_ONLY');
    });
  });

  // --------------------------------------------------------------------------
  // 4. "prefer_free" Policy Enforcement Invariants
  // --------------------------------------------------------------------------
  await suite.test('4. "prefer_free" Policy Invariants', async (t) => {
    const verifiedFreePricing: ClassifiedPricing = {
      isZeroPriced: true,
      pricingTier: 'free',
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
    };

    const paidPricing: ClassifiedPricing = {
      isZeroPriced: false,
      pricingTier: 'paid',
      promptPricePerMillion: 5.0,
      completionPricePerMillion: 15.0,
    };

    const unknownPricing: ClassifiedPricing = {
      isZeroPriced: false,
      pricingTier: 'unknown',
    };

    await t.test('4a. Permits eligible free models without requiring authorization', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'prefer_free',
        pricing: verifiedFreePricing,
        modelId: 'gemini-3.1-flash-lite',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_ZERO_COST');
    });

    await t.test('4b. Blocks paid model if allowPaidExecution is false or undefined (HTTP 402)', () => {
      const dec1 = evaluateCostPolicy({
        costPolicy: 'prefer_free',
        allowPaidExecution: false,
        pricing: paidPricing,
        modelId: 'gpt-4o',
      });
      assert.equal(dec1.allowed, false);
      assert.equal(dec1.status, 402);
      assert.equal(dec1.reasonCode, 'BLOCKED_PAID_UNAUTHORIZED');
      assert.ok(dec1.message.includes('allowPaidExecution: true'));

      const dec2 = evaluateCostPolicy({
        costPolicy: 'prefer_free',
        allowPaidExecution: undefined,
        pricing: paidPricing,
        modelId: 'gpt-4o',
      });
      assert.equal(dec2.allowed, false);
      assert.equal(dec2.status, 402);
      assert.equal(dec2.reasonCode, 'BLOCKED_PAID_UNAUTHORIZED');
    });

    await t.test('4c. Blocks unknown pricing model without authorization (HTTP 402)', () => {
      const dec = evaluateCostPolicy({
        costPolicy: 'prefer_free',
        allowPaidExecution: undefined,
        pricing: unknownPricing,
        modelId: 'custom-unverified',
      });
      assert.equal(dec.allowed, false);
      assert.equal(dec.status, 402);
      assert.equal(dec.reasonCode, 'BLOCKED_UNKNOWN_PRICING');
      assert.ok(dec.message.includes('unknown/unverified pricing'));
    });

    await t.test('4d. Permits paid execution with explicit, validated allowPaidExecution: true', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'prefer_free',
        allowPaidExecution: true,
        pricing: paidPricing,
        modelId: 'gpt-4o',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_PAID_AUTHORIZED');
    });
  });

  // --------------------------------------------------------------------------
  // 5. "manual" Policy Enforcement Invariants
  // --------------------------------------------------------------------------
  await suite.test('5. "manual" Policy Invariants', async (t) => {
    const verifiedFreePricing: ClassifiedPricing = {
      isZeroPriced: true,
      pricingTier: 'free',
      promptPricePerMillion: 0,
      completionPricePerMillion: 0,
    };

    const paidPricing: ClassifiedPricing = {
      isZeroPriced: false,
      pricingTier: 'paid',
      promptPricePerMillion: 5.0,
      completionPricePerMillion: 15.0,
    };

    await t.test('5a. Permits zero-cost models under manual policy', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'manual',
        pricing: verifiedFreePricing,
        modelId: 'gemini-3.1-flash-lite',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_ZERO_COST');
    });

    await t.test('5b. Direct manual selection of paid model permits execution as direct user consent', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'manual',
        pricing: paidPricing,
        modelId: 'gpt-4o',
        connectionName: 'User Selected Paid Model',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_MANUAL');
    });

    await t.test('5c. Direct manual selection with allowPaidExecution: true returns ALLOWED_PAID_AUTHORIZED', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'manual',
        allowPaidExecution: true,
        pricing: paidPricing,
        modelId: 'gpt-4o',
      });
      assert.equal(decision.allowed, true);
      assert.equal(decision.status, 200);
      assert.equal(decision.reasonCode, 'ALLOWED_PAID_AUTHORIZED');
    });

    await t.test('5d. Explicit opt-out (allowPaidExecution: false) blocks billable execution under manual', () => {
      const decision = evaluateCostPolicy({
        costPolicy: 'manual',
        allowPaidExecution: false,
        pricing: paidPricing,
        modelId: 'gpt-4o',
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.status, 402);
      assert.equal(decision.reasonCode, 'BLOCKED_PAID_UNAUTHORIZED');
    });

    await t.test('5e. Failover candidate under manual policy blocks paid candidate if source was free', () => {
      const failoverBlocked = costPolicyEngine.evaluateFailoverCandidate(
        paidPricing,
        verifiedFreePricing,
        'manual',
        false, // no authorization
        'paid-candidate',
        'Candidate Paid Node'
      );
      assert.equal(failoverBlocked.allowed, false);
      assert.equal(failoverBlocked.status, 402);
      assert.equal(failoverBlocked.reasonCode, 'BLOCKED_PAID_UNAUTHORIZED');

      const failoverAllowed = costPolicyEngine.evaluateFailoverCandidate(
        paidPricing,
        verifiedFreePricing,
        'manual',
        true, // explicit authorization
        'paid-candidate',
        'Candidate Paid Node'
      );
      assert.equal(failoverAllowed.allowed, true);
      assert.equal(failoverAllowed.status, 200);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Security, Credential Scrubbing & Error Safety
  // --------------------------------------------------------------------------
  await suite.test('6. Security, Credential Scrubbing & Error Safety', async (t) => {
    await t.test('6a. Decision messages never leak cleartext keys or bearer tokens', () => {
      const rawSecret = 'AIzaSyFakeSecretKeyThatMustBeRedacted12345';
      const decision = evaluateCostPolicy({
        costPolicy: 'free_only',
        pricing: {
          isZeroPriced: false,
          pricingTier: 'paid',
        },
        modelId: `custom-model-with-${rawSecret}`,
        connectionName: `Connection-${rawSecret}`,
      });

      assert.equal(decision.allowed, false);
      assert.ok(!decision.message.includes(rawSecret));
      assert.ok(decision.message.includes('AIza***'));
    });
  });

  // --------------------------------------------------------------------------
  // 7. Integration with aiExecutionEngine.execute()
  // --------------------------------------------------------------------------
  await suite.test('7. Shared AI Execution Engine Integration with Cost Policy Engine', async (t) => {
    const freeConnId = `conn_cpe_free_${Date.now()}`;
    const paidConnId = `conn_cpe_paid_${Date.now()}`;

    providerManager.addOrUpdateConnection({
      id: freeConnId,
      name: 'CPE Verified Free Node',
      provider: 'Google GenAI',
      modelId: 'gemini-3.1-flash-lite',
      apiKey: 'AIzaSyTestCPEKey1',
      pricing: { isZeroPriced: true, pricingTier: 'free' },
    });

    providerManager.addOrUpdateConnection({
      id: paidConnId,
      name: 'CPE Paid Node',
      provider: 'OpenAI',
      modelId: 'gpt-4o',
      apiKey: 'sk-proj-testCPEPaidKey2',
      pricing: { isZeroPriced: false, pricingTier: 'paid', promptPricePerMillion: 5 },
    });

    t.after(() => {
      providerManager.deleteConnection(freeConnId);
      providerManager.deleteConnection(paidConnId);
    });

    await t.test('7a. Rejects malformed costPolicy string with HTTP 400 INVALID_PAYLOAD', async () => {
      await assert.rejects(
        async () => {
          await aiExecutionEngine.execute({
            connectionId: freeConnId,
            costPolicy: 'invalid_policy_name' as any,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'INVALID_PAYLOAD');
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('Invalid cost policy'));
          return true;
        }
      );
    });

    await t.test('7b. Rejects non-boolean allowPaidExecution with HTTP 400 INVALID_PAYLOAD', async () => {
      await assert.rejects(
        async () => {
          await aiExecutionEngine.execute({
            connectionId: freeConnId,
            costPolicy: 'prefer_free',
            allowPaidExecution: 'true' as any,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'INVALID_PAYLOAD');
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('Invalid allowPaidExecution'));
          return true;
        }
      );
    });

    await t.test('7c. Step 5 enforces free_only on paid connection with HTTP 402 PAYWALL_BLOCKED', async () => {
      await assert.rejects(
        async () => {
          await aiExecutionEngine.execute({
            connectionId: paidConnId,
            costPolicy: 'free_only',
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('free_only'));
          return true;
        }
      );
    });

    await t.test('7d. Step 5 enforces prefer_free on paid connection without auth (HTTP 402)', async () => {
      await assert.rejects(
        async () => {
          await aiExecutionEngine.execute({
            connectionId: paidConnId,
            costPolicy: 'prefer_free',
            allowPaidExecution: false,
            prompt: 'Test prompt',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'PAYWALL_BLOCKED');
          assert.equal(err.status, 402);
          assert.ok(err.message.includes('prefer_free'));
          return true;
        }
      );
    });
  });
});
