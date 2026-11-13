// @vitest-environment node
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// BUG-086: без companion в Mac-пакете вход невозможен. Проверяем, что для обеих
// архитектур лежат darwin-бинари нужной архитектуры, совпадающие с SHA256SUMS,
// и что electron-builder берёт их в секции mac.

const ROOT = join(__dirname, "..", "..");
const BINARIES = ["companion", "tool-connector", "cdp-connector"];
// Mach-O 64-bit: magic 0xfeedfacf (LE на диске cf fa ed fe), cputype следом.
const CPU = { arm64: 0x0100000c, x64: 0x01000007 } as const;

// @lat: [[mac-companion#Companion in the Mac bundle]]
describe("Mac bundle binaries", () => {
  for (const arch of Object.keys(CPU) as (keyof typeof CPU)[]) {
    it(`resources/bin/mac-${arch}: Mach-O ${arch}, совпадает с SHA256SUMS`, () => {
      const dir = join(ROOT, "resources", "bin", `mac-${arch}`);
      const sums = new Map(
        readFileSync(join(dir, "SHA256SUMS"), "utf8")
          .trim()
          .split("\n")
          .map((l) => {
            const [hash, name] = l.trim().split(/\s+/);
            return [name, hash] as const;
          }),
      );
      for (const name of BINARIES) {
        const buf = readFileSync(join(dir, name));
        expect(buf.readUInt32LE(0), `${name} magic`).toBe(0xfeedfacf);
        expect(buf.readUInt32LE(4), `${name} cpu`).toBe(CPU[arch]);
        expect(createHash("sha256").update(buf).digest("hex")).toBe(
          sums.get(name),
        );
      }
    });
  }

  it("electron-builder кладёт их в Contents/Resources/bin на Mac и не дублирует в asar", () => {
    const cfg = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
    const mac = cfg.slice(cfg.indexOf("\nmac:"), cfg.indexOf("\ndmg:"));
    expect(mac).toMatch(/from: resources\/bin\/mac-\$\{arch\}\s+to: bin/);
    for (const name of BINARIES) expect(mac).toContain(`- ${name}`);
    expect(cfg).toContain('- "!resources/bin/**"');
  });
});
