import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserExtensionBanner } from "./BrowserExtensionBanner";

vi.mock("./useI18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}|${Object.values(vars).join(",")}` : key,
  }),
}));

function api(
  toRemind: Array<{ browser: string; status: string }>,
): Record<string, ReturnType<typeof vi.fn>> {
  const value = {
    browserExtensionStatus: vi.fn().mockResolvedValue({
      remind: true,
      browsers: toRemind,
      toRemind: toRemind.map((r) => ({ ...r, profile: "Default" })),
    }),
    browserExtensionOpenStore: vi.fn().mockResolvedValue(true),
    browserExtensionSnooze: vi.fn().mockResolvedValue(undefined),
    browserExtensionSetRemind: vi.fn().mockResolvedValue(false),
  };
  Object.defineProperty(window, "hermesAPI", { configurable: true, value });
  return value;
}

describe("BrowserExtensionBanner", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("ничего не показывает, если напоминать не о чем", async () => {
    api([]);
    const { container } = render(<BrowserExtensionBanner />);
    await act(async () => undefined);
    expect(container.innerHTML).toBe("");
  });

  it("предлагает установить в каждом браузере без расширения и открывает магазин в нём", async () => {
    const a = api([
      { browser: "chrome", status: "missing" },
      { browser: "yandex", status: "disabled" },
    ]);
    render(<BrowserExtensionBanner />);
    await act(async () => undefined);
    expect(screen.getByRole("status").textContent).toContain(
      "settings.browserExtension.bannerMissing",
    );
    fireEvent.click(
      screen.getByText(
        "settings.browserExtension.install|settings.browserExtension.chrome",
      ),
    );
    expect(a.browserExtensionOpenStore).toHaveBeenCalledWith("chrome");
    fireEvent.click(
      screen.getByText(
        "settings.browserExtension.open|settings.browserExtension.yandex",
      ),
    );
    expect(a.browserExtensionOpenStore).toHaveBeenCalledWith("yandex");
  });

  it("«Позже» и «Не напоминать» убирают плашку", async () => {
    const a = api([{ browser: "yandex", status: "missing" }]);
    const { container, unmount } = render(<BrowserExtensionBanner />);
    await act(async () => undefined);
    fireEvent.click(screen.getByText("settings.browserExtension.later"));
    expect(a.browserExtensionSnooze).toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
    unmount();

    const b = api([{ browser: "yandex", status: "missing" }]);
    const second = render(<BrowserExtensionBanner />);
    await act(async () => undefined);
    fireEvent.click(screen.getByText("settings.browserExtension.never"));
    expect(b.browserExtensionSetRemind).toHaveBeenCalledWith(false);
    expect(second.container.innerHTML).toBe("");
  });
});
