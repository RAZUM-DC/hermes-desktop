import { BrowserWindow, desktopCapturer, screen } from "electron";
import type { Display, NativeImage } from "electron";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { ScreenshotFailure } from "../shared/screenshot";

/**
 * Screen capture for the chat's screenshot button.
 *
 * Uses Electron's `desktopCapturer` rather than `getDisplayMedia` in the
 * renderer: it runs here in the main process, needs no source picker, no
 * permission prompt on Windows, and hands back a finished frame instead of a
 * video stream we would have to grab a frame out of.
 *
 * The window is hidden with `hide()` rather than `minimize()` — minimising
 * animates and flashes through the taskbar, which both looks wrong and can
 * land in the picture. The frame is captured a moment later, once the
 * compositor has had time to redraw the screen without us in it.
 */

/** How long to wait, after hiding, before grabbing the frame. */
export const HIDE_SETTLE_MS = 350;

export class ScreenshotError extends Error {
  constructor(
    readonly reason: ScreenshotFailure,
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotError";
  }
}

export interface Screenshot {
  /** PNG bytes; the renderer turns these into a normal attachment. */
  png: ArrayBuffer;
  name: string;
  width: number;
  height: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function screenshotFileName(now: Date = new Date()): string {
  return [
    "screenshot-",
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    ".png",
  ].join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The screen the app window sits on — that is the one the user means. */
function displayForWindow(window: BrowserWindow | null): Display {
  if (window && !window.isDestroyed()) {
    try {
      return screen.getDisplayMatching(window.getBounds());
    } catch {
      // Fall back to the primary display rather than failing the capture.
    }
  }
  return screen.getPrimaryDisplay();
}

/**
 * Gets the app window out of the way, grabs the screen it was on, and puts the
 * window back.
 *
 * The frame is requested at the display's physical pixel size
 * (`size × scaleFactor`): asking for the logical size on a scaled display —
 * 125% is common on laptops — returns a downscaled image in which text is
 * unreadable, which rather defeats the point of sending a screenshot to a
 * model.
 */
async function captureDisplayFrame(
  window: BrowserWindow | null,
  settleMs: number,
): Promise<{ image: NativeImage; display: Display }> {
  const display = displayForWindow(window);
  const live = !!window && !window.isDestroyed();
  const hidden = live && window.isVisible();
  const wasMinimized = live ? window.isMinimized() : false;

  let restored = false;
  const restore = (): void => {
    if (restored || !hidden || !window || window.isDestroyed()) return;
    restored = true;
    window.show();
    if (wasMinimized) window.minimize();
    else window.focus();
  };

  if (hidden && window) {
    window.hide();
    await delay(settleMs);
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
      fetchWindowIcons: false,
    });
    // Back on screen as soon as the frame is in hand — encoding it takes
    // long enough to be noticed if the window is still missing.
    restore();

    const source =
      sources.find(
        (candidate) => candidate.display_id === String(display.id),
      ) ?? sources[0];
    if (!source) {
      throw new ScreenshotError(
        "no-screen",
        "the system returned no screens to capture",
      );
    }

    const image = source.thumbnail;
    if (!image || image.isEmpty()) {
      throw new ScreenshotError(
        "empty-frame",
        "the captured frame came back empty",
      );
    }

    return { image, display };
  } finally {
    restore();
  }
}

/** A finished frame, packaged the way the renderer wants it. */
function toScreenshot(image: NativeImage): Screenshot {
  const size = image.getSize();
  // Node's Buffer is a view into a larger pooled allocation, so the slice is
  // what makes the bytes standalone — handing over `buffer` directly would
  // ship whatever else happens to share that pool.
  const bytes = image.toPNG();
  const png = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    png,
    name: screenshotFileName(),
    width: size.width,
    height: size.height,
  };
}

/**
 * Hides the window, captures its screen, and brings the window back.
 *
 * The frame is requested at the display's physical pixel size
 * (`size × scaleFactor`): asking for the logical size on a scaled display —
 * 125% is common on laptops — returns a downscaled image in which text is
 * unreadable, which rather defeats the point of sending a screenshot to a
 * model.
 */
export async function captureScreen(
  window: BrowserWindow | null,
  settleMs: number = HIDE_SETTLE_MS,
): Promise<Screenshot> {
  const { image } = await captureDisplayFrame(window, settleMs);
  return toScreenshot(image);
}

/**
 * The selection overlay's page.
 *
 * Kept as a string written to a temp file rather than a second renderer entry
 * point: it is a self-contained scratch surface with no part in the app's UI,
 * and a temp file lets it load the frozen frame over `file://` next to it.
 *
 * `__pickRegion()` resolves with the chosen rectangle in CSS pixels (plus the
 * window's device-pixel ratio, since the frame itself is in physical pixels),
 * or with null when the user gives up. The main process simply awaits it.
 */
