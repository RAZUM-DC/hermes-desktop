// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
let bin: string;
let output: string;
const script = resolve("scripts/verify-macos-native-arch.sh");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "macos-native-check-"));
  bin = join(root, "bin");
  output = join(root, "test output");
  mkdirSync(bin);
  mkdirSync(output);
  const commands = {
    file: "printf 'Mach-O fixture\\n'",
    // Apple's lipo requires the file before the variadic architecture list.
    lipo: 'test "$#" -eq 3 && test -f "$1" && test "$2" = -verify_arch && test "$3" = "$(cat "$1")"',
    codesign:
      'if [ "$1" = --verify ]; then test "${FAIL_CODESIGN:-0}" = 0; else printf "Signature=%s\\n" "${TEST_SIGNATURE:-adhoc}" >&2; fi',
  };
  for (const [name, command] of Object.entries(commands)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${command}\n`, {
      mode: 0o755,
    });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function bundle(arch: string, binaryArch: string): string {
  const resources = join(
    output,
    arch === "x64" ? "mac" : "mac-arm64",
    "РАЗУМ Ассистент Test.app",
    "Contents",
    "Resources",
  );
  const nativeDir = join(
    resources,
    "app.asar.unpacked/node_modules/better-sqlite3/build/Release",
  );
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(nativeDir, "better_sqlite3.node"), binaryArch);
  return resources;
}

function verify(
  arch: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [script, arch, output], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MACOS_TEST_BUILD: "true",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

// The production script runs on macOS; Linux can exercise its shell contract too.
describe.skipIf(process.platform === "win32")(
  "macOS bundle verification",
  () => {
    it.each([
      ["x64", "x86_64"],
      ["arm64", "arm64"],
    ])(
      "checks %s bundles with spaces and Cyrillic names",
      (arch, binaryArch) => {
        bundle(arch, binaryArch);
        const result = verify(arch);
        expect(result.status, String(result.stderr)).toBe(0);
      },
    );

    it("rejects a native module built for the wrong architecture", () => {
      bundle("arm64", "x86_64");
      expect(verify("arm64").status).not.toBe(0);
    });

    it("rejects a missing app bundle", () => {
      expect(verify("x64").status).not.toBe(0);
    });

    it("rejects multiple app bundles instead of guessing", () => {
      bundle("x64", "x86_64");
      mkdirSync(join(output, "mac", "Other.app"));
      expect(verify("x64").status).not.toBe(0);
    });

    it("rejects a production update feed in a test app", () => {
      const resources = bundle("arm64", "arm64");
      writeFileSync(join(resources, "app-update.yml"), "provider: github\n");
      expect(verify("arm64").status).not.toBe(0);
    });

    it("rejects an invalid signature", () => {
      bundle("arm64", "arm64");
      expect(verify("arm64", { FAIL_CODESIGN: "1" }).status).not.toBe(0);
    });

    it("requires the explicitly ad-hoc test signature", () => {
      bundle("arm64", "arm64");
      expect(verify("arm64", { TEST_SIGNATURE: "other" }).status).not.toBe(0);
    });
  },
);
