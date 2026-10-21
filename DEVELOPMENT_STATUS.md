# Veyl development status

Updated: October 21, 2026

## Baseline recovered

- Workspace: `/Users/aarishsharma/Documents/veyl`.
- Stack: TypeScript, esbuild, Manifest V3, MediaPipe Tasks Vision.
- Starting commit: `8e83ab1 feat: establish working Veyl camera effects extension`.
- Existing Google Meet camera processing, background capture, compositing,
  effects, popup, build, and architecture tests were preserved.
- The repository now uses **Veyl** as the product identity and keeps the local
  directory name unchanged.

## Implemented in this expansion

### Website policy and permissions

- Google Meet remains the built-in statically injected site.
- Other sites are not statically injected.
- The popup accepts HTTPS origins and localhost development origins only.
- Chrome optional host permission is requested for the exact selected origin.
- Enabled non-Meet origins use dynamic `document_start` content-script
  registration with isolated and MAIN-world scripts.
- Profiles are stored separately per site and require both host permission and
  explicit Veyl enablement plus the global switch, including Meet. Registrations
  and profiles use exact scheme/host/port; a browser grant alone never enables a site.
- Global enable/disable, current-site enable/disable, site removal, and
  permission revocation/deactivation paths are implemented.
- Dynamic scripts are top-frame-only and do not automatically enter
  cross-origin iframes.
- Worker writes are serialized across tabs/settings/captures. Legacy backgrounds
  migrate only to Meet; disabled Meet tombstones prevent resurrection. Prior
  audio-trigger consent never opts users into the camera trigger.

### Reusable camera path

- Injected selected pages get a minimal synchronous API prehook before site code
  caches media methods. This does not acquire a camera or initialize ML.
- Native camera requests start immediately; processing waits at most 1500 ms
  for worker-authorized policy, otherwise passes the native stream through.
  Meet has no unconditional processing bootstrap while storage loads.
- The shared pipeline continues to use local person segmentation, background
  plates, Canvas compositing, and a processed video capture track.
- WebRTC routing covers known camera tracks through `getUserMedia`,
  `addTrack`, `addTransceiver`, and `replaceTrack` paths.
- `src/integration/camera-integration.ts` tracks aggregate sender bindings and
  successful replacements, restoring original senders/streams before releasing
  output tracks. Unknown replacements do not overwrite unrelated bindings.
- One canvas capture source provides leased output clones across repeated
  acquisitions, stopped permission probes, native stream clones, and source
  switches. Existing consumers survive when another output is stopped.
- If native sender restoration is rejected, ML/effects turn off and the existing
  output stays live as passthrough with a reload-required status, rather than
  freezing a still-transmitted track.
- Original website microphone tracks are returned unchanged and never stopped
  by video cleanup. Disabling transfers native video back where possible.
- Unknown tracks and display capture are not intentionally routed.
- Camera gesture detection reuses the existing hidden source video; it does
  not start a second camera or microphone stream.
- Session-bound commands report actual operation/persistence failures. Revision
  guards, worker refresh/heartbeats, a bounded authorization lease, pagehide,
  and BFCache re-handshake keep lifecycle changes from reviving stale state.
- Confident person masks are opaque on the first frame; invalid inference drops
  stale masks. Captured plates/live fallback avoid permanent black/frozen output.

### Camera-based gesture trigger

- Removed the active microphone-based detector and its audio resource path.
- Added a locally bundled MediaPipe `HandLandmarker` model.
- Added GPU-first/CPU fallback hand-landmarker initialization.
- Added a temporal thumb–middle contact then quick inward-curl state machine:
  stable appearance/contact, timestamp-based palm/aspect-normalized motion,
  multi-frame release confirmation, hand-loss handling, and cooldown.
- Filters reject static/slow releases, thumb-only motion, waves, translation,
  camera approach/scale changes, identity jumps, gaps, and malformed landmarks.
- Singleton model construction is cancellation-safe across WASM resolution and
  late GPU/CPU creation; buffers are reused and masks are released after reading.
- Hand inference treats MediaPipe handedness as identity metadata rather than
  presence confidence, clears stale temporal evidence on repeated/reordered
  timestamps, and keeps hand failures separate from usable person segmentation.
- Hand inference runs before segmentation on its own adaptive cadence and
  reports `handInferenceMs`, `handInferenceOffloaded`, and
  `handInferenceOffloadError` diagnostics.
- Added `hand-gesture-worker.js`, which transfers local `ImageBitmap` frames to a
  detector worker. A blob bootstrap imports only the packaged extension worker
  and exact local WASM paths, including under enforced Trusted Types; blocked
  workers fail closed to the main-thread detector.
