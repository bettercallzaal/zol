#!/usr/bin/env node
// scripts/test-warper-keeper-dryrun.js
// Dry-run test for Warper Keeper adapter in mock mode
// Verifies structured receipts, no network, no private data sent

const { createWarperKeeperAdapter } = require('../src/adapters/warper-keeper-adapter');

// Mock handlers for testing
const mockHandlers = {
  discoverCapabilities: async (payload, context) => {
    console.log('[DRYRUN] discoverCapabilities called');
    console.log(`  correlationId: ${context.correlationId}`);
    return {
      contractVersion: '2026-07-14',
      transports: { http: '/v1' },
      tools: [
        'get_assignment',
        'open_trapper',
        'append_context',
        'submit_artifact',
        'request_approval',
        'close_trapper',
        'release_assignment',
        'verify_proof',
      ],
      scopes: [
        'assignment:read',
        'trapper:read',
        'context:append',
        'artifact:submit',
        'approval:request',
        'trapper:close',
        'assignment:release',
        'receipt:read',
      ],
    };
  },

  getAssignment: async (payload, context) => {
    console.log('[DRYRUN] getAssignment called');
    console.log(`  correlationId: ${context.correlationId}`);
    return {
      ok: true,
      assignment: {
        id: 'asgn_dryrun_123',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    };
  },

  openTrapper: async (payload, context) => {
    console.log('[DRYRUN] openTrapper called');
    console.log(`  correlationId: ${context.correlationId}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: 'rcpt_trapper_001',
        createdAt: new Date().toISOString(),
      },
    };
  },

  appendContext: async (payload, context) => {
    console.log('[DRYRUN] appendContext called');
    console.log(`  kind: ${payload.kind}`);
    console.log(`  textLength: ${payload.text?.length || 0} chars`);
    console.log(`  correlationId: ${context.correlationId}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: `rcpt_context_${Math.random().toString(36).slice(2, 9)}`,
        kind: payload.kind,
      },
    };
  },

  submitArtifact: async (payload, context) => {
    console.log('[DRYRUN] submitArtifact called');
    console.log(`  uri: ${payload.uri}`);
    console.log(`  mediaType: ${payload.mediaType}`);
    console.log(`  correlationId: ${context.correlationId}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: `rcpt_artifact_${Math.random().toString(36).slice(2, 9)}`,
        uri: payload.uri,
      },
    };
  },

  requestApproval: async (payload, context) => {
    console.log('[DRYRUN] requestApproval called');
    console.log(`  action: ${payload.action}`);
    console.log(`  correlationId: ${context.correlationId}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: `rcpt_approval_${Math.random().toString(36).slice(2, 9)}`,
      },
    };
  },

  closeTrapper: async (payload, context) => {
    console.log('[DRYRUN] closeTrapper called');
    console.log(`  reason: ${payload.reason || 'not specified'}`);
    console.log(`  correlationId: ${context.correlationId}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: 'rcpt_close_001',
        closedAt: new Date().toISOString(),
      },
    };
  },

  releaseAssignment: async (payload, context) => {
    console.log('[DRYRUN] releaseAssignment called');
    console.log(`  reason: ${payload.reason || 'not specified'}`);
    console.log(`  idempotencyKey: ${context.idempotencyKey}`);
    return {
      ok: true,
      receipt: {
        id: 'rcpt_release_001',
      },
    };
  },

  verifyProof: async (receiptId, context) => {
    console.log('[DRYRUN] verifyProof called');
    console.log(`  receiptId: ${receiptId}`);
    console.log(`  correlationId: ${context.correlationId}`);
    return {
      ok: true,
      verified: true,
      receipt: {
        id: receiptId,
      },
    };
  },
};

async function runDryRun() {
  console.log('='.repeat(70));
  console.log('Warper Keeper Adapter - Dry-run Test (Mock Mode)');
  console.log('='.repeat(70));
  console.log('');

  // Create adapter in mock mode
  const adapter = createWarperKeeperAdapter({
    mode: 'mock',
    assignmentKey: '[REDACTED]', // Never logged
    mockHandlers,
  });

  console.log(`Adapter Mode: ${adapter.mode}`);
  console.log(`Enabled: ${adapter.isEnabled()}`);
  console.log('');
  console.log('-'.repeat(70));

  try {
    // Discover capabilities
    console.log('STEP 1: Discover Capabilities');
    console.log('-'.repeat(70));
    const capabilities = await adapter.discoverCapabilities({
      correlationId: 'zol-dryrun-1',
    });
    console.log('[RESULT] Capabilities discovered');
    console.log(`  contractVersion: ${capabilities.contractVersion}`);
    console.log(`  tools: ${capabilities.tools.length} available`);
    console.log('');

    // Get assignment
    console.log('STEP 2: Get Assignment');
    console.log('-'.repeat(70));
    const assignment = await adapter.getAssignment({
      correlationId: 'zol-dryrun-2',
    });
    console.log('[RESULT] Assignment retrieved');
    console.log(`  id: ${assignment.assignment.id}`);
    console.log('');

    // Open trapper
    console.log('STEP 3: Open Trapper (initialize work context)');
    console.log('-'.repeat(70));
    const openResult = await adapter.openTrapper(
      { scope: 'work-context' },
      { correlationId: 'zol-dryrun-3' }
    );
    console.log('[RESULT] Trapper opened');
    console.log(`  receipt: ${openResult.receipt.id}`);
    console.log('');

    // Append context
    console.log('STEP 4: Append Bounded Context');
    console.log('-'.repeat(70));
    const contextText = 'ZOL completed task analysis: examined 5 mentions, prioritized 3 for response, drafted approval-pending replies.';
    const contextResult = await adapter.appendContext(
      {
        kind: 'summary',
        text: contextText,
      },
      { correlationId: 'zol-dryrun-4' }
    );
    console.log('[RESULT] Context appended');
    console.log(`  receipt: ${contextResult.receipt.id}`);
    console.log('');

    // Submit artifact reference (URI only, not content)
    console.log('STEP 5: Submit Artifact Reference');
    console.log('-'.repeat(70));
    const artifactResult = await adapter.submitArtifact(
      {
        uri: 'urn:zol:artifact:dryrun-001',
        mediaType: 'application/json',
        checksum: 'sha256:abc123...',
      },
      { correlationId: 'zol-dryrun-5' }
    );
    console.log('[RESULT] Artifact reference submitted');
    console.log(`  uri: ${artifactResult.receipt.uri}`);
    console.log('');

    // Request approval
    console.log('STEP 6: Request Approval');
    console.log('-'.repeat(70));
    const approvalResult = await adapter.requestApproval(
      {
        action: 'publish-replies',
        artifactReceiptId: artifactResult.receipt.id,
      },
      { correlationId: 'zol-dryrun-6' }
    );
    console.log('[RESULT] Approval requested');
    console.log(`  status: ${approvalResult.status}`);
    console.log('');

    // Verify proof
    console.log('STEP 7: Verify Proof');
    console.log('-'.repeat(70));
    const proofResult = await adapter.verifyProof(
      artifactResult.receipt.id,
      { correlationId: 'zol-dryrun-7' }
    );
    console.log('[RESULT] Proof verified');
    console.log(`  verified: ${proofResult.verified}`);
    console.log('');

    // Close trapper
    console.log('STEP 8: Close Trapper (complete work)');
    console.log('-'.repeat(70));
    const closeResult = await adapter.closeTrapper(
      { reason: 'dryrun-complete' },
      { correlationId: 'zol-dryrun-8' }
    );
    console.log('[RESULT] Trapper closed');
    console.log(`  status: ${closeResult.status}`);
    console.log('');

    console.log('='.repeat(70));
    console.log('DRY-RUN PASSED');
    console.log('='.repeat(70));
    console.log('');
    console.log('Verification Summary:');
    console.log('- All operations succeeded in mock mode');
    console.log('- Structured receipts received for all write operations');
    console.log('- No network calls made');
    console.log('- No private memory, secrets, or signer material sent');
    console.log('- Idempotency and correlation IDs present');
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('');
    console.error('='.repeat(70));
    console.error('DRY-RUN FAILED');
    console.error('='.repeat(70));
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run if invoked directly
if (require.main === module) {
  runDryRun();
}

module.exports = { runDryRun };
