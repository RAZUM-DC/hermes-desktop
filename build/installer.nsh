; Ссылки razum-assistant://session/<id> (см. docs/deep-link.md).
;
; Сам electron-builder для Windows схему не регистрирует: `protocols` из
; electron-builder.yml попадает только в Info.plist (macOS) и .desktop (Linux).
; Без этих макросов ссылка заработала бы лишь после первого запуска приложения
; (там его регистрирует app.setAsDefaultProtocolClient), а после удаления в
; реестре осталась бы запись, указывающая на удалённый exe.
;
; SHCTX — HKCU для установки на пользователя (nsis.perMachine: false).

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\razum-assistant" "" "URL:razum-assistant"
  WriteRegStr SHCTX "Software\Classes\razum-assistant" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\razum-assistant\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\razum-assistant\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; При обновлении старый деинсталлятор тоже запускается — схему не трогаем,
  ; новая версия перепишет её в customInstall.
  ${ifNot} ${isUpdated}
    DeleteRegKey SHCTX "Software\Classes\razum-assistant"
  ${endIf}
!macroend
