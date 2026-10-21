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
- Segmentation remains initialized and available for effect capture when normal
  real-time removal compositing is disabled; this uses the existing singleton
  model and render loop rather than a duplicate inference path.
- The rendering boundary now treats the source camera frame, person mask, live
  removal compositor, disappearance renderer, and captured plate as separate
  products. Normal disabled mode redraws the source frame directly; the mask is
  not applied to that visible path.
- The completed-disappearance ghost was traced to two render-boundary gaps:
  `DisintegrationEffect.renderPixelation()` retained an 8% opacity floor
  (`1 - shatter * 0.92`), and `Compositor.render()` always drew the live source
  before relying on an alpha plate overlay rather than treating the terminal
  disappeared state as plate-authoritative. The terminal branch now skips the
  source draw, clears the output, and draws the captured plate as the entire
  normal-mode frame. Transition buffers are reset when terminal frames are
  observed.
- Segmentation itself is synchronous inside the camera render pass; there is no
  asynchronous segmentation callback that can overwrite the disappearance
  state. The background-mismatch promise can update status asynchronously, but
  normal-mode disappearance still uses the captured plate and does not fall
  back to a blurred camera layer.
- The architectural bug was an implicit compositor boundary: the effect path
  reused mask-scoped plate rendering without an explicit normal-mode passthrough
  and stable full-plate branch. Runtime removal changes could therefore leave a
  mask/composited frame in the output state. The pipeline now cancels active
  effect state when removal is turned off, keeps segmentation alive, and resumes
  live compositing only when the setting is turned back on.

### Camera-based gesture trigger

- Removed the active microphone-based detector and its audio resource path.
- Added a locally bundled MediaPipe `HandLandmarker` model.
- Added GPU-first/CPU fallback hand-landmarker initialization.
- Added a temporal thumb–middle contact then quick inward-curl state machine:
  stable appearance/contact, timestamp-based palm/aspect-normalized motion,
  multi-frame release confirmation, hand-loss handling, and cooldown.
- Added normalized folded-finger scoring for a closed-fist gesture with stable
  dwell, one-shot latching, cooldown suppression, and explicit open-hand rearm.
  Snap and fist confirmations share the same `toggleEffect()` path and emit
  gesture-kind diagnostics without requesting microphone access.
- Filters reject static/slow releases, thumb-only motion, waves, translation,
  camera approach/scale changes, identity jumps, gaps, and malformed landmarks.
- Singleton model construction is cancellation-safe across WASM resolution and
  late GPU/CPU creation; buffers are reused and masks are released after reading.
- Hand inference treats MediaPipe handedness as identity metadata rather than
  presence confidence, clears stale temporal evidence on repeated/reordered
  timestamps, and keeps hand failures separate from usable person segmentation.
- Hand inference is scheduled independently of segmentation on its own adaptive
  cadence and reports `handInferenceMs`, `handInferenceOffloaded`, and
  `handInferenceOffloadError` diagnostics.
- The render loop no longer waits for a worker hand result before drawing the
  next camera frame. One request is in flight at a time, actual completion
  timestamps produce an effective frequency diagnostic, and a one-time worker
  warm-up timeout is separate from the steady-state timeout.
- The gesture state machine now exposes local rejection/measurement diagnostics,
  arms on the second contact frame only after the minimum stable time, tolerates
  one bounded missing-hand frame after contact, and requires fresh valid release
  evidence before confirmation. Diagnostics include fist-fold score and the
  current gesture state.
- Added `hand-gesture-worker.js`, which transfers local `ImageBitmap` frames to a
  detector worker. A blob bootstrap imports only the packaged extension worker
  and exact local WASM paths, including under enforced Trusted Types; blocked
  workers fail closed to the main-thread detector.
- A post-initialization worker crash or timeout rejects pending inference and
  switches to the existing main-thread detector without stopping the camera or
  microphone path.
- Added popup controls for enablement, sensitivity, cooldown, hand-tracked
  status, and manual fallback controls.
