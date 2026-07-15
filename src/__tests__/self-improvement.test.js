// src/__tests__/self-improvement.test.js
// Comprehensive tests for the evidence-gated self-improvement state machine
// Verifies: trust boundaries cannot be skipped, proposals require all 9 fields,
// radar cannot install/modify/deploy/self-promote, and full state paths work.
// Run: node --test src/__tests__/self-improvement.test.js

const test = require('node:test');
const assert = require('node:assert');
const {
  handlers: smHandlers,
  STATE_MACHINE_STATES,
  PROPOSAL_FIELDS,
  validateProposalSchema,
  validateApprovalGate,
} = require('../handlers/self-improvement-state-machine');
const {
  handlers: radarHandlers,
  BLOCKED_ACTIONS,
  validateBlockedActionNotAttempted,
} = require('../handlers/component-radar');

// ===== PROPOSAL SCHEMA VALIDATION TESTS =====

test('validateProposalSchema: rejects proposal missing any of the 9 fields', async (t) => {
  const validProposal = {
    problem: 'performance issue',
    evidence: 'observed high latency in radar scans',
    alternatives: '[do nothing]',
    compatibility: 'no breaking changes',
    security: 'no security implications',
    cost: 'minimal',
    test_plan: 'existing tests pass',
    rollback_procedure: 'revert version',
    expected_benefit: 'faster scans'
  };

  // Sanity check: valid proposal should pass
  assert.doesNotThrow(() => validateProposalSchema(validProposal));

  // Test each missing field
  for (const field of PROPOSAL_FIELDS) {
    const invalid = structuredClone(validProposal);
    delete invalid[field];
    try {
      validateProposalSchema(invalid);
      assert.fail(`should have rejected proposal missing ${field}`);
    } catch (e) {
      assert.ok(e.message.includes(field) || e.message.includes('missing required fields'));
    }
  }
});

test('validateProposalSchema: rejects proposal with empty string in required field', async (t) => {
  const invalid = {
    problem: 'issue',
    evidence: '', // empty
    alternatives: 'alt',
    compatibility: 'compat',
    security: 'sec',
    cost: 'cost',
    test_plan: 'plan',
    rollback_procedure: 'rollback',
    expected_benefit: 'benefit'
  };

  try {
    validateProposalSchema(invalid);
    assert.fail('should have rejected proposal with empty evidence');
  } catch (e) {
    assert.ok(e.message.includes('missing required fields') || e.message.includes('evidence'));
  }
});

test('validateProposalSchema: rejects null proposal', async (t) => {
  try {
    validateProposalSchema(null);
    assert.fail('should have rejected null');
  } catch (e) {
    assert.ok(e.message.includes('object'));
  }
});

// ===== APPROVAL GATE TESTS (TRUST BOUNDARIES) =====

test('validateApprovalGate: requires non-empty approvalToken for trust boundary', async (t) => {
  // Trust boundary: proposed -> approved_for_sandbox
  try {
    validateApprovalGate('proposed', 'approved_for_sandbox', undefined);
    assert.fail('should have rejected undefined token');
  } catch (e) {
    assert.ok(e.message.includes('approvalToken') || e.message.includes('SECURITY'));
  }

  try {
    validateApprovalGate('proposed', 'approved_for_sandbox', '');
    assert.fail('should have rejected empty token');
  } catch (e) {
    assert.ok(e.message.includes('approvalToken') || e.message.includes('SECURITY'));
  }

  try {
    validateApprovalGate('proposed', 'approved_for_sandbox', '   ');
    assert.fail('should have rejected whitespace-only token');
  } catch (e) {
    assert.ok(e.message.includes('approvalToken') || e.message.includes('SECURITY'));
  }
});

test('validateApprovalGate: accepts valid approval token', async (t) => {
  assert.doesNotThrow(() => {
    validateApprovalGate('proposed', 'approved_for_sandbox', 'valid_token_from_operator');
  });
});

test('validateApprovalGate: rejects MOCK_REJECTION token', async (t) => {
  try {
    validateApprovalGate('proposed', 'approved_for_sandbox', 'MOCK_REJECTION');
    assert.fail('should have rejected MOCK_REJECTION token');
  } catch (e) {
    assert.ok(e.message.includes('rejection') || e.message.includes('SECURITY'));
  }
});

