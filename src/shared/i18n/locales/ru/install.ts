export default {
  preparing: "Подготовка...",
  startingInstall: "Запуск установки",
  installationComplete: "Установка завершена",
  installationFailed: "Установка не удалась",
  installingHermes: "Установка Hermes Agent",
  installationFailedHint:
    "Установка не удалась. Попробуйте снова или установите через терминал.",
  retryInstallation: "Повторить установку",
  copied: "Скопировано!",
  copyLogs: "Копировать логи",
  stepLabel: "Шаг {{step}}/{{total}}: {{title}}",
  waitingToStart: "Ожидание запуска...",
  continueToSetup: "Перейти к настройке",
  confirmTitle: "Перед установкой",
  confirmLocationLabel: "Hermes будет установлен в:",
  confirmFresh:
    "Существующая установка здесь не найдена — будет выполнена чистая установка.",
  confirmUpdate:
    "Здесь уже есть установка Hermes — она будет обновлена до последней версии.",
  confirmReplace:
    "Здесь есть папка, но это не корректная установка Hermes — при установке она будет удалена и заменена.",
  confirmNotInherited:
    "Если вы установили Hermes в другом месте или через командную строку, эта установка не будет перенесена.",
  confirmInstallBtn: "Установить Hermes",
  useExistingBtn: "Использовать существующую установку",
  useExistingHint:
    "Выберите папку с существующей установкой Hermes (ту, что содержит папку hermes-agent).",
  useExistingInvalid: "В этой папке не найдена пригодная установка Hermes.",
  useExistingDone:
    "Существующая установка задана — закройте и снова откройте Hermes, чтобы применить.",
  useExistingQuitBtn: "Закрыть Hermes",
} as const;
