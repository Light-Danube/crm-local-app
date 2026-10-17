# Оновлення залежностей — 2026-10-17

PR 5 прибирає невикористані production dependencies `reload`, `uuid`, `node-fetch` та dev dependencies `connect-livereload`, `livereload`. Їхніх імпортів або викликів у сервері, клієнтах, тестах і npm scripts не знайдено. Browser `fetch` і Node.js `fetch` у тестах не потребують `node-fetch`. `nodemon` збережено, оскільки його запускає `npm start`.

Прямий імпорт `cors` тепер має пряму залежність `^2.8.6`. Оновлено Express до 4.22.3, Socket.IO до 4.8.4 і nodemon до 3.1.14; lockfile оновлює транзитивні залежності в дозволених ranges, без major migration або overrides. Зокрема: `body-parser` 1.20.8, `qs` 6.16.1, `proxy-addr` 2.0.8, `path-to-regexp` 0.1.13, `engine.io` 6.6.11, `socket.io-parser` 4.2.7, `socket.io-adapter` 2.5.8, `ws` 8.21.3.

## Перевірка

Node.js 24.19.0 / npm 11.9.0. `npm update` і наступний чистий `npm ci` завершилися з кодом 0. Усі 33 тести пройшли:

```sh
node --test --test-timeout=15000 test/http-smoke.test.js test/media-path.test.js test/socket-payloads.test.js test/session-auth.test.js test/session-store.test.js test/media-auth.test.js test/media-service.test.js
```

Це HTTP/assets, точні download/range, containment, upload quotas/cleanup, session/role authorization, pairing та malformed Socket.IO packets. Майбутній некомітнутий YouTube suite не входить у цю перевірку. Browser playback і зовнішній YouTube цими тестами не перевіряються.

| Audit | До | Після | Exit після |
| --- | --- | --- | --- |
| Full | 19: critical 1, high 10, moderate 4, low 4 | 3 high | 1 |
| `--omit=dev` | 16: critical 1, high 7, moderate 4, low 4 | 0 | 0 |

Обидва початкові audit завершилися з кодом 1. Нових незалежних advisory після оновлення немає. Деталі, встановлені версії й результати команд наведено в [JSON snapshot](dependency-update-2026-10-17.json). Історичний [baseline audit](dependency-audit-2026-10-17.json) збережено.

## Залишковий ризик і наступний крок

Full audit містить один advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): stack exhaustion на глибоко вкладених glob patterns у `braces@3.0.3`. npm поширює його на `chokidar@3.6.0` і прямий `nodemon@3.1.14`, звідси три package findings. Цей advisory уже був у baseline; `chokidar` і `nodemon` тепер перелічено як уражених батьків у поточному графі.

`npm start` використовує nodemon, тому dev finding не є автоматично неважливим для запущеного застосунку. Chokidar передає watch paths у `braces.expand`; ці patterns походять із локальної конфігурації watcher. HTTP/Socket.IO API не налаштовує watch patterns, а upload імена генеруються сервером. Шлях від віддаленого запиту до керованого attacker glob pattern не виявлено; довільну конфігурацію або локальні шляхи не оголошено безпечними. DoS-відтворення цього advisory не запускалося.

У дозволеній гілці `braces@3` виправлення зараз немає. `npm audit` пропонує downgrade nodemon до 1.14.10 як major change; його не застосовано. Окремий план: у PR 12 додати production script із прямим `node server.js`, перевірити запуск після `npm ci --omit=dev`, graceful shutdown і smoke; для dev watcher відстежити upstream виправлення або окремо протестувати заміну/оновлення watcher зі збереженням автоматичного перезапуску. Перед випуском повторити full/prod audit, оскільки registry advisories змінюються. Нуль production findings не є доказом повної безпеки застосунку.
