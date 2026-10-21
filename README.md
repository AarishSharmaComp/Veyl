# Veyl

**Present, not visible.**

Veyl is a local-first Manifest V3 Chrome extension for live camera effects.
It can process a camera on Google Meet and on other HTTPS or localhost origins
that the user explicitly enables. Its signature effect removes the visible
person from the outgoing camera feed while using a captured background plate
where possible.

Veyl is not a universal guarantee for every camera website. Sites acquire and
transmit media differently. Veyl uses a reusable `getUserMedia`/WebRTC route
for compatible pages, reports whether a known processed track reached a site
sender, and documents the remaining browser-level verification honestly.

## Features

- User-selected website access with exact-origin optional permissions.
- Google Meet remains a built-in integration.
- Dynamic content-script registration for enabled non-Meet sites.
- Local MediaPipe person segmentation with GPU-first/CPU fallback.
- Clean background capture, local preview, recapture, deletion, and mismatch
  warnings.
- Canvas compositing and a processed `CanvasCaptureMediaStreamTrack`.
- Disappearance and reappearance transitions with optional particles and
  shockwave effects.
- Keyboard shortcut: `Ctrl`/`⌘` + `Shift` + `X`.
- Camera-based visual hand gesture trigger using local MediaPipe Hand Landmarker
  inference, with transferable `ImageBitmap` worker offload when the host page
  permits it. Veyl does **not** request microphone access for this feature.
- Dark, compact Veyl popup with site management and camera status.
- No camera-frame, mask, hand-landmark, background, or audio uploads.

## Current compatibility status

| Website type | Integration | Verification status |
| --- | --- | --- |
| Google Meet | Built-in static early injection, `getUserMedia`, WebRTC sender hooks | Shared route has unit/integration and synthetic browser coverage; actual Meet call remains a manual regression gate |
| OmeTV | User-enabled dynamic origin injection using the shared route | Official application code inspected for camera probes, reacquisition, and WebRTC; actual remote output not yet verified |
| Other HTTPS WebRTC sites | User-enabled dynamic origin injection | Depends on the site’s camera and sender flow |
| Localhost development pages | Supported for `http://localhost` and `http://127.0.0.1` | Synthetic Chromium WebRTC loopback passed with real bundled models; fixture injects/authorizes its bridge directly |
| Cross-origin iframe camera apps | Unsupported embedded-frame path | Injection is top-frame-only; separately enabling the iframe origin does not enable processing inside an existing embedded frame |
| WebCodecs/custom non-WebRTC pipelines | Not guaranteed | Veyl reports that its sender route was not verified rather than claiming success |

## Build requirements

- Chrome 111 or newer, as declared by the manifest. Browser smoke was run with
  Brave's Chromium 155 engine; the minimum Chrome version was not separately tested.
- Node.js with `--experimental-strip-types` support and npm. Node **26.9.0** and
  npm **11.19.1** were verified here. The optional browser smoke also needs Node's
  built-in `fetch` and `WebSocket` APIs.
- macOS Apple Silicon, Windows, or Linux capable of running Chrome and Node.
- A local checkout of this repository. Do not copy `node_modules` between
  operating systems.

## Install and build

From the repository root:

```sh
npm ci
npm run check
```

`check` runs typecheck, build, then tests, so packaging tests inspect the current
output. The build prepares and validates a unique staging directory before
publishing `dist/`. Staged renames retain the previous output for rollback; this
is not an atomic filesystem exchange. If publication and rollback both fail,
the error identifies the preserved previous output for manual recovery. It includes:

- `manifest.json`
- bundled content, page, hand-worker, service-worker, and popup scripts
- popup HTML/CSS
- Veyl icons at 16, 32, 48, and 128 pixels
- `selfie_segmenter.tflite`
- `hand_landmarker.task`
- MediaPipe WASM files
- model provenance/checksums and third-party license notices

Validation checks model sizes/SHA-256 hashes, all four declared PNG icon sizes,
required scripts/UI/notices, and both SIMD/non-SIMD WASM modules. Missing or
corrupt assets fail the build before publication.

### Trusted Types and the local MediaPipe loader

