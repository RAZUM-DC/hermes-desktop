// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - Release tooling is plain Node ESM, outside the app TS build.
import {
  prepareReleaseArtifacts,
  requiredReleaseArtifacts,
} from "../scripts/prepare-release-artifacts.mjs";

const name = "hermes-desktop";
const version = "9.9.9";
const required: string[] = requiredReleaseArtifacts(name, version, true);
let artifactsDir: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), "release-artifacts-"));
  for (const file of required) {
    writeFileSync(join(artifactsDir, file), `fixture for ${file}`);
  }
});
afterEach(() => rmSync(artifactsDir, { recursive: true, force: true }));

describe("release artifact contract", () => {
  // @lat: [[release-packaging#Release Packaging#Regression checks]]
  it("includes both Linux architectures and their separate update feeds", () => {
    expect(required).toContain(`${name}-${version}-x86_64.AppImage`);
    expect(required).toContain(`${name}-${version}-arm64.AppImage`);
    expect(required).toContain("latest-linux.yml");
    expect(required).toContain("latest-linux-arm64.yml");
    expect(required).not.toContain(`${name}-${version}.AppImage`);
  });

  it.each(required)("rejects a missing %s before writing metadata", (file) => {
    rmSync(join(artifactsDir, file));
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow(file);
    expect(existsSync(join(artifactsDir, "latest-mac.yml"))).toBe(false);
  });

  it.each(required)("rejects an empty %s", (file) => {
    writeFileSync(join(artifactsDir, file), "");
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow(file);
  });

  it("requires arm64 even when an obsolete architecture-free AppImage exists", () => {
    rmSync(join(artifactsDir, `${name}-${version}-arm64.AppImage`));
    writeFileSync(join(artifactsDir, `${name}-${version}.AppImage`), "old");
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow("arm64.AppImage");
  });

  it("uses electron-builder's x86_64 filename rather than the matrix label x64", () => {
    rmSync(join(artifactsDir, `${name}-${version}-x86_64.AppImage`));
    writeFileSync(
      join(artifactsDir, `${name}-${version}-x64.AppImage`),
      "wrong name",
    );
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow("x86_64.AppImage");
  });

  it("writes both macOS ZIP hashes and sizes with x64 as the primary update", () => {
    const result = prepareReleaseArtifacts({
      artifactsDir,
      name,
      version,
      includeMac: true,
    });
    expect(result).toEqual([...required, "latest-mac.yml"]);
    const metadata = readFileSync(join(artifactsDir, "latest-mac.yml"), "utf8");
    expect(metadata).toContain(`version: ${version}\n`);
    expect(metadata).toContain(`path: ${name}-${version}-x64-mac.zip\n`);
    for (const arch of ["x64", "arm64"]) {
      const url = `${name}-${version}-${arch}-mac.zip`;
      const bytes = readFileSync(join(artifactsDir, url));
      const hash = createHash("sha512").update(bytes).digest("base64");
      expect(metadata).toContain(
        `  - url: ${url}\n    sha512: ${hash}\n    size: ${bytes.length}\n`,
      );
    }
  });

  it("allows known optional ZIP blockmaps but not stale or unrelated files", () => {
    const blockmap = `${name}-${version}-arm64-mac.zip.blockmap`;
    writeFileSync(join(artifactsDir, blockmap), "blockmap");
    writeFileSync(join(artifactsDir, "unrelated.zip"), "unrelated");
    const result = prepareReleaseArtifacts({
      artifactsDir,
      name,
      version,
      includeMac: true,
    });
    expect(result).toContain(blockmap);
    expect(result).not.toContain("unrelated.zip");
  });

  it("rejects test macOS artifacts even when the release set is complete", () => {
    writeFileSync(
      join(artifactsDir, `${name}-${version}-arm64-test-unnotarized.dmg`),
      "test",
    );
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow("Test macOS artifacts");
  });
});

