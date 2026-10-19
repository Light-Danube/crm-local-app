# YouTube command-boundary regression, 2026-10-19

The user observed desynchronization immediately after starting or pausing YouTube.
On main `75f1bc1`, displays ignored the canonical time on start/pause, and a
playing reconnect did not include time spent preparing metadata or starting playback.

A controlled local IFrame API double delayed display play by 600 ms and pause by
150 ms. Controller delays were zero. Both independent Chromium contexts decoded a
20-second H.264/AAC MP4 (320×180, 24 fps), served with proper byte ranges.
Environment: Chromium 154.0.8037.57, Node 24.19.0, one Linux host, loopback Socket.IO.
This isolates asynchronous API commands; it does not contact YouTube.

| Boundary | Main, seconds | Correction, seconds |
| --- | ---: | ---: |
| Start | 0.534 | 0.066 |
| Pause | 0.374 | 0.043 |
| Resume | 0.901 | 0.095 |

Each value is one paired observation, not a percentile or a quality guarantee.
A later complete-suite run observed 0.058/0.040/0.082 seconds for the same three corrected boundaries.
The test reads the double's actual native video clocks and decoded frame counts,
then projects playing clocks to a common monotonic timestamp. It does **not** use
the facade's briefly cached requested seek position. Sampling waits for playback
or pause and seeks to settle. Host load and decoder scheduling affect the result.

The regression is reproducible with:

```sh
CHROMIUM_PATH=/usr/bin/chromium node --test --test-timeout=60000 scripts/browser-youtube-sync.cjs
```

The test rejects residual drift above 200 ms in this specific delayed-API fixture.
It is not a live YouTube/LAN/physical-display measurement. Actual YouTube remains
blocked by the cloud network policy. Corrections occur at explicit commands and
restore boundaries; no periodic seeks or playback-rate correction were introduced.