function overlayHtml(frameFile: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
  body { cursor: crosshair; user-select: none; }
  #frame { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
  #dim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); }
  #sel {
    position: fixed; display: none; border: 1px solid #fff;
    /* Everything outside the selection is dimmed by one huge shadow — no
       four-rectangle bookkeeping as the box is dragged around. */
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
  }
  #size, #hint {
    position: fixed; color: #fff; background: rgba(0, 0, 0, 0.75);
    font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    border-radius: 6px; white-space: nowrap; pointer-events: none;
  }
  #size { display: none; padding: 3px 7px; font-size: 12px; }
  #hint { top: 24px; left: 50%; transform: translateX(-50%); padding: 9px 15px; }
</style>
</head>
<body>
  <img id="frame" src="./${frameFile}" alt="" />
  <div id="dim"></div>
  <div id="sel"></div>
  <div id="size"></div>
  <div id="hint">Выделите область — Esc чтобы отменить</div>
<script>
window.__pickRegion = function () {
  return new Promise(function (resolve) {
    var sel = document.getElementById("sel");
    var dim = document.getElementById("dim");
    var size = document.getElementById("size");
    var hint = document.getElementById("hint");
    var startX = 0, startY = 0, dragging = false, done = false;

    function box(e) {
      var x = Math.min(startX, e.clientX), y = Math.min(startY, e.clientY);
      var w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
      return { x: x, y: y, width: w, height: h };
    }

    function finish(rect) {
      if (done) return;
      done = true;
      resolve(rect);
    }

    document.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      dim.style.display = "none";
      hint.style.display = "none";
      sel.style.display = "block";
      size.style.display = "block";
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var r = box(e);
      sel.style.left = r.x + "px";
      sel.style.top = r.y + "px";
      sel.style.width = r.width + "px";
      sel.style.height = r.height + "px";
      size.textContent = Math.round(r.width) + " × " + Math.round(r.height);
      // Keep the readout inside the screen when the box hugs an edge.
      var sx = Math.min(r.x, window.innerWidth - 90);
      var sy = r.y > 28 ? r.y - 24 : r.y + r.height + 6;
      size.style.left = Math.max(4, sx) + "px";
      size.style.top = sy + "px";
    });

    document.addEventListener("mouseup", function (e) {
      if (!dragging) return;
      dragging = false;
      var r = box(e);
      // A click with no drag is someone changing their mind, not a request
      // for a zero-pixel picture.
      if (r.width < 4 || r.height < 4) {
        finish(null);
        return;
      }
      r.dpr = window.devicePixelRatio || 1;
      finish(r);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") finish(null);
    });

    window.addEventListener("blur", function () {
      // Losing focus means something else took over the screen; the frozen
      // frame is stale from here on, so stop rather than crop the wrong thing.
      finish(null);
    });
  });
};
</script>
</body>
</html>`;
}

export interface PickedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

/**
 * Turns a selection into a crop rectangle on the captured frame.
 *
 * The two live in different coordinate systems: the selection comes back in
 * CSS pixels from the overlay window, while the frame was captured in physical
 * pixels. On a scaled display — 125% is ordinary on a laptop — skipping the
 * conversion crops a region a quarter of the way off from what was selected.
 * Exported for the tests, since this is where that class of mistake hides.
 */
export function cropRectForSelection(
  selection: PickedRegion,
  frame: { width: number; height: number },
  display: Pick<Display, "scaleFactor">,
): { x: number; y: number; width: number; height: number } | null {
  const scale = selection.dpr || display.scaleFactor || 1;
  const x = Math.max(0, Math.round(selection.x * scale));
  const y = Math.max(0, Math.round(selection.y * scale));
  // Clamped to the frame: a drag that runs off the edge of the screen must not
  // ask for pixels the image does not have.
  const width = Math.min(Math.round(selection.width * scale), frame.width - x);
  const height = Math.min(
    Math.round(selection.height * scale),
    frame.height - y,
  );
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Freezes the screen, lets the user drag a rectangle over it, and returns just
 * that part of the frame. Resolves with null when the selection is cancelled.
 *
 * The selection happens over a still image rather than the live screen on
 * purpose: nothing moves under the cursor, a notification popping up cannot
 * land in the shot, and the overlay itself is guaranteed not to photograph.
 */
export async function captureRegion(
  window: BrowserWindow | null,
  settleMs: number = HIDE_SETTLE_MS,
): Promise<Screenshot | null> {
  const { image, display } = await captureDisplayFrame(window, settleMs);

  const dir = join(tmpdir(), "hermes-desktop-media");
  mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const framePath = join(dir, `region-${stamp}.png`);
  const htmlPath = join(dir, `region-${stamp}.html`);
  writeFileSync(framePath, image.toPNG());
  writeFileSync(htmlPath, overlayHtml(basename(framePath)), "utf-8");

  const overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    show: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#000000",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await overlay.loadFile(htmlPath);
    // Above everything, including other apps' always-on-top windows.
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.show();
    overlay.focus();

    const picked = (await overlay.webContents
      .executeJavaScript("window.__pickRegion()", true)
      .catch(() => null)) as PickedRegion | null;
    if (!picked) return null;

    const crop = cropRectForSelection(picked, image.getSize(), display);
    if (!crop) return null;
    return toScreenshot(image.crop(crop));
  } finally {
    if (!overlay.isDestroyed()) overlay.destroy();
    rmSync(framePath, { force: true });
    rmSync(htmlPath, { force: true });
  }
}
