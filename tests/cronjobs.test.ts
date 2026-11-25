import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const runtimeRef = vi.hoisted(() => ({
  profileHome: "C:/hermes",
  remoteMode: false,
  remoteOnlyMode: false,
  connection: {
    mode: "local" as "local" | "remote" | "ssh",
    remoteUrl: "",
    apiKey: "",
    ssh: undefined as
      | {
          host: string;
          port: number;
          username: string;
          keyPath: string;
          remotePort: number;
          localPort: number;
        }
      | undefined,
  },
  fetch: vi.fn(),
  sshRunCron: vi.fn(),
}));

const { execFileSpy } = vi.hoisted(() => ({
  execFileSpy: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "ok", ""),
  ),
}));

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));

vi.mock("../src/main/utils", () => ({
  profileHome: () => runtimeRef.profileHome,
}));

vi.mock("../src/main/hermes", () => ({
  isRemoteMode: () => runtimeRef.remoteMode,
  isRemoteOnlyMode: () => runtimeRef.remoteOnlyMode,
  getApiUrl: () => "http://127.0.0.1:8642",
  getRemoteAuthHeader: () => ({}),
  normaliseRemoteUrl: (url: string) => url.replace(/\/+$/, ""),
}));

vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => runtimeRef.connection,
}));

vi.mock("../src/main/ssh-remote", () => ({
  sshRunCron: runtimeRef.sshRunCron,
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "C:/hermes",
  HERMES_PYTHON: "C:/hermes/hermes-agent/venv/Scripts/pythonw.exe",
  hermesCliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
}));

import {
  createCronJob,
  listCronJobs,
  parseCronListOutput,
} from "../src/main/cronjobs";

beforeEach(() => {
  runtimeRef.profileHome = "C:/hermes";
  runtimeRef.remoteMode = false;
  runtimeRef.remoteOnlyMode = false;
  runtimeRef.connection = {
    mode: "local",
    remoteUrl: "",
    apiKey: "",
    ssh: undefined,
  };
  runtimeRef.fetch.mockReset();
  runtimeRef.sshRunCron.mockReset();
  vi.stubGlobal("fetch", runtimeRef.fetch);
});

describe("createCronJob", () => {
  beforeEach(() => {
    execFileSpy.mockClear();
  });

  it("passes the prompt as the cron create positional argument before flags", async () => {
    await createCronJob(
      "7 17 * * *",
      "Create a daily brief with local news, weather, and quotes.",
      "Daily brief",
      "telegram",
    );

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "create",
      "7 17 * * *",
      "Create a daily brief with local news, weather, and quotes.",
      "--name",
      "Daily brief",
      "--deliver",
      "telegram",
    ]);
    expect(execFileSpy.mock.calls[0][1]).not.toContain("--");
  });
});

describe("cron terminal-state normalization", () => {
  // @lat: [[scheduled-jobs#Test specifications#Local terminal-state normalization]]
  it("preserves local completed jobs and filters every non-active job without rewriting the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermes-cron-states-"));
    try {
      runtimeRef.profileHome = home;
      mkdirSync(join(home, "cron"));
      const file = join(home, "cron", "jobs.json");
      const content = JSON.stringify({
        jobs: [
          { id: "finished", state: "completed", enabled: false },
          { id: "paused", state: "paused", enabled: false },
          { id: "legacy-disabled", enabled: false },
          { id: "active", state: "scheduled", enabled: true },
        ],
      });
      writeFileSync(file, content);

      const jobs = await listCronJobs();
      expect(
        jobs.map(({ id, state, enabled }) => ({ id, state, enabled })),
      ).toEqual([
        { id: "finished", state: "completed", enabled: false },
        { id: "paused", state: "paused", enabled: false },
        { id: "legacy-disabled", state: "paused", enabled: false },
        { id: "active", state: "active", enabled: true },
      ]);
      await expect(listCronJobs(false)).resolves.toEqual([
        expect.objectContaining({ id: "active" }),
      ]);
      expect(readFileSync(file, "utf-8")).toBe(content);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // @lat: [[scheduled-jobs#Test specifications#Remote completed jobs remain completed]]
  it("preserves completed jobs from the Remote API and excludes them from active-only results", async () => {
    runtimeRef.remoteMode = true;
    runtimeRef.connection.mode = "remote";
    runtimeRef.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        jobs: [
          { id: "finished", state: "completed", enabled: false },
          { id: "active", state: "scheduled", enabled: true },
        ],
      }),
    });

    await expect(listCronJobs()).resolves.toEqual([
      expect.objectContaining({
        id: "finished",
        state: "completed",
        enabled: false,
      }),
      expect.objectContaining({ id: "active", enabled: true }),
    ]);
    await expect(listCronJobs(false)).resolves.toEqual([
      expect.objectContaining({ id: "active" }),
    ]);
  });

  // @lat: [[scheduled-jobs#Test specifications#Completed SSH jobs stay disabled]]
  it("keeps completed named-profile SSH jobs disabled and out of active-only results", async () => {
    runtimeRef.remoteMode = true;
    runtimeRef.connection = {
      mode: "ssh",
      remoteUrl: "",
      apiKey: "",
      ssh: {
        host: "example.test",
        port: 22,
        username: "hermes",
        keyPath: "/tmp/id_ed25519",
        remotePort: 8642,
        localPort: 18642,
      },
    };
    runtimeRef.sshRunCron.mockResolvedValue({
      success: true,
      stdout:
        "  finished-once [completed]\n    Name: Finished job\n\n" +
        "  active-job [active]\n    Name: Active job\n",
    });

    await expect(listCronJobs(true, "work")).resolves.toEqual([
      expect.objectContaining({
        id: "finished-once",
        state: "completed",
        enabled: false,
      }),
      expect.objectContaining({ id: "active-job", enabled: true }),
    ]);
    await expect(listCronJobs(false, "work")).resolves.toEqual([
      expect.objectContaining({ id: "active-job" }),
    ]);
  });
});

describe("parseCronListOutput", () => {
  it("parses the Hermes cron list table used by SSH profiles", () => {
    const jobs = parseCronListOutput(`
┌─────────────────────────────────────────────────────────────────────────┐
│                         Scheduled Jobs                                  │
└─────────────────────────────────────────────────────────────────────────┘

  321a3a33703e [active]
    Name:      daily-daegu-startup-grant-monitoring
    Schedule:  0 9 * * *
    Repeat:    ∞
    Next run:  2026-06-25T09:00:00+09:00
    Deliver:   origin
    Workdir:   /workspaces/biz-office
    Last run:  2026-06-24T09:16:46.248027+09:00  ok

  85e1165b00eb [paused]
    Name:      server-emergency-watchdog
    Schedule:  every 10m
    Repeat:    2/5
    Next run:  2026-06-24T23:00:40.707549+09:00
    Deliver:   discord:channel-123
    Script:    server_emergency_watchdog.py
    Mode:      no-agent (script stdout delivered directly)
`);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "321a3a33703e",
      name: "daily-daegu-startup-grant-monitoring",
      schedule: "0 9 * * *",
      state: "active",
      enabled: true,
      next_run_at: "2026-06-25T09:00:00+09:00",
      last_run_at: "2026-06-24T09:16:46.248027+09:00",
      last_status: "ok",
      repeat: { times: null, completed: 0 },
      deliver: ["origin"],
    });
    expect(jobs[1]).toMatchObject({
      id: "85e1165b00eb",
      state: "paused",
      enabled: false,
      repeat: { times: 5, completed: 2 },
      deliver: ["discord:channel-123"],
      script: "server_emergency_watchdog.py",
    });
  });
});
