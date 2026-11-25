import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  display: {
    id: 7,
    size: { width: 1536, height: 960 },
    scaleFactor: 1.25,
  },
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  screen: {
    getDisplayMatching: (): typeof mocks.display => mocks.display,
    getPrimaryDisplay: (): typeof mocks.display => mocks.display,
  },
}));

import {
  captureScreen,
  cropRectForSelection,
  screenshotFileName,
} from "./screenshot";

type FakeWindow = BrowserWindow & {
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  minimize: ReturnType<typeof vi.fn>;
};

function fakeWindow(overrides: Partial<BrowserWindow> = {}): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    minimize: vi.fn(),
    ...overrides,
  } as unknown as FakeWindow;
}

interface FakeSource {
  display_id: string;
  thumbnail: {
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    toPNG: () => Buffer;
  };
}

function fakeSource(displayId: string, empty = false): FakeSource {
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => empty,
      getSize: () => ({ width: 1920, height: 1200 }),
      toPNG: () => Buffer.from("png-bytes"),
    },
  };
}

describe("captureScreen", () => {
  beforeEach(() => mocks.getSources.mockReset());

  it("hides the window, captures, and brings it back", async () => {
    mocks.getSources.mockResolvedValue([fakeSource("7")]);
    const win = fakeWindow();

    const shot = await captureScreen(win, 0);

    expect(win.hide).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(Buffer.from(shot.png).toString()).toBe("png-bytes");
    expect(shot.name).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
  });

  it("asks for the frame in physical pixels, not logical ones", async () => {
    mocks.getSources.mockResolvedValue([fakeSource("7")]);

    await captureScreen(fakeWindow(), 0);

    // 1536 × 1.25 = 1920, 960 × 1.25 = 1200 — anything less and the text on a
    // scaled display comes back unreadable.
    expect(mocks.getSources).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbnailSize: { width: 1920, height: 1200 },
      }),
    );
  });

  it("picks the source belonging to the window's display", async () => {
    const wanted = fakeSource("7");
    mocks.getSources.mockResolvedValue([fakeSource("99"), wanted]);

    const shot = await captureScreen(fakeWindow(), 0);

    expect(shot.width).toBe(1920);
    expect(mocks.getSources).toHaveBeenCalledOnce();
  });

  it("fails with 'no-screen' when the system returns nothing", async () => {
    mocks.getSources.mockResolvedValue([]);
    const win = fakeWindow();

    await expect(captureScreen(win, 0)).rejects.toMatchObject({
      reason: "no-screen",
    });
    // The window must come back even when the capture fails.
    expect(win.show).toHaveBeenCalledOnce();
  });

  it("fails with 'empty-frame' when the frame is blank", async () => {
    mocks.getSources.mockResolvedValue([fakeSource("7", true)]);

    await expect(captureScreen(fakeWindow(), 0)).rejects.toMatchObject({
      reason: "empty-frame",
    });
  });

  it("restores a window the user had minimised back to minimised", async () => {
    mocks.getSources.mockResolvedValue([fakeSource("7")]);
    const win = fakeWindow({ isMinimized: vi.fn(() => true) });

    await captureScreen(win, 0);

    expect(win.minimize).toHaveBeenCalledOnce();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("captures without a window at all", async () => {
    mocks.getSources.mockResolvedValue([fakeSource("7")]);
    await expect(captureScreen(null, 0)).resolves.toMatchObject({
      width: 1920,
    });
  });
});

describe("screenshotFileName", () => {
  it("is sortable and second-precise", () => {
    expect(screenshotFileName(new Date(2026, 8, 23, 1, 4, 5))).toBe(
      "screenshot-2026-09-23-010405.png",
    );
  });
});

describe("cropRectForSelection", () => {
  const frame = { width: 1920, height: 1200 };
  const display = { scaleFactor: 1.25 };

  it("converts the selection from CSS pixels to the frame's physical ones", () => {
    // 100 CSS px on a 125% display is 125 real pixels; cropping at 100 would
    // hand back a region noticeably up and to the left of what was selected.
    expect(
      cropRectForSelection(
        { x: 100, y: 80, width: 400, height: 200, dpr: 1.25 },
        frame,
        display,
      ),
    ).toEqual({ x: 125, y: 100, width: 500, height: 250 });
  });

  it("falls back to the display's scale when the window reports none", () => {
    expect(
      cropRectForSelection(
        { x: 0, y: 0, width: 100, height: 100, dpr: 0 },
        frame,
        display,
      ),
    ).toEqual({ x: 0, y: 0, width: 125, height: 125 });
  });

  it("clamps a selection dragged past the edge of the screen", () => {
    // Both sides run over: 1700 + 400 > 1920 wide, 900 + 400 > 1200 tall.
    const crop = cropRectForSelection(
      { x: 1700, y: 900, width: 400, height: 400, dpr: 1 },
      frame,
      { scaleFactor: 1 },
    );

    expect(crop).toEqual({ x: 1700, y: 900, width: 220, height: 300 });
  });

  it("rejects a selection that leaves nothing to crop", () => {
    expect(
      cropRectForSelection(
        { x: 1920, y: 0, width: 10, height: 10, dpr: 1 },
        frame,
        { scaleFactor: 1 },
      ),
    ).toBeNull();
  });
});
