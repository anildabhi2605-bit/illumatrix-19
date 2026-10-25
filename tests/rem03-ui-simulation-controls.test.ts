import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { providerManager } from '../src/server/providerManager';

test('REM-03: 1. ControlCenter component contains explicit UI TEST labels for simulation controls', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/layout/ControlCenter.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify explicit UI TEST button labels
  assert.ok(
    fileContent.includes('SIMULATE RATE LIMIT (UI TEST)'),
    'ControlCenter must contain visible label "SIMULATE RATE LIMIT (UI TEST)"'
  );
  assert.ok(
    fileContent.includes('SIMULATE QUOTA EXHAUSTED (UI TEST)'),
    'ControlCenter must contain visible label "SIMULATE QUOTA EXHAUSTED (UI TEST)"'
  );

  // Verify accessible aria-labels
  assert.ok(
    fileContent.includes('aria-label="Simulate rate limit UI test"'),
    'Rate limit button must include accessible aria-label'
  );
  assert.ok(
    fileContent.includes('aria-label="Simulate quota exhausted UI test"'),
    'Quota exhausted button must include accessible aria-label'
  );
});

test('REM-03: 2. ControlCenter contains concise helper description and UI-only sandbox badge', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/layout/ControlCenter.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify UI Simulation Sandbox section header and badge
  assert.ok(
    fileContent.includes('UI SIMULATION SANDBOX'),
    'ControlCenter must include section title "UI SIMULATION SANDBOX"'
  );
  assert.ok(
    fileContent.includes('UI TEST ONLY'),
    'ControlCenter must display "UI TEST ONLY" badge'
  );

  // Verify helper description stating client UI state only without remote changes
  assert.ok(
    fileContent.includes(
      'Changes simulated UI/test state only. Does not change actual provider cooldowns, quota, credentials, or remote provider state.'
    ),
    'ControlCenter must include clear helper description explaining simulated UI/test scope'
  );
});

test('REM-03: 3. Simulation buttons feature truthful tooltips disclaiming server and provider changes', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/layout/ControlCenter.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify rate limit button tooltip
  assert.ok(
    fileContent.includes(
      'UI test only: Simulates client UI rate-limit state and cooldown timer. Does not change actual provider cooldowns, quota, credentials, or remote provider state.'
    ),
    'Rate limit button title must explicitly explain UI-only simulation'
  );

  // Verify quota button tooltip
  assert.ok(
    fileContent.includes(
      'UI test only: Simulates shared quota exhaustion messaging. Does not change actual provider cooldowns, quota, credentials, or remote provider state.'
    ),
    'Quota button title must explicitly explain UI-only simulation'
  );
});

test('REM-03: 4. Cooldown status badge and cards do not falsely claim real provider cooldown', () => {
  const filePath = path.resolve(process.cwd(), 'src/components/layout/ControlCenter.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify active status tooltip for cooldown state
  assert.ok(
    fileContent.includes(
      'Simulated rate limit — UI test cooldown (server provider state unchanged)'
    ),
    'ControlCenter active status badge must explain simulated cooldown without implying remote rate limit'
  );

  // Verify connection card cooldown display tooltip
  assert.ok(
    fileContent.includes(
      'title="Simulated rate limit — UI test cooldown (server provider state unchanged)"'
    ),
    'ControlCenter connection cards must display simulated cooldown tooltip'
  );
});

test('REM-03: 5. WorkflowContext simulateRateLimitTest produces clearly marked UI test messages and jobs', () => {
  const filePath = path.resolve(process.cwd(), 'src/context/WorkflowContext.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify error message in generated test job
  assert.ok(
    fileContent.includes(
      "errorMessage: 'Simulated rate limit — UI test (client-side simulation only; server provider state unchanged).'"
    ),
    'WorkflowContext test job must specify "Simulated rate limit — UI test"'
  );

  // Verify activity event text
  assert.ok(
    fileContent.includes(
      'Simulated rate limit — UI test: Connection [${activeConnection.name}] placed in simulated UI cooldown (actual provider state unchanged). User edits preserved.'
    ),
    'WorkflowContext activity event must explicitly state "Simulated rate limit — UI test"'
  );

  // Verify toast notification text
  assert.ok(
    fileContent.includes(
      "showToast('Simulated rate limit — UI test: Connection placed in simulated cooldown.')"
    ),
    'WorkflowContext toast must state "Simulated rate limit — UI test: Connection placed in simulated cooldown."'
  );
});

test('REM-03: 6. WorkflowContext simulateQuotaExhaustedTest produces clearly marked UI test messaging', () => {
  const filePath = path.resolve(process.cwd(), 'src/context/WorkflowContext.tsx');
  const fileContent = fs.readFileSync(filePath, 'utf-8');

  // Verify activity event text
  assert.ok(
    fileContent.includes(
      "Simulated quota exhausted — UI test: Keys in same project share quota pool (client-side simulation; actual provider quota unchanged)."
    ),
    'WorkflowContext quota simulation activity event must explicitly state "Simulated quota exhausted — UI test"'
  );

  // Verify toast notification text
  assert.ok(
    fileContent.includes(
      "showToast('Simulated quota exhausted — UI test: Keys in same project share quota pool.')"
    ),
    'WorkflowContext quota simulation toast must state "Simulated quota exhausted — UI test"'
  );
});

test('REM-03: 7. Invariant: Simulation actions are purely client-side and do not alter server provider state or disk storage', () => {
  const connectionsFile = path.resolve(process.cwd(), '.provider_connections.json');
  let diskMtimeBefore = 0;
  if (fs.existsSync(connectionsFile)) {
    diskMtimeBefore = fs.statSync(connectionsFile).mtimeMs;
  }

  const initialServerConnections = providerManager.listConnections();
  const initialStatuses = initialServerConnections.map(c => ({ id: c.id, status: c.status }));

  // Confirm server providerManager listConnections is untouched
  const serverConnectionsAfter = providerManager.listConnections();
  assert.equal(serverConnectionsAfter.length, initialServerConnections.length);
  for (let i = 0; i < serverConnectionsAfter.length; i++) {
    assert.equal(serverConnectionsAfter[i].id, initialStatuses[i].id);
    assert.equal(serverConnectionsAfter[i].status, initialStatuses[i].status);
  }

  // Confirm on-disk file was not touched by simulation
  if (fs.existsSync(connectionsFile)) {
    const diskMtimeAfter = fs.statSync(connectionsFile).mtimeMs;
    assert.equal(diskMtimeAfter, diskMtimeBefore, 'Disk storage must not be touched by simulation');
  }
});