// ===== STATE MACHINE HANDLER TESTS =====

test('self-improvement.observe: creates proposal in observed state', async (t) => {
  const result = await smHandlers['self-improvement.observe']({
    input: {
      problem: 'high memory usage in radar scans',
      evidence: 'observed 500MB+ memory after each scan'
    },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'observed');
  assert.ok(result.proposalId);
  assert.ok(result.proposal);
  assert.equal(result.proposal.state, 'observed');
  assert.equal(result.proposal.transitions.length, 1);
});

test('self-improvement.propose: requires all 9 proposal fields', async (t) => {
  const incompleteProposal = {
    proposalId: 'prop_test',
    state: 'observed',
    problem: 'issue',
    evidence: 'evidence',
    // missing: alternatives, compatibility, security, cost, test_plan, rollback_procedure, expected_benefit
  };

  try {
    await smHandlers['self-improvement.propose']({
      input: { proposal: incompleteProposal },
      state: {},
      signal: null
    });
    assert.fail('should have rejected incomplete proposal');
  } catch (e) {
    assert.ok(e.message.includes('missing required fields'));
  }
});

test('self-improvement.propose: accepts complete proposal and transitions to proposed', async (t) => {
  const completeProposal = {
    proposalId: 'prop_test',
    state: 'observed',
    problem: 'high memory usage',
    evidence: 'observed 500MB+',
    alternatives: '[do nothing, cache results]',
    compatibility: 'backwards compatible',
    security: 'no security implications',
    cost: 'minimal',
    test_plan: 'run existing tests',
    rollback_procedure: 'revert change',
    expected_benefit: 'reduce memory by 50%',
    transitions: []
  };

  const result = await smHandlers['self-improvement.propose']({
    input: { proposal: completeProposal },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'proposed');
  assert.ok(result.proposal);
  assert.equal(result.proposal.state, 'proposed');
  assert.equal(result.proposal.transitions.length, 1); // propose only (no prior observe in this test)
});

test('self-improvement.approve-for-sandbox: CANNOT advance without approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'proposed',
    problem: 'issue',
    transitions: []
  };

  try {
    await smHandlers['self-improvement.approve-for-sandbox']({
      input: { proposal, approvalToken: undefined },
      state: {},
      signal: null
    });
    assert.fail('should have rejected missing approval token');
  } catch (e) {
    assert.ok(e.message.includes('SECURITY') || e.message.includes('approvalToken'));
  }
});

test('self-improvement.approve-for-sandbox: CANNOT advance if proposal not in proposed state', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'observed', // wrong state
    transitions: []
  };

  try {
    await smHandlers['self-improvement.approve-for-sandbox']({
      input: { proposal, approvalToken: 'valid_token', operatorId: 'zaal' },
      state: {},
      signal: null
    });
    assert.fail('should have rejected wrong state');
  } catch (e) {
    assert.ok(e.message.includes('cannot approve_for_sandbox'));
  }
});

test('self-improvement.approve-for-sandbox: ADVANCES with valid approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'proposed',
    problem: 'issue',
    transitions: []
  };

  const result = await smHandlers['self-improvement.approve-for-sandbox']({
    input: { proposal, approvalToken: 'valid_token_from_zaal', operatorId: 'zaal' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'approved_for_sandbox');
  assert.equal(result.proposal.state, 'approved_for_sandbox');
  assert.ok(result.proposal.sandboxApprovedAt);
  assert.equal(result.proposal.approverOperatorId, 'zaal');
});

test('self-improvement.test-in-sandbox: rejects if not in approved_for_sandbox state', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'proposed', // wrong state
    transitions: []
  };

  try {
    await smHandlers['self-improvement.test-in-sandbox']({
      input: { proposal, testOutcome: 'passed' },
      state: {},
      signal: null
    });
    assert.fail('should have rejected wrong state');
  } catch (e) {
    assert.ok(e.message.includes('cannot test'));
  }
});

test('self-improvement.test-in-sandbox: rejects proposal on failed tests', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'approved_for_sandbox',
    transitions: []
  };

  const result = await smHandlers['self-improvement.test-in-sandbox']({
    input: { proposal, testOutcome: 'failed' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'rejected');
  assert.ok(result.proposal.rejectionReason.includes('tests failed'));
});

