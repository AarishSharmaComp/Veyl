# Veyl / Snap

**Present, not visible.**

Veyl is the project name. **Snap** is the current user-facing extension and
effect name from the original product requirements. Snap is a local-first
Manifest V3 Chrome extension for processing a live Google Meet camera feed.

The extension uses a locally bundled MediaPipe person-segmentation model,
Canvas compositing, and a canvas-captured video track. It does not upload
camera frames, background captures, or optional snap-detection audio.

## Current status

The working tree contains the complete implementation slice currently under
development:

- Google Meet-only Manifest V3 integration with an isolated content script and
  a synchronous `MAIN`-world page bridge.
- Local camera processing with a processed `CanvasCaptureMediaStreamTrack`.
- WebRTC `addTrack`, `addTransceiver`, and `replaceTrack` routing hooks that
  provide local evidence that Meet attached the processed track.
- MediaPipe ImageSegmenter with GPU-first and CPU fallback initialization.
- Captured background plates, local persistence, previews, mismatch warnings,
  and a graceful no-plate fallback.
- Optional disintegration particles/shockwave, keyboard toggle, and local
  finger-snap detection with cooldown and cleanup.

The extension has been typechecked and built locally on macOS ARM64. A real
Google Meet call with a remote participant is still a required manual test;
the code cannot honestly claim that remote delivery was verified from this
terminal environment alone.

## Requirements

- macOS Apple Silicon, Windows, or Linux capable of running current Chrome.
- Chrome 111 or newer.
- Node.js and npm for building. The repository uses the committed npm
  lockfile; do not copy `node_modules` between operating systems.

## Install and build

From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build creates `dist/` atomically. It bundles the extension scripts,
copies the popup, local `selfie_segmenter.tflite` model, and MediaPipe WASM
files, and validates the required output files before replacing `dist/`.

For a development version override, use a Chrome-compatible semantic version:

```sh
SNAP_VERSION=0.1.1 npm run build
```

## Load the unpacked extension

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository’s `dist/` directory.
6. Pin the extension if desired.
7. After source changes, rebuild and press **Reload** on the extension card.
8. Reload the Google Meet tab after reloading the extension so the page bridge
   is installed before the next camera request.

## Use in Google Meet

1. Open a meeting at `https://meet.google.com/`.
2. Allow camera permission and turn the camera on.
3. Open the Snap popup and wait for the camera route to show **Routed** or
   **Live**. **Processing** only means that a local canvas track exists; it is
   not proof that a remote participant has received it.
4. For the cleanest effect, move out of frame and press **Capture background**.
   Keep the webcam fixed while using that plate.
5. Enable **Real-time removal** when you want the person mask to follow motion.
6. Press `Ctrl`/`⌘` + `Shift` + `X`, or use **Disappear**.
7. Trigger the same control again to reappear. Reappearance uses the current
   live camera frame rather than a frozen capture.

The background capture should be made while the room is empty. A clean plate
can fill scenery physically hidden by the person; segmentation alone cannot
reconstruct those hidden pixels.

## Permissions and privacy

The extension requests only:

- `storage`: save sanitized settings and the user’s captured background plate
  locally in Chrome extension storage.
- `https://meet.google.com/*`: install the camera integration only on Google
  Meet pages.

Camera processing, segmentation, compositing, and optional snap detection run
  in the browser. No camera frames, masks, background images, microphone
  recordings, analytics, or personal information are uploaded. Snap detection
  is disabled by default. When enabled, Chrome may ask for microphone access;
  the detector analyzes short audio windows locally and does not save them.
  Disabling it stops its microphone tracks and closes its `AudioContext`.

The saved background is a local data URL. Use **Delete** in the popup to
remove it. Chrome’s extension storage and the page’s active media permissions
remain under Chrome’s control.

## Architecture

```text
Google Meet getUserMedia()
        |
        v
MAIN-world page bridge (Meet pages only)
        |
        v
Original camera stream -> hidden video -> MediaPipe mask
                              |                 |
                              +-> compositor <- background plate
                                        |
                                        v
                         canvas.captureStream() video track
                                        |
                                        v
                     Meet WebRTC sender / remote participant
```

The isolated content script owns Chrome extension APIs and popup messaging.
The page bridge owns page-world camera/WebRTC interaction and communicates via
validated `window.postMessage` events. The service worker only handles the
keyboard-command message and does not process media.