describe("Windows/Linux-only release", () => {
  const baseFiles: string[] = requiredReleaseArtifacts(name, version, false);
  const macFiles = required.filter((file) => !baseFiles.includes(file));
  const prepare = (): string[] =>
    prepareReleaseArtifacts({ artifactsDir, name, version, includeMac: false });

  beforeEach(() => {
    for (const file of macFiles) rmSync(join(artifactsDir, file));
  });

  it("publishes the complete Windows/Linux set without macOS files or feed", () => {
    expect(prepare()).toEqual(baseFiles);
    expect(baseFiles).toHaveLength(11);
    expect(existsSync(join(artifactsDir, "latest-mac.yml"))).toBe(false);
    expect(prepareReleaseArtifacts({ artifactsDir, name, version })).toEqual(
      baseFiles,
    );
  });

  it.each(baseFiles)("still rejects a missing required %s", (file) => {
    rmSync(join(artifactsDir, file));
    expect(prepare).toThrow(file);
  });

  it("never publishes stale macOS installers, feed or blockmaps", () => {
    for (const file of [
      ...macFiles,
      "latest-mac.yml",
      `${name}-${version}-arm64-mac.zip.blockmap`,
    ]) {
      writeFileSync(join(artifactsDir, file), "stale mac artifact");
    }
    expect(prepare()).toEqual(baseFiles);
    expect(readFileSync(join(artifactsDir, "latest-mac.yml"), "utf8")).toBe(
      "stale mac artifact",
    );
  });

  it("does not silently fall back when macOS was requested", () => {
    expect(() =>
      prepareReleaseArtifacts({
        artifactsDir,
        name,
        version,
        includeMac: true,
      }),
    ).toThrow("x64.dmg");
  });

  it.each(["false", "true", "", null, 0, 1])(
    "rejects an ambiguous platform flag %s",
    (includeMac) => {
      expect(() =>
        prepareReleaseArtifacts({ artifactsDir, name, version, includeMac }),
      ).toThrow("explicit boolean");
    },
  );

  it("also rejects test artifacts in a Windows/Linux-only release", () => {
    writeFileSync(
      join(artifactsDir, `${name}-${version}-arm64-test-unnotarized.dmg`),
      "test",
    );
    expect(prepare).toThrow("Test macOS artifacts");
  });
});

describe("release workflow safety", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  const publish = workflow
    .split("\n  publish:\n")[1]
    .split("\n  rebuild_landing_page:")[0];

  it("only releases by explicit dispatch, dry-runs by default, and never cancels publication", () => {
    const triggers = workflow.split("\npermissions:")[0];
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/\n {2}(push|pull_request|workflow_run):/);
    expect(triggers).toMatch(/dry_run:[\s\S]*?default: true/);
    expect(triggers).toMatch(/include_macos:[\s\S]*?default: false/);
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('"$GITHUB_REF" != "refs/heads/release"');
  });

  it("only promotes a draft after verifying every uploaded asset", () => {
    expect(publish).toContain("draft: true");
    expect(
      publish.indexOf("node scripts/verify-release-assets.mjs"),
    ).toBeGreaterThan(publish.indexOf("uses: softprops/action-gh-release@v2"));
    expect(publish.indexOf("--draft=false")).toBeGreaterThan(
      publish.indexOf("node scripts/verify-release-assets.mjs"),
    );
    expect(publish).toContain(
      "INCLUDE_MACOS: ${{ needs.prepare.outputs.include_macos }}",
    );
  });

  it("waits for every platform and validates artifacts before creating a tag", () => {
    expect(publish).toContain(
      "needs: [prepare, release_mac, release_linux, release_windows]",
    );
    expect(
      publish.indexOf("node scripts/prepare-release-artifacts.mjs"),
    ).toBeLessThan(publish.indexOf("- name: Create tag"));
    expect(publish).toContain("fail_on_unmatched_files: true");
    expect(publish).toContain("files: ${{ steps.artifacts.outputs.files }}");
  });

  it("allows existing tags only in dry runs and guards both publication steps", () => {
    expect(publish).toContain(
      "needs.prepare.outputs.tag_exists == 'false' || needs.prepare.outputs.is_dry_run == 'true'",
    );
    expect(
      publish.match(/if: needs\.prepare\.outputs\.is_dry_run == 'false'/g),
    ).toHaveLength(3);
  });

  it("keeps Apple and Windows signing credentials separate", () => {
    const mac = workflow
      .split("\n  release_mac:\n")[1]
      .split("\n  release_linux:")[0];
    expect(mac).toContain("CSC_LINK: ${{ secrets.MAC_CSC_LINK }}");
    expect(mac).not.toContain("secrets.CSC_LINK");
    expect(workflow).toContain("WIN_CSC_LINK: ${{ secrets.CSC_LINK }}");
    expect(mac).not.toContain("Hermes One.app");
  });

  // @lat: [[release-packaging#Release Packaging#Test macOS builds]]
  it("keeps the manual test workflow read-only, credential-free and off the release feed", () => {
    const testWorkflow = readFileSync(
      ".github/workflows/macos-test.yml",
      "utf8",
    );
    const profile = readFileSync("electron-builder.macos-test.yml", "utf8");
    expect(testWorkflow).toContain("workflow_dispatch:");
    expect(testWorkflow).toContain("pull_request:");
    expect(testWorkflow).toContain("branches: [main, release]");
    expect(testWorkflow).toContain("contents: read");
    expect(testWorkflow).not.toMatch(/secrets\.|git push|action-gh-release/);
    expect(testWorkflow).toContain("--publish never");
    expect(testWorkflow).toContain('CSC_FOR_PULL_REQUEST: "true"');
    expect(profile).toContain("publish: null");
    expect(profile).toContain('identity: "-"');
    expect(profile).toContain("notarize: false");
    expect(profile).toContain("appId: tools.razum.hermes-desktop.test");
    expect(profile).toContain("-test-unnotarized");
  });
});
