# Third-party runtime assets

Veyl bundles the unmodified MediaPipe Tasks Vision runtime and WASM from
`@mediapipe/tasks-vision` 0.10.35 (locked by npm). Copyright The MediaPipe
Authors. The upstream runtime is licensed under Apache License 2.0; its terms
are included in `Apache-2.0.txt`. This notice and the complete license are
distributed with the extension, independently of comments in upstream's
prebundled JavaScript. The build also preserves marked legal comments when present.

The two unmodified Google MediaPipe model assets and their versioned official
source URLs, sizes, SHA-256 checksums, and purposes are listed in
`models/models.json`. Models are loaded from this extension, not downloaded
from those URLs at runtime. They provide person masks and hand landmarks, not
an upstream finger-snap classifier.

Upstream project and license:
https://github.com/google-ai-edge/mediapipe
https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE

Veyl's original logo and promotional illustrations are separate original
artwork, not MediaPipe or Google branding. No endorsement is implied.
