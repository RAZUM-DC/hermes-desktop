import "./assets/main.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { VoiceDictationOverlay } from "./components/VoiceDictationOverlay";
import { I18nProvider } from "./components/I18nProvider";
import { initAnalytics } from "./utils/analytics";

const appName = import.meta.env.VITE_HERMES_DESKTOP_APP_NAME?.trim();
document.title = appName || "Hermes One";

// Initialize analytics (privacy-first, only if user consented and key is configured)
initAnalytics();

// Окошко быстрой диктовки живёт в отдельном окне, но в той же сборке
// рендерера — main открывает его по маршруту `#voice-overlay`. Отдельная
// точка входа не нужна: разница только в том, что рисуется в корне.
const isVoiceOverlay = window.location.hash === "#voice-overlay";
if (isVoiceOverlay) document.body.classList.add("dictation-overlay-body");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      {isVoiceOverlay ? <VoiceDictationOverlay /> : <App />}
    </I18nProvider>
  </StrictMode>,
);
