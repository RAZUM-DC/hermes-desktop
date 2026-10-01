import { useState, useEffect, useCallback, useRef } from "react";
import { Toaster } from "react-hot-toast";
import { ThemeProvider } from "./components/ThemeProvider";
import { FontProvider } from "./components/FontProvider";
import { ProfileModalProvider } from "./components/profile/ProfileModalProvider";
import { SettingsModalProvider } from "./components/settings/SettingsModalProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import Welcome from "./screens/Welcome/Welcome";
import Install from "./screens/Install/Install";
import Setup from "./screens/Setup/Setup";
import Layout from "./screens/Layout/Layout";
import SplashScreen from "./screens/SplashScreen/SplashScreen";
import { captureScreenView } from "./utils/analytics";

type Screen = "splash" | "welcome" | "installing" | "setup" | "main";

// Minimum time the splash stays visible so the background video plays
// through. Gateway / config checks happen during this window.
const SPLASH_MIN_MS = 3000;

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>("splash");
  const [installError, setInstallError] = useState<string | null>(null);
  // Soft warning: install files exist but the deep `verifyInstall` probe
  // failed (e.g. slow Python startup, restricted network). We surface this
  // as a dismissible banner instead of bouncing the user back to Welcome,
  // which previously trapped restricted-network users in a reinstall
  // loop on every launch (#130).
  const [verifyWarning, setVerifyWarning] = useState(false);
  const [splashStatus, setSplashStatus] = useState<string | undefined>(
    undefined,
  );
  const [setupProfile, setSetupProfile] = useState<string | undefined>(
    undefined,
  );
  const isMac = window.electron?.process?.platform === "darwin";
  // A reconnect can supersede an earlier startup check. Only the latest check
  // may choose the screen or the profile that Setup will configure.
  const installCheckIdRef = useRef(0);

  const runInstallCheck = useCallback(async () => {
    const checkId = ++installCheckIdRef.current;
    const startedAt = Date.now();
    let next: Screen = "welcome";
    const error: string | null = null;
    let isRemote = false;
    let nextSetupProfile = "default";

    try {
      setSplashStatus("Checking connection…");
      const conn = await window.hermesAPI.getConnectionConfig();
      isRemote = conn.mode === "remote" || conn.mode === "ssh";

      if (conn.mode === "ssh" && conn.ssh) {
        setSplashStatus("Starting SSH tunnel…");
        try {
          await window.hermesAPI.startSshTunnel();
        } catch (tunnelErr) {
          console.warn("SSH tunnel failed to start on launch:", tunnelErr);
        }
        next = "main";
      } else if (conn.mode === "remote" && conn.remoteUrl) {
        setSplashStatus("Testing remote connection…");
        const ok = await window.hermesAPI.testRemoteConnection(conn.remoteUrl);
        if (ok) {
          next = "main";
        } else {
          console.warn(`Cannot reach remote Hermes at ${conn.remoteUrl}.`);
          next = "main";
        }
      } else {
        setSplashStatus("Checking local install…");
        const status = await window.hermesAPI.checkInstall();
        nextSetupProfile = status.activeProfile || "default";
        if (!status.installed) {
          next = "welcome";
        } else if (!status.hasApiKey) {
          next = "setup";
        } else {
          next = "main";
        }

        // Warm config-health and gateway status in the background while the
        // splash is still visible so the first render is snappy. Cap at 800ms
        // so it never pushes us past the 3s minimum.
        if (next === "main") {
          setSplashStatus("Checking configuration…");
          await Promise.race([
            Promise.all([
              window.hermesAPI
                .getConfigHealth()
                .catch(() => null)
                .then(() => undefined),
              window.hermesAPI
                .gatewayStatus()
                .catch(() => null)
                .then(() => undefined),
            ]),
            new Promise<void>((r) => setTimeout(r, 800)),
          ]);
        }
      }
    } catch {
      next = "welcome";
    }

    if (checkId !== installCheckIdRef.current) return;

    setSplashStatus(undefined);
    if (error) setInstallError(error);

    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    if (checkId !== installCheckIdRef.current) return;
    if (!isRemote) setSetupProfile(nextSetupProfile);
    setScreen(next);

    // Lazy deep-verify in the background after the UI is up. If the
    // install is broken, surface the warning then — don't block startup.
    //
    // Skip for remote-mode connections: verifyInstall() probes the LOCAL
    // Python + script paths (HERMES_PYTHON / HERMES_SCRIPT in installer.ts),
    // which don't exist on machines that only use a remote backend. Without
    // this guard the user is bounced back to Welcome with an "installBroken"
    // error immediately after a successful remote connect. (#47, #41, #30)
    if ((next === "main" || next === "setup") && !isRemote) {
      window.hermesAPI.verifyInstall().then((ok) => {
        // Files exist (checkInstall passed) but the probe failed. Surface
        // a soft warning instead of bouncing to Welcome — see #130.
        if (!ok) setVerifyWarning(true);
      });
    }
  }, []);

  useEffect(() => {
    runInstallCheck();
  }, [runInstallCheck]);

  // Пока человек на экране входа, companion в это время проводит enroll и,
  // закончив, пишет remote-конфиг прямо на диск — мимо всех уведомлений
  // (notifyConnectionConfigChanged шлётся только из обработчиков настроек,
  // то есть когда конфиг меняет сам пользователь внутри приложения).
  // Раньше заметить это было нечем, и единственным способом продолжить была
  // кнопка «Проверить снова»: человек логинился в браузере, возвращался — и
  // видел всё тот же экран.
  //
  // Поэтому опрашиваем конфиг сами. Опрос дешёвый: чтение одного json-файла
  // раз в две секунды, и только пока мы на этом экране — уйдя с него,
  // интервал снимается.
  useEffect(() => {
    if (screen !== "welcome") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void window.hermesAPI
        .getConnectionConfig()
        .then((conn) => {
          if (cancelled) return;
          // Признак завершённого enroll — не сам режим, а появившийся адрес:
          // режим по умолчанию remote и до входа, так что по нему судить
          // нельзя.
          if (conn.mode === "remote" && conn.remoteUrl) {
            setInstallError(null);
            setScreen("main");
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [screen]);

  // Track screen views for analytics
  useEffect(() => {
    captureScreenView(screen);
  }, [screen]);

  const handleSplashFinished = useCallback(() => {
    /* splash transition is driven by the install check, not a timer */
  }, []);

  function handleInstallComplete(): void {
    setInstallError(null);
    setScreen("setup");
  }

  function handleInstallFailed(error: string): void {
    setInstallError(error);
    setScreen("welcome");
  }

  function handleRecheck(): void {
    setInstallError(null);
    setScreen("splash");
    runInstallCheck();
  }

  function handleVerifyReinstall(): void {
    setVerifyWarning(false);
    setInstallError(null);
    setScreen("installing");
  }

  function handleDismissVerifyWarning(): void {
    setVerifyWarning(false);
  }

  function renderScreen(): React.JSX.Element {
    switch (screen) {
      case "splash":
        return (
          <SplashScreen
            onFinished={handleSplashFinished}
            status={splashStatus}
          />
        );
      case "welcome":
        return <Welcome error={installError} onRecheck={handleRecheck} />;
      case "installing":
        return (
          <Install
            onComplete={handleInstallComplete}
            onFailed={handleInstallFailed}
            onCancel={() => setScreen("welcome")}
          />
        );
      case "setup":
        return (
          <Setup
            onComplete={() => setScreen("main")}
            profile={setupProfile}
            verifyWarning={verifyWarning}
            onReinstall={handleVerifyReinstall}
            onDismissVerifyWarning={handleDismissVerifyWarning}
          />
        );
      case "main":
        return (
          <Layout
            verifyWarning={verifyWarning}
            onReinstall={handleVerifyReinstall}
            onDismissVerifyWarning={handleDismissVerifyWarning}
          />
        );
    }
  }

  return (
    <ThemeProvider>
      <FontProvider>
        <ProfileModalProvider>
          <SettingsModalProvider>
            <ErrorBoundary>
              <div className={`app${isMac ? " is-mac" : ""}`}>
                {isMac && <div className="drag-region" />}
                <div className="app-content">{renderScreen()}</div>
              </div>
              <Toaster
                position="bottom-right"
                reverseOrder={false}
                toastOptions={{
                  style: {
                    background: "var(--bg-elevated)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-bright)",
                    fontSize: 13,
                  },
                }}
              />
            </ErrorBoundary>
          </SettingsModalProvider>
        </ProfileModalProvider>
      </FontProvider>
    </ThemeProvider>
  );
}

export default App;
