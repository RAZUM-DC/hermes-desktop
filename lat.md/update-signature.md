# Update signature

How the Windows auto-updater decides whether a downloaded installer is ours: by the pinned signing certificate, not by Windows trust in it.

## Pinned certificate instead of Windows trust

Releases are signed with a self-signed `CN=Razum` certificate; Windows does not trust its root, so stock electron-updater rejected every update (BUG-080).

[[src/main/app/updater.ts#setupUpdater]] replaces `verifyUpdateCodeSignature` on Windows with [[src/main/app/update-signature.ts#verifyPinnedUpdateSignature]]. It runs one PowerShell script (path passed via an environment variable, not spliced into the command) that returns the Authenticode status, the signer thumbprint and the certificate chain flags. [[src/main/app/update-signature.ts#decideUpdateSignature]] accepts the file when the signature is intact and the only chain complaint is `UntrustedRoot` for a thumbprint in [[src/main/app/update-signature.ts#PINNED_UPDATE_THUMBPRINTS]], or when Windows itself reports a valid signature whose CN matches `publisherName` (a future certificate from a trusted CA). A changed byte gives `HashMismatch` and is rejected; any failure of the check itself is a rejection.

Rotating the certificate: add the new thumbprint, ship one release still signed with the old certificate, then switch the signing secret.

## Background download errors

A failed background download used to reach only `updater.log`, so the sidebar button froze at "Downloading 100%".

The updater now remembers that a download was started by `autoDownload` and, if it fails, sends `update-error` with the first line of the message ([[src/main/app/updater.ts#firstLine]]); the button switches to the "update failed" state and offers a retry. Errors of plain background checks (offline, feed down) stay in the log.
