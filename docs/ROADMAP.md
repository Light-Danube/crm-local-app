# Роадмапа невеликих оновлень

Дата: 2026-10-17. База: `4d0830a`. Ціль — безпечніша робота з локальним відео, надійне з'єднання контролера з кількома авторизованими екранами і вимірюване покращення швидкодії без зміни стеку. «Єднання» тут означає pairing, reconnect і узгоджений стан двох пристроїв. Уточнення користувача: підтримати більше одного папета; окремий PR 7a додає bounded multi-display та перевірки реального video flow.

Документ фіксує план і стан виконання. Історичний огляд описує початкову базу; актуальний прогрес наведено нижче. [Огляд безпеки](security/REVIEW-2026-10-17.md) пояснює підтверджені ризики й межі перевірки. Усі роботи — окремі draft PR; оцінки в людино-днях орієнтовні та включають регресійні перевірки. Кожен PR має працювати самостійно й не залишати залежний від іншого PR зламаний контракт.

## Стан виконання

- PR 1: реалізовано в гілці `fix/socket-payload-validation`; `npm test` перевіряє malformed packets, межі значень, ізоляцію серверів і HTTP/upload/range smoke. Формат помилки: подія `error` з рядком `Invalid payload for <event>`. Effects надсилаються boolean, volume — number. S3/S4 ще відкриті; валідація не є авторизацією.
- PR 2: реалізовано в `fix/media-path-containment`: спільний валідатор і realpath-containment для медіамаршрутів, негативні перевірки traversal/symlink і точності download/range. Авторизація медіа залишається PR 3–4.
- PR 3: серверні identity/role tokens, TTL та одноразовий pairing, ліміти спроб, заборона duplicate takeover й сторонніх команд; обидва клієнти оновлені. Контракт: [sessions](contracts/sessions.md).
- PR 4: owner auth до upload, серверні media ID, MP4/WebM signatures, size/concurrency/disk/session quotas, cleanup partial/rejected uploads та авторизовані media URL в обох клієнтах. Публічні legacy media routes закрито.
- PR 5: вилучено невикористані dependencies, задекларовано прямий cors, оновлено сумісні Express/Socket.IO та lockfile. Production audit: 0; full: 3 high package findings у nodemon/chokidar/braces, з reachability та планом у [звіті](security/dependency-update-2026-10-17.md).
- PR 6: exact allowed origins для HTTP/Socket.IO (обидва transports), явна no-Origin policy; YouTube має bounded concurrency/rate/deadline, cancellation та stream-error handling. 48 тестів, fake upstream; реальний YouTube не перевірявся.
- PR 7: lifecycle кімнат, ідемпотентне pairing, безпечне switching/disconnect та cleanup неактивних сесій; 54 тести, включно з 20 циклами кімнат.
- PR 7a: кілька папетів реалізовано: default 5 незалежних display identities, reconnect/revoke кожного, спільний pairing-код у межах його початкового TTL, актуальні count/slots (уточнення користувача 2026-10-19). Chromium перевірив upload, decode, play/pause на трьох display одночасно.
- PR 8: canonical playback snapshot/revision, role-token reconnect, видимі connection states, відсутність stale offline commands, явне повторне єднання після restart та autoplay recovery. Спільний YouTube URL parser прибирає розбіжність клієнтів.
- PR 9: preview URL відкликається при заміні/закритті, cancel без винятку, YouTube preview — прямий stream URL. UI показує фактичні upload limits і помилки; MIME-empty MP4/WebM перевіряються сервером. Chromium: 20 фактичних замін, active URLs≤1; обидва клієнти декодують до завершення fake upstream.
- PR 9a: YouTube admission відповідає master + 5 display (6 streams/60 requests на хвилину); initial/idle timeout 15 с та окремий hard cap 2 год не обривають активний довгий stream. 17 fake-upstream regressions.
- PR 10: стандартний authenticated sendFile закріплено Range/HEAD/304/416/abort/error tests; HTML/JS revalidate, CSS/images max-age 300 із ETag. Bounded HTTP baseline та paired comparison збережені; надійного прискорення не заявлено.
- PR 11–12: очікують виконання.

## Послідовність

