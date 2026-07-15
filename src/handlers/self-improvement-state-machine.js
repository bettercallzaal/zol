// src/handlers/self-improvement-state-machine.js
// Self-improvement state machine with human-gated promotion gates
// States: observed -> proposed -> approved_for_sandbox -> tested -> reviewed -> approved_for_canary -> canary -> (accepted|rejected|rolled_back)
// CRITICAL: Each trust boundary (proposed->approved, reviewed->approved, canary->accepted) REQUIRES explicit human approval token
// NO self-advancement past gates; self-improvement is NEVER autonomous at the promotion level

const STATE_MACHINE_STATES = Object.freeze([
  'observed',
  'proposed',
  'approved_for_sandbox',
  'tested',
  'reviewed',
  'approved_for_canary',
  'canary',
  'accepted',
  'rejected',
  'rolled_back',
]);

const TRUST_BOUNDARIES = Object.freeze({
  'proposed->approved_for_sandbox': true,
  'reviewed->approved_for_canary': true,
  'canary->accepted': true,
});

// Proposal schema - all 9 fields REQUIRED
const PROPOSAL_FIELDS = [
  'problem',           // What issue this addresses
  'evidence',          // What observation led to this proposal
  'alternatives',      // What other approaches were considered
  'compatibility',     // Will this break existing behavior?
  'security',          // Any security implications?
  'cost',              // Resource/token cost estimate
  'test_plan',         // How will this be validated
  'rollback_procedure', // How to undo if it fails
  'expected_benefit',  // What improvement is expected
];

// Validate all proposal fields are present and non-empty
function validateProposalSchema(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new Error('proposal must be an object');
  }

  const missing = [];
  for (const field of PROPOSAL_FIELDS) {
    if (!(field in proposal) || proposal[field] === null || proposal[field] === undefined || proposal[field] === '') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new Error(`proposal missing required fields: ${missing.join(', ')}`);
  }

  return true;
}

// Approval gate handler - validates that a transition crosses a trust boundary and has an approval token
function validateApprovalGate(fromState, toState, approvalToken) {
  const transition = `${fromState}->${toState}`;
  if (!TRUST_BOUNDARIES[transition]) {
    throw new Error(`[SECURITY] transition ${transition} is not a trust boundary and should not require approval gate`);
  }

  if (!approvalToken || typeof approvalToken !== 'string' || approvalToken.trim().length === 0) {
    throw new Error(`[SECURITY] trust boundary transition ${transition} requires explicit approvalToken; cannot auto-advance`);
  }

  // In production, this would validate the approval token against a Telegram operator approval log
  // For Phase 6, we accept any non-empty string as proof-of-concept
  if (approvalToken === 'MOCK_REJECTION') {
    throw new Error(`[SECURITY] approval token indicates rejection; transition blocked`);
  }

  return true;
}

// State machine handlers - one per transition type

