#!/usr/bin/env node
import { Command } from "commander";
import { mkdirp, remove } from "fs-extra";
import { join, resolve } from "node:path";
import process from "node:process";
import { $ } from "zx";

$.verbose = true;

interface CompareOptions {
  version: string;
  ref?: string;
  affineDir: string;
  packageName: string;
  packDir: string;
  skipInstall: boolean;
  sourceRepo: string;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCompareOptions(options: unknown): CompareOptions {
  if (!isRecord(options)) {
    throw new Error("Invalid options provided to compare-blocksuite.");
  }

  if (
    typeof options.version !== "string" ||
    typeof options.affineDir !== "string" ||
    typeof options.packageName !== "string" ||
    typeof options.packDir !== "string" ||
    typeof options.skipInstall !== "boolean" ||
    typeof options.sourceRepo !== "string"
  ) {
    throw new Error("Invalid options provided to compare-blocksuite.");
  }

  if (options.ref !== undefined && typeof options.ref !== "string") {
    throw new Error("ref must be a string when provided.");
  }

  return {
    version: options.version,
    ref: typeof options.ref === "string" ? options.ref : undefined,
    affineDir: options.affineDir,
    packageName: options.packageName,
    packDir: options.packDir,
    skipInstall: options.skipInstall,
    sourceRepo: options.sourceRepo,
  };
}

function normalizeBaseName(packageName: string) {
  return packageName.replace("@", "").replace("/", "-");
}

async function buildLocalTarball(
  options: CompareOptions,
  localPackDir: string,
) {
  const ref = options.ref ?? options.version;
  const baseName = normalizeBaseName(options.packageName);
  const localPackPath = resolve(REPO_ROOT, localPackDir);
  const args = [
    "run",
    "build-blocksuite",
    "--",
    "--affine-dir",
    resolve(REPO_ROOT, options.affineDir),
    "--ref",
    ref,
    "--pack-dir",
    localPackPath,
    "--clean",
    "--source-repo",
    options.sourceRepo,
    "--packages",
    options.packageName,
  ];

  if (options.skipInstall) {
    args.push("--skip-install");
  }

  await $`pnpm ${args}`;

  return join(localPackPath, `${baseName}.tgz`);
}

async function fetchNpmTarball(
  packageName: string,
  version: string,
  destination: string,
) {
  await mkdirp(destination);
  const npmVersion = version.replace(/^v/, "");
  const result =
    await $`npm pack ${packageName}@${npmVersion} --pack-destination ${destination}`;
  const filename = result.stdout.trim().split("\n").pop();

  if (!filename) {
    throw new Error("npm pack did not return a filename");
  }

  return resolve(destination, filename);
}

async function extractTarball(tarballPath: string, destination: string) {
  await remove(destination);
  await mkdirp(destination);
  await $`tar -xzf ${tarballPath} -C ${destination}`;
}

async function compareTarballs(npmDir: string, localDir: string) {
  const diffResult = await $({
    nothrow: true,
  })`diff -ruN ${npmDir} ${localDir}`;
  if (diffResult.exitCode !== 0) {
    throw new Error(
      "Local build does not match npm publication for the selected version.",
    );
  }
}

async function main() {
  const program = new Command()
    .name("compare-blocksuite")
    .description(
      "Build a BlockSuite package from AFFiNE and compare it with the npm-published tarball",
    )
    .option("--version <semver>", "Version to compare", "v0.19.5")
    .option(
      "--ref <git-ref>",
      "AFFiNE git reference to build (defaults to the provided version)",
    )
    .option(
      "--affine-dir <path>",
      "Directory to clone AFFiNE into",
      "vendor/blocksuite",
    )
    .option(
      "--source-repo <url>",
      "Git repository containing the BlockSuite sources to build",
      "https://github.com/toeverything/blocksuite.git",
    )
    .option(
      "--package-name <name>",
      "BlockSuite package to compare",
      "@blocksuite/blocks",
    )
    .option(
      "--pack-dir <path>",
      "Base directory for comparison artifacts",
      "dist/compare-blocksuite",
    )
    .option("--skip-install", "Skip yarn install inside AFFiNE", false);

  program.action(async (cmdOptions) => {
    const options = parseCompareOptions(cmdOptions);
    const baseDir = resolve(REPO_ROOT, options.packDir);
    const baseName = normalizeBaseName(options.packageName);
    const localPackDir = join(baseDir, "local-pack");
    const npmPackDir = join(baseDir, "npm-pack");
    const localExtractDir = join(baseDir, `${baseName}-local`);
    const npmExtractDir = join(baseDir, `${baseName}-npm`);

    await remove(baseDir);
    await mkdirp(baseDir);

    const localTarball = await buildLocalTarball(options, localPackDir);
    const npmTarball = await fetchNpmTarball(
      options.packageName,
      options.version,
      npmPackDir,
    );

    await extractTarball(localTarball, localExtractDir);
    await extractTarball(npmTarball, npmExtractDir);

    await compareTarballs(npmExtractDir, localExtractDir);

    console.log(
      `Success: ${options.packageName}@${options.version} matches between AFFiNE build and npm.`,
    );
  });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
