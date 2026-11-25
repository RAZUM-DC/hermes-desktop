import { execFile } from "child_process";
import { normalize } from "path";

/**
 * Проверка подписи скачанного обновления с привязкой к нашему сертификату.
 *
 * electron-updater (NsisUpdater) по умолчанию ставит обновление, только если
 * Windows признаёт подпись установщика действительной (`Get-AuthenticodeSignature`
 * → `Status === 0`) и CN издателя совпадает с `publisherName`. Релизы РАЗУМ
 * подписаны самоподписанным сертификатом `CN=Razum`, корня которого на ПК
 * сотрудников нет, — Windows отдаёт `UnknownError` («корень не доверен»), и
 * апдейтер молча выбрасывает уже скачанный файл (BUG-080: прогресс висит на 100%).
 *
 * Здесь вместо доверия Windows — доверие отпечатку: обновление принимается, если
 *   • подпись цела (Windows не сообщает о подмене содержимого — HashMismatch и
 *     прочие статусы кроме Valid/UnknownError отвергаются), и
 *   • единственная претензия Windows к цепочке — недоверенный корень
 *     (`X509ChainStatusFlags.UntrustedRoot`, не зависит от языка ОС), и
 *   • сертификат подписанта — один из закреплённых ниже.
 * Если подпись действительна и для Windows (например, сертификат от
 * корпоративного CA), работает и штатное правило по `publisherName`.
 *
 * Подделать такую подпись без закрытого ключа нельзя: отпечаток — это SHA-1
 * всего сертификата, а подпись файла проверяет Windows.
 *
 * Смена сертификата: новый отпечаток добавить сюда и выпустить версию,
 * подписанную ЕЩЁ старым сертификатом; следующую можно подписывать новым.
 */
export const PINNED_UPDATE_THUMBPRINTS: readonly string[] = [
  // CN=Razum, O=Razum, C=RU — самоподписанный, 23.09.2026–23.09.2031 (секрет CSC_LINK)
  "DCDEB567CE9D0D723BBF68DF2663BA19BC409AD6",
];

/** Значения System.Management.Automation.SignatureStatus. */
const STATUS_VALID = 0;
const STATUS_UNKNOWN_ERROR = 1;

export interface SignatureInfo {
  status: number;
  path: string;
  thumbprint: string;
  subject: string;
  chainFlags: string[];
}

function cnOf(subject: string): string {
  const m = /(?:^|,)\s*CN=([^,]+)/i.exec(subject);
  return m ? m[1].trim() : "";
}

function samePath(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

/**
 * Решение по результату проверки. `null` — обновление принимается,
 * строка — причина отказа (её electron-updater положит в текст ошибки).
 */
export function decideUpdateSignature(
  info: SignatureInfo,
  file: string,
  publisherNames: string[],
  pinned: readonly string[] = PINNED_UPDATE_THUMBPRINTS,
): string | null {
  if (!info.path || !samePath(info.path, file)) {
    return `signature check ran on another file: ${info.path || "<empty>"}`;
  }
  const thumb = (info.thumbprint || "").toUpperCase();
  const isPinned =
    !!thumb && pinned.map((t) => t.toUpperCase()).includes(thumb);

  if (info.status === STATUS_VALID) {
    const cn = cnOf(info.subject || "");
    if (isPinned || (cn && publisherNames.includes(cn))) return null;
    return `valid signature by an unexpected publisher: ${info.subject}`;
  }
  if (info.status === STATUS_UNKNOWN_ERROR && isPinned) {
    const flags = info.chainFlags.filter((f) => f && f !== "NoError");
    if (flags.length === 1 && flags[0] === "UntrustedRoot") return null;
    return `pinned certificate, but chain problems besides untrusted root: ${flags.join(", ") || "<none>"}`;
  }
  return `installer rejected: status=${info.status}, signer=${info.subject || "<none>"}, thumbprint=${thumb || "<none>"}`;
}

/** Одна проверка в PowerShell: статус Authenticode + флаги цепочки сертификата.
 *  Путь передаётся через переменную окружения — без подстановки в команду. */
const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$s=Get-AuthenticodeSignature -LiteralPath $env:HERMES_UPDATE_FILE",
  "$c=$s.SignerCertificate",
  "$f=@()",
  "if($c){$ch=New-Object System.Security.Cryptography.X509Certificates.X509Chain;" +
    "$ch.ChainPolicy.RevocationMode='NoCheck';[void]$ch.Build($c);" +
    "$f=@($ch.ChainStatus|ForEach-Object{$_.Status.ToString()})}",
  "[pscustomobject]@{Status=[int]$s.Status;Path=[string]$s.Path;" +
    "Thumbprint=$(if($c){$c.Thumbprint}else{''});Subject=$(if($c){$c.Subject}else{''});" +
    "ChainFlags=$f}|ConvertTo-Json -Compress",
].join("\n");

export function parseSignatureOutput(stdout: string): SignatureInfo {
  const d = JSON.parse(stdout.replace(/^\uFEFF/, "").trim()) as {
    Status?: unknown;
    Path?: unknown;
    Thumbprint?: unknown;
    Subject?: unknown;
    ChainFlags?: unknown;
  };
  const flags = Array.isArray(d.ChainFlags)
    ? d.ChainFlags
    : d.ChainFlags == null || d.ChainFlags === ""
      ? []
      : [d.ChainFlags];
  return {
    status: typeof d.Status === "number" ? d.Status : -1,
    path: typeof d.Path === "string" ? d.Path : "",
    thumbprint: typeof d.Thumbprint === "string" ? d.Thumbprint : "",
    subject: typeof d.Subject === "string" ? d.Subject : "",
    chainFlags: flags.map(String),
  };
}

interface Logger {
  info: (m?: unknown) => void;
  warn: (m?: unknown) => void;
}

/** Совместимо с `NsisUpdater.verifyUpdateCodeSignature`. Любой сбой самой
 *  проверки — отказ (штатный верификатор в этом случае пропускает файл). */
export function verifyPinnedUpdateSignature(
  publisherNames: string[],
  file: string,
  logger: Logger,
): Promise<string | null> {
  return new Promise((resolve) => {
    logger.info(`Verifying signature (pinned) ${file}`);
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(PS_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, HERMES_UPDATE_FILE: file },
        timeout: 30_000,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          const reason = `signature check failed to run: ${error.message}`;
          logger.warn(reason);
          resolve(reason);
          return;
        }
        try {
          const info = parseSignatureOutput(stdout);
          const verdict = decideUpdateSignature(info, file, publisherNames);
          logger.info(
            `signature: status=${info.status} thumbprint=${info.thumbprint} chain=[${info.chainFlags.join(",")}] → ${verdict === null ? "accepted" : "rejected"}`,
          );
          if (verdict !== null) logger.warn(verdict);
          resolve(verdict);
        } catch (e) {
          const reason = `signature check output unreadable: ${e instanceof Error ? e.message : String(e)}`;
          logger.warn(reason);
          resolve(reason);
        }
      },
    );
  });
}