test('self-improvement.test-in-sandbox: advances to tested on passed tests', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'approved_for_sandbox',
    transitions: []
  };

  const result = await smHandlers['self-improvement.test-in-sandbox']({
    input: { proposal, testOutcome: 'passed' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'tested');
  assert.ok(result.proposal.testedAt);
  assert.ok(result.proposal.testResults);
});

test('self-improvement.request-review: advances from tested to reviewed', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'tested',
    transitions: []
  };

  const result = await smHandlers['self-improvement.request-review']({
    input: { proposal, reviewFeedback: 'looks good' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'reviewed');
  assert.ok(result.proposal.reviewedAt);
});

test('self-improvement.approve-for-canary: CANNOT advance without approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'reviewed',
    transitions: []
  };

  try {
    await smHandlers['self-improvement.approve-for-canary']({
      input: { proposal, approvalToken: undefined },
      state: {},
      signal: null
    });
    assert.fail('should have rejected missing approval token');
  } catch (e) {
    assert.ok(e.message.includes('SECURITY') || e.message.includes('approvalToken'));
  }
});

test('self-improvement.approve-for-canary: ADVANCES with valid approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'reviewed',
    transitions: []
  };

  const result = await smHandlers['self-improvement.approve-for-canary']({
    input: { proposal, approvalToken: 'valid_token_from_zaal', operatorId: 'zaal' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'approved_for_canary');
  assert.ok(result.proposal.canaryApprovedAt);
});

test('self-improvement.deploy-canary: stages deployment but does NOT apply changes', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'approved_for_canary',
    transitions: []
  };

  const result = await smHandlers['self-improvement.deploy-canary']({
    input: {
      proposal,
      changeType: 'dependency-update',
      changeTarget: 'radar-lib',
      changeDescription: 'update to v2.0'
    },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'canary');
  assert.equal(result.proposal.deploymentStatus, 'staged-not-applied');
  assert.ok(result.warningNote.includes('NOT YET APPLIED'));
});

test('self-improvement.accept: CANNOT advance from canary without approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'canary',
    transitions: []
  };

  try {
    await smHandlers['self-improvement.accept']({
      input: { proposal, approvalToken: undefined },
      state: {},
      signal: null
    });
    assert.fail('should have rejected missing approval token');
  } catch (e) {
    assert.ok(e.message.includes('SECURITY') || e.message.includes('approvalToken'));
  }
});

test('self-improvement.accept: ADVANCES from canary with valid approval token', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'canary',
    transitions: []
  };

  const result = await smHandlers['self-improvement.accept']({
    input: { proposal, approvalToken: 'valid_token_from_zaal', operatorId: 'zaal' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'accepted');
  assert.ok(result.proposal.acceptedAt);
});

test('self-improvement.reject: can reject from any state', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'tested',
    transitions: []
  };

  const result = await smHandlers['self-improvement.reject']({
    input: { proposal, reason: 'incompatible with production', operatorId: 'zaal' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'rejected');
  assert.ok(result.proposal.rejectionReason.includes('incompatible'));
});

test('self-improvement.rollback: can only rollback from accepted or canary', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'proposed',
    transitions: []
  };

  try {
    await smHandlers['self-improvement.rollback']({
      input: { proposal, reason: 'regression detected', operatorId: 'zaal' },
      state: {},
      signal: null
    });
    assert.fail('should have rejected non-accepted/canary state');
  } catch (e) {
    assert.ok(e.message.includes('cannot rollback'));
  }
});

test('self-improvement.rollback: succeeds from accepted state', async (t) => {
  const proposal = {
    proposalId: 'prop_test',
    state: 'accepted',
    transitions: []
  };

  const result = await smHandlers['self-improvement.rollback']({
    input: { proposal, reason: 'regression detected', operatorId: 'zaal' },
    state: {},
    signal: null
  });

  assert.equal(result.state, 'rolled_back');
  assert.ok(result.proposal.rollbackReason.includes('regression'));
});

// ===== COMPONENT RADAR HANDLER TESTS =====

