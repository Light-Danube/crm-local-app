# Origin policy і YouTube

`ALLOWED_ORIGINS` — список точних HTTP(S) origins через кому, без slash наприкінці, wildcard або path. Default — лише localhost/127.0.0.1 на порті сервера. Для LAN/production задайте реальні origins явно; клієнти відкривають сторінки на дозволеному origin.

Одна policy діє на HTTP, CORS, polling і WebSocket handshakes/upgrades. Чужий Origin відхиляється до application handlers. Рядок `null` не є дозволеним origin. `ALLOW_NO_ORIGIN` default true: дозволяє CLI, native navigation та same-origin video GET, де браузер може не додавати Origin. `false` відхиляє всі такі запити, включно з навігацією; це свідомо суворий режим. Відсутність Origin не надає role/media прав: tokens перевіряються незалежно.

`GET /youtube/:videoId` приймає рівно 11 URL-safe символів ID. Default: 2 concurrent requests, 10 requests/хв на адресу socket (bounded table 1024), 15 секунд на metadata + media stream загалом. Constructor `youtubeOptions` дозволяє змінити positive integer `maxConcurrent`, `maxRequests`, `windowMs`, `timeoutMs`. Ліміти адреси не довіряють X-Forwarded-For. Слот звільняється при завершенні, помилці, timeout або client disconnect; upstream і metadata requests скасовуються. 400 — неправильний ID, 429 — rate, 503 — capacity, 504 — timeout, 502 — upstream failure (після початку відповіді connection закривається).

Тести використовують підставний upstream: включають зависання metadata, пізні запити, помилки до/після headers і client abort. Реальна сумісність з YouTube потребує окремої ручної перевірки й дозволеного зовнішнього доступу; CI не завантажує YouTube-відео. TLS та upstream package verification не вимикаються.
