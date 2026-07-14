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

- `LICENSE` - Apache-2.0 license from upstream root

## What Was NOT Vendored

The following were excluded from the vendor copy:

- `.git/` directory
- `node_modules/` directories
- `packages/warper-keeper/` - not required for Phase 1
- `packages/okf-exporter/` - not required for Phase 1
- Top-level `schemas/` from root (runtime has its own schemas)

## Note on Dependencies

The vendored CLI depends on the vendored runtime. Import paths have been adjusted to reference the local vendored runtime rather than the npm package @dreamloops/runtime.

## Validation Date

Vendored at commit 1c6d3b19. The actual vendoring date was not recorded by the tooling and is left to the committer to document if needed.