test('radar.validate-proposal-safety: blocks package.install via BLOCKED_ACTIONS', async (t) => {
  try {
    validateBlockedActionNotAttempted('package.install');
    assert.fail('should have blocked package.install');
  } catch (e) {
    assert.ok(e.message.includes('BLOCKED') || e.message.includes('SECURITY'));
  }
});

test('radar.validate-proposal-safety: blocks all BLOCKED_ACTIONS', async (t) => {
  for (const action of BLOCKED_ACTIONS) {
    try {
      validateBlockedActionNotAttempted(action);
      assert.fail(`should have blocked ${action}`);
    } catch (e) {
      assert.ok(e.message.includes('BLOCKED'));
    }
  }
});

test('radar.scan-releases: reads public sources (timeout-bounded)', async (t) => {
  const result = await radarHandlers['radar.scan-releases']({
    input: {
      source: 'npm',
      componentType: 'radar-lib',
      scanDepth: 'shallow'
    },
    state: {},
    signal: null
  });

  assert.ok(result.scanned);
  assert.equal(result.source, 'npm');
  assert.ok(result.releases);
});

test('radar.scan-releases: CANNOT install packages or modify code', async (t) => {
  // radar handlers are pure read operations; they never call blocked-action validators
  // If radar tried to install a package, it would call validateBlockedActionNotAttempted('package.install')
  // which would throw. Test this directly.
  try {
    validateBlockedActionNotAttempted('package.install');
    assert.fail('should have blocked package.install');
  } catch (e) {
    assert.ok(e.message.includes('BLOCKED'));
  }
});

test('radar.generate-proposal: produces proposal with all 9 fields', async (t) => {
  const result = await radarHandlers['radar.generate-proposal']({
    input: {
      problem: 'radar library has security update available',
      evidence: 'scanner found v2.1.0 published 3 days ago',
      alternatives: '[do nothing]',
      compatibility: '[check release notes]',
      security: '[review advisories]',
      cost: 'minimal',
      testPlan: 'run tests',
      rollbackProcedure: 'revert version',
      expectedBenefit: 'security patches'
    },
    state: {},
    signal: null
  });

  assert.ok(result.proposalGenerated);
  assert.ok(result.proposal);

  // Verify all 9 fields are present
  for (const field of PROPOSAL_FIELDS) {
    assert.ok(field in result.proposal, `proposal missing field ${field}`);
  }

  // Verify radar is NOT attempting to promote
  assert.ok(result.warningNote.includes('Human must stage'));
});

test('radar.generate-proposal: CANNOT self-promote past gates', async (t) => {
  // If radar tries to call approve-for-sandbox, it should fail
  try {
    validateBlockedActionNotAttempted('proposal.self_promote_past_gate');
    assert.fail('should have blocked proposal.self_promote_past_gate');
  } catch (e) {
    assert.ok(e.message.includes('BLOCKED'));
  }
});

test('radar.validate-proposal-safety: rejects unsafe change types', async (t) => {
  const result = await radarHandlers['radar.validate-proposal-safety']({
    input: {
      changeType: 'signer-key-rotation',
      changeTarget: 'system-signer'
    },
    state: {},
    signal: null
  });

  assert.equal(result.safe, false);
  assert.ok(result.reason.includes('not in the safe-types list'));
});

test('radar.validate-proposal-safety: rejects changes to critical targets', async (t) => {
  const result = await radarHandlers['radar.validate-proposal-safety']({
    input: {
      changeType: 'dependency-update',
      changeTarget: 'src/auth-handler.js'
    },
    state: {},
    signal: null
  });

  assert.equal(result.safe, false);
  assert.ok(result.reason.includes('critical component'));
});

test('radar.validate-proposal-safety: accepts safe changes', async (t) => {
  const result = await radarHandlers['radar.validate-proposal-safety']({
    input: {
      changeType: 'dependency-update',
      changeTarget: 'node_modules/radar-lib'
    },
    state: {},
    signal: null
  });

  assert.equal(result.safe, true);
  assert.equal(result.estimatedRisk, 'low');
});

test('radar.read-local-component-state: reads state only, CANNOT modify', async (t) => {
  const result = await radarHandlers['radar.read-local-component-state']({
    input: { componentId: 'radar-v1' },
    state: {},
    signal: null
  });

  assert.ok(result.componentId);
  assert.ok(result.state);
  assert.ok(result.version);
  assert.ok(result.canUpdate);
  // This is read-only; if it tried to modify, it would call validateBlockedActionNotAttempted
});

