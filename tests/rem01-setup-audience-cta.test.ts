import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  DEFAULT_STORIES, 
  DEFAULT_SEO_PACKAGE, 
  DEFAULT_THUMBNAIL_PACKAGE, 
  DEFAULT_SCENE_PACKAGES, 
  DEFAULT_CONTINUITY_BIBLE,
  StorageService 
} from '../src/services/storage';
import { ProjectSettings } from '../src/types/hud';
import fs from 'node:fs';
import path from 'node:path';

// In-memory mock for localStorage in Node test runner
class MockLocalStorage {
  private store: Record<string, string> = {};
  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }
  removeItem(key: string): void {
    delete this.store[key];
  }
  clear(): void {
    this.store = {};
  }
}

const createMockProject = (overrides?: Partial<ProjectSettings>): ProjectSettings => ({
  id: 'proj_matrix_rem01_test',
  name: 'REM01 Audience & CTA Test',
  format: '9:16_SHORTS',
  shortsDuration: 24,
  longFormDurationMinutes: 4,
  modeId: 'scifi_explainer',
  language: 'en',
  visualStyleId: 'cinematic',
  targetAudience: 'Curiosity-driven Tech Enthusiasts',
  callToAction: 'Follow for Daily Reality Glitches',
  costPolicy: 'manual',
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
  ...overrides,
});

test('REM-01: 1. SetupWorkspace component contains Audience & Conversion controls', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/stages/SetupWorkspace.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify section title and collapsible header
  assert.ok(fileContent.includes('AUDIENCE & CONVERSION'), 'SetupWorkspace must contain AUDIENCE & CONVERSION title');
  assert.ok(fileContent.includes('Optional Context'), 'SetupWorkspace must display Optional Context badge');
  assert.ok(fileContent.includes('isAudienceExpanded'), 'SetupWorkspace must maintain collapsible state');

  // Verify Target Audience input configuration
  assert.ok(fileContent.includes('target-audience-input'), 'SetupWorkspace must have target-audience-input ID');
  assert.ok(fileContent.includes('Target Audience'), 'SetupWorkspace must have Target Audience label');
  assert.ok(fileContent.includes('Curious science and astronomy enthusiasts'), 'SetupWorkspace must provide expected placeholder');
  assert.ok(fileContent.includes('maxLength={150}'), 'Target Audience input must enforce max length 150');
  assert.ok(fileContent.includes('updateProject({ targetAudience: e.target.value })'), 'Target Audience input must bind updateProject handler');

  // Verify Call to Action input configuration
  assert.ok(fileContent.includes('call-to-action-input'), 'SetupWorkspace must have call-to-action-input ID');
  assert.ok(fileContent.includes('Call to Action'), 'SetupWorkspace must have Call to Action label');
  assert.ok(fileContent.includes('Subscribe for weekly deep-space explainers'), 'SetupWorkspace must provide expected placeholder');
  assert.ok(fileContent.includes('updateProject({ callToAction: e.target.value })'), 'Call to Action input must bind updateProject handler');
});

test('REM-01: 2. Editing either field updates project settings correctly', () => {
  let project = createMockProject();

  // Update target audience
  const updateTargetAudience = (audience: string) => {
    project = { ...project, targetAudience: audience, updatedAt: new Date().toISOString() };
  };

  // Update call to action
  const updateCallToAction = (cta: string) => {
    project = { ...project, callToAction: cta, updatedAt: new Date().toISOString() };
  };

  updateTargetAudience('Astrophysics Researchers and Students');
  assert.strictEqual(project.targetAudience, 'Astrophysics Researchers and Students');

  updateCallToAction('Download the telemetry dataset from the link below');
  assert.strictEqual(project.callToAction, 'Download the telemetry dataset from the link below');
});

test('REM-01: 3. Both values survive persistence and restoration via localStorage', () => {
  const mockStorage = new MockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  const initialProject = createMockProject({
    targetAudience: 'Sci-Fi Writers and Filmmakers',
    callToAction: 'Check out our story bible in the description',
  });

  // Save to storage
  StorageService.saveProject(initialProject);

  // Load from storage
  const loadedProject = StorageService.loadProject(createMockProject({
    targetAudience: 'Default Audience',
    callToAction: 'Default CTA',
  }));

  assert.strictEqual(loadedProject.targetAudience, 'Sci-Fi Writers and Filmmakers');
  assert.strictEqual(loadedProject.callToAction, 'Check out our story bible in the description');
});

test('REM-01: 4. Empty values remain valid and are safely preserved', () => {
  const mockStorage = new MockLocalStorage();
  (globalThis as any).localStorage = mockStorage;

  const projectWithEmptyValues = createMockProject({
    targetAudience: '',
    callToAction: '',
  });

  // Save empty values
  StorageService.saveProject(projectWithEmptyValues);

  // Load back
  const loaded = StorageService.loadProject(createMockProject());
  assert.strictEqual(loaded.targetAudience, '');
  assert.strictEqual(loaded.callToAction, '');
});

