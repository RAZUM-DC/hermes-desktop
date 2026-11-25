import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this contract in sync with electron-builder.yml and the release matrix.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function requiredReleaseArtifacts(
  name,
  version,
  includeMac = false,
  macUnsigned = false,
) {
  if (typeof includeMac !== "boolean") {
    throw new Error("includeMac must be an explicit boolean");
  }
  if (typeof macUnsigned !== "boolean") {
    throw new Error("macUnsigned must be an explicit boolean");
  }
  if (includeMac && macUnsigned) {
    throw new Error("Signed and unsigned macOS cannot ship in one release");
  }
  const prefix = `${name}-${version}`;
  return [
    // Without Apple credentials: the ad-hoc test app, both architectures, no feed.
    ...(macUnsigned ? unsignedMacArtifacts(name, version) : []),
    ...(includeMac
      ? [
          `${prefix}-x64.dmg`,
          `${prefix}-arm64.dmg`,
          `${prefix}-x64-mac.zip`,
          `${prefix}-arm64-mac.zip`,
        ]
      : []),
    `${prefix}-x86_64.AppImage`,
    `${prefix}-arm64.AppImage`,
    `${name}_${version}_amd64.deb`,
    `${prefix}.rpm`,
    `${prefix}-setup.exe`,
    `${prefix}-setup.exe.blockmap`,
    `${prefix}-portable.exe`,
    `${prefix}.msi`,
    "latest.yml",
    "latest-linux.yml",
    "latest-linux-arm64.yml",
  ];
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function unsignedMacArtifacts(name, version) {
  const prefix = `${name}-${version}`;
  return ["x64", "arm64"].flatMap((arch) => [
    `${prefix}-${arch}-test-unnotarized.dmg`,
    `${prefix}-${arch}-test-unnotarized-mac.zip`,
  ]);
}

// @lat: [[release-packaging#Release Packaging#Complete release artifacts]]
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function prepareReleaseArtifacts({
  artifactsDir,
  name,
  version,
  includeMac = false,
  macUnsigned = false,
}) {
  const required = requiredReleaseArtifacts(
    name,
    version,
    includeMac,
    macUnsigned,
  );
  const present = readdirSync(artifactsDir);
  // Never mix the test app into a signed macOS release. Otherwise leftover test
  // files (e.g. one architecture of a failed unsigned build) are simply not on
  // the explicit allowlist below.
  if (
    includeMac &&
    present.some((file) => file.includes("-test-unnotarized"))
  ) {
    throw new Error(
      "Test macOS artifacts must never be published in a signed macOS release",
    );
  }
  const invalid = required.filter((file) => {
    if (!present.includes(file)) return true;
    const stat = lstatSync(join(artifactsDir, file));
    return !stat.isFile() || stat.size === 0;
  });
  if (invalid.length > 0) {
    throw new Error(
      `Missing or empty release artifacts: ${invalid.join(", ")}`,
    );
  }

  // Never infer macOS readiness from downloaded files or publish a stale feed.
  if (!includeMac) return required;

  // When enabled, both architectures are mandatory. Never publish a partial feed.
  const files = ["x64", "arm64"].map((arch) => {
    const url = `${name}-${version}-${arch}-mac.zip`;
    const bytes = readFileSync(join(artifactsDir, url));
    return {
      url,
      sha512: createHash("sha512").update(bytes).digest("base64"),
      size: bytes.length,
    };
  });
  const lines = [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${files[0].url}`,
    `sha512: ${files[0].sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ];
  writeFileSync(join(artifactsDir, "latest-mac.yml"), lines.join("\n"));

  // An explicit allowlist avoids uploading stale or unrelated downloaded files.
  const optionalBlockmaps = files
    .map((file) => `${file.url}.blockmap`)
    .filter((file) => present.includes(file));
  return [...required, ...optionalBlockmaps, "latest-mac.yml"];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
  const artifactsDir = process.argv[2] || "artifacts";
  const flag = process.env.INCLUDE_MACOS;
  if (flag !== "true" && flag !== "false") {
    throw new Error("INCLUDE_MACOS must be explicitly set to true or false");
  }
  const unsigned = process.env.MACOS_UNSIGNED ?? "false";
  if (unsigned !== "true" && unsigned !== "false") {
    throw new Error("MACOS_UNSIGNED must be true or false");
  }
  const files = prepareReleaseArtifacts({
    artifactsDir,
    name,
    version,
    includeMac: flag === "true",
    macUnsigned: unsigned === "true",
  });
  console.log(`Verified ${files.length} release files for ${version}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `files<<RELEASE_FILES\n${files.map((file) => join(artifactsDir, file)).join("\n")}\nRELEASE_FILES\n`,
    );
  }
}
