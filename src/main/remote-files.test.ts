// @vitest-environment node
import http from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardApiUrl,
  remoteDownloadFile,
  remoteFileExists,
  remoteReadFile,
} from "./remote-files";

const TOKEN = "shim-token";
const BODY = Buffer.from("квартальный отчёт\n".repeat(4000), "utf8");

interface Seen {
  path: string | null;
  authorization?: string;
  sessionToken?: string;
  range?: string;
}

let server: http.Server;
let baseUrl: string;
let workDir: string;
let seen: Seen[] = [];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "remote-files-test-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.searchParams.get("path");
    seen.push({
      path,
      authorization: req.headers.authorization,
      sessionToken: req.headers["x-hermes-session-token"] as string | undefined,
      range: req.headers.range,
    });
    if (url.pathname !== "/api/files/download") {
      res.writeHead(404).end();
    } else if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res
        .writeHead(403, { "Content-Type": "text/plain" })
        .end("shim forbidden");
    } else if (
      path === "/workspace/uploads/report.xlsx" ||
      path === "/workspace/uploads/Отчёт за май.docx"
    ) {
      if (req.headers.range) {
        res
          .writeHead(206, { "Content-Range": `bytes 0-0/${BODY.length}` })
          .end(BODY.subarray(0, 1));
      } else {
        res
          .writeHead(200, { "Content-Type": "application/octet-stream" })
          .end(BODY);
      }
    } else if (path === "/opt/data/config.yaml") {
      res
        .writeHead(403, { "Content-Type": "application/json" })
        .end(JSON.stringify({ detail: "Path outside managed files root" }));
    } else if (path === "/workspace/uploads/truncated.pdf") {
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      res.write(BODY.subarray(0, 1000), () => res.socket?.destroy());
    } else {
      res
        .writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ detail: "File not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

function config(apiKey = TOKEN): { remoteUrl: string; apiKey: string } {
  return { remoteUrl: baseUrl, apiKey };
}

describe("remote file delivery", () => {
  it("downloads a document to the chosen path and leaves no .part behind", async () => {
    const dest = join(workDir, "report.xlsx");
    const result = await remoteDownloadFile(
      config(),
      "/workspace/uploads/report.xlsx",
      dest,
    );

    expect(result).toEqual({ ok: true, bytes: BODY.length });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("sends the shim token as a Bearer header and as the session token", async () => {
    seen = [];
    await remoteFileExists(config(), "/workspace/uploads/report.xlsx");

    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].sessionToken).toBe(TOKEN);
  });

  it("round-trips a path with spaces and Cyrillic", async () => {
    seen = [];
    const dest = join(workDir, "may.docx");
    const result = await remoteDownloadFile(
      config(),
      "/workspace/uploads/Отчёт за май.docx",
      dest,
    );

    expect(result.ok).toBe(true);
    expect(seen[0].path).toBe("/workspace/uploads/Отчёт за май.docx");
  });

  it("reports the server's reason when the file is outside the shared folder", async () => {
    const dest = join(workDir, "config.yaml");
    const result = await remoteDownloadFile(
      config(),
      "/opt/data/config.yaml",
      dest,
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "Path outside managed files root",
    });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("does not leave a truncated file when the connection drops mid-download", async () => {
    const dest = join(workDir, "truncated.pdf");
    const result = await remoteDownloadFile(
      config(),
      "/workspace/uploads/truncated.pdf",
      dest,
    );

    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("fails without a file when the server cannot be reached", async () => {
    const dest = join(workDir, "unreachable.xlsx");
    const result = await remoteDownloadFile(
      { remoteUrl: "http://127.0.0.1:1", apiKey: TOKEN },
      "/workspace/uploads/report.xlsx",
      dest,
    );

    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it("probes existence with a one-byte range request", async () => {
    seen = [];
    expect(
      await remoteFileExists(config(), "/workspace/uploads/report.xlsx"),
    ).toBe(true);
    expect(seen[0].range).toBe("bytes=0-0");
    expect(
      await remoteFileExists(config(), "/workspace/uploads/missing.xlsx"),
    ).toBe(false);
    expect(
      await remoteFileExists(
        config("wrong-token"),
        "/workspace/uploads/report.xlsx",
      ),
    ).toBe(false);
  });

  it("reads a small file into memory and refuses one over the cap", async () => {
    const whole = await remoteReadFile(
      config(),
      "/workspace/uploads/report.xlsx",
      BODY.length,
    );
    expect(whole?.equals(BODY)).toBe(true);
    expect(
      await remoteReadFile(config(), "/workspace/uploads/report.xlsx", 1024),
    ).toBeNull();
    expect(
      await remoteReadFile(config(), "/workspace/uploads/missing.xlsx", 1024),
    ).toBeNull();
  });

  it("builds dashboard URLs from a base that ends in /v1 or /api", () => {
    expect(
      dashboardApiUrl(
        { remoteUrl: "http://127.0.0.1:18644/v1/" },
        "/api/files/download",
      ),
    ).toBe("http://127.0.0.1:18644/api/files/download");
  });
});