The bridge returns the processed stream from the wrapped video
`getUserMedia()` call. It also routes known original camera tracks through
WebRTC `addTrack`, `addTransceiver`, and `RTCRtpSender.replaceTrack` hooks when
Meet uses those paths. The popup reports a local **outbound** state when a
known processed track is attached to a sender. This state is useful
diagnostics, but only a remote-participant test proves end-to-end delivery.

## Modes and limitations

### Captured background plate

This mode is lightweight and works best with a fixed camera, stable lighting,
and an empty-room capture. Camera movement, a changed crop/aspect ratio, moving
objects, or lighting changes can produce a mismatch warning. Recapture the
plate when that happens.

### Real-time person removal

MediaPipe produces a confidence mask at a lower processing resolution. Snap
smooths the mask over time and uses it to replace only likely person pixels.
The captured plate is used where it is available. Without a plate, the
extension uses a visibly degraded live-pixel fallback; it does not pretend to
reconstruct scenery that the camera never saw.

Very fast motion, hair, dark clothing, low light, similarly colored
backgrounds, and multiple people can reduce mask quality. Performance mode
reduces inference frequency on slower machines.

### Camera and microphone lifecycle

The processed video is owned separately from the microphone tracks. The
pipeline clones audio tracks for the returned stream and does not stop Meet’s
active microphone merely because video processing is stopped. Camera switches,
camera-off events, page teardown, and extension reloads still need the manual
checks below because Chrome and Meet can change their internal capture flow.

## Testing

Automated checks currently cover packaging and source invariants that can run
without Chrome. Run:

```sh
npm run typecheck
npm test
npm run build
```

`npm test` uses Node’s built-in test runner. Browser media behavior cannot be
fully proven by Node-only tests.

### Manual test matrix

Perform these checks in Chrome with a second Meet participant or a second
device watching the call:

1. **Normal camera:** camera image works before enabling the effect.
2. **Outbound route:** popup progresses from Processing to Routed/Live, and
   the remote participant sees the same output.
3. **Background capture:** leave frame, capture, preview, recapture, delete,
   reload, and verify local persistence.
4. **Instant disappearance:** use a captured plate and confirm the person is
   replaced by the room rather than a black/transparent hole.
5. **Real-time removal:** move the head, hands, and body while hidden; check
   mask stability and performance mode.
6. **Reappearance:** toggle again and confirm the current pose returns without
   restarting the camera.
7. **Keyboard:** test `Ctrl`/`⌘` + `Shift` + `X` outside text fields.
8. **Snap detection:** opt in, grant microphone access, test sensitivity and
   cooldown, then disable it and confirm the microphone/audio context closes.
9. **Failures:** deny camera/microphone permission, disconnect the camera,
   turn the Meet camera off, switch cameras, reload the tab, and leave/rejoin.
10. **Unrelated site:** open a non-Meet webcam site and confirm Snap does not
    inject or alter its camera stream.
11. **Background mismatch:** move the camera after capture and confirm a
    warning and recapture path.

Do not report a successful Google Meet or remote-participant test unless it
was actually performed in Chrome.

## Troubleshooting

- **Build says esbuild is for another platform:** remove only the generated
  `node_modules/` directory if it was copied from another OS, then run
  `npm ci` from this repository. Do not delete `package-lock.json`.
- **Popup says Meet is not ready:** reload the Meet tab after rebuilding or
  reloading the extension, then turn the camera off and on once.
- **Status stays Processing:** the local canvas exists, but Meet has not yet
  attached the known output track. Check the page console for the bridge and
  WebRTC errors and verify with a remote participant.
- **Segmentation is unavailable:** the extension can still use a captured
  plate. Check that `dist/models/selfie_segmenter.tflite` and `dist/wasm/`
  exist, then reload the extension and Meet tab.
- **The plate looks shifted:** keep the camera fixed, check the mismatch
  warning, and capture a new empty-room plate at the current camera crop.
- **No snap events:** confirm microphone permission, lower or raise
  sensitivity, and avoid testing while speech or keyboard noise is present.

## Known verification gaps

The source contains the real segmentation and media-routing implementation,
but this coding environment cannot operate a Chrome window or join a Meet
call. The following remain manual acceptance evidence rather than completed
automated checks:

- remote participant receives the processed track;
- behavior across Meet camera switching and call teardown;
- Chrome permission prompts and page CSP behavior;
- visual segmentation quality and target frame rate on ordinary laptops;
- unrelated-site camera non-interference.
