/**
 * Remote file delivery: fetches a file the agent produced on the Hermes server
 * through the dashboard's managed-files API. `/api/media` only serves images
 * from a few media folders, so documents (xlsx, docx, pdf…) and images saved
 * elsewhere need this route. Kept free of Electron imports so it can be tested
 * against a plain HTTP server.
 */
import http from "http";
import https from "https";
import { createWriteStream } from "fs";
import { rename, rm } from "fs/promises";
import { pipeline } from "stream/promises";

export interface RemoteFileEndpoint {
  remoteUrl: string;
  apiKey: string;
}

export interface RemoteFileFailure {
  ok: false;
  /** HTTP status when the server answered, null when the request never completed. */
  status: number | null;
  message: string;
}

export type RemoteFileResult = { ok: true; bytes: number } | RemoteFileFailure;

/** Socket inactivity limit: a large file may take minutes, a stalled one must not hang forever. */
const IDLE_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const ERROR_BODY_LIMIT = 4096;

export function normalizeRemoteDashboardBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("Remote Hermes dashboard URL is not configured.");
  const url = new URL(raw);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/v1" || url.pathname === "/api") {
    url.pathname = "";
  }
  return url.toString().replace(/\/+$/, "");
}

export function dashboardApiUrl(
  config: { remoteUrl: string },
  path: string,
): string {
  const base = normalizeRemoteDashboardBaseUrl(config.remoteUrl);
  return new URL(path, `${base}/`).toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestRemoteFile(
  config: RemoteFileEndpoint,
  filePath: string,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<http.IncomingMessage> {
  const token = config.apiKey.trim();
  if (!token) {
    return Promise.reject(
      new Error("Remote Hermes dashboard token is not configured."),
    );
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(
      dashboardApiUrl(
        config,
        `/api/files/download?path=${encodeURIComponent(filePath)}`,
      ),
    );
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers: {
          Accept: "*/*",
          "X-Hermes-Session-Token": token,
          // The companion agent-shim only lets a request through when the shim
          // token arrives as Authorization: Bearer; without it the shim answers
          // 403 locally and the request never reaches the server.
          Authorization: "Bearer " + token,
          ...extraHeaders,
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`No data from the remote Hermes server for ${timeoutMs}ms`),
      );
    });
    req.end();
  });
}

async function readErrorDetail(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > ERROR_BODY_LIMIT) break;
      chunks.push(buffer);
    }
  } catch {
    // The status code already tells the story; the body is a bonus.
  }
  res.destroy();
  const text = Buffer.concat(chunks).toString("utf8").trim();
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text || res.statusMessage || "";
}

/**
 * Download `filePath` from the server into `destPath`. The body is streamed to
 * `<destPath>.part` and renamed only after it arrived whole, so a dropped
 * connection never leaves a truncated file under the name the user chose.
 */
export async function remoteDownloadFile(
  config: RemoteFileEndpoint,
  filePath: string,
  destPath: string,
  options: { idleTimeoutMs?: number } = {},
): Promise<RemoteFileResult> {
  let res: http.IncomingMessage;
  try {
    res = await requestRemoteFile(
      config,
      filePath,
      {},
      options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
    );
  } catch (error) {
    return { ok: false, status: null, message: errorMessage(error) };
  }

  const status = res.statusCode ?? 0;
  if (status !== 200) {
    return { ok: false, status, message: await readErrorDetail(res) };
  }

  const partPath = `${destPath}.part`;
  let bytes = 0;
  res.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    await pipeline(res, createWriteStream(partPath));
    if (!res.complete) throw new Error("The connection closed mid-download.");
    await rename(partPath, destPath);
    return { ok: true, bytes };
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined);
    return { ok: false, status: null, message: errorMessage(error) };
  }
}

/** Read a remote file into memory, or null when it is missing, refused or larger than `maxBytes`. */
export async function remoteReadFile(
  config: RemoteFileEndpoint,
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    const res = await requestRemoteFile(config, filePath, {}, IDLE_TIMEOUT_MS);
    if (res.statusCode !== 200) {
      res.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > maxBytes) {
        res.destroy();
        return null;
      }
      chunks.push(buffer);
    }
    return res.complete ? Buffer.concat(chunks) : null;
  } catch {
    return null;
  }
}

/** True when the server would hand `filePath` over. Asks for a single byte instead of the whole file. */
export async function remoteFileExists(
  config: RemoteFileEndpoint,
  filePath: string,
): Promise<boolean> {
  try {
    const res = await requestRemoteFile(
      config,
      filePath,
      { Range: "bytes=0-0" },
      PROBE_TIMEOUT_MS,
    );
    const status = res.statusCode ?? 0;
    res.destroy();
    return status === 200 || status === 206;
  } catch {
    return false;
  }
}
