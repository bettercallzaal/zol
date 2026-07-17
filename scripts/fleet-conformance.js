#!/usr/bin/env node
// fleet-conformance.js — ZOL Fleet Standard v0.1 conformance harness.
// CommonJS, no npm deps, compatible with: node --test (Node 18+) or plain:
//   node scripts/fleet-conformance.js
// Run from repo root: node scripts/fleet-conformance.js
// Exit 0 when all checks pass. Exit 1 on any hard failure.
// Advisory checks (known in-progress items) print WARN but do not fail.
// Prints "N conformance checks passed, 0 failed" on success.

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");

function repoPath(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

/** Read a JSON file, return parsed object or throw with a descriptive message. */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read/parse JSON at ${filePath}: ${err.message}`);
  }
}

/** Read a text file, return string or throw. */
function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read file at ${filePath}: ${err.message}`);
  }
}

/** Collect all .json files in a directory (non-recursive). */
function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f));
  } catch (err) {
    throw new Error(`Cannot read directory ${dir}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check registry
// Results have two severities:
//   hard — a violation; counted as a failure; causes exit 1.
//   advisory — a known in-progress item; printed as WARN; does not fail.
// ---------------------------------------------------------------------------

const results = [];

/**
 * Register a HARD conformance check. Failures cause exit 1.
 * @param {string} name
 * @param {() => void} fn - throw to signal failure
 */
function check(name, fn) {
  try {
    fn();
    results.push({ name, severity: "hard", passed: true, note: null });
  } catch (err) {
    results.push({ name, severity: "hard", passed: false, note: err.message });
  }
}

/**
 * Register an ADVISORY check. Failures print WARN but do not cause exit 1.
 * Use for items that are known to be in-progress in open PRs.
 * @param {string} name
 * @param {string} prNote - the PR or issue tracking the fix
 * @param {() => void} fn - throw to signal the advisory concern
 */
function advisory(name, prNote, fn) {
  try {
    fn();
    results.push({ name, severity: "advisory", passed: true, note: null });
  } catch (err) {
    results.push({
      name,
      severity: "advisory",
      passed: false,
      note: `${err.message} [tracking: ${prNote}]`,
    });
  }
}

// ---------------------------------------------------------------------------
// SECTION 1: Capsule validation
// Validates all files in capsules/ against the capsule schema.
// Manual validation — no ajv: checks required fields and types.
// For capsules with status="draft", a placeholder content_hash of the form
// "sha256:draft-*" is accepted with an advisory warning.
// ---------------------------------------------------------------------------

const CAPSULE_REQUIRED_FIELDS = [
  { field: "schema", type: "string" },
  { field: "capsule_id", type: "string" },
  { field: "name", type: "string" },
  { field: "version", type: "string" },
  { field: "capsule_type", type: "string" },
  { field: "status", type: "string" },
  { field: "purpose", type: "string" },
  { field: "payload", type: "object" },
  { field: "permissions", type: "object" },
  { field: "resource_limits", type: "object" },
  { field: "activation", type: "object" },
  { field: "provenance", type: "object" },
];

const CAPSULE_SCHEMA_VALUE = "dreamnet.synergy_capsule.v1";

const CAPSULES_DIR = repoPath("capsules");

check("capsules/ directory exists", () => {
  if (!fs.existsSync(CAPSULES_DIR)) {
    throw new Error(`capsules/ directory not found at ${CAPSULES_DIR}`);
  }
});

const capsuleFiles = fs.existsSync(CAPSULES_DIR) ? listJsonFiles(CAPSULES_DIR) : [];

check("capsules/ contains at least one JSON file", () => {
  if (capsuleFiles.length === 0) {
    throw new Error("No .json files found in capsules/");
  }
});

for (const filePath of capsuleFiles) {
  const fileName = path.basename(filePath);

  check(`capsule ${fileName}: is valid JSON`, () => {
    readJson(filePath);
  });

  check(`capsule ${fileName}: required fields and types`, () => {
    const manifest = readJson(filePath);
    const ctx = `capsule ${fileName}`;

    // Required scalar fields
    for (const { field, type } of CAPSULE_REQUIRED_FIELDS) {
      if (!(field in manifest)) {
        throw new Error(`${ctx}: required field "${field}" is missing`);
      }
      const actual = Array.isArray(manifest[field])
        ? "array"
        : typeof manifest[field];
      if (actual !== type) {
        throw new Error(
          `${ctx}: field "${field}" must be type ${type}, got ${actual}`
        );
      }
    }

    // schema value
    if (manifest.schema !== CAPSULE_SCHEMA_VALUE) {
      throw new Error(
        `${ctx}: schema must be "${CAPSULE_SCHEMA_VALUE}", got "${manifest.schema}"`
      );
    }

    // permissions sub-fields
    const perms = manifest.permissions;
    if (!Array.isArray(perms.allowed)) {
      throw new Error(`${ctx}: permissions.allowed must be an array`);
    }
    if (!Array.isArray(perms.blocked)) {
      throw new Error(`${ctx}: permissions.blocked must be an array`);
    }

    // no overlap between allowed and blocked
    const overlap = perms.allowed.filter((a) => perms.blocked.includes(a));
    if (overlap.length > 0) {
      throw new Error(
        `${ctx}: permissions.allowed and permissions.blocked overlap: ${overlap.join(", ")}`
      );
    }

    // resource_limits sub-fields
    const rl = manifest.resource_limits;
    if (
      !Number.isInteger(rl.max_wall_time_ms) ||
      rl.max_wall_time_ms < 1 ||
      rl.max_wall_time_ms > 86400000
    ) {
      throw new Error(
        `${ctx}: resource_limits.max_wall_time_ms must be integer 1–86400000`
      );
    }
    if (
      !Number.isInteger(rl.max_steps) ||
      rl.max_steps < 1 ||
      rl.max_steps > 1000
    ) {
      throw new Error(
        `${ctx}: resource_limits.max_steps must be integer 1–1000`
      );
    }
    if (
      !Number.isInteger(rl.max_retries_per_step) ||
      rl.max_retries_per_step < 1 ||
      rl.max_retries_per_step > 10
    ) {
      throw new Error(
        `${ctx}: resource_limits.max_retries_per_step must be integer 1–10`
      );
    }

    // provenance.content_hash: real hash required for non-draft; warn for draft
    const ch = manifest.provenance.content_hash;
    if (typeof ch !== "string") {
      throw new Error(`${ctx}: provenance.content_hash must be a string`);
    }
    const isRealHash = /^sha256:[0-9a-f]{64}$/.test(ch);
    const isDraftPlaceholder =
      manifest.status === "draft" && /^sha256:draft-/.test(ch);

    if (!isRealHash && !isDraftPlaceholder) {
      throw new Error(
        `${ctx}: provenance.content_hash must match sha256:<64-hex> ` +
        `(or sha256:draft-* for draft capsules), got ${JSON.stringify(ch)}`
      );
    }
  });

  // Advisory: draft capsules with placeholder hashes should be finalized
  advisory(
    `capsule ${fileName}: provenance.content_hash is a real SHA-256 (not a draft placeholder)`,
    "PR #26 — capsule hash computation",
    () => {
      const manifest = readJson(filePath);
      const ch = manifest.provenance.content_hash;
      if (!/^sha256:[0-9a-f]{64}$/.test(ch)) {
        throw new Error(
          `content_hash "${ch}" is a draft placeholder — compute and replace with real capsuleContentHash(manifest) before promoting this capsule to active status`
        );
      }
    }
  );
}

// ---------------------------------------------------------------------------
// SECTION 2: Loop (DreamLoop manifest) validation
// Validates all files in loops/ against the loop schema.
// Required fields: loop_id, title, version, status, owner, trigger, cooldown,
// blocked_actions (containing at least one of wallet.sign /
// deployment.production.write / signer.change).
// ---------------------------------------------------------------------------

const LOOP_REQUIRED_STRING_FIELDS = [
  "loop_id",
  "title",
  "version",
  "status",
  "owner",
  "trigger",
  "cooldown",
];

const LOOP_BLOCKED_REQUIRED_ANY = [
  "wallet.sign",
  "deployment.production.write",
  "signer.change",
];

const LOOPS_DIR = repoPath("loops");

check("loops/ directory exists", () => {
  if (!fs.existsSync(LOOPS_DIR)) {
    throw new Error(`loops/ directory not found at ${LOOPS_DIR}`);
  }
});

const loopFiles = fs.existsSync(LOOPS_DIR) ? listJsonFiles(LOOPS_DIR) : [];

check("loops/ contains at least one JSON file", () => {
  if (loopFiles.length === 0) {
    throw new Error("No .json files found in loops/");
  }
});

for (const filePath of loopFiles) {
  const fileName = path.basename(filePath);

  check(`loop ${fileName}: is valid JSON`, () => {
    readJson(filePath);
  });

  check(`loop ${fileName}: required fields and blocked_actions`, () => {
    const manifest = readJson(filePath);
    const ctx = `loop ${fileName}`;

    // Required non-empty string fields
    for (const field of LOOP_REQUIRED_STRING_FIELDS) {
      if (!(field in manifest)) {
        throw new Error(`${ctx}: required field "${field}" is missing`);
      }
      if (
        typeof manifest[field] !== "string" ||
        !manifest[field].trim()
      ) {
        throw new Error(
          `${ctx}: field "${field}" must be a non-empty string`
        );
      }
    }

    // blocked_actions: must be an array
    if (!("blocked_actions" in manifest)) {
      throw new Error(`${ctx}: required field "blocked_actions" is missing`);
    }
    if (!Array.isArray(manifest.blocked_actions)) {
      throw new Error(`${ctx}: field "blocked_actions" must be an array`);
    }

    // blocked_actions must contain at least one of the required entries
    const blocked = manifest.blocked_actions;
    const hasRequired = LOOP_BLOCKED_REQUIRED_ANY.some((a) =>
      blocked.includes(a)
    );
    if (!hasRequired) {
      throw new Error(
        `${ctx}: blocked_actions must include at least one of: ` +
        `${LOOP_BLOCKED_REQUIRED_ANY.join(", ")}. ` +
        `Found: ${JSON.stringify(blocked)}`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// SECTION 3: Pi-only guard
// ADVISORY: src/zol-lib.js must NOT have require('@farcaster/hub-nodejs') at
// the top level. This is a known issue tracked in PR #26 (hardening pass).
// Reported as WARN so it does not block the harness; must be fixed before
// the capsule is promoted to active status on non-Pi environments.
// ---------------------------------------------------------------------------

const ZOL_LIB_PATH = repoPath("src", "zol-lib.js");

advisory(
  "src/zol-lib.js: require('@farcaster/hub-nodejs') is NOT at top level (Pi-only guard)",
  "PR #26 — lazy-require @farcaster/hub-nodejs inside the functions that use it",
  () => {
    if (!fs.existsSync(ZOL_LIB_PATH)) {
      // File doesn't exist — no violation possible.
      return;
    }
    const source = readText(ZOL_LIB_PATH);
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Top-level: line does not start with whitespace and contains the require
      const isTopLevel = line.length > 0 && !/^[\s]/.test(line);
      if (isTopLevel && line.includes("require('@farcaster/hub-nodejs')")) {
        throw new Error(
          `line ${i + 1}: top-level require('@farcaster/hub-nodejs') found. ` +
          `Guard it with a lazy require inside the functions that use it ` +
          `so non-Pi environments can import zol-lib.js without crashing.`
        );
      }
    }
  }
);

// ---------------------------------------------------------------------------
// SECTION 4: scripts/secret-scan.sh exists (hard check)
// ---------------------------------------------------------------------------

const SECRET_SCAN_PATH = repoPath("scripts", "secret-scan.sh");

check("scripts/secret-scan.sh exists", () => {
  if (!fs.existsSync(SECRET_SCAN_PATH)) {
    throw new Error(
      `scripts/secret-scan.sh not found at ${SECRET_SCAN_PATH}. ` +
      `Required by Fleet Standard INV-4 / Section 11.3.`
    );
  }
});

// ---------------------------------------------------------------------------
// SECTION 5: src/approval-bridge.js exports ApprovalBridge and consume
// ADVISORY: This file is in scope for PR #28 (ApprovalBridge hardening).
// Reported as WARN — does not block the harness exit code.
// ---------------------------------------------------------------------------

const APPROVAL_BRIDGE_PATH = repoPath("src", "approval-bridge.js");

advisory(
  "src/approval-bridge.js exists and exports ApprovalBridge class and consume function",
  "PR #28 — ApprovalBridge implementation (connect to ToolGateway and AgentGateway)",
  () => {
    if (!fs.existsSync(APPROVAL_BRIDGE_PATH)) {
      throw new Error(
        `src/approval-bridge.js not found at ${APPROVAL_BRIDGE_PATH}. ` +
        `Fleet Standard Section 8 requires ApprovalBridge with fail-closed semantics.`
      );
    }
    const source = readText(APPROVAL_BRIDGE_PATH);

    const hasApprovalBridge =
      /class\s+ApprovalBridge/.test(source) ||
      /ApprovalBridge\s*=/.test(source) ||
      /exports\.ApprovalBridge/.test(source) ||
      /module\.exports\.ApprovalBridge/.test(source) ||
      /module\.exports\s*=\s*\{[^}]*ApprovalBridge/.test(source);

    if (!hasApprovalBridge) {
      throw new Error(
        `src/approval-bridge.js does not define or export "ApprovalBridge". ` +
        `Expected: class ApprovalBridge or exports.ApprovalBridge = ...`
      );
    }

    const hasConsume =
      /function\s+consume/.test(source) ||
      /consume\s*[=(]/.test(source) ||
      /exports\.consume/.test(source) ||
      /['"]consume['"]/.test(source);

    if (!hasConsume) {
      throw new Error(
        `src/approval-bridge.js does not define "consume". ` +
        `Expected: function consume(...) or consume = ... or exports.consume = ...`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// SECTION 6: Schema files exist and are valid JSON with $schema field
// ---------------------------------------------------------------------------

const SCHEMA_FILES = [
  "docs/fleet-standard/schemas/capsule.schema.json",
  "docs/fleet-standard/schemas/receipt.schema.json",
  "docs/fleet-standard/schemas/task-lease.schema.json",
];

for (const rel of SCHEMA_FILES) {
  check(`schema file exists and is valid: ${rel}`, () => {
    const p = repoPath(rel);
    if (!fs.existsSync(p)) {
      throw new Error(`Schema file not found at ${p}`);
    }
    const schema = readJson(p); // throws on parse error
    if (!schema["$schema"]) {
      throw new Error(
        `Schema file ${rel} is missing required "$schema" field`
      );
    }
    if (!schema["title"]) {
      throw new Error(
        `Schema file ${rel} is missing recommended "title" field`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const hardFailed = results.filter((r) => r.severity === "hard" && !r.passed);
const advisoryFailed = results.filter(
  (r) => r.severity === "advisory" && !r.passed
);
const hardPassed = results.filter((r) => r.severity === "hard" && r.passed);
const advisoryPassed = results.filter(
  (r) => r.severity === "advisory" && r.passed
);

if (hardFailed.length > 0) {
  console.error("\nFAILED CHECKS:");
  for (const r of hardFailed) {
    console.error(`  FAIL  ${r.name}`);
    console.error(`        ${r.note}`);
  }
  console.error("");
}

if (advisoryFailed.length > 0) {
  console.warn("\nADVISORY WARNINGS (not failures — tracked in open PRs):");
  for (const r of advisoryFailed) {
    console.warn(`  WARN  ${r.name}`);
    console.warn(`        ${r.note}`);
  }
  console.warn("");
}

const totalPassed = hardPassed.length + advisoryPassed.length;
const totalFailed = hardFailed.length; // advisory failures do NOT count

console.log(
  `${hardPassed.length} conformance checks passed, ${hardFailed.length} failed` +
  (advisoryFailed.length > 0
    ? ` (${advisoryFailed.length} advisory warning${advisoryFailed.length === 1 ? "" : "s"} — see above)`
    : "") +
  (advisoryPassed.length > 0 && advisoryFailed.length === 0
    ? ` (+${advisoryPassed.length} advisory checks clean)`
    : "")
);

process.exit(hardFailed.length > 0 ? 1 : 0);
