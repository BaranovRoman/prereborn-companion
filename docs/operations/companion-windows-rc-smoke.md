# Companion Windows RC — установка и native smoke

Статус итерации 17: **BuiltIn candidate pipeline подготовлен; артефакта сборки пока нет.
External developer gate закрыт.** Windows-specific код прошёл только cross-check на macOS.
Нельзя считать это Windows native proof. Публикация, использование signing secrets и запуск CI
в этой итерации не выполнялись.

## Получение candidate

После согласования отправить feature-ветку и запустить **PreReborn Companion - Windows** (`windows-release.yml`, candidate job)
на `codex/plugin-runtime-prototype`, не tag. `candidate_version` — `X.Y.Z-rc.N`, численно выше установленной
stable; не оставлять исходное `0.4.0` для overinstall новой stable. Выбор версии требует сверки
с установленной версией на ПК. Сравнить `candidate-source.txt` с согласованным коммитом.

`sign_dota=false`: NSIS + SHA256, без доступа к plugin signing key. Нет GitHub Release,
latest.json, updater signatures, deploy, Silero/старый overlay build или автоматической миграции.
Для RC beforeBuildCommand переопределяется только в runner: tsc + vite; используется committed overlay renderer.
`sign_dota=true` требует отдельного разрешения: секреты `PLUGIN_SIGNING_PRIVATE_KEY` и
`PLUGIN_SIGNING_PRIVATE_KEY_PASSWORD`. Ключ обязан соответствовать `plugins/manager/trusted.pub`;
проверка реальным Store отклонит другую подпись. Private key хранится только в runner temp,
удаляется в finally и не загружается в artifacts. Архив не запускается при проверке подписи.

Скачать artifact из Actions после успешных targeted Windows tests и NSIS build.
Проверить `Get-FileHash .\PreReborn*.exe -Algorithm SHA256` против соответствующего `.sha256`
(использовать фактическое имя из artifact). Подпись minisign пакета **не** Authenticode
подпись NSIS; Windows SmartScreen может показывать неизвестного издателя. Не считать
SmartScreen подтверждением целостности. Candidate не распространяется через updater.

Подписанный ZIP/release.json в artifact ещё не доступен через release UI магазина:
production local-install отключён; нужен Windows release в **подписанном каталоге** и
доступный GitHub URL. Workflow использует явно неопубликованный URL-заглушку.
Не копировать package вручную в registry и не подменять TRUSTED_KEY.
Для smoke установки через магазин сначала согласовать публикацию package/catalog,
сохранив другие записи каталога; не публиковать single-entry catalog поверх действующего.
Для успешного update необходим второй подписанный Windows package с большей версией
и совпадающей версией handshake. В этой итерации он не изготовлен.

## Безопасные условия

Проверять вне реального стрима, предпочтительно отдельным Windows-пользователем.
Не менять identifier или GSI-конфигурацию. Не запускать второй Companion.
Для baseline закрыть Companion, убедиться в завершении его процесса, скопировать весь
app-data directory (обычно `%APPDATA%\com.romanbaranov.dota-companion`; сверить реальный путь)
в отдельный backup. Копия должна включать SQLite/WAL/SHM, если они остались.
Не копировать только главный SQLite-файл при работающем приложении.
Не публиковать backup/логи с токенами или сырыми GSI.

Для проверки целостности **копии** можно использовать имеющийся Python, без установки toolchain:

```powershell
python -c "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(c.execute('PRAGMA integrity_check').fetchall())" "C:\smoke-copy\local-runtime.sqlite3"
```

Ожидается ровно `ok`. Native ручной migration entrypoint пока не открыт.
Не выполнять SQL миграции вручную и не подключать копию к live runtime обходным способом.
Migration/rollback пока проверяются существующими targeted Rust tests на временных SQLite.
Сохранённый backup нельзя возвращать после новых записей, теряя историю/ledger.
Runtime fallback сохраняет safety tables и использует новый epoch.

## Порядок проверки

В колонке «стоп» действия выполняются только над проверяемым Companion/worker,
никаких широких `taskkill` по Node, OBS или другим приложениям.

