import { describe, expect, it } from "vitest";
import {
  decideUpdateSignature,
  parseSignatureOutput,
  PINNED_UPDATE_THUMBPRINTS,
  type SignatureInfo,
} from "./update-signature";

const FILE =
  "C:\\Users\\ivan\\AppData\\Local\\hermes-desktop-updater\\pending\\temp-hermes-desktop-0.7.16-setup.exe";
const PINNED = PINNED_UPDATE_THUMBPRINTS[0];

function info(over: Partial<SignatureInfo> = {}): SignatureInfo {
  return {
    status: 1,
    path: FILE,
    thumbprint: PINNED,
    subject: "CN=Razum, O=Razum, C=RU",
    chainFlags: ["UntrustedRoot"],
    ...over,
  };
}

// @lat: [[update-signature#Pinned certificate instead of Windows trust]]
describe("decideUpdateSignature", () => {
  it("принимает наш самоподписанный сертификат, если Windows жалуется только на корень", () => {
    expect(decideUpdateSignature(info(), FILE, ["Razum"])).toBeNull();
  });

  it("отпечаток сравнивается без учёта регистра", () => {
    expect(
      decideUpdateSignature(info({ thumbprint: PINNED.toLowerCase() }), FILE, [
        "Razum",
      ]),
    ).toBeNull();
  });

  it("отвергает чужой сертификат с тем же именем Razum", () => {
    const r = decideUpdateSignature(
      info({ thumbprint: "0000000000000000000000000000000000000000" }),
      FILE,
      ["Razum"],
    );
    expect(r).toMatch(/installer rejected/);
  });

  it("отвергает подменённый файл (HashMismatch) даже с нашим отпечатком", () => {
    expect(decideUpdateSignature(info({ status: 3 }), FILE, ["Razum"])).toMatch(
      /status=3/,
    );
  });

  it("отвергает неподписанный файл", () => {
    expect(
      decideUpdateSignature(
        info({ status: 2, thumbprint: "", subject: "", chainFlags: [] }),
        FILE,
        ["Razum"],
      ),
    ).toMatch(/status=2/);
  });

  it("отвергает, если у цепочки есть проблемы кроме недоверенного корня", () => {
    expect(
      decideUpdateSignature(
        info({ chainFlags: ["UntrustedRoot", "NotTimeValid"] }),
        FILE,
        ["Razum"],
      ),
    ).toMatch(/NotTimeValid/);
    expect(
      decideUpdateSignature(info({ chainFlags: [] }), FILE, ["Razum"]),
    ).toMatch(/chain problems/);
  });

  it("отвергает, если проверка выполнилась над другим файлом", () => {
    expect(
      decideUpdateSignature(info({ path: "C:\\other.exe" }), FILE, ["Razum"]),
    ).toMatch(/another file/);
  });

  it("действительную для Windows подпись принимает по CN издателя (корпоративный CA)", () => {
    expect(
      decideUpdateSignature(
        info({
          status: 0,
          thumbprint: "1111111111111111111111111111111111111111",
          subject: "CN=Razum, DC=razum, DC=group",
          chainFlags: [],
        }),
        FILE,
        ["Razum"],
      ),
    ).toBeNull();
  });

  it("действительную подпись другого издателя отвергает", () => {
    expect(
      decideUpdateSignature(
        info({
          status: 0,
          thumbprint: "1111111111111111111111111111111111111111",
          subject: "CN=Evil Corp",
          chainFlags: [],
        }),
        FILE,
        ["Razum"],
      ),
    ).toMatch(/unexpected publisher/);
  });
});

describe("parseSignatureOutput", () => {
  it("читает вывод PowerShell, флаги цепочки одной строкой или массивом, с BOM", () => {
    const one = parseSignatureOutput(
      `\uFEFF{"Status":1,"Path":"C:\\\\x.exe","Thumbprint":"AB","Subject":"CN=Razum","ChainFlags":"UntrustedRoot"}`,
    );
    expect(one).toEqual({
      status: 1,
      path: "C:\\x.exe",
      thumbprint: "AB",
      subject: "CN=Razum",
      chainFlags: ["UntrustedRoot"],
    });
    const many = parseSignatureOutput(
      `{"Status":0,"Path":"C:\\\\x.exe","Thumbprint":"AB","Subject":"CN=Razum","ChainFlags":["A","B"]}`,
    );
    expect(many.chainFlags).toEqual(["A", "B"]);
    const none = parseSignatureOutput(
      `{"Status":2,"Path":"C:\\\\x.exe","Thumbprint":"","Subject":"","ChainFlags":null}`,
    );
    expect(none.chainFlags).toEqual([]);
  });
});

// Вывод скрипта проверки, снятый на Windows 10.11.2026 (ПК сотрудника, домен
// razum.group): настоящий установщик, тот же файл с одним изменённым байтом и
// notepad.exe (каталожная подпись Microsoft).
describe("реальный вывод PowerShell", () => {
  const T = "C:\\Users\\EA6927~1.ERM\\AppData\\Local\\Temp\\g016sig\\";
  it("настоящий установщик — принят", () => {
    const i = parseSignatureOutput(
      `{"Status":1,"Path":"${T.replace(/\\/g, "\\\\")}ok-setup.exe","Thumbprint":"DCDEB567CE9D0D723BBF68DF2663BA19BC409AD6","Subject":"CN=Razum, O=Razum, C=RU","ChainFlags":["UntrustedRoot"]}`,
    );
    expect(decideUpdateSignature(i, `${T}ok-setup.exe`, ["Razum"])).toBeNull();
  });
  it("изменённый байт — отвергнут (HashMismatch)", () => {
    const i = parseSignatureOutput(
      `{"Status":3,"Path":"${T.replace(/\\/g, "\\\\")}tampered-setup.exe","Thumbprint":"DCDEB567CE9D0D723BBF68DF2663BA19BC409AD6","Subject":"CN=Razum, O=Razum, C=RU","ChainFlags":["UntrustedRoot"]}`,
    );
    expect(
      decideUpdateSignature(i, `${T}tampered-setup.exe`, ["Razum"]),
    ).not.toBeNull();
  });
  it("файл, подписанный Microsoft, — отвергнут", () => {
    const i = parseSignatureOutput(
      `{"Status":0,"Path":"${T.replace(/\\/g, "\\\\")}unsigned.exe","Thumbprint":"667BBA1E1F478221AA65DE4F75187A751B03A453","Subject":"CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US","ChainFlags":[]}`,
    );
    expect(decideUpdateSignature(i, `${T}unsigned.exe`, ["Razum"])).toMatch(
      /unexpected publisher/,
    );
  });
});
