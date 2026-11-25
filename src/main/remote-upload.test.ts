// @vitest-environment node
import http from "http";
import type { AddressInfo } from "net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const conn = { mode: "remote", remoteUrl: "", apiKey: "shim-token", ssh: {} };
vi.mock("./config", () => ({
  getConnectionConfig: vi.fn(() => conn),
}));

import {
  MAX_REMOTE_UPLOAD_BYTES,
  uploadRemoteAttachment,
} from "./remote-upload";

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  contentType?: string;
  body: Buffer;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen = [];
  conn.mode = "remote";
  conn.remoteUrl = baseUrl + "/";
  reply = { status: 200, body: {} };
});

describe("uploadRemoteAttachment", () => {
  it("posts multipart to <remoteUrl>/v1/files with the shim token and returns the server path", async () => {
    reply = {
      status: 200,
      body: {
        id: "file-1",
        bytes: 8,
        path: "/workspace/uploads/file-1__Отчёт.docx",
      },
    };
    const res = await uploadRemoteAttachment(
      "Отчёт.docx",
      Buffer.from("PK\x03\x04docx").toString("base64"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res).toEqual({
      ok: true,
      path: "/workspace/uploads/file-1__Отчёт.docx",
      id: "file-1",
      bytes: 8,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1/files");
    expect(seen[0].authorization).toBe("Bearer shim-token");
    expect(seen[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0].body.includes(Buffer.from("PK\x03\x04docx"))).toBe(true);
    expect(seen[0].body.toString("utf8")).toContain('name="file"');
  });

  it("is unsupported outside Remote Gateway mode and sends nothing", async () => {
    conn.mode = "ssh";
    expect(await uploadRemoteAttachment("a.pdf", "JVBERg==")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    conn.mode = "remote";
    conn.remoteUrl = "";
    expect(await uploadRemoteAttachment("a.pdf", "JVBERg==")).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses files over the body cap before sending", async () => {
    const big = Buffer.alloc(MAX_REMOTE_UPLOAD_BYTES + 1).toString("base64");
    expect(await uploadRemoteAttachment("big.pdf", big)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(seen).toHaveLength(0);
  });

  it("maps 413 to too-large and other errors to failed with the server message", async () => {
    reply = {
      status: 413,
      body: { error: { message: "per-user bytes limit" } },
    };
    expect(await uploadRemoteAttachment("a.pdf", "JVBERg==")).toEqual({
      ok: false,
      reason: "too-large",
      detail: "per-user bytes limit",
    });
    reply = {
      status: 401,
      body: { error: { message: "Требуется Bearer agent-JWT" } },
    };
    expect(await uploadRemoteAttachment("a.pdf", "JVBERg==")).toEqual({
      ok: false,
      reason: "failed",
      detail: "Требуется Bearer agent-JWT",
    });
    reply = { status: 200, body: { id: "x" } };
    expect(await uploadRemoteAttachment("a.pdf", "JVBERg==")).toEqual({
      ok: false,
      reason: "failed",
      detail: "server returned no path",
    });
  });
});
