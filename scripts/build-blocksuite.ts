#!/usr/bin/env node
import { DefaultArtifactClient } from "@actions/artifact";
import { Command } from "commander";
import { mkdirp, pathExists, readdir, remove } from "fs-extra";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { $ } from "zx";

$.verbose = true;

/**
 * Build BlockSuite packages from AFFiNE vendor directory
 *
 * This script:
 * 1. Ensures the AFFiNE submodule is properly initialized and clean
 * 2. Installs dependencies using yarn with an immutable lockfile
 * 3. Builds all BlockSuite packages recursively
 * 4. Packs all BlockSuite packages to .tgz files
 * 5. Generates pnpm.overrides configuration for package.json
 * 6. Runs pnpm install && pnpm run check to validate the repository
 */

interface BuildOptions {
  affineDir: string;
  ref: string;
  packDir: string;
  packages?: string[];
  skipInstall: boolean;
  upload: boolean;
  artifactName: string;
  clean: boolean;
  sourceRepo: string;
  excludeWorkspaces: string[];
}

interface ReleaseOptions {
  version: string;
  affineRef?: string;
  ref?: string;
  affineDir: string;
  packDir: string;
  packages?: string[];
  skipInstall: boolean;
  clean: boolean;
  sourceRepo: string;
  excludeWorkspaces: string[];
  repository?: string;
  token?: string;
  tag?: string;
}

type YarnWorkspace = {
  name: string;
  location: string;
};

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
};

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_AFFINE_DIR = resolve(REPO_ROOT, "vendor/AFFiNE");
const DEFAULT_SOURCE_REPO = "https://github.com/toeverything/AFFiNE.git";
const DEFAULT_EXCLUDED_WORKSPACES = [
  "@blocksuite/e2e",
  "@blocksuite/playground",
];

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function section(title: string) {
  const separator = "=".repeat(60);
  log(`\n${separator}`, colors.bright);
  log(title, colors.bright + colors.blue);
  log(separator, colors.bright);
}

function isYarnWorkspace(value: unknown): value is YarnWorkspace {
  if (!value || typeof value !== "object") {
    return false;
  }

  const workspace = value as { name?: unknown; location?: unknown };

  return (
    typeof workspace.name === "string" && typeof workspace.location === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }

  return value;
}

function parseBuildOptions(options: unknown): BuildOptions {
  if (!isRecord(options)) {
    throw new Error("Invalid CLI options provided to build-blocksuite.");
  }

  const packages =
    options.packages === undefined
      ? undefined
      : ensureStringArray(options.packages, "packages");
  const excludeWorkspaces = options.excludeWorkspaces
    ? ensureStringArray(options.excludeWorkspaces, "excludeWorkspaces")
    : DEFAULT_EXCLUDED_WORKSPACES;

  if (
    typeof options.affineDir !== "string" ||
    typeof options.ref !== "string" ||
    typeof options.packDir !== "string" ||
    typeof options.skipInstall !== "boolean" ||
    typeof options.upload !== "boolean" ||
    typeof options.artifactName !== "string" ||
    typeof options.clean !== "boolean" ||
    typeof options.sourceRepo !== "string"
  ) {
    throw new Error("Invalid CLI options provided to build-blocksuite.");
  }

  return {
    affineDir: options.affineDir,
    ref: options.ref,
    packDir: options.packDir,
    packages,
    skipInstall: options.skipInstall,
    upload: options.upload,
    artifactName: options.artifactName,
    clean: options.clean,
    sourceRepo: options.sourceRepo,
    excludeWorkspaces,
  };
}

function parseReleaseOptions(options: unknown): ReleaseOptions {
  if (!isRecord(options)) {
    throw new Error("Invalid release options provided to build-blocksuite.");
  }

  const packages =
    options.packages === undefined
      ? undefined
      : ensureStringArray(options.packages, "packages");
  const excludeWorkspaces = options.excludeWorkspaces
    ? ensureStringArray(options.excludeWorkspaces, "excludeWorkspaces")
    : DEFAULT_EXCLUDED_WORKSPACES;

  if (
    typeof options.version !== "string" ||
    typeof options.affineDir !== "string" ||
    typeof options.packDir !== "string" ||
    typeof options.skipInstall !== "boolean" ||
    typeof options.clean !== "boolean" ||
    typeof options.sourceRepo !== "string"
  ) {
    throw new Error("Invalid release options provided to build-blocksuite.");
  }

  const optionalStrings: Array<[keyof ReleaseOptions, unknown]> = [
    ["affineRef", options.affineRef],
    ["ref", options.ref],
    ["repository", options.repository],
    ["token", options.token],
    ["tag", options.tag],
  ];

  optionalStrings.forEach(([key, value]) => {
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`${key} must be a string when provided.`);
    }
  });

  return {
    version: options.version,
    affineRef:
      typeof options.affineRef === "string" ? options.affineRef : undefined,
    ref: typeof options.ref === "string" ? options.ref : undefined,
    affineDir: options.affineDir,
    packDir: options.packDir,
    packages,
    skipInstall: options.skipInstall,
    clean: options.clean,
    sourceRepo: options.sourceRepo,
    excludeWorkspaces,
    repository:
      typeof options.repository === "string" ? options.repository : undefined,
    token: typeof options.token === "string" ? options.token : undefined,
    tag: typeof options.tag === "string" ? options.tag : undefined,
  };
}

