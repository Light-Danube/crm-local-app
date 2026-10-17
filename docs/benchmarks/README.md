# Відтворювані вимірювання

Усі fixtures тимчасові, усі requests loopback; немає production scans або реального YouTube. Node 24.19.0, Chromium 154.0.8037.57. Дані одного host не є LAN/physical-screen latency або оцінкою production capacity.

- [Preview baseline до PR 9](baseline-2026-10-17.json): 20 замін давали 20 active URLs без revoke. `npm run test:browser` тепер перевіряє 21 create / 20 revoke / 1 active. JS heap — оцінка без forced GC; total media/GPU/RSS plateau не виміряно.
- [HTTP до зміни](http-before-2026-10-17.json) та [після](http-after-2026-10-17.json): по 100 CSS requests під 1 та 5 bounded downloads, fixture 2 MiB із MP4 signature (без decode claim), HTTP/1.1 keep-alive. CPU/RSS/event-loop включають client driver у тому самому процесі. Незалежні короткі runs показали значний шум і вищі p95 після зміни.
- [Контрольна paired перевірка](http-cache-comparison-2026-10-17.json): один прогрітий Node process, дві isolated applications, 3 ABBA cycles, 6 samples/variant/concurrency. Median p95 1 stream: 3.704 → 3.018 ms; 5 streams: 4.067 → 3.318 ms. Розкид перекривається; систематична >10% регресія не відтворилася, прискорення також не доведено. Browser cache hits у driver не симулюються.

Запуск поточного HTTP benchmark:

```sh
node scripts/http-benchmark.cjs work/http-current.json
```

Для paired comparison потрібна історія pre-change commit (наприклад, `15092fd`, якщо він присутній у checkout):

```sh
BASELINE_REF=15092fd node scripts/http-cache-comparison.cjs work/http-comparison.json
```

HTML та app JS мають `no-cache`, CSS/images — `public, max-age=300, must-revalidate`. ETag дає 304. Media залишається private/no-store; auth виконується до conditional/range response. Socket.IO vendor script зберігає власну max-age=0 revalidation policy. Standard media sendFile було введено з авторизацією в PR 4; PR 10 перевіряє й закріплює його поведінку, не видає це за нову виміряну оптимізацію.
