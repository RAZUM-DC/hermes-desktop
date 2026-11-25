// @vitest-environment node
import { spawn } from "child_process";
import { once } from "events";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_ENV_UPDATE_SCRIPT,
  type RemoteEnvUpdate,
  type RemoteEnvUpdateResult,
} from "../src/main/ssh-env-update";

const directories: string[] = [];

function fixture(
  content = "OPENROUTER_API_KEY=sentinel\nTELEGRAM_BOT_TOKEN=keep\n",
): string {
  const directory = mkdtempSync(join(tmpdir(), "hermes-env-update-"));
  directories.push(directory);
  const path = join(directory, ".env");
  writeFileSync(path, content, { mode: 0o640 });
  return path;
}

function run(
  path: string,
  update: RemoteEnvUpdate,
  prefix = "",
): Promise<RemoteEnvUpdateResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", prefix + REMOTE_ENV_UPDATE_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify({ path, ...update }));
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The actual target is POSIX. Native Windows has neither fcntl nor POSIX ACLs;
// routing remains covered above while CI executes these behavioral tests.
describe.skipIf(process.platform === "win32")(
  "remote environment transactions",
  () => {
    // @lat: [[main-process#Main Process#SSH credential persistence#Concurrent writers]]
    it("serializes processes and preserves every unrelated credential", async () => {
      const path = fixture();
      const lock = spawn("python3", [
        "-c",
        "import fcntl,sys\nf=open(sys.argv[1]+'.lock','a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\nsys.stdin.read()",
        path,
      ]);
      await once(lock.stdout, "data");
      let completed = 0;
      const updates = Array.from({ length: 8 }, (_, index) => ({
        operation: "set" as const,
        key: `PROVIDER_${index}_KEY`,
        value: `value-${index}`,
      }));
      const pending = Promise.all(
        updates.map((update) =>
          run(path, update).then((result) => {
            completed += 1;
            return result;
          }),
        ),
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(completed).toBe(0);
      } finally {
        lock.stdin.end();
      }
      await pending;
      const content = readFileSync(path, "utf8");
      expect(content).toContain("OPENROUTER_API_KEY=sentinel");
      expect(content).toContain("TELEGRAM_BOT_TOKEN=keep");
      for (let index = 0; index < updates.length; index += 1) {
        expect(content).toContain(`PROVIDER_${index}_KEY=value-${index}`);
      }
      expect(statSync(path).mode & 0o777).toBe(0o640);
    });

    it("preserves bytes, line endings and mode while deduplicating one key", async () => {
      const path = fixture(
        "# Comment\r\nAPI_KEY_BACKUP=old\r\n# API_KEY=commented\r\nexport API_KEY=stale\r\nAPI_KEY=last\r\nUNICODE=olá\r\n",
      );
      await run(path, {
        operation: "set",
        key: "API_KEY",
        value: "replacement",
      });
      expect(readFileSync(path, "utf8")).toBe(
        "# Comment\r\nAPI_KEY_BACKUP=old\r\nAPI_KEY=replacement\r\nUNICODE=olá\r\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o640);
    });

    it.each(["read", "fsync", "replace"])(
      "leaves the original unchanged on a %s failure",
      async (failure) => {
        const path = fixture();
        const original = readFileSync(path);
        const prefix =
          failure === "read"
            ? "import builtins\n_original_open=builtins.open\ndef fail_read(path,*args,**kwargs):\n    raise PermissionError('injected read failure')\nbuiltins.open=fail_read\n"
            : `import os\ndef fail(*args):\n    raise OSError('injected ${failure} failure')\nos.${failure}=fail\n`;
        await expect(
          run(
            path,
            { operation: "set", key: "API_KEY", value: "new-secret" },
            prefix,
          ),
        ).rejects.toThrow(`injected ${failure} failure`);
        expect(readFileSync(path)).toEqual(original);
        expect(
          readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp")),
        ).toEqual([]);
      },
    );

    it("preserves a symlink and locks the resolved credential file", async () => {
      const path = fixture();
      const link = join(path, "..", "linked.env");
      symlinkSync(path, link);
      await Promise.all([
        run(path, { operation: "set", key: "A", value: "a" }),
        run(link, { operation: "set", key: "B", value: "b" }),
      ]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(link, "utf8")).toContain("A=a");
      expect(readFileSync(link, "utf8")).toContain("B=b");
    });

    it("creates a private file for first-time provisioning", async () => {
      const path = fixture();
      rmSync(path);
      await run(path, { operation: "set", key: "NEW_KEY", value: "new" });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).toBe("NEW_KEY=new\n");
    });

    // @lat: [[main-process#Main Process#SSH credential persistence#Failure preservation]]
    it("rejects injected lines without changing or echoing the secret", async () => {
      const path = fixture();
      const original = readFileSync(path);
      await expect(
        run(path, {
          operation: "set",
          key: "API_KEY",
          value: "secret\nOTHER=bad",
        }),
      ).rejects.toThrow("Environment value contains illegal characters");
      expect(readFileSync(path)).toEqual(original);
    });
  },
);