async function ensureAffineRepo(dir: string, ref: string, sourceRepo: string) {
  const repoStatus = await $({ nothrow: true })`
    git -C ${dir} rev-parse --is-inside-work-tree
  `;

  const needsReinit = !(await pathExists(dir)) || repoStatus.exitCode !== 0;

  if (needsReinit) {
    section(`Cloning AFFiNE into ${dir}`);
    if (await pathExists(dir)) {
      await remove(dir);
    }
    await mkdirp(dir);
    await $`git -C ${dir} init`;
    await $`git -C ${dir} remote add origin ${sourceRepo}`;
  } else {
    section(`Updating AFFiNE in ${dir}`);
    const originExists =
      (await $({ nothrow: true })`git -C ${dir} remote get-url origin`)
        .exitCode === 0;
    if (!originExists) {
      await $`git -C ${dir} remote add origin ${sourceRepo}`;
    } else {
      await $`git -C ${dir} remote set-url origin ${sourceRepo}`;
    }
  }

  await $`git -C ${dir} fetch --depth 1 origin ${ref}`;
  await $`git -C ${dir} checkout --force FETCH_HEAD`;
}

async function assertCleanRepo(dir: string) {
  const status = await $({ cwd: dir, nothrow: true })`git status --porcelain`;
  if (status.stdout.trim()) {
    throw new Error(
      `AFFiNE repository at ${dir} has uncommitted changes. Please commit or stash them before building.`,
    );
  }
}

async function getBlocksuiteWorkspaces(affineDir: string) {
  const workspaceList = await $({ cwd: affineDir })`
    yarn workspaces list --json
  `;

  return workspaceList.stdout
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line) as unknown)
    .filter(isYarnWorkspace)
    .filter((workspace) => workspace.name.startsWith("@blocksuite/"));
}

async function ensureBlocksuiteLocation(affineDir: string) {
  section("Checking repository layout");
  if (!(await pathExists(affineDir))) {
    throw new Error("Source directory is missing after clone.");
  }

  const workspaces = await getBlocksuiteWorkspaces(affineDir);
  if (!workspaces.length) {
    const packagesDir = resolve(affineDir, "packages");
    const entries = (await pathExists(packagesDir))
      ? await readdir(packagesDir)
      : [];

    log("No @blocksuite/* workspaces detected.", colors.red);
    if (entries.length) {
      log("Found packages directory entries:", colors.yellow);
      entries.forEach((pkg) => log(`- ${resolve(packagesDir, pkg)}`));
    }
    throw new Error("Repository does not contain any @blocksuite/* workspaces");
  }

  log(`Found ${workspaces.length} @blocksuite/* workspaces`, colors.green);
}