The locked MediaPipe Tasks Vision bundle uses a dynamic script element to load
its packaged Emscripten WASM loader. The build applies a reproducible local
transform so that this one loader URL passes through Veyl’s adapter instead of
assigning a string directly to `HTMLScriptElement.src`. When the selected page
requires Trusted Types for scripts, the page bridge creates one narrowly scoped
policy for the current `chrome-extension://` origin and the exact packaged
MediaPipe loader paths under `wasm/`. The adapter rejects every other URL and
configuration fails closed with the policy error visible in Veyl status. It
also removes MediaPipe’s upstream identity `goog#html` policy from the bundled
runtime. It does not weaken the host CSP, evaluate fetched code, or load remote
executable code. Hand inference uses a self-contained blob bootstrap to import
the packaged worker from its exact extension URL; the bootstrap applies the same
exact-origin policy to the local MediaPipe WASM loader. If a browser blocks the
worker path, Veyl falls back to the local main-thread detector and reports the
offload error instead of weakening Trusted Types.

The real browser regression can be run against the existing synthetic WebRTC
smoke fixture with Trusted Types enforcement enabled:

```sh
BROWSER_BIN="/path/to/Chromium" VEYL_TRUSTED_TYPES=1 npm run test:browser
```

Use `VEYL_VERSION` for a Chrome-compatible version override:

```sh
VEYL_VERSION=0.1.1 npm run build
```

## Load Veyl unpacked

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository’s `dist/` directory.
6. Confirm the extension is displayed as **Veyl — Live Camera Effects**.
7. After source changes, rebuild and press **Reload** on the extension card.
8. Reload any enabled website after reloading the extension.

## Enable a website

Veyl requires all three gates:

1. The global Veyl switch is on.
2. Chrome host permission covers the selected origin.
3. That exact-origin Veyl site profile is enabled.

Profiles and dynamic registrations distinguish scheme, host, and port, including
default ports. Chrome manages the underlying host permission; that grant alone
does not enable Veyl on other origins. Settings/backgrounds remain per-site.
Meet starts enabled to preserve the built-in path and legacy settings, but its
profile and the global switch can both pause processing.

To enable the current page:

1. Open an HTTPS camera website, such as Google Meet or OmeTV.
2. Open the Veyl popup.
3. Confirm the displayed current website/origin.
4. Click **Enable on this site**.
5. Approve Chrome’s permission prompt for that exact origin.
6. Reload the website before starting its camera. Reloading ensures Veyl’s
   early `document_start` hooks run before the site caches camera APIs.
7. Turn on the website camera and wait for **Routed** or the equivalent site
   status. **Processing** means a local canvas track exists; it is not proof
   that a remote participant receives it.

To add a different site, enter its HTTPS URL or domain in **Add website**.
Veyl rejects JavaScript URLs, extension URLs, file URLs, credentials, and
unsupported schemes. `http://localhost` and `http://127.0.0.1` are allowed for
development. Veyl does not support wildcard subdomain entries in the popup.

Use **Disable on this site** or the saved profile's **Pause** to deactivate the
current document while retaining its settings/background and unregistering
future dynamic injection. **Remove** also deletes that site's profile/background
and releases its optional permission. Meet's required manifest host access
cannot be removed this way; a disabled tombstone prevents migration re-enabling it.

Deactivation restores observed senders/streams to their original video tracks
before releasing processing resources. If a site rejects restoration, Veyl
reports **Reload**, keeps live passthrough rather than ending a transmitted
canvas track, and turns effects/ML off. Reload to fully detach that retained
route. Permission revocation and global disablement use the same cleanup path.

The global switch suspends Veyl on every enabled website without uninstalling
the extension.

## Use the disappearance effect

1. Turn on the website camera.
2. Keep the camera fixed and move out of frame.
3. Press **Capture background**.
4. Enable **Real-time removal** for a moving person mask.
5. Press **Disappear** or `Ctrl`/`⌘` + `Shift` + `X`.
6. Press the same control again to **Reappear**.

A clean background plate fills scenery physically hidden by the person.
Segmentation alone cannot know what was behind the body. Without a usable
plate, Veyl keeps the video track alive with an explicit degraded live-pixel
fallback instead of claiming perfect reconstruction or producing a black hole.

Camera movement, changed crop/aspect ratio, moving objects, and lighting
changes can produce a background mismatch warning. Recapture the plate after
the camera position changes.

## Camera-based gesture trigger

The optional **Camera snap trigger** uses the existing local camera source
video and a bundled MediaPipe Hand Landmarker model. It watches a short
temporal sequence, not just a static pinch or arbitrary finger separation:

1. Present one hand steadily for multiple frames.
2. Bring the thumb and middle fingertip into contact briefly, away from the palm.
3. Make a quick middle-finger curl inward toward the palm, separating from the
   thumb while the overall hand stays relatively still.
4. A second released frame confirms the motion, then Veyl toggles once and
   enters cooldown. A fresh stable contact is required to rearm.

This is a visual approximation of a finger snap. It does not detect the sound
of a snap. It is deliberately not a static one-frame pose classifier, and it
can still produce false positives or misses in low light, with occlusion,
fast motion, or unusual camera angles.

Distances are normalized by palm size and video aspect ratio; motion uses actual
timestamps. Filters reject sudden appearance, low confidence, malformed data,
landmark gaps, slow opening, thumb-only movement, whole-hand translation/zoom,
and hand-identity changes. These are tested heuristics, not measured claims of
physical snap accuracy across people or cameras.

The controls are:

- **Camera snap trigger** — explicitly opt in or out (off by default).
- **Snap sensitivity** — higher sensitivity allows looser contact and smaller,
  slower inward motion, while still requiring the temporal sequence.
- **Gesture cooldown** — prevents a held or repeated gesture from toggling
  several times.

No microphone permission is requested for this feature. Veyl does not create
an `AudioContext`, analyze microphone samples, or record audio for gestures.
Manual button and keyboard controls remain available if hand tracking fails.
Legacy microphone-trigger consent does not automatically enable this feature.

## Permissions and privacy

Veyl requests:

- `storage` to persist site profiles, sanitized settings, and locally captured
  background plates.
- `scripting` to register content scripts for origins the user enabled.
- `activeTab` to inspect the current popup tab and support user-initiated site
  management.
- Built-in `https://meet.google.com/*` host access.
- Optional exact-origin access under HTTPS, plus localhost development origins,
  only after the user enables a site.

Veyl processes camera frames, person masks, and hand landmarks locally in the
browser. It does not upload camera frames, segmentation masks, hand landmarks,
background images, microphone audio, or analytics. It does not request
microphone access for gesture detection. MediaPipe model and WASM resources
are bundled in the extension and exposed only as static runtime assets needed
by selected pages.

The Veyl service worker serializes site/settings/background writes and manages
registrations; it does not process or record media. Website-owned audio objects
pass through unchanged, and Veyl does not stop them. Disabling releases models
and restores native video where possible; the rejected-restoration exception
above retains only live passthrough until the site releases it or reloads.

The `MAIN` world is shared with the website. A page can interfere with
monkey-patched APIs, so Veyl is intended for compatible cooperative pages, not
hostile-page security boundaries. Unknown video tracks, screen shares, and
unrelated peer connections are passed through unless Veyl can associate a
track with its active camera session.

## Architecture

```text
User enables exact site origin
        |
        v
Optional permission + dynamic document_start registration
        |
        v
Isolated content script <-> MAIN-world page bridge
        |
        +--> getUserMedia camera stream
        |        |
        |        +--> hidden source video
        |        +--> MediaPipe person mask
        |        +--> MediaPipe hand landmarks / gesture state machine
        |        |        \--> local ImageBitmap worker when available
        |        +--> background plate + compositor
        |                       |
        |                       v
        |                 canvas.captureStream()
        |                       |
        |                       v
        |                 site WebRTC sender
```

Google Meet remains statically injected at `document_start`. Other origins get
dynamic scripts only after authorization. An injected page gets a minimal
synchronous API prehook to avoid late races with sites caching native methods.
It does **not** acquire a camera or load models. Native camera acquisition starts
normally; video requests wait at most 1500 ms for verified policy and otherwise
return the native stream. Global/profile/permission state is verified even for
Meet; there is no unconditional processing bootstrap.

One compositor/canvas capture source is shared by per-consumer output clones in
each tab. Temporary camera probes, repeated acquisitions, and native stream
clones have leases so stopping one consumer does not terminate another. Camera
switches reuse singleton models. Unused tasks close, pending construction is
cancelled safely, and the compositor/segmentation wrapper reuse mask buffers.
Multiple simultaneous independent effect views/cameras are not supported.

The isolated bridge uses session-bound request/results and heartbeats, with a
bounded authorization lease in the page world. Page teardown/BFCache navigation,
permission changes, and extension disconnection trigger deactivation. This is
compatible-page coordination, not protection from a hostile MAIN-world script.

