/**
 * Shape of a screenshot request's result, shared by the main process, the
 * preload bridge and the renderer.
 *
 * Deliberately a value rather than a thrown error: an exception crossing IPC
 * arrives in the renderer as a flattened string ("Error invoking remote
 * method…"), which leaves the UI guessing at what went wrong. A tagged reason
 * lets it say something useful — in particular that screen capture is being
 * refused by security policy rather than simply "failing".
 */
export type ScreenshotFailure = "no-screen" | "empty-frame";

export type ScreenshotResponse =
  | {
      ok: true;
      /**
       * PNG bytes, ready to become a normal attachment. An ArrayBuffer
       * rather than a Uint8Array so the renderer can hand it straight to the
       * File constructor without casting.
       */
      png: ArrayBuffer;
      name: string;
      width: number;
      height: number;
    }
  | {
      ok: false;
      /** "cancelled" — the user dismissed the region selection; not an error. */
      reason: ScreenshotFailure | "error" | "cancelled";
      detail: string;
    };