- Added popup controls for enablement, sensitivity, cooldown, hand-tracked
  status, and manual fallback controls.
- No microphone permission is requested for gesture detection.

### Veyl identity and assets

- Manifest, package metadata, popup title, action title, descriptions, errors,
  status copy, README, and tests use Veyl branding.
- Added PNG icons at 16, 32, 48, and 128 pixels.
- Added vector mark: `assets/brand/veyl-mark.svg`.
- Added promotional cover artwork:
  `assets/promotional/veyl-cover.svg` and 1600×900 PNG, plus original outlined
  wordmark, room/person illustration, 440×280 tile and 1400×560 marquee uploads.
- Eight PNGs reproduce byte-for-byte with `scripts/generate-artwork.py --check`;
  source/usage/font notes are in `docs/BRAND_ASSETS.md`. Illustrations are not
  screenshots or evidence of live-site operation.
- Popup displays:
  `VEYL` / `Present, not visible.`

### Build and tests

- Existing macOS ARM64 esbuild installation remains reproducible with
  `npm ci` and the committed lockfile.
- Build output is staged, validated, and promoted using rollback-safe staged
  renames (not an atomic filesystem exchange). Previous output is preserved if
  promotion fails; if rollback also fails, its recovery path is reported.
- The locked MediaPipe dynamic loader receives a reproducible build-time
  adapter. In a page requiring `require-trusted-types-for 'script'`, the page
  bridge creates a narrowly allowlisted policy for only the current extension
  origin and packaged `wasm/vision_wasm*_internal.js` loader paths; policy
  failure disables initialization with diagnostics rather than weakening CSP.
- The worker bootstrap brands its blob URL only after VEYL registers it and
  applies a separate exact-origin policy to the worker's local
  `importScripts()` WASM loaders. No unrestricted page policy, `eval`,
  `new Function`, or remote executable resource was added.
- Validation requires all icon/model metadata, PNG dimensions/signatures, model
  sizes/checksums, UI/scripts/notices, and valid SIMD/non-SIMD WASM modules.
- Model provenance is in `public/models/models.json`; runtime license/notices
  under `public/licenses/` are copied into the package. The build also preserves
  marked legal comments if present in upstream sources.
- Behavioral tests exercise permission/migration/persistence, real pipeline and
  integration behavior at mocked browser/ML boundaries, model-wrapper cleanup,
  temporal gestures, bridge commands/BFCache, and build failure recovery.

## Automated verification

Last run on October 21, 2026, macOS ARM64, Node 26.9.0 / npm 11.19.1.
Typecheck and tests were each run with a five-minute timeout:

- `npm run typecheck` — passed.
- `npm test` — **193 passed, 0 failed, 0 skipped**.
- `npm run build` — passed.
- `npm run check` is the convenience sequence: typecheck, build, tests. The
  individual commands above were executed against the current code/package.
- `python3 scripts/generate-artwork.py --check` — all eight PNGs matched.
- `git diff --check` — passed.
- No lint command is configured in `package.json`.

### Trusted Types regression

The existing browser smoke accepts `VEYL_TRUSTED_TYPES=1`, adds
`require-trusted-types-for 'script'` to its local fixture, and exercises the
real bundled MediaPipe loader plus both real local models. This is the focused
regression command:

```sh
BROWSER_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" VEYL_TRUSTED_TYPES=1 npm run test:browser
```

On October 21, 2026 this passed with Brave 155.1.97.59 / Chromium
`Chrome/155.0.8059.85`, both real local models ready, hand inference offloaded to
the worker, processed loopback output, sender restoration, and zero microphone
requests.

### Real browser smoke (synthetic only)

Executed against the fresh `dist/` package with an isolated temporary profile:

```sh
BROWSER_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm run test:browser
```

`TMPDIR` was set to the environment's approved scratch directory for this run.
Brave 155.1.97.59 reported Chromium `Chrome/155.0.8059.85`. Results:

- Unpacked extension identity: **Veyl — Live Camera Effects**.
- Browser accepted explicit-port script registration.
- Both real bundled MediaPipe models ready.
- Hand inference was offloaded to the worker with no offload error; observed
  hand inference was approximately 86 ms without the strict Trusted Types
  fixture and 92 ms with it.
- Local receiving peer decoded replacement plate `[186, 34, 70, 255]` for target
  `[192, 32, 64]` within the test's compression tolerance.
- Reappearance restored current live imagery.
- Disablement restored the original sender track and ended the processed track.
- Microphone requests: **0**; camera input was browser-generated synthetic video.

