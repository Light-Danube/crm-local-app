# Сесії та ролі

Контракт PR 3. Стан лише в пам'яті процесу; restart анулює credentials. Усі token передавати через TLS поза локальною розробкою. Код доступу — одноразовий дозвіл приєднати один display, не owner credential.

- `POST /api/sessions` → 201 `{sessionId, ownerToken, pairingCode, expiresAt}`. Identity і 256-bit owner token генерує сервер. Клієнт зберігає owner token у sessionStorage, не в URL.
- `POST /api/sessions/:sessionId/pairing`, `Authorization: Bearer <ownerToken>` → 200 `{pairingCode, expiresAt}`. Оновлює попередній код. Код має шість цифр і діє п'ять хвилин.
- Namespace `/playerControls`: handshake `auth: {role: 'controller', sessionId, token: ownerToken}`. Повторне одночасне controller-з'єднання відхиляється, навіть із тим самим token. Відновлення після disconnect потребує правильного token. `query.userID` не дає жодних прав.
- Display починає без credentials і надсилає `connectToMaster(pairingCode)`. Успіх — `masterConnected({sessionId, displayToken})`; код споживається. Display token дозволяє лише відновлення display: handshake `{role:'display', sessionId, token:displayToken}`. Активний display не можна замінити; pairing потребує активного controller.
- Ліміт pairing: п'ять спроб за хвилину на фактичну адресу socket, спільно для всіх кодів. `X-Forwarded-For` не вважається довіреним. Усі таблиці мають межі; default — 1000 sessions та 10000 IP-лічильників. Це захист локального застосунку, не повна Internet account authentication.

Команди playback, media та effects приймаються лише від controller його власної сесії. Display і неприєднаний socket не можуть надсилати controller commands. Поля `masterPageID`, `userID`, `role` у payload не створюють дозволів і не вибирають кімнату.

HTTP auth-помилки: JSON `{error:{code,message}}`, 401; rate limit — 429, capacity — 503. Socket handshake відхиляється через `connect_error`, код у `error.data.code`. Подія `session error` містить `{code,message,event}` для заборонених дій або невдалого pairing. Некоректний application payload залишається подією `error` з рядком `Invalid payload for <event>`.

Owner і display tokens не логуються; store зберігає SHA-256 hashes. Сервер порівнює hashes через timing-safe comparison. Pairing-коди ніколи не є HTTP upload/media авторизацією; закриття цих маршрутів — PR 4.
