# Сесії та ролі

Контракт PR 3. Стан лише в пам'яті процесу; restart анулює credentials. Усі token передавати через TLS поза локальною розробкою. Один код доступу дозволяє приєднати кілька display до завершення його TTL та в межах display slots; це не owner credential.

- `POST /api/sessions` → 201 `{sessionId, ownerToken, pairingCode, expiresAt}`. Identity і 256-bit owner token генерує сервер. Клієнт зберігає owner token у sessionStorage, не в URL.
- `POST /api/sessions/:sessionId/pairing`, `Authorization: Bearer <ownerToken>` → 200 `{pairingCode, expiresAt}`. Оновлює попередній код. Код має шість цифр і діє п'ять хвилин.
- Namespace `/playerControls`: handshake `auth: {role: 'controller', sessionId, token: ownerToken}`. Повторне одночасне controller-з'єднання відхиляється, навіть із тим самим token. Відновлення після disconnect потребує правильного token. `query.userID` не дає жодних прав.
- Display починає без credentials і надсилає `connectToMaster(pairingCode)`. Успіх — `masterConnected({sessionId, displayToken})`; код залишається чинним до початкового expiresAt. Display token дозволяє лише відновлення display: handshake `{role:'display', sessionId, token:displayToken}`. Те саме display identity не можна перехопити; pairing потребує активного controller. Default — до п’яти identities на сесію.
- Ліміт pairing: п'ять спроб за хвилину на фактичну адресу socket, спільно для всіх кодів. `X-Forwarded-For` не вважається довіреним. Усі таблиці мають межі; default — 1000 sessions та 10000 IP-лічильників. Це захист локального застосунку, не повна Internet account authentication.

Команди playback, media та effects приймаються лише від controller його власної сесії. Display і неприєднаний socket не можуть надсилати controller commands. Поля `masterPageID`, `userID`, `role` у payload не створюють дозволів і не вибирають кімнату.

HTTP auth-помилки: JSON `{error:{code,message}}`, 401; rate limit — 429, capacity — 503. Socket handshake відхиляється через `connect_error`, код у `error.data.code`. Подія `session error` містить `{code,message,event}` для заборонених дій або невдалого pairing. Некоректний application payload залишається подією `error` з рядком `Invalid payload for <event>`.

Owner і display tokens не логуються; store зберігає SHA-256 hashes. Сервер порівнює hashes через timing-safe comparison. Pairing-коди ніколи не є HTTP upload/media авторизацією.

## Медіа (PR 4)

`POST /upload?sessionId=<id>` із `Authorization: Bearer <ownerToken>` та одним multipart-полем `video` повертає 201 `{mediaId,url,mime}`. Display token для upload не підходить. Ім'я з multipart не використовується як шлях або ID. Приймаються `video/mp4` (ftyp) та `video/webm` (EBML DocType webm); це перевірка контейнера, не гарантія декодування кожного codec.

Default межі: 100 MiB/file, 2 concurrent uploads, 500 MiB/session, 2 GiB total, 10 files/session. Налаштування запуску: `UPLOAD_MAX_FILE_BYTES`, `UPLOAD_MAX_CONCURRENT`, `UPLOAD_MAX_SESSION_BYTES`, `UPLOAD_MAX_TOTAL_BYTES`, `UPLOAD_MAX_SESSION_FILES` — додатні цілі числа. Admission резервує max-file bytes до запису; тому upload може бути відхилений до фактичного заповнення диска. Existing regular files враховуються в total quota після restart. Відхилені/перервані uploads видаляються; прийняті файли лишаються до явного локального видалення. Після restart in-memory ownership втрачено, тож старі файли не отримують публічного доступу.

`GET /media/:sessionId/:mediaId` вимагає owner або display token цієї сесії. Для native video element: `POST /api/sessions/:sessionId/media-access` із Bearer token встановлює HttpOnly/SameSite=Strict cookie, обмежений `/media/<sessionId>/`. Tokens не додаються до URL. Для локального HTTP Secure не встановлюється; HTTPS додає Secure (`secureCookies` також можна явно задати при створенні application). Media відповіді: `nosniff`, CSP sandbox, private/no-store. Legacy `/uploads`, `/videofile` та `/video/:id` більше не віддають файлів.

Підтвердження upload — одна серверна подія `file uploaded({mediaId,url,mime})` у кімнату display. Клієнтський `video uploaded` вилучено: довільний ID більше не можна оголосити завантаженим. HTTP auth-помилки зберігають `{error:{code,message}}`; media limits — 413, capacity — 429, неприйнятний формат — 415.


## Lifecycle (PR 7)