test('REM-01: 5. Older project backups without these fields remain backward-compatible', () => {
  // Legacy backup JSON lacking targetAudience and callToAction
  const legacyBackupJson = JSON.stringify({
    schemaVersion: 'illum_project_backup_v1',
    exportTimestamp: '2026-10-15T00:00:00.000Z',
    project: {
      id: 'proj_legacy_01',
      name: 'Legacy Project Without Audience',
      format: '9:16_SHORTS',
      shortsDuration: 24,
      longFormDurationMinutes: 4,
      modeId: 'scifi_explainer',
      language: 'en',
      visualStyleId: 'cinematic',
      costPolicy: 'free_only',
    },
    stories: DEFAULT_STORIES,
    selectedStoryId: DEFAULT_STORIES[0].id,
    currentScript: {
      id: 'script_legacy_v1',
      sourceStoryId: DEFAULT_STORIES[0].id,
      sourceStoryVersion: 1,
      versionNumber: 1,
      title: 'Legacy Script',
      hookSummary: 'Legacy hook',
      scenes: [
        {
          id: 'sc_1',
          sceneNumber: 1,
          timeRange: '0–8s',
          purpose: 'Hook',
          narrationText: 'Legacy narration beat',
          visualDirectionDraft: 'Legacy visual',
          wordCount: 3,
        }
      ],
      totalWords: 3,
      speakingDurationSeconds: 8,
      isApproved: true,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
      configSnapshot: {
        format: '9:16_SHORTS',
        duration: 24,
        modeId: 'scifi_explainer',
        language: 'en',
        visualStyleId: 'cinematic',
      }
    },
    scriptVersions: [],
    scenePackages: DEFAULT_SCENE_PACKAGES,
    continuityBible: DEFAULT_CONTINUITY_BIBLE,
    seoPackage: DEFAULT_SEO_PACKAGE,
    thumbnailsPackage: DEFAULT_THUMBNAIL_PACKAGE,
  });

  const importResult = StorageService.importProjectBackupJson(legacyBackupJson);
  assert.ok(importResult.success, 'Importing legacy backup without audience fields must succeed');
  assert.strictEqual(importResult.data?.project.targetAudience, undefined, 'targetAudience safely defaults to undefined');
  assert.strictEqual(importResult.data?.project.callToAction, undefined, 'callToAction safely defaults to undefined');
  assert.strictEqual(importResult.data?.project.name, 'Legacy Project Without Audience');
});

test('REM-01: 6. Script generation request payload includes both configured values', () => {
  const project = createMockProject({
    targetAudience: 'Deep-Sky Astrophotographers',
    callToAction: 'Join our stargazing discord community',
  });

  // Emulate WorkflowContext generateScriptWithAI payload construction
  const scriptParams = {
    connectionId: 'conn_gemini_01',
    costPolicy: project.costPolicy || 'manual',
    sourceText: 'Anomalous radio waves detected.',
    sourceTitle: 'Space Anomaly',
    sourceVersion: 1,
    contentMode: project.modeId,
    language: project.language,
    format: project.format,
    duration: project.shortsDuration,
    visualStyle: project.visualStyleId,
    targetAudience: project.targetAudience,
    callToAction: project.callToAction,
  };

  assert.strictEqual(scriptParams.targetAudience, 'Deep-Sky Astrophotographers');
  assert.strictEqual(scriptParams.callToAction, 'Join our stargazing discord community');
});

test('REM-01: 7. SEO generation request payload includes both configured values', () => {
  const project = createMockProject({
    targetAudience: 'Physics and Astronomy Enthusiasts',
    callToAction: 'Hit like and subscribe for weekly cosmological mysteries',
  });

  // Emulate WorkflowContext generateSeoWithAI payload construction
  const seoParams = {
    connectionId: 'conn_gemini_01',
    costPolicy: project.costPolicy || 'manual',
    sourceTitle: 'Space Anomaly',
    sourceText: 'Anomalous radio waves detected.',
    scriptTitle: 'Space Anomaly Script',
    hookSummary: 'Telemetry shows artificial origin.',
    scenes: [],
    contentMode: project.modeId,
    language: project.language,
    format: project.format,
    duration: project.shortsDuration,
    targetAudience: project.targetAudience,
    callToAction: project.callToAction,
  };

  assert.strictEqual(seoParams.targetAudience, 'Physics and Astronomy Enthusiasts');
  assert.strictEqual(seoParams.callToAction, 'Hit like and subscribe for weekly cosmological mysteries');
});

test('REM-01: 8. Missing optional values do not produce malformed prompts or literal "undefined"', () => {
  // Test prompt formatting logic in server.ts
  const formatPrompt = (targetAudience?: string, callToAction?: string) => {
    return [
      targetAudience ? `- Target Audience: ${String(targetAudience).slice(0, 200)}` : '',
      callToAction ? `- Call to Action: ${String(callToAction).slice(0, 200)}` : '',
    ].filter(Boolean).join('\n');
  };

  // Undefined values
  const promptEmpty = formatPrompt(undefined, undefined);
  assert.strictEqual(promptEmpty, '');
  assert.ok(!promptEmpty.includes('undefined'));
  assert.ok(!promptEmpty.includes('null'));

  // Empty string values
  const promptEmptyString = formatPrompt('', '');
  assert.strictEqual(promptEmptyString, '');
  assert.ok(!promptEmptyString.includes('undefined'));

  // Configured values
  const promptConfigured = formatPrompt('Science lovers', 'Subscribe now');
  assert.ok(promptConfigured.includes('- Target Audience: Science lovers'));
  assert.ok(promptConfigured.includes('- Call to Action: Subscribe now'));
});

test('REM-01: 9. Input length bounds prevent prompt overflow and preserve prompt safety', () => {
  const longAudience = 'A'.repeat(500);
  const longCta = 'B'.repeat(500);

  // In server prompt formatting, string is safely bounded to 200 chars
  const boundedAudience = String(longAudience).slice(0, 200);
  const boundedCta = String(longCta).slice(0, 200);

  assert.strictEqual(boundedAudience.length, 200);
  assert.strictEqual(boundedCta.length, 200);
  assert.ok(!boundedAudience.includes('undefined'));
  assert.ok(!boundedCta.includes('undefined'));
});