| PR | Пріоритет / оцінка | Невелика зміна | Критерій завершення / залежності |
| --- | --- | --- | --- |
| 1 | P0 / 0.5–1 д. | Валідувати Socket.IO payloads і заборонити process crash на `null`, масивах, неправильних типах та позамежних числах. Додати справжній `node:test` runner та ізольований lifecycle сервера для цих тестів. | S2 більше не завершує процес; клієнт отримує контрольовану помилку; наступний HTTP-запит працює. Перевірити time ≥ 0, volume 0…1, string URL/ID і boolean effects; не приймати невідомі поля як права доступу. |
| 2 | P0 / 0.5–1 д. | Закрити traversal у `/videofile` та узгодити безпечне визначення media path. | S1 повертає 4xx; encoded separators, `..`, абсолютні шляхи й symlink поза media root не читаються. Звичайний download/range не змінює байти. Це containment, а не повна авторизація. |
| 3 | P0 / 1–2 д. | Серверна сесія й ролі: створення controller identity/token, pairing code із TTL, перевірка owner token, ліміт спроб; заборона сторонніх команд і duplicate takeover. Оновити обидва клієнти в цьому самому PR. | S3 відхиляється; display не може виконувати controller commands; інша сесія не бачить подій. Контролер із коректним token може відновитися без перехоплення чужої сесії. Усі HTTP/Socket.IO auth-помилки мають визначений контракт. Не логувати tokens. |
| 4 | P0 / 1–2 д. | Авторизація upload до запису, серверні media ID/імена, перевірка формату, size/concurrency/disk quotas, cleanup; закрити публічний `/uploads` і підключити авторизовані media URL до обох клієнтів. | Залежить від PR 2–3. S4 не залишає файлів; HTML/SVG/невідповідні MIME відхиляються; oversized upload дає 413, від'єднання прибирає partial file; overwrite неможливий; чужі media недоступні. Конкретні межі задати через конфіг і покрити boundary tests. |
| 5 | P1 / 0.5–1 д. | Прибрати перевірені невикористані production dependencies (`reload`, `uuid`, за потреби `node-fetch`); задекларувати прямий `cors`; оновити сумісні Express/Socket.IO транзитивні залежності з lockfile. | Можна почати паралельно з PR 1–2, але перед випуском перевірити інтеграцію з PR 3–4. Порівняти full/prod audit; жодного непоясненого нового finding. Залишкові findings мають reachability-оцінку й окремий план; major migrations — окремо. Smoke + auth/negative tests проходять після `npm ci`. |
| 6 | P1 / 0.5–1 д. | Явні allowed origins для HTTP і WebSocket, перевірка handshake; обмеження частоти/concurrency, timeout/cancellation та stream errors у YouTube route. | Чужий origin відхиляється, дозволений працює; політика для клієнтів без Origin явна. Фальшивий upstream у тесті показує timeout, cancel та error без зависання/витоку. Не завантажувати реальні YouTube-відео в CI; інтеграцію з сервісом перевіряти окремо. |
| 7 | P1 / 1 д. | Єдиний lifecycle session/room: один namespace `/playerControls`, cleanup старої кімнати при перепідключенні, ідемпотентний join, актуальний лічильник екранів. | Залежить від PR 3. Після 20 циклів pairing/switch/disconnect немає stale members і доставки в попередню кімнату. Disconnect старого socket не видаляє нового власника; `updatePuppets` оновлюється після виходу. Upload notification доставляється один раз правильному екрану. |
| 7a | P1 / уточнення | Кілька папетів: незалежні display tokens, bounded slots, reconnect/revoke кожного display, актуальний лічильник і новий pairing-код для наступного екрана. | Команди й upload доходять рівно один раз до кожного з трьох екранів; чужа сесія ізольована; duplicate token не перехоплює display; межа configurable. Перевірити відео браузером. |
| 8 | P1 / 1–2 д. | Reconnect UI: `connecting/connected/reconnecting/disconnected`, автоматичне rejoin із token, явне відновлення сесії та snapshot `{media,time,paused,volume,effects,revision}`. | Залежить від PR 7. Після короткого network drop display повертається до доступної сесії, отримує актуальний стан і не виконує старі команди. Після restart сервера показує потребу повторного pairing, якщо збереження сесій не реалізовано. Автоплей-помилка дає видиму кнопку відновлення. |
| 9 | P2 / 0.5–1 д. | Прибрати зайві Blob allocations: revoke локального object URL при заміні/закритті; YouTube preview передавати як stream URL, а не чекати `response.blob()`. Listener `loadedmetadata` робити одноразовим/керованим. | Після 20 замін файлу кількість активних object URLs обмежена одним; preview може починати буферизацію до завершення download. Покрити cancel file selection. Перевірити браузером memory trend й autoplay, а не лише HTTP. Залежить від узгоджених media URL у PR 4/6. |
| 10 | P2 / 1 д. | Після вимірювання замінити `statSync` і самописний Range handler на безпечну стандартну видачу медіа; додати conditional caching для статичних assets. | Зберегти auth/containment із PR 2/4; `bytes=0-9`, open-ended і suffix ranges, 416, client abort та stream error мають тести. Повторний asset request дає 304; HTML не отримує довгий immutable cache. Не стискати вже стиснене відео без вимірювання. |
| 11 | P2 / 1–2 д. | Узгодити seek/loop/inversion state, додати revision/ack для важливих команд; виміряти дрейф і лише тоді ввести bounded sync. | Після PR 8. Виправити однобічні payload effects; перевірити play/pause/seek/volume/loop на двох реальних браузерах. Не шукати кадр на кожні 10 мс: threshold/cadence обирати з baseline; high-frequency volume/time updates обмежити, фінальний seek не губити. |
| 12 | P2 / 0.5–1 д. | Надійний runtime: configurable port, mkdir runtime dirs, обробка log errors/backpressure/rotation, SIGTERM/SIGINT shutdown, production script без nodemon, CI smoke/audit. | Не логувати pairing tokens. SIGTERM із активною сесією закриває sockets/server/log stream без reserved-event exception. CI запускає реальні тести; відсутній test suite більше не маскується placeholder. Кеш deps прив'язати до lockfile. |

