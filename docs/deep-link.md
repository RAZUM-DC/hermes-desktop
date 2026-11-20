# Deep link: открыть диалог по ссылке

Ссылка `razum-assistant://session/<id>` открывает в приложении «РАЗУМ Ассистент» указанный диалог (сессию Hermes). Её даёт браузерное расширение («Открыть в РАЗУМ Ассистент»).

## Формат

- Схема `razum-assistant`, хост строго `session`, затем один сегмент пути: id сессии `[A-Za-z0-9_-]{1,128}` (браузерные сессии начинаются с `brw-`).
- Пример: `razum-assistant://session/brw-3f9a1c`.
- Допускается один завершающий `/`. Любое другое (query, hash, лишние сегменты, `%`-кодировки, `..`, чужие хосты и схемы) игнорируется; в лог пишется только факт отказа, без значения.
- По ссылке выполняется единственное действие: открыть диалог. Отправки сообщений и запуска команд нет.

## Как работает

- Разбор: чистая функция `parseDeepLink` в `src/main/deep-link.ts` (белый список).
- Windows/Linux: ссылка приходит в argv при первом запуске и в событии `second-instance` (`pickDeepLinkFromArgv`). macOS: событие `open-url`.
- Main буферизует последнюю ссылку, пока рендерер не подписался. Layout монтируется только после установки и настройки, поэтому подписка `window.hermesAPI.onDeepLinkOpenSession` служит сигналом готовности.
- Каналы IPC: `deep-link:open-session` (main → renderer, payload: id), `deep-link:renderer-ready` и `deep-link:renderer-gone` (renderer → main).
- В рендерере Layout вызывает `handleResumeSession(id)` и переходит в чат.
- Регистрация схемы: `protocols` в `electron-builder.yml` (установщик Windows, Info.plist macOS, MimeType для Linux) и `app.setAsDefaultProtocolClient` при старте (в dev передаётся путь к приложению).

## Как проверить

Windows (установленное приложение или `npm run dev` после первого запуска, чтобы схема записалась в реестр):

```
start razum-assistant://session/<id>
```

Ожидание: приложение запускается (или выходит на передний план) и открывает диалог `<id>`. Если приложение ещё не вошло, диалог откроется после входа. Несуществующий id даёт пустой диалог/ошибку загрузки, как при ручном открытии.

Проверка отказа: `start razum-assistant://session/../x` ничего не открывает, в консоли main появляется `[DEEP-LINK] Ignored unsupported link`.

Linux: `xdg-open razum-assistant://session/<id>`. macOS: `open razum-assistant://session/<id>` (работает только из установленного .app).
