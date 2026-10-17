# Working in this repository

## Scope and architecture

This is a small video controller/display application, despite the repository name.
- `server.js`: CommonJS Express HTTP server, authenticated disk uploads (`lib/media-service.js`), YouTube proxy and Socket.IO namespace `/playerControls`.
- `master.html`: controller, local preview, upload and playback controls.
- `video.html`: paired display/player.
- `index.html` and `public/`: entry page and static assets.
- Server-issued session identity and hashed owner/display tokens live in `lib/session-store.js`; restarting the server loses sessions. See `docs/contracts/sessions.md` for HTTP and Socket.IO authentication. There is no database or build pipeline.

Keep changes focused and preserve the Ukrainian UI. Prefer small draft PRs; update both ends and tests when changing HTTP or Socket.IO contracts. Do not add a framework or distributed infrastructure without a demonstrated need. See `docs/ROADMAP.md` and `docs/security/REVIEW-2026-10-17.md` for planned work and known defects. Those documents describe the reviewed baseline, not fixes already delivered.

## Development

Use the existing checkout. Cloud tasks are isolated; do not create Git worktrees unless explicitly requested. Read any more specific instructions before editing a subdirectory.

From the repository root:

```sh
npm ci
mkdir -p logs uploads
npm start
```

Validated runtime: Node.js 24.19.0 / npm 11.9.0; the repository currently has no version pin. `npm start` runs nodemon; the server currently hardcodes port 3000. Run it from the repository root because uploads use a relative path. Create `logs` before startup or its write stream can fail. A normal production launch should eventually use a dedicated script rather than nodemon; no production script exists today.

No credentials or external service are needed for local-file development. YouTube mode requires external access and separate validation. Inspect only credential names/status; never print values or commit local credentials. Preserve TLS, checksum and package-signature verification.

## Validation and reporting

Run `npm test` for the Node built-in regression suite. Tests own isolated servers on random loopback ports and temporary media/log directories. There is no build or typecheck script; do not report those checks as passing.

For documentation-only work, check links, source references and `git diff --check`; no application test changes are needed. For behavior changes, add focused regression coverage using a lightweight runner, preferably Node's built-in test runner, and cover the failure being fixed. Do not assume cloud-only helpers outside the checkout exist in another environment.

Minimum application smoke checks after relevant changes:
1. Start the server, inspect errors and request `/`, `/master.html`, `/video`, `/video.html?video=sample.mp4`, a public asset and `/socket.io/socket.io.js`. Expect nonempty HTTP 200 responses. `/video.html` without its query should return 400; `/select?type=local` should redirect to `/master.html?type=local`.
2. Create a session, upload a disposable MP4/WebM fixture with the owner Bearer token, verify exact authorized download/range bytes, and confirm anonymous/other-session denial. Tests remove only their temporary runtime files. Legacy `/uploads` and `/videofile` URLs must not serve files.
3. Connect a controller and display in `/playerControls`; check pairing, play, pause, seeking and volume. For connection changes also check disconnect/reconnect, room isolation and rejected unauthorized events.
4. Browser-test actual media decoding, autoplay and visible player state when touching the UI. HTTP/Socket.IO checks do not prove browser playback or synchronization quality.

Run `npm audit` and `npm audit --omit=dev` for dependency/security work. Preserve exit status and distinguish registry advisories from proven reachable bugs; a production dependency can still be unused at runtime. Do not run `npm audit fix --force` blindly. Keep manifests and lockfile consistent when a dependency change is explicitly in scope.

Security reproductions that can terminate a process must use a separate disposable server and benign fixtures, never a shared server or a deployed instance. Avoid load tests, external scans and reading real credentials. Report exact checks run, passes/failures, untested behavior and remaining limitations.

## Security boundaries to preserve and improve

Do not treat a client-provided `userID`, room name, filename or MIME type as authorization. Session roles, identity generation, media ownership and payload validation belong on the server. The six-digit, expiring, one-use pairing code is a convenience; it does not replace owner authentication or Internet account access controls.

Changes involving uploads must address authentication before writing, server-generated filenames, path containment, bounded size/concurrency, cleanup and active-content serving. Restrict downloads to authorized session media. An Express HTTP CORS policy does not secure WebSocket handshakes; validate allowed origins and authorize Socket.IO events separately. Reject malformed payloads without crashing the process.

Maintain a single session contract for HTTP and `/playerControls`; do not silently emit into the default namespace. Bound queues and network work, handle stream errors and cancellation, and keep CPU/blocking filesystem work out of hot request paths. Do not introduce aggressive `currentTime` correction without measuring playback effects.

## Repository hygiene and delivery

Inspect `git status` before and after work; preserve existing changes. Never commit `node_modules/`, uploads, connection logs, local credentials or generated media. Currently only `node_modules` is ignored, so stage explicit files rather than `git add .`. Do not remove user data to make the tree clean.

Do not merge or deploy unless requested. A draft PR should explain the concrete problem, scope, validation and outstanding risks. Do not claim a remote PR exists without a successful creation result and URL. If API/network access blocks it, retain the branch and PR text, report the precise blocker and continue local work.