Безпечний порядок для публічного запуску: PR 1–4 та оцінка/усунення досяжних критичних dependency risks; PR 5–6 не відкладати заради UI-оптимізацій. Виправлення окремого P0 можна випускати раніше, але це не означає, що решта P0 закриті.

## Що вимірювати

Baseline перед PR 9: [дані](benchmarks/baseline-2026-10-17.json). Активні object URLs зростали 1→20 без revoke; після PR 9 browser-media перевіряє 21 create / 20 revoke / 1 active. JS heap — лише оцінка, не retained Blob/RSS/GPU; без forced GC. Поточні відтворювані browser smoke/media scripts генерують власний fixture. Числа relay baseline включають IPC автоматизації й не є ack або видимою затримкою. Запропоновані нижче пороги — цілі, а не отримані результати.

| Метрика | Відтворювана перевірка | Початкова ціль |
| --- | --- | --- |
| Команда → ack → видимий стан | Один controller і display, 100 послідовних команд без медіа, окремо з 1080p fixture; RTT/ack на одному clock, видимий стан браузером | На локальному середовищі p95 ack < 100 мс; не видавати це за міжпристроєву затримку відтворення. На реальній LAN записати окремий baseline. |
| Reconnect | 10 циклів відключення мережі на 2 с, wait-after-restore; сервер не перезапускається | Відновлення pairing + snapshot ≤ 5 с після доступності мережі; жодної чужої команди/застарілої кімнати. |
| HTTP під медіа-навантаженням | Однаковий fixture/тривалість, 1 і 5 bounded одночасних streams; p50/p95 latency assets, CPU/RSS/event-loop delay | Відсутність >10% регресії p95 проти baseline за однакових умов; зміни менші за шум не називати покращенням. |
| Пам'ять браузера | 20 послідовних замін того самого локального fixture, heap/retained Blob після стабілізації | Немає лінійного зростання object URLs/listeners. Не встановлювати довільний RSS-ліміт без розміру відео та профілю пристрою. |
| Відеосинхронізація | Два браузери, 10 хв відтворення + seek, зафіксовані codec/fps/network; порівняння відносно спільного time reference | Спершу виміряти drift/stalls; потім погодити threshold. Час сервера чи ack не дорівнює моменту показу кадру. |

У результатах записувати Node/browser версії, розмір/codec fixture, кількість клієнтів, transport, RTT, filters on/off та команду benchmark. Не називати CSS effects «оптимізацією швидкодії»: blur/drop-shadow/contrast можуть збільшувати GPU-навантаження.

## Поточні дефекти єднання, на які спирається план

- `server.js:156` повідомляє default namespace, хоча клієнти в `/playerControls`; браузер компенсує це окремою подією (`master.html:376`). Потрібен один узгоджений шлях підтвердження upload.
- Disconnect шукає Map за `socket.id`, хоча ключ — клієнтський `userID` (`server.js:239–241, 287–306`). Повторна реєстрація може залишити або видалити неправильний стан. При switching кімната не звільняється (`server.js:264–266`).
- Обидва клієнти на disconnect очищають `src`; display не повторює `connectToMaster` після reconnect (`video.html:79–97, 120–123`, `master.html:523–526`). Socket reconnect сам по собі не відновлює room membership/state.
- Server emits `loop status`/`inversion status` з одним параметром; display порівнює відсутній `masterPageID` із неініціалізованим `socket.connectionSocketID` (`server.js:366–373`, `video.html:205–215`). Обидва `undefined` можуть випадково пропустити подію, але це не перевірка сесії й не надійний контракт.
- `timeupdate` на сервері названо узагальнено, але controller відправляє його лише на `seeking` (`master.html:352–354`). Поточного постійного flood немає; throttling потрібен лише якщо вводиться періодична синхронізація.

## Поки що поза обсягом

Redis/multi-instance adapters, транскодування, великі frontend migrations, повна синхронізація кадрів. Вони потребують вимог/метрик, яких зараз немає. План не залежить від нових платних сервісів.