| Шаг | Действия и ожидаемый результат | Ошибка | Безопасное прекращение |
|---|---|---|---|
| 1. Baseline | Записать старую версию, настройки, число матчей/outbox; закрыть приложение, сделать backup, проверить копию `integrity_check`. | `busy`, повреждение, незавершённый процесс, отсутствующие WAL-файлы. | Не устанавливать; повторить согласованный backup после закрытия. |
| 2. Overinstall | Установить RC NSIS поверх старой версии. Одна установка, тот же identifier/app-data, настройки и история сохранены. | Пустая история, новые data paths, второй процесс, изменение updater endpoint. | Закрыть RC; сохранить текущие данные для анализа. Не восстанавливать старую БД после новых writes. |
| 3. Default/package contents | Запустить без установленного Dota package. BuiltIn работает; External worker отсутствует. Осмотреть install dir: нет отдельного companion-dota-plugin.exe/archive/private key. | External стартует сам, требуется plugin для BuiltIn, лишний worker/ключ в installer. | Закрыть Companion; gate не открывать. Встроенные Dota UI/алгоритмы/overlay в core ожидаемы для этого RC. |
| 4. Twitch/TTS | Подключить тестовый канал, несколько коротких/длинных сообщений, очередь и прерывание. Текст читается полностью согласно ручному лимиту, порядок сохраняется. | Обрыв, повтор, изменение очереди, потеря подключения. | Остановить TTS штатной командой; отключить тестовый канал, закрыть RC при зависании. |
| 5. OBS | Тестовые сцены: connect/disconnect, mapping, manual scene change. Транспорт и настройки работают как baseline. | Неверная сцена, повторные команды, потеря пароля, зависание. | Выключить auto scenes в настройках, вручную вернуть безопасную сцену в OBS. |
| 6. BuiltIn live GSI | Запустить тестовую игру Dota; единственный listener 127.0.0.1:3665, hero/pregame/game/postgame; один матч/outbox, сохранение старой identity при reconnect. | Два listener/worker, двойные sound/write/sync, неверная history. | Закрыть Dota и Companion; сохранить новые данные, не откатывать SQLite автоматически. |
| 7. Signed install | **После доставки signed catalog** установить Windows package через магазин; enabled=false, worker не запущен. Проверить update более новой signed версии и удаление. | Подпись/платформа/IPC не совпадают, самозапуск, сбой активной версии после update. | Cancel transfer/удалить package штатно после подтверждённой остановки; BuiltIn должен продолжать работать. Пока доставка отсутствует — BLOCKED. |
| 8. Tamper | CI Store verifier проверяет изменение ZIP и installed executable на временных данных. Вручную не повреждать действующий package. | Изменённый архив/EXE принят, test trust root в production. | Не запускать пакет; остановить распространение RC. Успешный подписанный update отдельно ещё не проверен. |
| 9. Backup/migration copy | **После открытия проверенного manual entrypoint** выполнить backup/migration только sandbox-копии, reopen/integrity, старые queries/history/outbox. Сейчас entrypoint закрыт — BLOCKED. | Migration касается исходной БД, несовпадение UUID/revisions, unsafe rollback. | Закрыть проверяемый процесс, сохранить копию и backup отдельно; не применять production SQL вручную. |
| 10. External activation | Сейчас **НЕ ВЫПОЛНЯТЬ**: gate закрыт. Позже manual action проверяет signed executable/version/generation, backup/migration, quotas/Unknown, native process/audio/OBS fences; epoch увеличивается, BuiltIn admission закрыт. | Автоактивация, неverified package, две admission ветки, старый epoch. | Остановить admission и сохранить Draining; takeover только после доказанных fences. |
| 11. Sounds/reminder | Сначала BuiltIn: реальное audio + draft reminder. После gate — External с durable queued/playing/completed; emit не означает completed. | Повтор после Unknown, потерянные ACK, reminder влияет на TTS. | Game-only cancel; если fence не доказан — Draining, без takeover. |
| 12. Cancellation/TTS | Во время игрового звука и queued reminder запустить Twitch utterance, отменить game audio. TTS активный/очередь продолжаются. External: cancelled receipt, pending/active=0 до нового epoch. | Останавливается TTS, продолжается game audio, fence ACK приходит раньше durable ACK. | Не возобновлять игровые эффекты; TTS остановить отдельно только по необходимости. |
| 13. OBS reconciliation | Reconnect, смена mapping/manual scene, missing scene; External после gate — свежий GetCurrentProgramScene + requestId; ambiguous reply без blind retry. | Cached name считается доказательством, повтор Set после Unknown, неверная fallback сцена. | Отключить auto scene; оставить Unknown/Draining, вручную безопасная сцена OBS. |
| 14. Native supervisor | CI выполняет job stop, collision, spawn failure, parent crash с worker/descendant, explicit journal recovery. На ПК после gate: crash Companion до/после spawn, IPC и commit; worker завершается, receipt сохраняется. | Orphan, PID используется как proof, повтор после commit, новый владелец при неопределённости. | Не запускать BuiltIn takeover; сохранить Draining. Только exact generation job/native handle, не kill по сохранённому PID. |
| 15. Restart/orphan | External не включается автоматически. Journal поколения сохраняется, explicit recovery доказывает остановку job; audio/OBS отдельно. Старый journal без supervision marker блокирует takeover. | Самозапуск, отсутствие Unknown, исчезновение ledger, неподтверждённый takeover. | Закрыть Companion; сохранить DB/journal, не удалять safety tables и не подменять stopped. |
| 16. External → BuiltIn | После gate: admission close → drain → process/job/audio/OBS proof → новый BuiltIn epoch. История/ledger сохраняются, один handler. | Два owner, двойные effects/outbox, fallback даже при failed fence. | Остаться Draining; game effects не возобновлять, Twitch/TTS проверять отдельно. |
| 17. History/quota | Несколько матчей + reconnect/postgame; сравнить UUID/key/rating/session/outbox. Unknown не очищается, квоты видны и admission fail-closed. | Повторные записи, непроверенные sync повторы, исчезающие keys, исчерпание квоты. | Завершить game admission и сохранить данные; не повышать quota/не удалять Unknown вручную. |

## Условия допуска External

Не открывать gate только потому, что NSIS собрался. Требуются успешный native Windows
supervisor suite и crash/restart на пользовательском ПК, verified installed live package,
безопасный manual migration/backup entrypoint, audio/OBS fences и fallback. После этого
узко подключить существующие preflight/handover/recovery функции, без новой архитектуры.
До этого RC годится для BuiltIn regression smoke; External smoke блокирован.

Нагрузка: измерение итерации 16 — 8 часов синтетического IPC, 4959 keys, 48 tickets,
2 541 636 receipt bytes, 13 revision identities, Unknown=0. Это не native звук/OBS и не
доказательство realtime GSI; тест занял 43 минуты на Mac debug. Не запускать его повторно
в этой итерации. На Windows проверить burst/frame cadence и цену signature/hash revalidation.