function convertSrcExport(target: string) {
  if (!target.startsWith("./src/")) {
    return undefined;
  }

  const distBase = target
    .replace(/^\.\/src\//, "./dist/")
    .replace(/\.tsx?$/, "");

  return {
    types: `${distBase}.d.ts`,
    import: `${distBase}.js`,
  } as const;
}

function rewriteExportsField(exportsField: unknown): unknown {
  if (typeof exportsField === "string") {
    return convertSrcExport(exportsField) ?? exportsField;
  }

    if (isRecord(exportsField)) {
      return Object.fromEntries(
        Object.entries(exportsField).map(([key, value]) => {
          if (typeof value === "string") {
            return [key, convertSrcExport(value) ?? value];
          }

          if (isRecord(value)) {
            const nested = Object.fromEntries(
              Object.entries(value).map(([nestedKey, nestedValue]) => [
                nestedKey,
                typeof nestedValue === "string"
                  ? (convertSrcExport(nestedValue) ?? nestedValue)
                  : nestedValue,
              ]),
            );

            return [key, nested];
          }

          return [key, value];
        }),
      );
    }

  return exportsField;
}

async function patchBlocksuitePublishConfig(affineDir: string) {
  section("Patching BlockSuite publish configuration");
  const workspaces = await getBlocksuiteWorkspaces(affineDir);

  if (!workspaces.length) {
    log(
      "No @blocksuite/* workspaces detected; skipping patch step.",
      colors.yellow,
    );
    return;
  }

  for (const ws of workspaces) {
    const packageJsonPath = resolve(affineDir, ws.location, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

    const alreadyPatched = Boolean(packageJson.publishConfig?.exports);
    if (alreadyPatched) {
      log(
        `publishConfig.exports already present for ${ws.name}; skipping.`,
        colors.green,
      );
      continue;
    }

    const rewrittenExports = rewriteExportsField(packageJson.exports);

    if (rewrittenExports === packageJson.exports) {
      log(
        `No src-based exports found for ${ws.name}; leaving package.json unchanged.`,
        colors.yellow,
      );
      continue;
    }

    packageJson.publishConfig = {
      ...(packageJson.publishConfig ?? {}),
      exports: rewrittenExports,
    };

    await writeFile(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2) + "\n",
    );
    log(`Added publishConfig.exports for ${ws.name}`, colors.green);
  }
}

async function configureYarnVersion(affineDir: string) {
  section("Configuring Yarn version");

  await $({ cwd: affineDir })`corepack enable`;

  const packageJsonPath = resolve(affineDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    log(
      "package.json not found in AFFiNE directory; using default Yarn.",
      colors.yellow,
    );
    return;
  }

  const packageJsonRaw = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageJson = isRecord(packageJsonRaw) ? packageJsonRaw : {};
  const packageManager =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager
      : undefined;
  const yarnSpec = packageManager?.startsWith("yarn@")
    ? packageManager
    : undefined;

  if (!yarnSpec) {
    log(
      "No Yarn packageManager entry found in AFFiNE package.json; using default Yarn.",
      colors.yellow,
    );
    return;
  }

  await $({ cwd: affineDir })`corepack use ${yarnSpec}`;
  log(`Activated Yarn version from packageManager: ${yarnSpec}`, colors.green);
}

async function installDependencies(dir: string, skipInstall: boolean) {
  if (skipInstall) {
    log("Skipping dependency installation.", colors.yellow);
    return;
  }

  section("Installing dependencies in AFFiNE with yarn");
  await $({
    cwd: dir,
    env: {
      ...process.env,
      YARN_ENABLE_IMMUTABLE_INSTALLS: "1",
      YARN_IGNORE_PATH: "1",
    },
  })`yarn install --immutable --check-cache`;
}

async function buildBlocksuite(dir: string, excludeWorkspaces: string[]) {
  section("Building @blocksuite/* packages");
  const excludeArgs = excludeWorkspaces.flatMap((name) => ["--exclude", name]);

  await $({ cwd: dir, env: { ...process.env, YARN_IGNORE_PATH: "1" } })`
    yarn exec yarn workspaces foreach --all --topological-dev --include @blocksuite/* ${excludeArgs} run build
  `;
}

async function packBlocksuite(
  dir: string,
  packDir: string,
  clean: boolean,
  packages?: string[],
) {
  section(`Packing BlockSuite packages into ${packDir}`);
  const absolutePackDir = resolve(REPO_ROOT, packDir);

  if (clean && (await pathExists(absolutePackDir))) {
    await remove(absolutePackDir);
  }

  await mkdirp(absolutePackDir);
  const workspaces = await getBlocksuiteWorkspaces(dir);
  const workspaceMap = new Map(workspaces.map((ws) => [ws.name, ws]));
  const targets = packages?.length
    ? packages.map((name) => {
        const ws = workspaceMap.get(name);
        if (!ws) {
          throw new Error(`Workspace ${name} was not found in the repo.`);
        }
        return ws;
      })
    : workspaces;
  const files: string[] = [];
  for (const ws of targets) {
    const filename = `${ws.name.replace("@", "").replace("/", "-")}.tgz`;
    const outputPath = join(absolutePackDir, filename);
    await $({ cwd: dir, env: { ...process.env, YARN_IGNORE_PATH: "1" } })`
      yarn exec yarn workspace ${ws.name} pack --out ${outputPath}
    `;
    files.push(outputPath);
  }

  if (!files.length) {
    throw new Error("No BlockSuite package tarballs were produced.");
  }

  log(`Packed ${files.length} files:`, colors.green);
  files.forEach((file: string) => log(`- ${file}`));
  return { absolutePackDir, files };
}

async function uploadArtifact(
  dir: string,
  files: string[],
  artifactName: string,
) {
  const isRunningInActions = process.env["GITHUB_ACTIONS"] === "true";
  if (!isRunningInActions) {
    log(
      "Artifact upload requested, but this is not running inside GitHub Actions. Skipping.",
      colors.yellow,
    );
    return;
  }

  const client = new DefaultArtifactClient();
  await client.uploadArtifact(artifactName, files, dir);
  log(
    `Uploaded artifact "${artifactName}" with ${files.length} files.`,
    colors.green,
  );
}

async function ensureRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  version: string,
) {
  try {
    const existing = await octokit.repos.getReleaseByTag({ owner, repo, tag });
    return existing.data;
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status === 404
    ) {
      log(`Release for tag ${tag} not found. Creating...`, colors.yellow);
      const created = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: tag,
        name: `Blocksuite ${version}`,
        draft: false,
        prerelease: false,
      });
      return created.data;
    }
    throw error;
  }
}

