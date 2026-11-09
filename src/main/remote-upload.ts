import { getConnectionConfig } from "./config";

/**
 * Upload of binary chat attachments (PDF, docx, xlsx…) in Remote Gateway mode.
 *
 * In local mode the agent reads an attachment straight from its path on this
 * computer. In remote mode the agent runs on a server and that path means
 * nothing to it, so the bytes are uploaded first: POST `<remoteUrl>/v1/files`
 * (multipart, field `file`). In the RAZUM hybrid the remote URL is the
 * companion's loopback shim, which prefixes the path with `/agent` and signs
 * the request with the device's agent-JWT; identity-proxy stores the file in
 * the caller's own runtime and answers with `path` — where the agent sees it
 * (`/workspace/uploads/<id>__<name>`). That path is sent to the agent as an
 * ordinary path-ref attachment.
 *
 * SSH mode has no such endpoint, so it keeps the old "binary attachments need
 * local mode" refusal (`unsupported`).
 */

// Every nginx layer in front of identity-proxy caps request bodies at 32 MiB.
// Stay below it with headroom for the multipart envelope.
export const MAX_REMOTE_UPLOAD_BYTES = 30 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 120_000;

export type RemoteUploadResult =
  | { ok: true; path: string; id?: string; bytes?: number }
  | {
      ok: false;
      reason: "unsupported" | "too-large" | "failed";
      detail?: string;
    };

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { message?: string } | string;
      detail?: string;
    };
    if (typeof body.error === "string") return body.error;
    return body.error?.message || body.detail || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function uploadRemoteAttachment(
  filename: string,
  base64Bytes: string,
  mime?: string,
): Promise<RemoteUploadResult> {
  const conn = getConnectionConfig();
  const base = (conn.remoteUrl || "").trim().replace(/\/+$/, "");
  if (conn.mode !== "remote" || !base) {
    return { ok: false, reason: "unsupported" };
  }

  const bytes = Buffer.from(base64Bytes || "", "base64");
  if (bytes.length > MAX_REMOTE_UPLOAD_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: mime || "application/octet-stream" }),
    filename || "file",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/files`, {
      method: "POST",
      headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {},
      body: form,
      signal: controller.signal,
    });
    if (res.status === 413) {
      return { ok: false, reason: "too-large", detail: await errorDetail(res) };
    }
    if (!res.ok) {
      return { ok: false, reason: "failed", detail: await errorDetail(res) };
    }
    const body = (await res.json()) as {
      path?: unknown;
      id?: unknown;
      bytes?: unknown;
    };
    if (typeof body.path !== "string" || !body.path) {
      return { ok: false, reason: "failed", detail: "server returned no path" };
    }
    return {
      ok: true,
      path: body.path,
      id: typeof body.id === "string" ? body.id : undefined,
      bytes: typeof body.bytes === "number" ? body.bytes : undefined,
    };
  } catch (err) {
    const detail = controller.signal.aborted
      ? "timeout"
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, reason: "failed", detail };
  } finally {
    clearTimeout(timer);
  }
}
