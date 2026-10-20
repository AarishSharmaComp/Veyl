# Veyl development status

Updated: October 21, 2026

## Recovered project state

- Workspace: `/Users/aarishsharma/Documents/veyl`
- Stack: TypeScript, esbuild, Manifest V3, MediaPipe Tasks Vision.
- Git history currently contains only the initial `README.md` commit. The
  current source, configuration, lockfile, model, build output, and
  `node_modules` are untracked; preserve them until the project is reviewed
  and intentionally staged.
- No prior-session progress document or automated test files were present.

## Implemented in the working tree

- Manifest V3 extension limited to `https://meet.google.com/*` with a popup,
  isolated content script, service worker command, and synchronous MAIN-world
  page bridge at `document_start`.
- Local camera pipeline using a canvas `captureStream()` and preservation of
  cloned audio tracks with separate video/audio cleanup ownership.
- WebRTC routing hooks for `addTrack`, `addTransceiver`, and
  `RTCRtpSender.replaceTrack`, plus an outbound processed-track status so the
  popup does not call a merely local canvas “Live.”
- MediaPipe `ImageSegmenter` initialization with GPU then CPU fallback,
  confidence-mask smoothing, background-plate compositing, and a documented
  no-plate blur fallback.
- Background capture, local storage synchronization, preview, deletion, and
  a lightweight border-based mismatch warning.
- Popup settings for real-time removal, background plate use, animation,
  performance mode, optional snap detection, and sensitivity.
- Keyboard shortcut (`Ctrl`/`⌘` + `Shift` + `X`), particle/shockwave effects,
  and local Web Audio snap detection with cooldown and cleanup paths.
- Atomic, self-validating build output with platform-correct npm installation,
  local model/WASM asset checks, README installation/privacy/troubleshooting
  documentation, and seven Node architecture/package tests.

## Partial or unverified

- The page bridge now runs synchronously at `document_start`, returns the
  processed stream from the wrapped video `getUserMedia()` call, and routes
  known original tracks through WebRTC sender hooks. This still has not been
  verified in a real Google Meet call with a remote participant; a local
  outbound-track status is not proof of remote delivery.
- Camera lifecycle, camera switching, permissions, initialization failures,
  and cleanup need browser-level testing.
- Segmentation/compositing exists in code but has no automated media tests and
  has not been validated with the supplied model in Chrome.
- Product-facing naming is inconsistent: the repository is Veyl, while much
  of the manifest, UI, messages, and code still says `Snap`.

## Remaining work

- Real Chrome/Google Meet verification of remote output, camera switching,
  camera-off behavior, permission prompts, page lifecycle, and unrelated-site
  non-interference.
- Browser-level media tests for segmentation quality, frame rate, sender
  replacement, and visual mask boundaries.
- Decide whether the final release should keep “Snap” as the extension name
  under the Veyl project or rename every user-facing identifier to Veyl.

## Checks run

- `npm ci` — repaired the copied Linux ARM64 esbuild installation with the
  lockfile’s macOS ARM64 optional package.
- `npm run typecheck` — passed after the camera/bridge changes.
- `npm test` — 7 tests passed.
- `npm run build` — passed on macOS ARM64 and produced a validated `dist/`.

## Manual verification still required

1. Load `dist/` as an unpacked extension in Chrome.
2. Open a Google Meet call, turn on the camera, and verify the processed
   stream is the camera seen by other participants (not only a local canvas).
3. Capture a clean plate, move in frame, toggle disappearance, reappear, and
   test camera changes, tab reloads, permission denial, and call teardown.
4. Opt into snap detection, verify microphone permission, sensitivity,
   cooldown, and that disabling it stops tracks and closes the audio context.

## Reconciled project requirements

The original project prompt is now available and is the source of truth for
the implementation. The required user-visible result is a real Manifest V3
Chrome extension for Google Meet that continuously processes a live camera,
uses local person segmentation, removes the person from the outgoing track,
supports a captured background plate, and allows immediate reappearance from
the current live frame. It must not be only a popup or local preview.

Required behavior includes:

- Two disappearance modes: a lightweight captured-background mode and a
  hybrid real-time segmentation mode.
- Actual delivery of the processed `MediaStreamTrack` to Google Meet, with
  normal microphone audio preserved and the original camera restored or left
  usable when processing fails.
- Background capture, preview, recapture, deletion, local persistence, and a
  visible warning when the camera/plate alignment is unreliable.
- Mask confidence handling, temporal smoothing, edge refinement, adaptive
  inference, and an honest fallback when hidden scenery cannot be
  reconstructed.
- Disappearance and reappearance transitions that end in a fully correct
  live frame, plus optional particle/shockwave effects.
- Keyboard activation and opt-in local snap detection with sensitivity,
  cooldown, permission/error UX, and complete microphone/audio cleanup.
- Google Meet-only integration, narrow permissions, no remote executable
  code, no uploads or recordings, and cleanup for camera changes, tab/call
  lifecycle, permissions, and failures.
- A practical test plan, installation/Chrome loading instructions, privacy
  documentation, limitations, troubleshooting, and no claims beyond what was
  actually verified.

The original prompt calls the extension “Snap” while the project/product
brief calls the project “Veyl.” This implementation will preserve “Snap” as
the user-facing effect/extension name under the Veyl project identity unless
the product brief is later changed; the README will make that relationship
explicit rather than silently renaming existing files.

## Reconciled remaining tasks

### Completed in this session

- Reinstalled npm dependencies from the existing lockfile so the macOS ARM64
  esbuild binary is used, and made build output atomic and self-validating.
- Installed the page-world hook synchronously at `document_start`, before
  asynchronous storage initialization can miss Meet’s first camera request.
- Added local diagnostics for processed-track identity and active WebRTC sender
  usage through `getUserMedia`, `addTrack`, `addTransceiver`, and
  `replaceTrack` routing.
- Separated input-camera ownership, processed-video ownership, and microphone
  ownership; serialized camera attachment and added lifecycle/model disposal.
- Hardened camera-off, pagehide/pageshow, repeated initialization, error
  recovery, background validation, reappearance transitions, and degraded
  compositing behavior.
- Persisted popup settings/background deletion without requiring an active Meet
  tab, completed the README, and added seven automated architecture/package
  tests.

### Core effect correctness

The remaining core work is browser validation rather than an unimplemented
placeholder:

- Confirm segmentation/model loading and visual mask quality in Chrome.
- Confirm the remote participant receives the processed track in Google Meet.
- Confirm Meet camera switching and sender renegotiation do not interrupt the
  microphone or leave stale streams.

### Product quality and evidence

- Add deeper browser/media tests if Chrome automation becomes available.
- Decide whether the final release should keep “Snap” as the extension name
  under the Veyl project or rename every user-facing identifier to Veyl.
- Add a dedicated segmentation-mask development preview only if it is needed
  for visual model tuning; it is not exposed in the current production popup.

## Latest verification state

The original requirements have been reconciled with the working tree and the
highest-priority build/media-path implementation has been completed as far as
this non-browser environment allows. The remaining acceptance evidence is
manual Chrome/Google Meet testing:

- `npm ci` — passed and repaired the platform-specific esbuild installation.
- `npm run check` — passed: typecheck, 7 tests, and build.
- `dist/` — contains the manifest, four bundled scripts, popup assets, local
  model, and MediaPipe WASM assets.
- No lint command is configured in `package.json`.
