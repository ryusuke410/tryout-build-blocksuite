# Tryout: Build BlockSuite from AFFiNE

This repository keeps a reproducible workflow for building the BlockSuite packages that live inside the [AFFiNE](https://github.com/toeverything/AFFiNE) monorepo. The primary goal is to provide downloadable `.tgz` artifacts, and the secondary goal is to make it easy for contributors to build those artifacts themselves.

## What this project provides

- A TypeScript build script that clones AFFiNE, builds the `@blocksuite/*` packages, packs them into `.tgz` files, and optionally uploads them as GitHub Actions artifacts or GitHub release assets.
- A single `pnpm run check` command for local validation (formatting → type checking → tests → build).
- Documentation that stays in English for easier collaboration.

## Prerequisites

- **pnpm 10.x** (the repository declares `packageManager` so `corepack` can supply the right version).
- **Node.js 18+** (to run Vite Node and GitHub Actions libraries).
- Git with network access to clone the AFFiNE repository.

## Quick start

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Run the validation pipeline:

   ```bash
   pnpm run check
   ```

3. Build BlockSuite packages and pack them into `.tgz` files (default output: `dist/blocksuite-tgz`):

   ```bash
   pnpm run build-blocksuite -- --ref main
   ```

4. If you run the script inside GitHub Actions, pass `--upload` to attach the generated files as an artifact (defaults to `blocksuite-packages`):

   ```bash
   pnpm run build-blocksuite -- --ref <tag-or-branch> --upload
   ```

5. Publish the built `.tgz` files to a GitHub release for a specific BlockSuite version (requires `GITHUB_TOKEN` with `repo` scope):

   ```bash
   pnpm run release-blocksuite -- --version 0.25.5 --repository <owner/repo>
   ```

   The command will create or reuse the `blocksuite@0.25.5` release tag, build the matching artifacts from AFFiNE (using `blocksuite@0.25.5` as the default git ref), and upload each package tarball as a release asset.

6. Dispatch the GitHub Actions workflow to build and publish artifacts directly from this repository (no local setup required):
   - Navigate to **Actions → Release BlockSuite packages → Run workflow**.
   - Provide the `version` (e.g., `0.25.5`). Optional inputs let you override the AFFiNE git ref, choose a custom pack directory, or disable the cleanup step.
   - The workflow will ensure the `blocksuite@<version>` release exists in this repository, replace any assets with matching filenames, and upload the freshly built `.tgz` files.

## Script overview

`scripts/build-blocksuite.ts` performs these steps:

1. Clone or update `https://github.com/toeverything/AFFiNE` into `vendor/AFFiNE` (override with `--affine-dir`).
2. Check out the requested git reference (default: `main`).
3. Install dependencies in the AFFiNE workspace with `pnpm install --frozen-lockfile`.
4. Build every `@blocksuite/*` workspace with `pnpm --filter @blocksuite/* run build --recursive`.
5. Pack each BlockSuite package to `.tgz` files in `dist/blocksuite-tgz`.
6. Optionally upload the packed files as a GitHub Actions artifact.

## CLI options

```bash
pnpm run build-blocksuite -- [options]
```

- `--affine-dir <path>`: Destination for the AFFiNE clone. Default: `vendor/AFFiNE`.
- `--ref <git-ref>`: Branch, tag, or commit to check out. Default: `main`.
- `--pack-dir <path>`: Directory for generated `.tgz` files. Default: `dist/blocksuite-tgz`.
- `--skip-install`: Skip `pnpm install` inside AFFiNE (use only if dependencies are already installed).
- `--upload`: Upload the packed files as a GitHub Actions artifact.
- `--artifact-name <name>`: Custom artifact name. Default: `blocksuite-packages`.
- `--clean`: Remove any existing package tarballs from the pack directory before packing.

When `--upload` is enabled, the script uses `@actions/artifact` and requires the `GITHUB_ACTIONS` environment to be available.

### Release publishing

```bash
pnpm run release-blocksuite -- --version <semver> [options]
```

- `--version <semver>` (required): BlockSuite version to package (e.g., `0.25.5`).
- `--ref <git-ref>`: AFFiNE git reference to check out. Defaults to `blocksuite@<version>`.
- `--affine-dir <path>`: Destination for the AFFiNE clone. Default: `vendor/AFFiNE`.
- `--pack-dir <path>`: Directory for generated `.tgz` files. Default: `dist/blocksuite-tgz`.
- `--skip-install`: Skip `pnpm install` inside AFFiNE (use only if dependencies are already installed).
- `--clean`: Remove any existing package tarballs from the pack directory before packing.
- `--repository <owner/repo>`: Target repository for the release. Defaults to `GITHUB_REPOSITORY` when available.
- `--token <github-token>`: GitHub token used to create/releases assets. Defaults to `GITHUB_TOKEN`.
- `--tag <tag>`: Custom release tag. Defaults to `blocksuite@<version>`.

The command will create the release if it does not exist, remove assets with matching filenames, and upload the freshly built tarballs as release assets.

## Notes

- The repository intentionally stays minimal; the build pipeline lives entirely in the script.
- All documentation and comments remain in English to support contributors from different locales.
- The package version stays pinned at `0.0.0-beta.0` for consistency.