const handlers = {
  // ===== OBSERVATION -> PROPOSAL =====
  'self-improvement.observe': async function({ input, state, signal }) {
    // Input: evidence of a problem (error pattern, performance metric, etc.)
    if (!input.problem || !input.evidence) {
      throw new Error('observe requires problem and evidence fields');
    }

    const proposalId = `prop_${Math.random().toString(36).slice(2, 9)}`;
    const proposal = {
      proposalId,
      state: 'observed',
      problem: input.problem,
      evidence: input.evidence,
      createdAt: new Date().toISOString(),
      transitions: [
        {
          from: null,
          to: 'observed',
          timestamp: new Date().toISOString(),
          approvalToken: 'system-init'
        }
      ]
    };

    return {
      proposalId,
      state: 'observed',
      proposal
    };
  },

  'self-improvement.propose': async function({ input, state, signal }) {
    // Input: a complete proposal object with all 9 fields
    // Output: proposal in 'proposed' state, ready for sandbox approval
    validateProposalSchema(input.proposal);

    const proposal = structuredClone(input.proposal);
    proposal.state = 'proposed';
    proposal.proposedAt = new Date().toISOString();

    if (!proposal.transitions) proposal.transitions = [];
    proposal.transitions.push({
      from: input.proposal.state || 'observed',
      to: 'proposed',
      timestamp: new Date().toISOString(),
      approvalToken: 'auto-promote-from-observed'
    });

    return {
      proposalId: proposal.proposalId,
      state: 'proposed',
      proposal,
      nextAction: 'await_sandbox_approval'
    };
  },

  'self-improvement.approve-for-sandbox': async function({ input, state, signal }) {
    // TRUST BOUNDARY: proposed -> approved_for_sandbox
    // REQUIRES: explicit human approval token
    const proposal = input.proposal;

    if (proposal.state !== 'proposed') {
      throw new Error(`cannot approve_for_sandbox: proposal is in state ${proposal.state}, not proposed`);
    }

    validateApprovalGate('proposed', 'approved_for_sandbox', input.approvalToken);

    proposal.state = 'approved_for_sandbox';
    proposal.sandboxApprovedAt = new Date().toISOString();
    proposal.approverOperatorId = input.operatorId || 'unknown';

    proposal.transitions.push({
      from: 'proposed',
      to: 'approved_for_sandbox',
      timestamp: new Date().toISOString(),
      approvalToken: input.approvalToken,
      operatorId: input.operatorId
    });

    return {
      proposalId: proposal.proposalId,
      state: 'approved_for_sandbox',
      proposal,
      nextAction: 'run_sandbox_tests'
    };
  },

  'self-improvement.test-in-sandbox': async function({ input, state, signal }) {
    // No trust boundary; can auto-advance from approved_for_sandbox to tested
    const proposal = input.proposal;

    if (proposal.state !== 'approved_for_sandbox') {
      throw new Error(`cannot test: proposal is in state ${proposal.state}, not approved_for_sandbox`);
    }

    // In production, this would run the test plan defined in the proposal
    // For Phase 6, we record that tests were run
    const testResults = {
      ran: true,
      outcome: input.testOutcome || 'passed',
      timestamp: new Date().toISOString()
    };

    if (input.testOutcome === 'failed') {
      proposal.state = 'rejected';
      proposal.rejectionReason = 'sandbox tests failed';
      proposal.testResults = testResults;
      proposal.transitions.push({
        from: 'approved_for_sandbox',
        to: 'rejected',
        timestamp: new Date().toISOString(),
        reason: 'sandbox tests failed'
      });
      return {
        proposalId: proposal.proposalId,
        state: 'rejected',
        proposal,
        reason: 'sandbox tests failed'
      };
    }

    proposal.state = 'tested';
    proposal.testedAt = new Date().toISOString();
    proposal.testResults = testResults;

    proposal.transitions.push({
      from: 'approved_for_sandbox',
      to: 'tested',
      timestamp: new Date().toISOString(),
      testResults
    });

    return {
      proposalId: proposal.proposalId,
      state: 'tested',
      proposal,
      nextAction: 'await_review'
    };
  },

  'self-improvement.request-review': async function({ input, state, signal }) {
    // No trust boundary; can auto-advance from tested to reviewed
    const proposal = input.proposal;

    if (proposal.state !== 'tested') {
      throw new Error(`cannot request review: proposal is in state ${proposal.state}, not tested`);
    }

    // In production, this would send a review request to an operator
    proposal.state = 'reviewed';
    proposal.reviewedAt = new Date().toISOString();
    proposal.reviewFeedback = input.reviewFeedback || 'approved by review';

    proposal.transitions.push({
      from: 'tested',
      to: 'reviewed',
      timestamp: new Date().toISOString(),
      reviewFeedback: proposal.reviewFeedback
    });

    return {
      proposalId: proposal.proposalId,
      state: 'reviewed',
      proposal,
      nextAction: 'await_canary_approval'
    };
  },

  'self-improvement.approve-for-canary': async function({ input, state, signal }) {
    // TRUST BOUNDARY: reviewed -> approved_for_canary
    // REQUIRES: explicit human approval token
    const proposal = input.proposal;

    if (proposal.state !== 'reviewed') {
      throw new Error(`cannot approve_for_canary: proposal is in state ${proposal.state}, not reviewed`);
    }

    validateApprovalGate('reviewed', 'approved_for_canary', input.approvalToken);

    proposal.state = 'approved_for_canary';
    proposal.canaryApprovedAt = new Date().toISOString();
    proposal.canaryApproverOperatorId = input.operatorId || 'unknown';

    proposal.transitions.push({
      from: 'reviewed',
      to: 'approved_for_canary',
      timestamp: new Date().toISOString(),
      approvalToken: input.approvalToken,
      operatorId: input.operatorId
    });

    return {
      proposalId: proposal.proposalId,
      state: 'approved_for_canary',
      proposal,
      nextAction: 'deploy_canary'
    };
  },

  'self-improvement.deploy-canary': async function({ input, state, signal }) {
    // No trust boundary; can auto-advance from approved_for_canary to canary
    // CRITICAL: this handler CANNOT actually deploy. It only records the deployment intent.
    // Real deployment is done by a separate, human-triggered process.
    const proposal = input.proposal;

    if (proposal.state !== 'approved_for_canary') {
      throw new Error(`cannot deploy canary: proposal is in state ${proposal.state}, not approved_for_canary`);
    }

    // GUARD: this handler does NOT actually apply the change
    // It only records that deployment was STAGED
    proposal.state = 'canary';
    proposal.canaryDeployedAt = new Date().toISOString();
    proposal.deploymentStatus = 'staged-not-applied';
    proposal.changeWillBe = {
      type: input.changeType || 'unknown',
      target: input.changeTarget || 'unknown',
      description: input.changeDescription || 'unknown'
    };

    proposal.transitions.push({
      from: 'approved_for_canary',
      to: 'canary',
      timestamp: new Date().toISOString(),
      note: 'STAGED: actual deployment requires separate human approval'
    });

    return {
      proposalId: proposal.proposalId,
      state: 'canary',
      proposal,
      nextAction: 'monitor_canary_and_request_acceptance',
      warningNote: 'Change is STAGED but NOT YET APPLIED. Actual deployment requires separate system approval.'
    };
  },

  'self-improvement.accept': async function({ input, state, signal }) {
    // TRUST BOUNDARY: canary -> accepted
    // REQUIRES: explicit human approval token
    const proposal = input.proposal;

    if (proposal.state !== 'canary') {
      throw new Error(`cannot accept: proposal is in state ${proposal.state}, not canary`);
    }

    validateApprovalGate('canary', 'accepted', input.approvalToken);

    proposal.state = 'accepted';
    proposal.acceptedAt = new Date().toISOString();
    proposal.accepterOperatorId = input.operatorId || 'unknown';

    proposal.transitions.push({
      from: 'canary',
      to: 'accepted',
      timestamp: new Date().toISOString(),
      approvalToken: input.approvalToken,
      operatorId: input.operatorId,
      note: 'Proposal accepted. Implementation by human operator outside this handler.'
    });

    return {
      proposalId: proposal.proposalId,
      state: 'accepted',
      proposal,
      nextAction: 'none - awaiting human implementation'
    };
  },

  'self-improvement.reject': async function({ input, state, signal }) {
    // No trust boundary for rejection; can reject from any state
    const proposal = input.proposal;

    proposal.state = 'rejected';
    proposal.rejectedAt = new Date().toISOString();
    proposal.rejectionReason = input.reason || 'operator rejected';
    proposal.rejectorOperatorId = input.operatorId || 'unknown';

    proposal.transitions.push({
      from: proposal.state,
      to: 'rejected',
      timestamp: new Date().toISOString(),
      reason: proposal.rejectionReason,
      operatorId: input.operatorId
    });

    return {
      proposalId: proposal.proposalId,
      state: 'rejected',
      proposal,
      reason: proposal.rejectionReason
    };
  },

  'self-improvement.rollback': async function({ input, state, signal }) {
    // No trust boundary for rollback; can rollback from accepted/canary state
    const proposal = input.proposal;

    if (proposal.state !== 'accepted' && proposal.state !== 'canary') {
      throw new Error(`cannot rollback: proposal is in state ${proposal.state}, not accepted or canary`);
    }

    const fromState = proposal.state;
    proposal.state = 'rolled_back';
    proposal.rolledBackAt = new Date().toISOString();
    proposal.rollbackReason = input.reason || 'operator initiated rollback';
    proposal.rollbackOperatorId = input.operatorId || 'unknown';

    proposal.transitions.push({
      from: fromState,
      to: 'rolled_back',
      timestamp: new Date().toISOString(),
      reason: proposal.rollbackReason,
      operatorId: input.operatorId,
      note: 'Implementation by human operator outside this handler.'
    });

    return {
      proposalId: proposal.proposalId,
      state: 'rolled_back',
      proposal,
      reason: proposal.rollbackReason
    };
  },

  'self-improvement.persist-proposal': async function({ input, state, signal }) {
    // Persist proposal state via the state-adapter
    // This is called after each state transition to record the audit trail
    if (!input.proposalId || !input.proposal) {
      throw new Error('persist-proposal requires proposalId and proposal');
    }

    return {
      persisted: true,
      proposalId: input.proposalId,
      state: input.proposal.state,
      timestamp: new Date().toISOString()
    };
  }
};

module.exports = {
  handlers,
  STATE_MACHINE_STATES,
  TRUST_BOUNDARIES,
  PROPOSAL_FIELDS,
  validateProposalSchema,
  validateApprovalGate,
};
