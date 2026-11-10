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
export function requiredReleaseArtifacts(name, version) {
  const prefix = `${name}-${version}`;
  return [
    `${prefix}-x64.dmg`,
    `${prefix}-arm64.dmg`,
    `${prefix}-x64-mac.zip`,
    `${prefix}-arm64-mac.zip`,
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

// @lat: [[release-packaging#Release Packaging#Complete release artifacts]]
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function prepareReleaseArtifacts({ artifactsDir, name, version }) {
  const required = requiredReleaseArtifacts(name, version);
  const present = readdirSync(artifactsDir);
  if (present.some((file) => file.includes("-test-unnotarized"))) {
    throw new Error(
      "Test macOS artifacts must never be published as a release",
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

  // Both architectures are mandatory. Never silently publish a partial feed.
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
  const files = prepareReleaseArtifacts({ artifactsDir, name, version });
  console.log(`Verified ${files.length} release files for ${version}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `files<<RELEASE_FILES\n${files.map((file) => join(artifactsDir, file)).join("\n")}\nRELEASE_FILES\n`,
    );
  }
}
