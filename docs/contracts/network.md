# Origin policy і YouTube

`ALLOWED_ORIGINS` — список точних HTTP(S) origins через кому, без slash наприкінці, wildcard або path. Default — лише localhost/127.0.0.1 на порті сервера. Для LAN/production задайте реальні origins явно; клієнти відкривають сторінки на дозволеному origin.

Одна policy діє на HTTP, CORS, polling і WebSocket handshakes/upgrades. Чужий Origin відхиляється до application handlers. Рядок `null` не є дозволеним origin. `ALLOW_NO_ORIGIN` default true: дозволяє CLI, native navigation та same-origin video GET, де браузер може не додавати Origin. `false` відхиляє всі такі запити, включно з навігацією; це свідомо суворий режим. Відсутність Origin не надає role/media прав: tokens перевіряються незалежно.

`GET /youtube/:videoId` приймає рівно 11 URL-safe символів ID. Default: 6 concurrent requests (master + 5 display), 60 requests/хв на адресу socket (bounded table 1024), 15 секунд до першого video chunk; потім 15 секунд без надходження даних. Активний довгий stream не обривається цим idle timer. Окремий hard deadline — 2 години. Constructor `youtubeOptions` дозволяє змінити positive integer `maxConcurrent`, `maxRequests`, `windowMs`, `timeoutMs`, `maxDurationMs`. Ліміти адреси не довіряють X-Forwarded-For. Слот звільняється при завершенні, помилці, timeout або client disconnect; upstream і metadata requests скасовуються. 400 — неправильний ID, 429 — rate, 503 — capacity, 504 — timeout, 502 — upstream failure (після початку відповіді connection закривається).

Тести використовують підставний upstream: включають зависання metadata, пізні запити, помилки до/після headers і client abort. Реальна сумісність з YouTube потребує окремої ручної перевірки й дозволеного зовнішнього доступу; CI не завантажує YouTube-відео. TLS та upstream package verification не вимикаються.


Уточнення multi-display (PR 9a): попередні defaults 2 streams/10 requests за хвилину не вміщували master і кілька папетів. Значення 6/60 залишають network work bounded і дозволяють default п'ять екранів та preview. Initial, inactivity та hard timers мають незалежні regressions; кожен cleanup прибирає всі timers/listeners і upstream. Для довгих YouTube downloads використовуються inactivity + hard cap, не 15-секундний total cap.