### Standalone real hand inference lab

The following command used the actual bundled `HandLandmarker` and local WASM
under the strict Trusted Types fixture:

```sh
HAND_IMAGE="assets/promotional/veyl-room.svg" \
BROWSER_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
VEYL_TRUSTED_TYPES=1 npm run test:hand-lab
```

It produced three frames with `handTracked: true` and 21 landmarks. Warm-up was
approximately 4.7 seconds and subsequent samples were approximately 106–110 ms.
The SVG is a deterministic local illustration, not a physical hand or live-site
test, so this confirms real model execution and observable landmarks only.

The fixture directly injects/authorizes the production page bridge. It does not
test popup Chrome permission prompts or the real content-script/worker activation
path end-to-end, nor a Meet/OmeTV call, physical snap accuracy, or person-mask
quality. Reported FPS is incidental headless telemetry, not a performance benchmark.

The generated `dist/` package contains:

- `manifest.json`
- `content.js`
- `page-bridge.js`
- `hand-gesture-worker.js`
- `background.js`
- `popup.html`, `popup.js`, `popup.css`
- `icons/veyl-16.png`, `veyl-32.png`, `veyl-48.png`, `veyl-128.png`
- `models/selfie_segmenter.tflite`
- `models/hand_landmarker.task`
- `models/models.json`
- `licenses/NOTICE.md`, `licenses/Apache-2.0.txt`
- MediaPipe `wasm/` assets

## Manual verification still required

Google Chrome is not installed here. The isolated Brave synthetic test above is
available, but no real Meet/OmeTV call or physical camera/gesture test was made.
Do not claim these manual Chrome checks are complete:

### Google Meet regression gate

1. Load `dist/` at `chrome://extensions` and confirm the displayed name is
   **Veyl — Live Camera Effects**.
2. Reload Meet after extension reload so the early built-in bridge is present.
3. Verify normal camera and microphone behavior with Veyl globally disabled.
4. Enable Veyl, turn on the camera, and confirm the remote participant sees
   the processed track, not merely a local canvas.
5. Capture a clean plate, disappear, reappear, switch cameras, turn the
   camera off/on, leave/rejoin, reload the tab, and reload the extension.
6. Enable camera gesture detection and confirm no microphone permission prompt
   occurs; test thumb–middle contact/quick inward curl, held gestures, cooldown,
   low light, occlusion, and hand distance.

### OmeTV priority test

The official page loader and application bundle were inspected during this
change. They showed a top-page permission probe, selected-device camera
reacquisition, local preview, and `addTrack`/`replaceTrack` transmission. The
shared integration was hardened for these flows, rather than adding an
unevidenced site-specific adapter or any virtual-camera protection bypass.
Recorded source URLs and test steps are in `README.md`. Static investigation is
not evidence of remote-call success.

1. Enable the exact OmeTV origin from the popup and approve permission.
2. Reload OmeTV before its camera starts.
3. Verify Veyl’s processed route reaches the actual remote connection using a
   second account/device.
4. Test background capture, disappearance, reappearance, camera switching,
   permission denial, navigation, and global/site disablement.
5. If only a local preview changes, mark OmeTV as incompatible rather than
   claiming support.

### Other compatible websites

- Test exact-origin enablement and no injection before enablement.
- Test sites that use `getUserMedia` plus `addTrack`, `addTransceiver`, or
  `replaceTrack`.
- Test sites that use a preview without WebRTC and report the limitation.
- Confirm embedded camera frames remain unmodified: injection is top-frame-only,
  even if the embedded origin has a separately enabled profile.
- Test permission removal, dynamic-script removal, page navigation, BFCache,
  extension reload, and camera teardown.

## Known limitations and next work

- A visual contact/inward-curl sequence is a heuristic approximation of a snap; a
  camera cannot verify the snap sound without microphone input, which Veyl
  deliberately does not request.
- Hand-landmarker and person-segmentation quality, frame rate, and GPU
  behavior need real Chrome validation on Apple Silicon and ordinary laptops.
- The current WebRTC binding registry is substantially safer than the original
  single-track route, but multi-peer/camera-switch behavior needs browser
  coverage on each target site.
- One processed view is shared per tab; simultaneous independent camera views
  and embedded-frame applications are not supported guarantees.
- Page-world hooks share the site’s JavaScript environment and can be altered
  by a host page. Veyl is designed for compatible sites, not hostile-page
  isolation.
- OmeTV and other non-Meet sites are not claimed complete until remote output
  is manually verified.
- Future site-specific adapters should be added only when a target’s actual
  camera/WebRTC behavior demonstrates that the shared route is insufficient.
