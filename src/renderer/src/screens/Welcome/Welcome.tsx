import { useState } from "react";
import HermesLogo from "../../components/common/HermesLogo";
import { Refresh, Spinner } from "../../assets/icons";
import { useI18n } from "../../components/useI18n";

/**
 * Экран входа.
 *
 * Раньше здесь был выбор, каким способом подключаться: поставить Hermes
 * локально, подключиться по SSH или к удалённому дашборду. В гибридной сборке
 * выбора нет — companion стартует всегда, сам проводит вход через Яндекс и
 * сам записывает remote-конфиг. Предлагать три пути, два из которых никуда не
 * ведут, значит сбивать человека с толку в первую же минуту знакомства.
 *
 * Поэтому экран делает ровно одно: объясняет, что происходит, и ждёт. Уйти с
 * него можно двумя способами — дождаться, пока вход завершится (приложение
 * заметит это само, см. App.tsx), или, если что-то пошло не так, войти
 * заново.
 *
 * Кнопки остались обе не для симметрии. «Проверить снова» — страховка на
 * случай, если автоматика не сработала. «Войти снова» — единственный выход,
 * когда enroll не удался: без неё человек оказался бы заперт на экране, где
 * нечего нажать.
 */
interface WelcomeProps {
  /** Сообщение об ошибке от предыдущей попытки, если она была. */
  error: string | null;
  onRecheck: () => void;
}

function Welcome({ error, onRecheck }: WelcomeProps): React.JSX.Element {
  const { t } = useI18n();
  const [reenrolling, setReenrolling] = useState(false);

  async function handleSignInAgain(): Promise<void> {
    setReenrolling(true);
    try {
      // Флаг-файл для companion: он увидит его и начнёт enroll заново,
      // открыв окно входа. Ответ нас не интересует — важно, что флаг лёг.
      await window.hermesAPI.companionReenroll();
    } catch {
      /* companion мог ещё не подняться — поможет «Проверить снова» */
    } finally {
      setReenrolling(false);
      onRecheck();
    }
  }

  return (
    <div className="screen welcome-screen">
      <HermesLogo size={80} />
      <br />
      <h1 className="welcome-title">{t("welcome.signingInTitle")}</h1>
      {error ? (
        <p className="welcome-subtitle">{error}</p>
      ) : (
        <p className="welcome-subtitle">{t("welcome.signingInHint")}</p>
      )}

      <div className="welcome-actions">
        <button
          className="btn btn-secondary welcome-recheck-btn"
          onClick={onRecheck}
        >
          {t("welcome.recheck")}
          <Refresh size={16} />
        </button>
        <button
          className="btn btn-secondary welcome-recheck-btn"
          onClick={() => void handleSignInAgain()}
          disabled={reenrolling}
          style={{ marginTop: 12 }}
        >
          {t("welcome.signInAgain")}
          {reenrolling && <Spinner size={16} />}
        </button>
      </div>
    </div>
  );
}

export default Welcome;
