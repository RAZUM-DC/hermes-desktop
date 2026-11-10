// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
// @ts-expect-error - Release tooling is plain Node ESM, outside the app TS build.
import { verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";

const require = createRequire(import.meta.url);
const workflow = require("js-yaml").load(
  readFileSync(".github/workflows/release.yml", "utf8"),
);
const statuses = ["success", "failure", "cancelled", "skipped"];

describe("release job selection", () => {
  // @lat: [[release-packaging#Release Packaging#Optional production macOS]]
  it("allows intentional macOS skipping, never failed or cancelled required builds", () => {
    // The condition uses the common boolean/string syntax of Actions and JS.
    // Check the actual YAML expression, including its explicit status function:
    // without cancelled(), Actions would implicitly prepend success().
    const expression = workflow.jobs.publish.if.replace(
      /^\$\{\{\s*|\s*\}\}$/g,
      "",
    );
    expect(expression).toContain("!cancelled()");
    expect(workflow.jobs.publish.needs).toEqual([
      "prepare",
      "release_mac",
      "release_linux",
      "release_windows",
    ]);
    for (const includeMac of ["true", "false", ""]) {
      for (const prepare of statuses) {
        for (const linux of statuses) {
          for (const windows of statuses) {
            for (const mac of statuses) {
              const needs = {
                prepare: {
                  result: prepare,
                  outputs: {
                    include_macos: includeMac,
                    tag_exists: "false",
                    is_dry_run: "false",
                  },
                },
                release_linux: { result: linux },
                release_windows: { result: windows },
                release_mac: { result: mac },
              };
              const selectedMacPassed =
                (includeMac === "false" && mac === "skipped") ||
                (includeMac === "true" && mac === "success");
              const expected =
                prepare === "success" &&
                linux === "success" &&
                windows === "success" &&
                selectedMacPassed;
              expect(
                runInNewContext(expression, { needs, cancelled: () => false }),
              ).toBe(expected);
              expect(
                runInNewContext(expression, { needs, cancelled: () => true }),
              ).toBe(false);
              needs.prepare.outputs.tag_exists = "true";
              expect(
                runInNewContext(expression, { needs, cancelled: () => false }),
              ).toBe(false);
              needs.prepare.outputs.is_dry_run = "true";
              expect(
                runInNewContext(expression, { needs, cancelled: () => false }),
              ).toBe(expected);
            }
          }
        }
      }
    }
  });

  it("skips production macOS unless explicitly selected", () => {
    const expression = workflow.jobs.release_mac.if;
    for (const includeMac of ["true", "false", ""]) {
      for (const tagExists of ["true", "false"]) {
        for (const dryRun of ["true", "false"]) {
          const needs = {
            prepare: {
              outputs: {
                include_macos: includeMac,
                tag_exists: tagExists,
                is_dry_run: dryRun,
              },
            },
          };
          expect(runInNewContext(expression, { needs })).toBe(
            includeMac === "true" &&
              (tagExists === "false" || dryRun === "true"),
          );
        }
      }
    }
  });
});

describe("draft asset verification", () => {
  let dir: string;
  let files: string[];
  let release: {
    draft: boolean;
    prerelease: boolean;
    tag_name: string;
    assets: Array<{
      name: string;
      state: string;
      size: number;
      digest: string;
    }>;
  };
  const tag = "v9.9.9";
  const verify = (): void => verifyReleaseAssets({ release, tag, files });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-upload-"));
    files = ["installer.exe", "linux.AppImage", "latest.yml"].map((name) =>
      join(dir, name),
    );
    release = {
      draft: true,
      prerelease: false,
      tag_name: tag,
      assets: files.map((file) => {
        const bytes = Buffer.from(`fixture ${basename(file)}`);
        writeFileSync(file, bytes);
        return {
          name: basename(file),
          state: "uploaded",
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      }),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("accepts the exact selected set with matching size and SHA-256", () => {
    expect(verify).not.toThrow();
    release.assets.reverse();
    expect(verify).not.toThrow();
  });
  it.each([
    "missing",
    "extra",
    "duplicate",
    "uploading",
    "wrong size",
    "wrong hash",
    "missing hash",
  ])("rejects %s assets", (kind) => {
    if (kind === "missing") release.assets.pop();
    if (kind === "extra")
      release.assets.push({ ...release.assets[0], name: "stale-mac.dmg" });
    if (kind === "duplicate") release.assets[1] = { ...release.assets[0] };
    if (kind === "uploading") release.assets[0].state = "starter";
    if (kind === "wrong size") release.assets[0].size++;
    if (kind === "wrong hash") release.assets[0].digest = "sha256:bad";
    if (kind === "missing hash") release.assets[0].digest = "";
    expect(verify).toThrow();
  });
  it.each(["public", "prerelease", "wrong tag"])(
    "rejects a %s release",
    (kind) => {
      if (kind === "public") release.draft = false;
      if (kind === "prerelease") release.prerelease = true;
      if (kind === "wrong tag") release.tag_name = "v1.0.0";
      expect(verify).toThrow("unpublished");
    },
  );
  it.each([false, true])(
    "rejects an empty or duplicate allowlist (%s)",
    (duplicate) => {
      files = duplicate ? [files[0], files[0]] : [];
      expect(verify).toThrow("unique");
    },
  );

  it("runs the real CLI for a valid draft and refuses a corrupt one", () => {
    const metadata = join(dir, "release.json");
    const run = (): Buffer =>
      execFileSync(
        process.execPath,
        ["scripts/verify-release-assets.mjs", metadata],
        {
          env: {
            ...process.env,
            RELEASE_FILES: files.join("\n"),
            RELEASE_TAG: tag,
          },
          stdio: "pipe",
        },
      );
    writeFileSync(metadata, JSON.stringify(release));
    expect(run().toString()).toContain("Verified 3 uploaded assets");
    release.assets[0].digest = "sha256:wrong";
    writeFileSync(metadata, JSON.stringify(release));
    expect(run).toThrow();
  });
});
