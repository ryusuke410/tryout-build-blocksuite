# Contributing

Thank you for helping improve this build helper! Please keep documentation, code comments, and commit messages in English so every contributor can follow the workflow.

## Development workflow

1. Install dependencies using the pinned pnpm version:

   ```bash
   pnpm install
   ```

2. Run the full validation pipeline before sending changes:

   ```bash
   pnpm run check
   ```

   The command executes formatting, type checking, tests, and a build dry-run in sequence.

3. Use the build helper locally to verify the BlockSuite artifacts can be produced:

   ```bash
   pnpm run build-blocksuite -- --ref main
   ```

4. When verifying versioned artifacts that should be published as release assets, run the release helper with your test version (requires `GITHUB_TOKEN` with `repo` scope):

   ```bash
   pnpm run release-blocksuite -- --version 0.25.5 --repository <owner/repo>
   ```

## Coding standards

- Keep the package version at `0.0.0-beta.0`. New packages should start from the same version.
- Use `pnpm run format` to normalize trailing whitespace and newlines.
- Respect the strict TypeScript configuration in `tsconfig.json` and avoid reducing strictness.
- Prefer small, focused commits that describe _why_ a change is needed.

## GitHub Actions artifacts

When running inside GitHub Actions, enable the `--upload` flag for `build-blocksuite`. The script will attach the generated `.tgz` files to the workflow using `@actions/artifact`.
