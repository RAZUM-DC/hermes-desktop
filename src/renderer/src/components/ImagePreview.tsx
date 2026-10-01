import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import { useI18n } from "./useI18n";

interface ImagePreviewProps {
  src: string;
  name: string;
  onClose: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}

/**
 * Full-size image overlay, shared by chat attachments and agent-delivered
 * images.
 *
 * It renders through a portal into <body> rather than where it is used, and
 * that is the entire reason this component exists. Message rows carry
 * `content-visibility: auto`, which implies paint containment, which makes the
 * row a containing block for `position: fixed` descendants. An overlay
 * rendered inside a message was therefore laid out against that row instead of
 * the window and clipped to it: a wide, cropped strip of the picture with the
 * close button somewhere outside the visible area. Out in <body> there is no
 * contained ancestor, so `inset: 0` means the window again.
 */
export function ImagePreview({
  src,
  name,
  onClose,
  onContextMenu,
}: ImagePreviewProps): React.JSX.Element {
  const { t } = useI18n();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="chat-image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="chat-image-preview-actions"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="chat-image-preview-btn"
          onClick={() => window.hermesAPI.saveMediaFile(src, name)}
        >
          <Download size={14} />
          {t("chat.media.saveImage")}
        </button>
        <button
          className="chat-image-preview-btn"
          onClick={onClose}
          aria-label={t("chat.media.close")}
        >
          <X size={14} />
        </button>
      </div>
      {/* Clicking the empty space around the picture closes too; the click
          bubbles up to the backdrop. */}
      <div className="chat-image-preview-stage">
        <img
          className="chat-image-preview-image"
          src={src}
          alt={name}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={onContextMenu}
        />
      </div>
    </div>,
    document.body,
  );
}
