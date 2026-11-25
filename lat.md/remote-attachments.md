# Remote attachments

In Remote Gateway mode binary chat attachments (PDF, docx, xlsx…) are uploaded to the agent's server, because a path on the user's computer means nothing to an agent that runs elsewhere.

Images and text files are unaffected: they already travel inline in the message (`image_url` parts and `<file>` wrappers). Only the `path-ref` kind — attachments the agent opens with its own file tools — needed a remote route.

## Upload instead of refusal

The upstream client refused binary attachments outside local mode; this fork uploads them and sends the agent the server-side path.

[[src/renderer/src/screens/Chat/attachmentUtils.ts#processFiles]] routes such a file in remote mode to [[src/renderer/src/screens/Chat/attachmentUtils.ts#uploadToAgentServer]], which reads the bytes and calls the `upload-remote-attachment` IPC. In the main process [[src/main/remote-upload.ts#uploadRemoteAttachment]] posts them as multipart to `<remoteUrl>/v1/files` with the connection's bearer key. The result becomes an ordinary `path-ref` whose `path` is where the agent sees the file, so [[src/main/hermes.ts#buildUserContent]] emits `[Attached file: <server path>]` unchanged.

The upload happens when the file is attached, not on send, so a failure shows on the chip row immediately. Files over [[src/main/remote-upload.ts#MAX_REMOTE_UPLOAD_BYTES]] (30 MB, below the 32 MiB nginx body cap) are refused before sending.

## Server side in the RAZUM hybrid

The remote URL is the companion's loopback shim, which prefixes paths with `/agent` and signs requests with the device's agent-JWT.

identity-proxy (`razum-hermes`, `proxy/agent_handler.py`) serves `POST /agent/v1/files`: it takes the e-mail only from the agent-JWT, stores the file in that user's runtime (`/workspace/uploads/<id>__<name>`) through the same storage and quotas as the OpenWebUI `/v1/files`, and returns the path. The runtime image carries python-docx, pypdf, pymupdf and openpyxl to read it.

## Errors and SSH mode

SSH mode has no upload endpoint and keeps the old "requires local mode" message; upload problems get their own messages.

`unsupported` (SSH, or no remote URL) maps to `remote-mode-binary`; HTTP 413 or the client-side cap maps to `upload-too-large`; any other failure maps to `upload-failed` with the server's message. [[src/renderer/src/screens/Chat/ChatInput.tsx#ChatInput]] renders them via the `attachRemoteModeBinary`, `attachUploadTooLarge` and `attachUploadFailed` strings.
