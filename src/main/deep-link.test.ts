import { describe, expect, it, vi } from "vitest";
import {
  buildProtocolRegistration,
  createDeepLinkDispatcher,
  parseDeepLink,
  pickDeepLinkFromArgv,
} from "./deep-link";

describe("parseDeepLink", () => {
  it("accepts a valid session link", () => {
    expect(parseDeepLink("razum-assistant://session/brw-abc_123")).toEqual({
      type: "open-session",
      sessionId: "brw-abc_123",
    });
  });

  it("tolerates scheme/host case and one trailing slash", () => {
    expect(parseDeepLink("RAZUM-Assistant://Session/abc/")).toEqual({
      type: "open-session",
      sessionId: "abc",
    });
  });

  it("accepts ids up to 128 chars and rejects longer", () => {
    const ok = "a".repeat(128);
    expect(parseDeepLink(`razum-assistant://session/${ok}`)?.sessionId).toBe(
      ok,
    );
    expect(parseDeepLink(`razum-assistant://session/${ok}a`)).toBeNull();
  });

  it.each([
    "razum-assistant://session/",
    "razum-assistant://session",
    "razum-assistant://session/abc/extra",
    "razum-assistant://session/abc?x=1",
    "razum-assistant://session/abc#frag",
    "razum-assistant://session/abc def",
    "razum-assistant://user@session/abc",
    "razum-assistant://session:80/abc",
    "razum-assistant://send/abc",
    "razum-assistant://run/ls",
    "razum-assistant:session/abc",
    "razum-assistant:///session/abc",
  ])("ignores %s", (raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });

  it("ignores foreign schemes", () => {
    expect(parseDeepLink("https://session/abc")).toBeNull();
    expect(parseDeepLink("other-app://session/abc")).toBeNull();
    expect(parseDeepLink("xrazum-assistant://session/abc")).toBeNull();
  });

  it("rejects traversal and encoded ids without decoding", () => {
    expect(parseDeepLink("razum-assistant://session/..")).toBeNull();
    expect(parseDeepLink("razum-assistant://session/../x")).toBeNull();
    expect(parseDeepLink("razum-assistant://session/%2e%2e")).toBeNull();
    expect(parseDeepLink("razum-assistant://session/a%2Fb")).toBeNull();
    expect(parseDeepLink("razum-assistant://session/a%00b")).toBeNull();
    expect(parseDeepLink("razum-assistant://session/a\\b")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseDeepLink(undefined)).toBeNull();
    expect(parseDeepLink(null)).toBeNull();
    expect(parseDeepLink(42)).toBeNull();
    expect(parseDeepLink({})).toBeNull();
  });
});

describe("pickDeepLinkFromArgv", () => {
  it("finds the link in a Windows packaged argv", () => {
    expect(
      pickDeepLinkFromArgv([
        "C:\\Users\\u\\AppData\\Local\\Programs\\app\\hermes-agent.exe",
        "razum-assistant://session/brw-1",
      ]),
    ).toBe("razum-assistant://session/brw-1");
  });

  it("finds the link in a dev argv and strips quotes", () => {
    expect(
      pickDeepLinkFromArgv([
        "electron.exe",
        ".",
        "--flag",
        '"razum-assistant://session/abc"',
      ]),
    ).toBe("razum-assistant://session/abc");
  });

  it("returns null without a link and ignores foreign schemes", () => {
    expect(pickDeepLinkFromArgv(["app.exe", "--x", "https://a.b"])).toBeNull();
    expect(pickDeepLinkFromArgv([])).toBeNull();
  });

  it("returns the first candidate; validation stays in parseDeepLink", () => {
    const argv = [
      "app.exe",
      "razum-assistant://bad/x",
      "razum-assistant://session/ok",
    ];
    const picked = pickDeepLinkFromArgv(argv);
    expect(picked).toBe("razum-assistant://bad/x");
    expect(parseDeepLink(picked)).toBeNull();
  });
});

describe("buildProtocolRegistration", () => {
  const resolvePath = (p: string): string => `/abs/${p}`;
  it("is null for packaged apps", () => {
    expect(
      buildProtocolRegistration({
        defaultApp: false,
        execPath: "x",
        argv: ["x"],
        resolvePath,
      }),
    ).toBeNull();
  });
  it("passes the app path in dev mode", () => {
    expect(
      buildProtocolRegistration({
        defaultApp: true,
        execPath: "electron",
        argv: ["electron", "."],
        resolvePath,
      }),
    ).toEqual({ path: "electron", args: ["/abs/."] });
  });
  it("is null in dev mode without a script argument", () => {
    expect(
      buildProtocolRegistration({
        defaultApp: true,
        execPath: "electron",
        argv: ["electron"],
        resolvePath,
      }),
    ).toBeNull();
  });
});

describe("createDeepLinkDispatcher", () => {
  it("buffers until ready, then flushes once", () => {
    const send = vi.fn();
    const d = createDeepLinkDispatcher(send);
    d.enqueue("a");
    expect(send).not.toHaveBeenCalled();
    d.markReady();
    expect(send).toHaveBeenCalledExactlyOnceWith("a");
    d.markReady();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps only the latest buffered link", () => {
    const send = vi.fn();
    const d = createDeepLinkDispatcher(send);
    d.enqueue("a");
    d.enqueue("b");
    d.markReady();
    expect(send).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("sends immediately once ready and buffers again after markNotReady", () => {
    const send = vi.fn();
    const d = createDeepLinkDispatcher(send);
    d.markReady();
    d.enqueue("a");
    expect(send).toHaveBeenLastCalledWith("a");
    d.markNotReady();
    d.enqueue("b");
    expect(send).toHaveBeenCalledTimes(1);
    d.markReady();
    expect(send).toHaveBeenLastCalledWith("b");
  });
});