Повторний `connectToMaster` з кодом останнього успішного join на тому самому socket ідемпотентний: не видає нового display token. Переключення спочатку перевіряє destination, потім звільняє стару кімнату й оновлює обидва controller counters. Невдала спроба не змінює старе з'єднання. Disconnect змінює лише запис із відповідним socket ID.

Повністю від'єднані сесії зберігаються 30 хвилин від останньої активності (`sessionOptions.idleTtlMs`), потім credentials і pairing-коди видаляються. Активні controller/display не видаляються через idle TTL. Cleanup відбувається при session operations і periodic logging.


## Кілька екранів (PR 7a)

Default `SESSION_MAX_DISPLAYS=5` (positive integer). Кожен pairing видає окремі `{sessionId,displayId,displayToken}`; жоден display token не замінює інші. Після успіху controller отримує `pairing updated({pairingCode,expiresAt})` з тим самим кодом та початковим TTL. Для додаткових екранів вводьте той самий код; новий потрібен після expiresAt або явного owner refresh.

`updatePuppets({count,maxDisplays,displays:[{displayId,connected}]})` показує активні екрани й зайняті місця. Disconnect зберігає identity та її місце для reconnect. `DELETE /api/sessions/:sessionId/displays/:displayId` з owner Bearer token видаляє конкретний display, анулює лише його token і звільняє місце; master має видиму кнопку «Видалити». Код повної сесії: `DISPLAY_LIMIT`. Повторний handshake активного identity: `DISPLAY_OCCUPIED`. Ролі та доступ до медіа залишаються ізольованими за сесією. Команда/upload notification надсилається один раз кожному активному display цієї кімнати.

## Відновлення стану (PR 8)

Після authenticated connect, pairing та rejoin сервер надсилає `state snapshot({sessionId,media,time,paused,volume,effects,revision})`. `media` — null або `{kind,url,mediaId?}`; `effects` — `{loop,inversion,color,details,background}`. Сервер збільшує revision при прийнятті команди/медіа; читання snapshot revision не змінює. Поки грає відео, час snapshot враховує elapsed від останньої команди; це модель playback, не доказ показу кадру на екрані.

Обидва клієнти зберігають role credentials у sessionStorage, автоматично повторюють authenticated handshake й оновлюють media cookie. Видимий status показує connecting/connected/reconnecting/disconnected. Зміна з'єднання не очищає src. Команди під час offline/restore відкидаються, Socket.IO buffer очищається; старі snapshots не перекривають нову revision. Після restart credentials недійсні: controller пропонує створити нову сесію, display — повторити єднання. Autoplay-відмова показує кнопку «Відновити відтворення».

`npm run test:browser` потребує Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`) і ffmpeg. Скрипт створює власний H.264/AAC fixture й тимчасові сервери, перевіряє декодування, UI, десять reconnect циклів, offline commands, native autoplay recovery та restart. Він не завантажує реальні YouTube-відео.


## Preview та upload UI (PR 9)

`GET /api/media/config` повертає readonly `{maxFileBytes,acceptedMimeTypes}` без credentials. UI показує фактичний ліміт, приймає один MP4/WebM та відображає конкретну серверну причину upload failure. Порожній browser MIME для відомого розширення нормалізується лише в клієнті; перевірка контейнера на сервері лишається обов'язковою.

Локальний object URL відкликається при заміні, переході до stream/snapshot та pagehide; cancel не змінює вже наявне preview. YouTube preview і display використовують прямий `/youtube/:id`, без `response.blob()`. Shared parser приймає watch `v` незалежно від порядку query, shorts і youtu.be, відхиляє playlist-only та чужі hosts. `npm run test:browser` послідовно запускає recovery і media регресії; fake upstream лишається відкритим, доки обидва клієнти вже декодують fixture. Реальну доступність YouTube цей тест не доводить.

## Підтвердження команд

Playback/media/effects commands можуть передавати необов’язковий Socket.IO acknowledgement callback останнім аргументом. Після прийняття сервер повертає `{ok:true,revision}`; при відмові — `{ok:false,error:{code,message}}`, не змінюючи стан. Revision позначає прийняття сервером, а не показ кадру. Існуючі події та команди без callback зберігають свій формат.

Прийняті команди також надсилають `command applied({event,sessionId,media,time,paused,volume,effects,revision})` власнику та кожному display цієї сесії рівно один раз. Upload використовує `event:'media changed'`. Це canonical snapshot після зміни; legacy relay events збережено для сумісності. Клієнт, що переходить на `command applied`, має припинити застосовувати legacy relay, щоб не виконувати команду двічі.

Обидва браузери застосовують `command applied` замість legacy relay, перевіряючи sessionId та зростання revision. Volume/effects не перезапускають media. Controller зберігає локальне керування timeline без зворотного seek від власної команди; reconnect/media replacement застосовують повний snapshot. Display застосовує play/pause/stop/seek із canonical envelope.