async function uploadReleaseAssets(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
  files: string[],
) {
  const release = await octokit.repos.getRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  const existingNames = new Map(
    release.data.assets.map((asset) => [asset.name, asset.id]),
  );

  for (const file of files) {
    const name = file.split(/[/\\]/).pop();
    if (!name) {
      continue;
    }

    const existingId = existingNames.get(name);
    if (existingId) {
      log(`Deleting existing asset ${name} before upload...`, colors.yellow);
      await octokit.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingId,
      });
    }

    const buffer = Buffer.from(await readFile(file));
    log(`Uploading asset ${name} (${buffer.byteLength} bytes)...`, colors.blue);
    await octokit.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseId,
      name,
      data: buffer,
      headers: {
        "content-length": buffer.byteLength,
        "content-type": "application/gzip",
      },
    });
  }
}

async function generateOverrides(affineDir: string, packDir: string) {
  section("Generating pnpm.overrides configuration");
  const workspaces = await getBlocksuiteWorkspaces(affineDir);
  const overrides: Record<string, string> = {};
  const overridesDir = resolve(REPO_ROOT, "dist");
  await mkdirp(overridesDir);
  const relativePackDir = relative(overridesDir, packDir);

  for (const ws of workspaces) {
    const filename = `${ws.name.replace("@", "").replace("/", "-")}.tgz`;
    const relativeTgz = join(relativePackDir, filename);
    overrides[ws.name] = `file:./${relativeTgz}`;
  }

  log("Add the following to pnpm.overrides:", colors.bright);
  console.log(JSON.stringify(overrides, null, 2));

  const overridesPath = resolve(
    overridesDir,
    "blocksuite-package-overrides.json",
  );
  await writeFile(overridesPath, JSON.stringify(overrides, null, 2));
  log(`Saved overrides to ${overridesPath}`, colors.green);
}

async function buildAndMaybeUpload(options: BuildOptions) {
  const affineDir = resolve(REPO_ROOT, options.affineDir);
  const excludeWorkspaces =
    options.excludeWorkspaces?.length &&
    Array.isArray(options.excludeWorkspaces)
      ? options.excludeWorkspaces
      : DEFAULT_EXCLUDED_WORKSPACES;

  await ensureAffineRepo(affineDir, options.ref, options.sourceRepo);
  await assertCleanRepo(affineDir);
  await ensureBlocksuiteLocation(affineDir);
  await patchBlocksuitePublishConfig(affineDir);
  await configureYarnVersion(affineDir);
  await installDependencies(affineDir, options.skipInstall);
  await buildBlocksuite(affineDir, excludeWorkspaces);
  const result = await packBlocksuite(
    affineDir,
    options.packDir,
    options.clean,
    options.packages,
  );

  await generateOverrides(affineDir, result.absolutePackDir);

  if (options.upload) {
    await uploadArtifact(
      result.absolutePackDir,
      result.files,
      options.artifactName,
    );
  }

  return result;
}

