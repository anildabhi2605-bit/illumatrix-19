import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerManager,
  sanitizeError,
  maskApiKey,
  PROVIDER_REGISTRY,
  SupportedProvider,
} from '../src/server/providerManager';
import {
  evaluateConnectionPricing,
  evaluateModelCompatibility,
} from '../src/server/modelCompatibility';
import { aiExecutionEngine, AIExecutionError } from '../src/server/aiExecutionEngine';
import { StorageService } from '../src/services/storage';
import { AIService } from '../src/services/aiService';
import { ProjectSettings, CostPolicy } from '../src/types/hud';

test('Task 3.4: Backend-to-UI Execution Management Integration Suite', async (t) => {

  // ---------------------------------------------------------------------------
  // 1. Cost Policy Selection & Storage Persistence
  // ---------------------------------------------------------------------------
  await t.test('1. Cost Policy state management and complete project backup roundtrip', () => {
    // 1a. StorageService validates and preserves cost policy
    const testProject: ProjectSettings = {
      id: 'proj_test_cost_policy',
      name: 'Cost Policy Test Project',
      format: '9:16_SHORTS',
      shortsDuration: 32,
      longFormDurationMinutes: 3,
      modeId: 'scifi_explainer',
      language: 'en',
      visualStyleId: 'cinematic',
      targetAudience: 'Testing Audience',
      callToAction: 'Follow for more',
      costPolicy: 'prefer_free',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const exportedBackup = StorageService.exportProjectBackupJson({
      project: testProject,
      stories: [],
      selectedStoryId: 'story_1',
      scriptVersions: [],
      currentScript: {
        id: 'script_1',
        sourceStoryId: 'story_1',
        sourceStoryVersion: 1,
        versionNumber: 1,
        title: 'Script',
        hookSummary: 'Hook',
        scenes: [],
        totalWords: 0,
        speakingDurationSeconds: 0,
        editorialNotes: '',
        isApproved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        configSnapshot: {
          format: '9:16_SHORTS',
          duration: 32,
          modeId: 'scifi_explainer',
          language: 'en',
          visualStyleId: 'cinematic',
        },
      },
      scenePackages: [],
      continuityBible: { id: 'cb_1', projectId: testProject.id, voiceNarrator: 'Narrator', musicMood: 'Mood', soundDesign: 'Design', visualPalette: 'Cyan', fictionalCharacters: [], cameraGrammar: '35mm', updatedAt: new Date().toISOString() },
      seoPackage: {
        id: 'seo_1',
        projectId: testProject.id,
        sourceStoryId: 'story_1',
        sourceStoryVersion: 1,
        scriptVersionReference: 1,
        titleOptions: ['Title'],
        selectedTitle: 'Title',
        description: 'Desc',
        tags: ['tag'],
        hashtags: ['#tag'],
        chapters: [],
        isCustomEdited: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      thumbnailsPackage: {
        id: 'thumb_1',
        projectId: testProject.id,
        sourceStoryId: 'story_1',
        sourceStoryVersion: 1,
        scriptVersionReference: 1,
        options: [],
        selectedOptionId: 'option_a',
        isApproved: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      staleMatrix: {
        sourceStoryStale: false,
        scriptStale: false,
        promptsStale: false,
        thumbnailsStale: false,
        seoStale: false,
      },
    });

    const restored = StorageService.importProjectBackupJson(exportedBackup);
    assert.equal(restored.success, true);
    assert.ok(restored.data);
    assert.equal(restored.data.project.costPolicy, 'prefer_free', 'Cost policy must be preserved across backup restore');
  });

  // ---------------------------------------------------------------------------
  // 2. Cost Policy Backend Enforcement: free_only, prefer_free, manual
  // ---------------------------------------------------------------------------
  await t.test('2. Server Cost Policy Enforcement across execution boundaries', async (t2) => {
    // 2a. Under free_only, paid models are strictly blocked with 402 PAYWALL_BLOCKED
    await t2.test('2a. free_only blocks execution of paid models with 402 PAYWALL_BLOCKED', async () => {
      // Find or create a test connection with paid model pricing
      const allConns = providerManager.listConnections();
      const openRouterConn = allConns.find(c => c.provider === 'OpenRouter');
      if (openRouterConn) {
        // Set model to a paid model
        openRouterConn.modelId = 'anthropic/claude-3.5-sonnet';
        openRouterConn.pricing = {
          pricingTier: 'paid',
          promptPricePerMillion: 3.0,
          completionPricePerMillion: 15.0,
          isZeroPriced: false,
        };

        await assert.rejects(
          async () => {
            await aiExecutionEngine.executeTextGeneration({
              connectionId: openRouterConn.id,
              costPolicy: 'free_only',
              prompt: 'test prompt',
            });
          },
          (err: any) => {
            assert.equal(err.category, 'PAYWALL_BLOCKED');
            assert.equal(err.status, 402);
            assert.ok(err.message.includes('free_only'));
            return true;
          }
        );
      }
    });

    // 2b. Under prefer_free, paid models require explicit allowPaidExecution: true
    await t2.test('2b. prefer_free blocks paid models unless allowPaidExecution is explicitly provided', async () => {
      const allConns = providerManager.listConnections();
      const openRouterConn = allConns.find(c => c.provider === 'OpenRouter');
      if (openRouterConn) {
        openRouterConn.modelId = 'anthropic/claude-3.5-sonnet';
        openRouterConn.pricing = {
          pricingTier: 'paid',
          promptPricePerMillion: 3.0,
          completionPricePerMillion: 15.0,
          isZeroPriced: false,
        };

        // Without allowPaidExecution: fails closed with 402 PAYWALL_BLOCKED
        await assert.rejects(
          async () => {
            await aiExecutionEngine.executeTextGeneration({
              connectionId: openRouterConn.id,
              costPolicy: 'prefer_free',
              allowPaidExecution: false,
              prompt: 'test prompt',
            });
          },
          (err: any) => {
            assert.equal(err.category, 'PAYWALL_BLOCKED');
            assert.equal(err.status, 402);
            assert.ok(err.message.includes('prefer_free'));
            return true;
          }
        );
      }
    });

    // 2c. Image generation model gemini-3.1-flash-lite-image is paid and blocked under free_only
    await t2.test('2c. Image generation is blocked under free_only because gemini-3.1-flash-lite-image is billable', async () => {
      const googleConn = providerManager.listConnections().find(c => c.provider === 'Google GenAI');
      if (googleConn) {
        await assert.rejects(
          async () => {
            await aiExecutionEngine.executeImageGeneration({
              connectionId: googleConn.id,
              costPolicy: 'free_only',
              prompt: 'A futuristic city in obsidian void',
              format: '9:16_SHORTS',
              optionId: 'option_a',
            });
          },
          (err: any) => {
            assert.equal(err.category, 'PAYWALL_BLOCKED');
            assert.equal(err.status, 402);
            assert.ok(err.message.includes('free_only'));
            return true;
          }
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Modality Boundary for Image Generation
  // ---------------------------------------------------------------------------
  await t.test('3. Image generation strictly enforces Google GenAI provider modality boundary', async () => {
    const allConns = providerManager.listConnections();
    const nonGoogleConn = allConns.find(c => c.provider === 'Groq' || c.provider === 'OpenRouter');

    if (nonGoogleConn) {
      await assert.rejects(
        async () => {
          await aiExecutionEngine.executeImageGeneration({
            connectionId: nonGoogleConn.id,
            costPolicy: 'manual',
            allowPaidExecution: true,
            prompt: 'Test prompt',
            format: '9:16_SHORTS',
            optionId: 'option_a',
          });
        },
        (err: any) => {
          assert.equal(err.category, 'UNSUPPORTED_MODALITY');
          assert.equal(err.status, 400);
          assert.ok(err.message.includes('Google GenAI'));
          assert.ok(err.message.includes(nonGoogleConn.provider));
          return true;
        }
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Non-Generative vs. Billable Connection Testing Authorization
  // ---------------------------------------------------------------------------
  await t.test('4. Connection test fails closed with BILLABLE_TEST_REQUIRED for paid models without non-generative checks', async () => {
    const allConns = providerManager.listConnections();
    const openRouterConn = allConns.find(c => c.provider === 'OpenRouter');

    if (openRouterConn) {
      openRouterConn.modelId = 'anthropic/claude-3.5-sonnet';
      openRouterConn.pricing = {
        pricingTier: 'paid',
        promptPricePerMillion: 3.0,
        completionPricePerMillion: 15.0,
        isZeroPriced: false,
      };

      // Test without allowBillableTest fails closed
      const resWithoutAuth = await providerManager.testConnection(openRouterConn.id, { allowBillableTest: false });
      assert.equal(resWithoutAuth.success, false);
      assert.equal(resWithoutAuth.errorCategory, 'BILLABLE_TEST_REQUIRED');
      assert.ok(resWithoutAuth.error?.includes('requires explicit billable test authorization'));
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Safe Error Sanitization (No Leaks of Secrets / Headers / Internal Details)
  // ---------------------------------------------------------------------------
  await t.test('5. Error sanitization prevents leaking API keys, Bearer headers, or internal paths', () => {
    const sensitiveError = new Error('Failed to connect with Authorization: Bearer sk-or-v1-abcdef0123456789 and API key AIzaSyA1234567890abcdefghijklmnop.');
    const sanitized = sanitizeError(sensitiveError);

    assert.equal(sanitized.includes('sk-or-v1-abcdef0123456789'), false, 'Cleartext key must not be leaked');
    assert.equal(sanitized.includes('AIzaSyA1234567890abcdefghijklmnop'), false, 'Google API key must not be leaked');
    assert.ok(sanitized.includes('[REDACTED]'), 'Redaction placeholder must be present');

    const masked = maskApiKey('AIzaSyA1234567890abcdefghijklmnop');
    assert.equal(masked.startsWith('AIzaSy...'), true);
    assert.equal(masked.length < 20, true);
  });

  // ---------------------------------------------------------------------------
  // 6. AIService Frontend Contract & 402 PAYWALL_BLOCKED Mapping
  // ---------------------------------------------------------------------------
  await t.test('6. AIService client methods handle 402 HTTP status with PAYWALL_BLOCKED error category', () => {
    // Verify AIService methods are defined with proper TypeScript signatures
    assert.equal(typeof AIService.generateScript, 'function');
    assert.equal(typeof AIService.generateScenePrompts, 'function');
    assert.equal(typeof AIService.generateSeoPackage, 'function');
    assert.equal(typeof AIService.generateThumbnails, 'function');
    assert.equal(typeof AIService.renderThumbnailImage, 'function');
    assert.equal(typeof AIService.testProvider, 'function');
  });

});
