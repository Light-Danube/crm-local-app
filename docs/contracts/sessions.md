# Сесії та ролі

Контракт PR 3. Стан лише в пам'яті процесу; restart анулює credentials. Усі token передавати через TLS поза локальною розробкою. Код доступу — одноразовий дозвіл приєднати один display, не owner credential.

- `POST /api/sessions` → 201 `{sessionId, ownerToken, pairingCode, expiresAt}`. Identity і 256-bit owner token генерує сервер. Клієнт зберігає owner token у sessionStorage, не в URL.
- `POST /api/sessions/:sessionId/pairing`, `Authorization: Bearer <ownerToken>` → 200 `{pairingCode, expiresAt}`. Оновлює попередній код. Код має шість цифр і діє п'ять хвилин.
- Namespace `/playerControls`: handshake `auth: {role: 'controller', sessionId, token: ownerToken}`. Повторне одночасне controller-з'єднання відхиляється, навіть із тим самим token. Відновлення після disconnect потребує правильного token. `query.userID` не дає жодних прав.
- Display починає без credentials і надсилає `connectToMaster(pairingCode)`. Успіх — `masterConnected({sessionId, displayToken})`; код споживається. Display token дозволяє лише відновлення display: handshake `{role:'display', sessionId, token:displayToken}`. Активний display не можна замінити; pairing потребує активного controller.
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