async function main() {
  const program = new Command()
    .name("build-blocksuite")
    .description(
      "Clone AFFiNE, build BlockSuite workspaces, and pack them into .tgz files",
    )
    .option(
      "--affine-dir <path>",
      "Destination for the AFFiNE clone",
      DEFAULT_AFFINE_DIR,
    )
    .option("--ref <git-ref>", "Git reference to check out", "main")
    .option(
      "--pack-dir <path>",
      "Output directory for package tarballs",
      "dist/blocksuite-tgz",
    )
    .option(
      "--packages <names...>",
      "Subset of @blocksuite/* workspaces to pack",
    )
    .option(
      "--exclude-workspaces <names...>",
      "@blocksuite/* workspaces to skip during the build step",
      DEFAULT_EXCLUDED_WORKSPACES,
    )
    .option(
      "--source-repo <url>",
      "Git repository containing BlockSuite workspaces",
      DEFAULT_SOURCE_REPO,
    )
    .option("--skip-install", "Skip yarn install inside AFFiNE", false)
    .option("--upload", "Upload tarballs as a GitHub Actions artifact", false)
    .option(
      "--artifact-name <name>",
      "Artifact name used during upload",
      "blocksuite-packages",
    )
    .option("--clean", "Clean the pack directory before packing", false)
    .action(async (options) => {
      const buildOptions = parseBuildOptions(options);

      await buildAndMaybeUpload(buildOptions);
    });

  program
    .command("release")
    .description(
      "Build BlockSuite for a specific version and upload artifacts to a GitHub release",
    )
    .requiredOption("--version <semver>", "BlockSuite version to package")
    .option(
      "--ref <git-ref>",
      "AFFiNE git reference to check out (defaults to the tag named <version>)",
    )
    .option(
      "--affine-dir <path>",
      "Destination for the AFFiNE clone",
      DEFAULT_AFFINE_DIR,
    )
    .option(
      "--pack-dir <path>",
      "Output directory for package tarballs",
      "dist/blocksuite-tgz",
    )
    .option(
      "--packages <names...>",
      "Subset of @blocksuite/* workspaces to pack",
    )
    .option(
      "--exclude-workspaces <names...>",
      "@blocksuite/* workspaces to skip during the build step",
      DEFAULT_EXCLUDED_WORKSPACES,
    )
    .option(
      "--source-repo <url>",
      "Git repository containing BlockSuite workspaces",
      DEFAULT_SOURCE_REPO,
    )
    .option("--skip-install", "Skip yarn install inside AFFiNE", false)
    .option("--clean", "Clean the pack directory before packing", true)
    .option(
      "--repository <owner/repo>",
      "Target repository for the release (defaults to GITHUB_REPOSITORY)",
    )
    .option(
      "--token <github-token>",
      "GitHub token to create releases and upload assets (defaults to GITHUB_TOKEN)",
    )
    .option(
      "--tag <tag>",
      "Tag name used for the release (defaults to <version>)",
    )
    .action(async (options) => {
      const releaseOptions = parseReleaseOptions(options);
      const tag = releaseOptions.tag ?? releaseOptions.version;

      const affineRef = releaseOptions.affineRef ?? releaseOptions.ref ?? tag;
      const repository =
        releaseOptions.repository ?? process.env["GITHUB_REPOSITORY"];
      const token = releaseOptions.token ?? process.env["GITHUB_TOKEN"];

      if (!affineRef) {
        throw new Error(
          "AFFiNE git ref must be provided via --ref, --affine-ref, or default from --version/--tag.",
        );
      }

      if (!repository || !repository.includes("/")) {
        throw new Error(
          "Repository must be provided as owner/repo via --repository or GITHUB_REPOSITORY.",
        );
      }

      if (!token) {
        throw new Error(
          "GITHUB_TOKEN (or --token) is required to create releases and upload assets.",
        );
      }

      const [owner, repo] = repository.split("/");
      if (!owner || !repo) {
        throw new Error(
          "Repository must be provided as owner/repo via --repository or GITHUB_REPOSITORY.",
        );
      }
      const octokit = new Octokit({ auth: token });

      const { files } = await buildAndMaybeUpload({
        affineDir: releaseOptions.affineDir,
        ref: affineRef,
        packDir: releaseOptions.packDir,
        ...(releaseOptions.packages
          ? { packages: releaseOptions.packages }
          : {}),
        skipInstall: releaseOptions.skipInstall,
        upload: false,
        artifactName: "",
        clean: releaseOptions.clean,
        sourceRepo: releaseOptions.sourceRepo ?? DEFAULT_SOURCE_REPO,
        excludeWorkspaces:
          releaseOptions.excludeWorkspaces ?? DEFAULT_EXCLUDED_WORKSPACES,
      });

      const release = await ensureRelease(
        octokit,
        owner,
        repo,
        tag,
        releaseOptions.version,
      );
      await uploadReleaseAssets(octokit, owner, repo, release.id, files);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