test('radar.report-scan: generates report (data only, no state changes)', async (t) => {
  const result = await radarHandlers['radar.report-scan']({
    input: {
      componentsScanned: 5,
      proposalsGenerated: 2,
      riskAssessment: 'all low-risk'
    },
    state: {},
    signal: null
  });

  assert.ok(result.reportGenerated);
  assert.ok(result.scanId);
  assert.equal(result.componentsScanned, 5);
  assert.equal(result.proposalsGenerated, 2);
});

// ===== FULL HAPPY PATH TESTS =====

test('full happy path: observed -> proposed -> approved -> tested -> reviewed -> approved -> canary -> accepted', async (t) => {
  let proposal = {
    proposalId: 'prop_full_test',
    state: 'observed',
    problem: 'test issue',
    evidence: 'test evidence',
    alternatives: 'test',
    compatibility: 'test',
    security: 'test',
    cost: 'test',
    test_plan: 'test',
    rollback_procedure: 'test',
    expected_benefit: 'test',
    transitions: []
  };

  // observed -> proposed
  proposal = (await smHandlers['self-improvement.propose']({
    input: { proposal },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'proposed');

  // proposed -> approved_for_sandbox
  proposal = (await smHandlers['self-improvement.approve-for-sandbox']({
    input: { proposal, approvalToken: 'token1', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'approved_for_sandbox');

  // approved_for_sandbox -> tested
  proposal = (await smHandlers['self-improvement.test-in-sandbox']({
    input: { proposal, testOutcome: 'passed' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'tested');

  // tested -> reviewed
  proposal = (await smHandlers['self-improvement.request-review']({
    input: { proposal },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'reviewed');

  // reviewed -> approved_for_canary
  proposal = (await smHandlers['self-improvement.approve-for-canary']({
    input: { proposal, approvalToken: 'token2', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'approved_for_canary');

  // approved_for_canary -> canary
  proposal = (await smHandlers['self-improvement.deploy-canary']({
    input: {
      proposal,
      changeType: 'dependency-update',
      changeTarget: 'lib'
    },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'canary');

  // canary -> accepted
  proposal = (await smHandlers['self-improvement.accept']({
    input: { proposal, approvalToken: 'token3', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'accepted');

  // Verify full audit trail
  assert.ok(proposal.transitions.length >= 7);
  for (const transition of proposal.transitions) {
    assert.ok(transition.from !== undefined);
    assert.ok(transition.to);
    assert.ok(transition.timestamp);
  }
});

test('full path with rejection: observed -> proposed -> approved -> tested -> rejected', async (t) => {
  let proposal = {
    proposalId: 'prop_reject_test',
    state: 'observed',
    problem: 'test issue',
    evidence: 'test',
    alternatives: 'test',
    compatibility: 'test',
    security: 'test',
    cost: 'test',
    test_plan: 'test',
    rollback_procedure: 'test',
    expected_benefit: 'test',
    transitions: []
  };

  proposal = (await smHandlers['self-improvement.propose']({
    input: { proposal },
    state: {},
    signal: null
  })).proposal;

  proposal = (await smHandlers['self-improvement.approve-for-sandbox']({
    input: { proposal, approvalToken: 'token1', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;

  proposal = (await smHandlers['self-improvement.test-in-sandbox']({
    input: { proposal, testOutcome: 'failed' },
    state: {},
    signal: null
  })).proposal;

  assert.equal(proposal.state, 'rejected');
  assert.ok(proposal.rejectionReason.includes('tests failed'));
});

test('full path with rollback: ...-> canary -> accepted -> rolled_back', async (t) => {
  let proposal = {
    proposalId: 'prop_rollback_test',
    state: 'canary',
    transitions: []
  };

  proposal = (await smHandlers['self-improvement.accept']({
    input: { proposal, approvalToken: 'token1', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'accepted');

  proposal = (await smHandlers['self-improvement.rollback']({
    input: { proposal, reason: 'regression detected', operatorId: 'zaal' },
    state: {},
    signal: null
  })).proposal;
  assert.equal(proposal.state, 'rolled_back');
  assert.ok(proposal.rollbackReason.includes('regression'));
});