## Branding assets

- Runtime icons: `public/icons/veyl-16.png`, `veyl-32.png`, `veyl-48.png`, and
  `veyl-128.png`.
- Vector master: `assets/brand/veyl-mark.svg`.
- Original outlined lettering: `assets/brand/veyl-wordmark.svg`.
- Promotional/cover artwork: `assets/promotional/veyl-cover.svg` and
  `assets/promotional/veyl-cover.png` (1600×900).
- Separate store uploads: `assets/promotional/uploads/veyl-cws-tile.png`
  (440×280) and `veyl-cws-marquee.png` (1400×560).

The icons are referenced by the Manifest V3 `icons` and `action.default_icon`
fields. The cover artwork is source material for documentation or a Chrome Web
Store listing; Chrome Web Store promotional uploads are handled separately
from the extension manifest and are not invented as a manifest field.
See [brand asset instructions](docs/BRAND_ASSETS.md) for SVG sources, the
deterministic Pillow generator/check, fonts, and the distinction between
promotional illustrations and actual product screenshots.

Model provenance is recorded in `public/models/models.json`; runtime notices
are in `public/licenses/`. Both are copied into `dist/`.

## Testing

Run the configured checks:

```sh
npm run typecheck
npm run build
npm test
```

`npm run check` runs those three in that order. Behavioral tests cover:

- exact-origin authorization, migration, revoked permissions, disabled Meet,
  per-site plate isolation, and serialized multi-tab writes;
- real pipeline/integration behavior with native browser/ML boundaries mocked:
  probe/reacquire, output/stream clones, audio identity, camera switching,
  aggregate senders, rejected/in-flight replacements, restoration, teardown;
- real model-wrapper cancellation, late GPU/CPU tasks, reusable mask storage,
  malformed masks, and cleanup after errors;
- temporal gesture positives/false-positive boundaries and actual pipeline
  effect activation;
- Trusted Types loader transformation, exact URL policy boundaries, worker URL
  branding, and hand-detector lifecycle cleanup;
- bridge command failures, origin/session rejection, repeated injection/BFCache;
- build rollback and missing/corrupt model/icon/WASM/license assets.

Node mocks do not prove a particular site's actual camera or remote output.

### Standalone real MediaPipe hand lab

The hand lab runs the real bundled `HandLandmarker` and local WASM in a
disposable browser profile. It is useful for proving model initialization,
observable landmarks, and timing without involving a live site:

```sh
HAND_IMAGE="assets/promotional/veyl-room.svg" \
BROWSER_BIN="/absolute/path/to/chromium" \
VEYL_TRUSTED_TYPES=1 npm run test:hand-lab
```

The lab input must be treated as test evidence only. An illustration or local
image does not prove physical-camera snap accuracy or live Meet/OmeTV output.

### Optional real-browser synthetic smoke

Build first, then provide an absolute browser executable path:

```sh
npm run build
BROWSER_BIN="/absolute/path/to/chromium" npm run test:browser
```

The executable must support unpacked-extension loading. The verified macOS
executable was `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
(Brave 155.1.97.59 / Chromium 155.0.8059.85). Adapt environment-variable syntax
for your shell on Windows. No Puppeteer/Playwright dependency is required.

The runner uses a disposable browser profile, synthetic camera, no microphone,
a loopback HTTP fixture and real local WebRTC peers. It verifies the loaded
extension identity, explicit-port registration acceptance, both bundled models
ready, hand inference (including worker offload when available), a replacement
plate decoded by the receiving peer, reappearance, and native sender restoration.
It leaves personal browser profiles untouched.

**Boundary:** the fixture directly injects/authorizes the production page
bridge. It does not automate popup permission prompts or the actual isolated
content-script/worker activation path. It is not a Meet/OmeTV call, physical
snap-accuracy test, person-mask-quality test, or performance benchmark.

## Manual Google Meet test

Use a second Meet participant or a second device watching the call:

1. Load `dist/` unpacked and reload Meet.
2. Confirm the camera works normally with Veyl disabled.
3. Turn the global switch and Meet profile back on, reload if needed, then
   turn the Meet camera on and verify the popup reports a processed route.
4. Confirm the remote participant sees the camera feed, not only a local
   canvas preview.
5. Capture an empty-room background and test disappearance/reappearance.
6. Enable the camera gesture trigger and verify no microphone permission
   prompt appears.
7. Test thumb–middle contact plus quick inward curl, static holds, cooldown, both hands,
   partial occlusion, low light, and different distances.
8. Turn the camera off and on, switch cameras, leave/rejoin, reload the tab,
   and reload the extension.
9. Confirm the normal microphone remains usable throughout.

Do not claim remote output or visual segmentation quality is verified unless
this Chrome test was actually performed.

## Manual OmeTV test

During this change, the official page loader
`https://ome.tv/js/home.601121bf.js` and its application bundle
`https://cdn.ome.tv/scripts/main.js?t=1791884202505` were inspected. The observed
top-page application uses `navigator.mediaDevices.getUserMedia`, an initial
audio/video permission probe, selected-device reacquisition, a local preview,
and `addTrack`/`replaceTrack` transmission paths. Those findings informed the
shared track-lease integration; no speculative DOM adapter or virtual-camera
protection bypass was added. Website-requested audio remains the website's own
track, not a Veyl gesture input.