- No microphone permission is requested for gesture detection.

### Cinematic disappearance effect

- Added a separate `DisintegrationEffect` renderer behind the existing
  `CameraPipeline`/`Compositor` boundary. It snapshots only the valid person-mask
  region, progressively pixelates it, then disperses hundreds or thousands of
  deterministic small subject tiles through a reusable fragment buffer before
  the existing plate/fallback compositor reaches the stable hidden state.
- Fragment candidates are selected from recent mask coverage and the captured
  subject is alpha-clipped by that same mask for both disappearance and current-
  frame reappearance. Stale or invalid masks are rejected rather than reused.
- In disabled normal mode, a disappearance transition resolves to the captured
  plate instead of a mask-only overlay; reappearance still captures the current
  source frame and returns to live passthrough.
- Late shatter pixelation now reaches zero opacity, and stale terminal animation
  frames clear their offscreen fragment/pixel buffers without drawing to the
  outgoing canvas.
- Reappearance captures the current live frame rather than reusing an old
  disappearance snapshot. Fragments and pixel buffers are cleared on source
  changes, same-size mask/model resets, suspension, and frame recovery.
- `DisappearanceEffect` now has explicit pixelating, shattering, disappeared,
  reappearing, and stable-visible timing states. Duplicate activation is
  debounced; disabling still takes the immediate safe passthrough path.
- Terminal input tracks now end their processed leases instead of leaving a live
  black canvas sender when no valid camera source remains.

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
  temporal gestures, worker lifecycle recovery, mask-scoped visual transitions,
  terminal plate-authoritative disappearance, stale animation-buffer cleanup,
  normal-mode passthrough, runtime removal toggles, bridge commands/BFCache, and
  build failure recovery.

## Automated verification

Last run on October 21, 2026, macOS ARM64, Node 26.9.0 / npm 11.19.1.
Typecheck and tests were each run with a five-minute timeout:

- `npm run typecheck` — passed.
- `npm test` — **219 passed, 0 failed, 0 skipped**.
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
requests. With normal removal compositing disabled, the synthetic fixture
correctly kept segmentation available. Its intentional background mismatch
selected the graceful fallback instead of pretending the red test plate matched
the fake camera scene. Fresh-profile first-inference timing was approximately
6.0 seconds in both final normal and strict runs; this is
warm-up telemetry, not a steady-state benchmark, and it did not block the
processed camera render loop.

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
- Hand inference was offloaded to the worker with no offload error. The final
  normal run reported approximately 5.5 s and the strict run approximately
  5.6 s; fresh-profile warm-up varies, so these are not steady-state
  performance measurements.
- The synthetic fixture reported a background mismatch, so the receiving peer
  decoded a visible graceful fallback (`[81, 251, 36, 255]` normal and
  `[85, 253, 33, 255]` strict) rather than a falsely accepted replacement plate.
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
approximately 4.3 seconds and subsequent samples were approximately 101–114 ms.
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

The user has separately reported a Chrome Google Meet trial in which the prior
Trusted Types error did not reappear and one deliberate finger snap eventually
triggered the disappearance effect. That is useful integration evidence, but it
also demonstrated inconsistent recognition and is not a repeatable accuracy
measurement. The standalone diagnostic lab and repeated Meet trials remain the
calibration path.

Run the independent camera lab with:

```sh
npm run build
BROWSER_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm run test:gesture-lab
```

It uses the production detector on a local page, requests video without audio,
and displays the live reason/measurements. The deterministic production
sequence tests are:

```sh
node --test tests/gesture-state-machine.test.mjs
```

Neither command proves physical snap accuracy without a human following the
manual procedure.

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
   occurs; test thumb–middle contact/quick inward curl, held closed fists with
   open-hand rearm, cooldown, low light, occlusion, and hand distance.

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
- The new mask-scoped pixelation/shatter renderer is covered by deterministic
  timing, mask, lifecycle, and pipeline tests, but its visual quality and
  sustained frame rate still require physical-camera review on the target Meet
  setup.
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
