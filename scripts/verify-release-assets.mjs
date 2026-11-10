import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @lat: [[release-packaging#Release Packaging#Publication boundary]]
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function verifyReleaseAssets({ release, tag, files }) {
  if (
    release.draft !== true ||
    release.prerelease !== false ||
    release.tag_name !== tag
  ) {
    throw new Error(
      "Expected the selected tag's unpublished, non-prerelease draft",
    );
  }
  const expected = files.map((file) => basename(file));
  if (expected.length === 0 || new Set(expected).size !== expected.length) {
    throw new Error("Expected a non-empty, unique release file allowlist");
  }
  if (
    !Array.isArray(release.assets) ||
    release.assets.length !== expected.length
  ) {
    throw new Error(
      "Uploaded assets do not match the complete selected release",
    );
  }
  for (const file of files) {
    const matches = release.assets.filter(
      (asset) => asset.name === basename(file),
    );
    const bytes = readFileSync(file);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      matches[0].size !== bytes.length ||
      matches[0].digest !== digest
    ) {
      throw new Error(
        `Uploaded asset is missing, incomplete or corrupt: ${basename(file)}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const release = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const files = (process.env.RELEASE_FILES || "").split("\n").filter(Boolean);
  verifyReleaseAssets({ release, tag: process.env.RELEASE_TAG, files });
  console.log(`Verified ${files.length} uploaded assets before publication`);
}
