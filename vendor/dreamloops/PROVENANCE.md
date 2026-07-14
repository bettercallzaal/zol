# DreamLoops Runtime Vendor Provenance

**Source Repository:** https://github.com/BrandonDucar/dreamloops

**Pinned Commit:** `1c6d3b1910f5b83639e0735634740902e2caacff`

**Release Tag:** v0.1.0

**License:** Apache-2.0

## What Was Vendored

The following directories and files were copied from the upstream repository:

- `packages/runtime/` - the dependency-free @dreamloops/runtime runtime package
  - src/ - runtime source code
  - schemas/ - runtime schema definitions
  - templates/ - example templates
  - examples/ - example usage
  - tests/ - test suite
  - package.json - runtime package manifest
  - README.md - runtime documentation

- `packages/cli/` - the @dreamloops/cli command-line interface
  - src/ - CLI source code
  - templates/ - CLI templates
  - tests/ - CLI test suite
  - package.json - CLI package manifest
  - README.md - CLI documentation

- `packages/warper-keeper/` - the @dreamloops/warper-keeper assignment-bound connector client (added Phase 7)
  - src/ - client source code
  - src/contracts/v1.js - v1 contract definitions
  - src/client.js - WarperKeeperClient factory
  - src/errors.js - error types
  - src/index.js - public exports
  - tests/ - client test suite
  - package.json - warper-keeper package manifest
  - README.md - warper-keeper documentation

- `LICENSE` - Apache-2.0 license from upstream root

## What Was NOT Vendored

The following were excluded from the vendor copy:

- `.git/` directory
- `node_modules/` directories
- `packages/okf-exporter/` - not required
- Top-level `schemas/` from root (runtime has its own schemas)

## Note on Dependencies

The vendored CLI depends on the vendored runtime. Import paths have been adjusted to reference the local vendored runtime rather than the npm package @dreamloops/runtime.

## Vendoring Timeline

- **Phase 1-6:** Vendored runtime, cli, LICENSE at commit 1c6d3b19 (v0.1.0)
- **Phase 7:** Added warper-keeper at commit 1c6d3b19 (same pinned commit, expanded scope)
