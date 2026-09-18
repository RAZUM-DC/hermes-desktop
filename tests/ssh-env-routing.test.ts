// @vitest-environment node
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: spawnMock,
}));

import { sshSetEnvValue } from "../src/main/ssh-remote";
import type { SshConfig } from "../src/main/ssh-tunnel";

let directory: string;
let config: SshConfig;
let payloads: Record<string, unknown>[];
let failure = false;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hermes-env-routing-"));
  const keyPath = join(directory, "key");
  writeFileSync(keyPath, "fixture");
  config = {
    host: "example.test",
    port: 22,
    username: "test",
    keyPath,
    remotePort: 8642,
    localPort: 18642,
  };
  payloads = [];
  failure = false;
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      stdin: {
        end: (input: string): void => {
          payloads.push(JSON.parse(input));
          queueMicrotask(() => {
            if (failure) {
              child.stderr.write(
                "Could not safely update remote credentials: read failed",
              );
            } else {
              child.stdout.write(
                JSON.stringify({
                  values: { TEST_KEY: "stored" },
                  changed: true,
                }),
              );
            }
            child.emit("close", failure ? 1 : 0);
          });
        },
      },
    });
    return child;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("SSH environment writer routing", () => {
  // @lat: [[main-process#Main Process#SSH credential persistence#Profile routing and secret transport]]
  it("sends profile paths and secret values through stdin, not command arguments", async () => {
    const value = "secret-with-'quotes-and-$(literal)";
    await sshSetEnvValue(config, "PROVIDER_KEY", value, "research");
    await sshSetEnvValue(config, "DEFAULT_KEY", "default-value", "default");

    expect(payloads).toEqual([
      {
        path: "~/.hermes/profiles/research/.env",
        operation: "set",
        key: "PROVIDER_KEY",
        value,
      },
      {
        path: "~/.hermes/.env",
        operation: "set",
        key: "DEFAULT_KEY",
        value: "default-value",
      },
    ]);
    for (const call of spawnMock.mock.calls) {
      const command = call[1].at(-1) as string;
      expect(command).toMatch(/^python3 -c /);
      expect(command).not.toContain(value);
      expect(command).not.toContain("default-value");
    }
  });

  it("propagates a remote persistence error", async () => {
    failure = true;
    await expect(
      sshSetEnvValue(config, "API_KEY", "value", "research"),
    ).rejects.toThrow("read failed");
  });
});
