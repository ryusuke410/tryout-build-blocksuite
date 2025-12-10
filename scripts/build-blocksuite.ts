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
  skipInstall: boolean;
  upload: boolean;
  artifactName: string;
  clean: boolean;
}

interface ReleaseOptions {
  version: string;
  affineRef?: string;
  ref?: string;
  affineDir: string;
  packDir: string;
  skipInstall: boolean;
  clean: boolean;
  repository?: string;
  token?: string;
  tag?: string;
}

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

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function section(title: string) {
  const separator = "=".repeat(60);
  log(`\n${separator}`, colors.bright);
  log(title, colors.bright + colors.blue);
  log(separator, colors.bright);
}

async function ensureAffineRepo(dir: string, ref: string) {
  const affineUrl = "https://github.com/toeverything/AFFiNE.git";
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
    await $`git -C ${dir} remote add origin ${affineUrl}`;
  } else {
    section(`Updating AFFiNE in ${dir}`);
    const originExists =
      (await $({ nothrow: true })`git -C ${dir} remote get-url origin`)
        .exitCode === 0;
    if (!originExists) {
      await $`git -C ${dir} remote add origin ${affineUrl}`;
    } else {
      await $`git -C ${dir} remote set-url origin ${affineUrl}`;
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
    .map((line: string) => JSON.parse(line))
    .filter(
      (ws: any) =>
        ws.name?.startsWith("@blocksuite/") &&
        ws.location?.startsWith("blocksuite/"),
    );
}

async function ensureBlocksuiteLocation(affineDir: string) {
  section("Checking AFFiNE layout");
  const blocksuiteDir = resolve(affineDir, "blocksuite");
  if (!(await pathExists(affineDir))) {
    throw new Error("AFFiNE directory is missing after clone.");
  }

  if (!(await pathExists(blocksuiteDir))) {
    const packagesDir = resolve(affineDir, "packages");
    log(`BlockSuite not found at ${blocksuiteDir}`, colors.red);
    if (await pathExists(packagesDir)) {
      log("Available packages:", colors.yellow);
      for (const pkg of await readdir(packagesDir)) {
        const pkgPath = resolve(packagesDir, pkg);
        log(`- ${pkgPath}`, colors.yellow);
      }
    }
    throw new Error("BlockSuite directory not found in AFFiNE repository");
  }
  log(`Found BlockSuite at: ${blocksuiteDir}`, colors.green);
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

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const packageManager = packageJson.packageManager as string | undefined;
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

async function buildBlocksuite(dir: string) {
  section("Building @blocksuite/* packages");
  await $({ cwd: dir, env: { ...process.env, YARN_IGNORE_PATH: "1" } })`
    yarn exec yarn workspaces foreach --all --topological-dev --include @blocksuite/* run build
  `;
}

async function packBlocksuite(dir: string, packDir: string, clean: boolean) {
  section(`Packing BlockSuite packages into ${packDir}`);
  const absolutePackDir = resolve(REPO_ROOT, packDir);

  if (clean && (await pathExists(absolutePackDir))) {
    await remove(absolutePackDir);
  }

  await mkdirp(absolutePackDir);
  const workspaces = await getBlocksuiteWorkspaces(dir);
  const files: string[] = [];
  for (const ws of workspaces) {
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
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 404
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
    if (!name) continue;

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
      data: buffer as unknown as string,
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

  for (const ws of workspaces) {
    const filename = `${ws.name.replace("@", "").replace("/", "-")}.tgz`;
    const relativeTgz = join(relative(REPO_ROOT, packDir), filename);
    overrides[ws.name] = `file:./${relativeTgz}`;
  }

  log("Add the following to pnpm.overrides:", colors.bright);
  console.log(JSON.stringify(overrides, null, 2));

  const overridesPath = resolve(REPO_ROOT, "blocksuite-overrides.json");
  await writeFile(overridesPath, JSON.stringify(overrides, null, 2));
  log(`Saved overrides to ${overridesPath}`, colors.green);
}

async function buildAndMaybeUpload(options: BuildOptions) {
  const affineDir = resolve(REPO_ROOT, options.affineDir);

  await ensureAffineRepo(affineDir, options.ref);
  await assertCleanRepo(affineDir);
  await ensureBlocksuiteLocation(affineDir);
  await configureYarnVersion(affineDir);
  await installDependencies(affineDir, options.skipInstall);
  await buildBlocksuite(affineDir);
  const result = await packBlocksuite(
    affineDir,
    options.packDir,
    options.clean,
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
    .option("--skip-install", "Skip yarn install inside AFFiNE", false)
    .option("--upload", "Upload tarballs as a GitHub Actions artifact", false)
    .option(
      "--artifact-name <name>",
      "Artifact name used during upload",
      "blocksuite-packages",
    )
    .option("--clean", "Clean the pack directory before packing", false)
    .action(async (options) => {
      await buildAndMaybeUpload(options as BuildOptions);
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
      const releaseOptions = options as ReleaseOptions;
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
        skipInstall: releaseOptions.skipInstall,
        upload: false,
        artifactName: "",
        clean: releaseOptions.clean,
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
