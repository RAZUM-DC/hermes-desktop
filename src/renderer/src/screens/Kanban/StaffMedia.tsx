import { useEffect, useState } from "react";

// Рендер видео-материалов по токену MONTAGE_MEDIA:<which>:<project_id>, который
// агент Монтажёр кладёт в комментарий/результат. Байты тянутся через мостик
// /agent/montage/artifact (main: agentMontageArtifact → data-url), показываем
// <video> + кнопку Скачать. Видео-плеера в апстриме нет — это наш компонент.
const TOKEN_RE = /MONTAGE_MEDIA:(sample|final):([A-Za-z0-9_-]+)/gi;

const api = () =>
  window.hermesAPI as unknown as {
    agentMontageArtifact: (
      projectId: string,
      which: string,
    ) => Promise<{ success: boolean; data?: { dataUrl?: string }; error?: string }>;
  };

function MontageVideo({ which, pid }: { which: string; pid: string }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let on = true;
    api()
      .agentMontageArtifact(pid, which)
      .then((r) => {
        if (!on) return;
        if (r.success && r.data?.dataUrl) setUrl(r.data.dataUrl);
        else setErr(r.error || "не удалось загрузить видео");
      });
    return () => {
      on = false;
    };
  }, [which, pid]);
  return (
    <div className="kanban-detail-section">
      <label>{which === "final" ? "Финальный ролик" : "Сэмпл"}</label>
      {err && <div style={{ color: "#ff6b6b" }}>{err}</div>}
      {!url && !err && <div style={{ opacity: 0.6 }}>Загрузка видео…</div>}
      {url && (
        <>
          <video
            controls
            src={url}
            style={{ maxWidth: "100%", borderRadius: 8, marginBottom: 6 }}
          />
          <div>
            <a
              href={url}
              download={`montage_${which}_${pid}.mp4`}
              className="btn btn-secondary"
              style={{ display: "inline-block" }}
            >
              Скачать ролик
            </a>
          </div>
        </>
      )}
    </div>
  );
}

export default function StaffMedia({ texts }: { texts: string[] }): React.JSX.Element | null {
  const found: { which: string; pid: string }[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    const re = new RegExp(TOKEN_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text || "")) !== null) {
      const key = `${m[1].toLowerCase()}:${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ which: m[1].toLowerCase(), pid: m[2] });
      }
    }
  }
  if (!found.length) return null;
  return (
    <>
      {found.map((f) => (
        <MontageVideo key={`${f.which}:${f.pid}`} which={f.which} pid={f.pid} />
      ))}
    </>
  );
}