This is source inspection, **not a verified live call**. OmeTV's flow can change:

1. Open OmeTV in Chrome.
2. Enable the exact OmeTV origin in the Veyl popup and approve permission.
3. Reload OmeTV before allowing its camera.
4. Start the camera and verify Veyl reports **Routed** only after its known
   processed track reaches a sender.
5. Use a second account/device to confirm the remote partner sees the effect.
6. Test background capture, disappearance, reappearance, gesture trigger,
   camera-off, permission denial, and page navigation.
7. If OmeTV’s remote output stays original while a local preview changes,
   report it as incompatible rather than treating the site as supported.

## Testing another compatible site

Enable only the site’s exact origin, reload it, and check:

- normal camera behavior before and after Veyl;
- whether the site calls `getUserMedia` after Veyl’s bridge loads;
- whether it uses `RTCPeerConnection.addTrack`, `addTransceiver`, or
  `RTCRtpSender.replaceTrack`;
- whether the processed track reaches the remote connection;
- camera switching, camera-off, navigation, and teardown;
- unrelated screen-share and remote tracks remain untouched.

If a site uses a cached API reference, WebCodecs, a cross-origin iframe, or a
custom non-WebRTC pipeline, Veyl may require a site-specific adapter in a
future change. The current build deliberately avoids injecting into every
frame or every website.

## Troubleshooting

- **The site is locked:** open the popup on the exact HTTPS origin and click
  **Enable on this site**. Veyl will not process an unenabled page.
- **The site says Reload:** reload the page after enabling or after reloading
  the extension so the early hook runs before camera initialization.
- **Status says Processing but not Routed:** a local canvas exists, but Veyl
  has not observed its processed track attached to the site sender. Verify the
  remote participant and inspect the page console.
- **Google Meet no longer connects:** reload the Meet tab after reloading the
  extension, then turn the camera off and on once.
- **The gesture does not trigger:** enable the camera gesture control, show a
  single steady hand, touch thumb to middle fingertip, curl the middle finger
  quickly toward the palm, adjust sensitivity, and wait
  for the cooldown. Manual controls still work.
- **No microphone prompt appears:** this is expected. Camera gesture detection
  intentionally does not use microphone access.
- **The segmentation model fails:** Veyl can still use a captured plate. Check
  `dist/models/selfie_segmenter.tflite`, `dist/models/hand_landmarker.task`,
  and `dist/wasm/`, then rebuild and reload the extension/page.
- **The plate is shifted:** keep the camera fixed and recapture the empty room.
- **Build reports a platform-mismatched esbuild binary:** remove only the
  copied `node_modules/` directory and run `npm ci` on the current platform.
  Keep `package-lock.json`.

## Known limitations

- A camera-based visual gesture cannot hear or verify the sound of a physical
  finger snap; it uses a temporal contact/inward-curl heuristic as a local approximation.
- Person segmentation cannot reconstruct scenery that the person blocks
  without a suitable background plate.
- Sites may cache camera APIs, use custom media pipelines, or run camera code
  inside a cross-origin iframe.
- Chrome’s page-world integration can be interfered with by the host page.
- Processing is top-frame-only and one active processed view per tab. Multiple
  independent camera views and embedded-frame apps are not guaranteed.
- The synthetic browser runner covers a controlled local route only. Real
  Google Meet/OmeTV calls, Chrome UI permissions, physical gestures, segmentation
  quality, and remote-participant evidence remain manual gates.
