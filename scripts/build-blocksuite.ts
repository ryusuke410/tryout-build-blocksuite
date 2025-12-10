#!/usr/bin/env node
import { DefaultArtifactClient } from "@actions/artifact";
import { Command } from "commander";
import { execa } from "execa";
import { mkdirp, pathExists, readdir, remove } from "fs-extra";
import { join, resolve } from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";

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

async function run(command: string, args: string[], cwd?: string) {
  const options = { stdio: "inherit" as const, ...(cwd ? { cwd } : {}) };
  await execa(command, args, options);
}

function logStep(title: string) {
  const separator = "=".repeat(60);
  console.log(`\n${separator}\n${title}\n${separator}`);
}

async function ensureAffineRepo(dir: string, ref: string) {
  const affineUrl = "https://github.com/toeverything/AFFiNE.git";
  if (!(await pathExists(dir))) {
    logStep(`Cloning AFFiNE into ${dir}`);
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      ref,
      affineUrl,
      dir,
    ]);
    return;
  }

  logStep(`Updating AFFiNE in ${dir}`);
  await run("git", ["-C", dir, "fetch", "--tags", "origin"]);
  await run("git", ["-C", dir, "checkout", ref]);
  try {
    await run("git", ["-C", dir, "pull", "--ff-only", "origin", ref]);
  } catch (error) {
    console.warn(
      `Skipping fast-forward pull for ref ${ref}: ${(error as Error).message}`,
    );
  }
}

async function installDependencies(dir: string, skipInstall: boolean) {
  if (skipInstall) {
    console.log("Skipping dependency installation.");
    return;
  }

  logStep("Installing dependencies in AFFiNE");
  await run("pnpm", ["install", "--frozen-lockfile"], dir);
}

async function buildBlocksuite(dir: string) {
  logStep("Building @blocksuite/* packages");
  await run(
    "pnpm",
    ["--filter", "@blocksuite/*", "--recursive", "run", "build"],
    dir,
  );
}

async function packBlocksuite(dir: string, packDir: string, clean: boolean) {
  logStep(`Packing BlockSuite packages into ${packDir}`);
  const absolutePackDir = resolve(packDir);

  if (clean && (await pathExists(absolutePackDir))) {
    await remove(absolutePackDir);
  }

  await mkdirp(absolutePackDir);
  await run(
    "pnpm",
    [
      "--filter",
      "@blocksuite/*",
      "--recursive",
      "pack",
      "--pack-destination",
      absolutePackDir,
    ],
    dir,
  );

  const files = (await readdir(absolutePackDir))
    .filter((name: string) => name.endsWith(".tgz"))
    .map((name: string) => join(absolutePackDir, name));

  if (!files.length) {
    throw new Error("No BlockSuite package tarballs were produced.");
  }

  console.log(`Packed ${files.length} files:`);
  files.forEach((file: string) => console.log(`- ${file}`));
  return { absolutePackDir, files };
}

async function uploadArtifact(
  dir: string,
  files: string[],
  artifactName: string,
) {
  const isRunningInActions = process.env["GITHUB_ACTIONS"] === "true";
  if (!isRunningInActions) {
    console.warn(
      "Artifact upload requested, but this is not running inside GitHub Actions. Skipping.",
    );
    return;
  }

  const client = new DefaultArtifactClient();
  await client.uploadArtifact(artifactName, files, dir);
  console.log(
    `Uploaded artifact "${artifactName}" with ${files.length} files.`,
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
      console.log(`Release for tag ${tag} not found. Creating...`);
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
      console.log(`Deleting existing asset ${name} before upload...`);
      await octokit.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: existingId,
      });
    }

    const buffer = Buffer.from(await readFile(file));
    console.log(`Uploading asset ${name} (${buffer.byteLength} bytes)...`);
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

async function buildAndMaybeUpload(options: BuildOptions) {
  const affineDir = resolve(options.affineDir);

  await ensureAffineRepo(affineDir, options.ref);
  await installDependencies(affineDir, options.skipInstall);
  await buildBlocksuite(affineDir);
  const result = await packBlocksuite(
    affineDir,
    options.packDir,
    options.clean,
  );

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
      "vendor/AFFiNE",
    )
    .option("--ref <git-ref>", "Git reference to check out", "main")
    .option(
      "--pack-dir <path>",
      "Output directory for package tarballs",
      "dist/blocksuite-tgz",
    )
    .option("--skip-install", "Skip pnpm install inside AFFiNE", false)
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
      "AFFiNE git reference to check out (defaults to blocksuite@<version>)",
    )
    .option(
      "--affine-dir <path>",
      "Destination for the AFFiNE clone",
      "vendor/AFFiNE",
    )
    .option(
      "--pack-dir <path>",
      "Output directory for package tarballs",
      "dist/blocksuite-tgz",
    )
    .option("--skip-install", "Skip pnpm install inside AFFiNE", false)
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
      "Tag name used for the release (defaults to blocksuite@<version>)",
    )
    .action(async (options) => {
      const releaseOptions = options as ReleaseOptions;
      const tag = releaseOptions.tag ?? `blocksuite@${releaseOptions.version}`;
      const affineRef = releaseOptions.affineRef ?? releaseOptions.ref ?? tag;
      const repository =
        releaseOptions.repository ?? process.env["GITHUB_REPOSITORY"];
      const token = releaseOptions.token ?? process.env["GITHUB_TOKEN"];

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
