export interface GestureLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface GestureSample {
  timestamp: number;
  landmarks: GestureLandmark[];
  /** Optional synthetic quality gate. MediaPipe's Tasks Vision result does not expose a separate per-frame presence score. */
  confidence?: number;
  handedness?: 'Left' | 'Right';
  /** Image width / height. Omit for square-coordinate input. */
  frameAspectRatio?: number;
}

export type GestureState = 'idle' | 'pinched' | 'fist' | 'cooldown';
export type GestureKind = 'snap' | 'fist';

export interface GestureUpdate {
  state: GestureState;
  handTracked: boolean;
  candidate: boolean;
  confirmed: boolean;
  confirmedGesture?: GestureKind;
  pinchDistance: number | null;
  releaseVelocity: number;
}

export type GestureDiagnosticPhase = 'idle' | 'stabilizing' | 'contact' | 'release' | 'fist' | 'cooldown';

export interface GestureDiagnostics {
  phase: GestureDiagnosticPhase;
  reason: string;
  pinchDistance: number | null;
  distanceDelta: number | null;
  middleRadius: number | null;
  middleRadiusDelta: number | null;
  releaseVelocity: number;
  sampleGapMs: number | null;
  contactFrames: number;
  releaseFrames: number;
  cooldownRemainingMs: number;
  landmarksUsable: boolean;
  trackingQuality: 'model-thresholded' | 'missing' | 'invalid';
  fistScore: number | null;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;
const PALM_ANCHORS = [WRIST, INDEX_MCP, MIDDLE_MCP, 13, PINKY_MCP];

// Tunable visual heuristics, not a physical/sound snap classifier. Distances are
// palm lengths, speeds are palm lengths/second, and durations are milliseconds.
// The minimum stable/contact time is deliberately separate from the frame count:
// this lets a ~10 Hz camera arm on its second valid contact frame without making
// a single noisy frame sufficient.
const HEURISTIC = {
  minPalmScale: 0.025,
  minContactRadius: 0.65,
  maxTipRadius: 3,
  stableFrames: 3,
  stableMs: 80,
  contactFrames: 2,
  contactMs: 80,
  maxContactMs: 1000,
  maxFrameGapMs: 300,
  releaseMs: 320,
  confirmationFrames: 2,
  confirmationMs: 24,
  maxWristStep: 0.14,
  maxWristDrift: 0.24,
  maxScaleStep: 0.10,
  maxScaleDrift: 0.15,
  maxPalmStep: 0.14,
  maxPalmDrift: 0.22,
  fistFrames: 3,
  fistMs: 120,
  fistOpenFrames: 2,
  // [low sensitivity, high sensitivity]: higher sensitivity accepts a
  // slightly less completely folded hand, but still requires all four long
  // fingers to contribute to the normalized score.
  fistScore: [0.68, 0.58],
  fistReleaseScore: [0.44, 0.34],
  minInwardFraction: 0.65,
  maxCurlRebound: 0.08,
  minCooldownMs: 450,
  defaultCooldownMs: 1100,
  // [low sensitivity, high sensitivity]: higher sensitivity is always easier.
  contactDistance: [0.22, 0.36],
  releaseDistance: [0.60, 0.46],
  separationGain: [0.30, 0.20],
  curlDistance: [0.34, 0.22],
  inwardSpeed: [3.2, 1.8]
} as const;

interface Vector {
  x: number;
  y: number;
  z: number;
}

interface HandFeatures {
  wrist: Vector;
  scale: number;
  palm: Vector[];
  middle: Vector;
  middleRadius: number;
  pinchDistance: number;
  fistScore: number;
  hasDepth: boolean;
  aspect: number;
  handedness: GestureSample['handedness'];
}

interface Contact {
  startedAt: number;
  frames: number;
  last: HandFeatures;
  lastAt: number;
  armed: boolean;
}

interface FistContact {
  startedAt: number;
  frames: number;
}

export class FingerGestureStateMachine {
  private previous: HandFeatures | null = null;
  private appearance: { reference: HandFeatures; since: number; frames: number } | null = null;
  private contact: Contact | null = null;
  private release: { evidenceAt: number | null; frames: number } | null = null;
  private fist: FistContact | null = null;
  private fistLatched = false;
  private fistOpenFrames = 0;
  private needsOpen = false;
  private cooldownRemainingMs = 0;
  private lastTimestamp: number | null = null;
  private missingFrames = 0;
  private diagnostic: GestureDiagnostics = {
    phase: 'idle',
    reason: 'waiting-for-hand',
    pinchDistance: null,
    distanceDelta: null,
    middleRadius: null,
    middleRadiusDelta: null,
    releaseVelocity: 0,
    sampleGapMs: null,
    contactFrames: 0,
    releaseFrames: 0,
    cooldownRemainingMs: 0,
    landmarksUsable: false,
    trackingQuality: 'missing',
    fistScore: null
  };

  update(sample: GestureSample | null, sensitivity: number, cooldownMs: number): GestureUpdate {
    if (!sample || !Number.isFinite(sample.timestamp) || sample.timestamp < 0) {
      this.forgetHand();
      this.setDiagnostic({
        phase: this.cooldownRemainingMs > 0 ? 'cooldown' : 'idle',
        reason: 'missing-or-invalid-timestamp',
        landmarksUsable: false,
        trackingQuality: 'invalid',
        sampleGapMs: null
      });
      return this.result(null);
    }

    const timestamp = sample.timestamp;
    const elapsed = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
    if (this.lastTimestamp !== null && elapsed <= 0) {
      // Reject duplicates/out-of-order frames without rewinding the clock (and
      // accidentally spending cooldown twice). reset() explicitly rebases it.
      this.forgetHand();
      this.setDiagnostic({
        phase: this.cooldownRemainingMs > 0 ? 'cooldown' : 'idle',
        reason: 'out-of-order-frame',
        landmarksUsable: false,
        trackingQuality: 'invalid',
        sampleGapMs: elapsed
      });
      return this.result(null);
    }
    this.lastTimestamp = timestamp;
    this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - elapsed);
    if (elapsed > HEURISTIC.maxFrameGapMs) {
      this.forgetHand();
      this.setDiagnostic({
        phase: 'stabilizing',
        reason: 'frame-gap-reset',
        landmarksUsable: false,
        trackingQuality: 'missing',
        sampleGapMs: elapsed
      });
    }

    const features = handFeatures(sample);
    if (this.cooldownRemainingMs > 0) {
      this.updateFistLatch(features, sensitivity);
      this.forgetHand();
      this.setDiagnostic({
        phase: 'cooldown',
        reason: 'cooldown-active',
        landmarksUsable: features !== null,
        trackingQuality: features ? 'model-thresholded' : 'invalid',
        sampleGapMs: elapsed,
        fistScore: features?.fistScore ?? null
      });
      return this.result(features);
    }
    if (!features) {
      return this.handleMissing(timestamp, elapsed, 'invalid-landmarks');
    }

    this.missingFrames = 0;
    return this.processFeatures(features, timestamp, elapsed, sensitivity, cooldownMs);
  }

  /**
   * Advance the temporal clock for a frame where MediaPipe returned no usable
   * hand. One short dropout is retained only after contact has begun; a second
   * dropout or a long gap resets the sequence and cannot confirm a snap.
   */
  updateMissing(timestamp: number): GestureUpdate {
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      this.forgetHand();
      this.setDiagnostic({ phase: 'idle', reason: 'missing-or-invalid-timestamp', landmarksUsable: false, trackingQuality: 'invalid', sampleGapMs: null });
      return this.result(null);
    }
    const elapsed = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
    if (this.lastTimestamp !== null && elapsed <= 0) {
      this.forgetHand();
      this.setDiagnostic({ phase: 'idle', reason: 'out-of-order-frame', landmarksUsable: false, trackingQuality: 'invalid', sampleGapMs: elapsed });
      return this.result(null);
    }
    this.lastTimestamp = timestamp;
    this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - elapsed);
    if (this.cooldownRemainingMs > 0) {
      this.forgetHand();
      this.setDiagnostic({ phase: 'cooldown', reason: 'cooldown-active', landmarksUsable: false, trackingQuality: 'missing', sampleGapMs: elapsed });
      return this.result(null);
    }
    if (this.contact && this.missingFrames === 0 && elapsed <= HEURISTIC.maxFrameGapMs) {
      this.missingFrames = 1;
      this.setDiagnostic({
        phase: this.release ? 'release' : 'contact',
        reason: 'tracking-gap-tolerated',
        landmarksUsable: false,
        trackingQuality: 'missing',
        sampleGapMs: elapsed,
        contactFrames: this.contact.frames,
        releaseFrames: this.release?.frames ?? 0
      });
      return this.result(null);
    }
    this.forgetHand();
    this.setDiagnostic({ phase: 'idle', reason: 'tracking-lost-reset', landmarksUsable: false, trackingQuality: 'missing', sampleGapMs: elapsed });
    return this.result(null);
  }

  private handleMissing(_timestamp: number, elapsed: number, reason: string): GestureUpdate {
    // A malformed landmark set is different from a detector frame with no
    // hand. Do not carry temporal evidence across corrupted coordinates.
    this.forgetHand();
    this.setDiagnostic({ phase: 'idle', reason, landmarksUsable: false, trackingQuality: 'invalid', sampleGapMs: elapsed });
    return this.result(null);
  }

  private processFeatures(features: HandFeatures, timestamp: number, elapsed: number, sensitivity: number, cooldownMs: number): GestureUpdate {

    if (this.previous && this.appearance && (
      !stableHand(features, this.previous, HEURISTIC.maxWristStep, HEURISTIC.maxScaleStep, HEURISTIC.maxPalmStep)
      || !stableHand(features, this.appearance.reference, HEURISTIC.maxWristDrift, HEURISTIC.maxScaleDrift, HEURISTIC.maxPalmDrift)
    )) {
      this.forgetHand();
      this.setDiagnostic({ phase: 'stabilizing', reason: 'hand-motion-reset', landmarksUsable: true, trackingQuality: 'model-thresholded', sampleGapMs: elapsed });
    }

    if (!this.appearance) this.appearance = { reference: features, since: timestamp, frames: 0 };
    this.appearance.frames += 1;
    const previous = this.previous;
    const releaseVelocity = previous === null || elapsed === 0
      ? 0
      : perSecond(features.pinchDistance - previous.pinchDistance, elapsed);
    this.previous = features;
    const level = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
    const threshold = (range: readonly [number, number]): number => range[0] + (range[1] - range[0]) * level;
    this.setDiagnostic({ fistScore: features.fistScore });

    if (this.fistLatched) {
      this.updateFistLatch(features, level);
      this.setDiagnostic({
        phase: 'idle',
        reason: this.fistLatched ? 'waiting-for-open-hand' : 'fist-released',
        landmarksUsable: true,
        trackingQuality: 'model-thresholded',
        sampleGapMs: elapsed,
        fistScore: features.fistScore
      });
      return this.result(features, releaseVelocity);
    }

    const fistThreshold = threshold(HEURISTIC.fistScore);
    const fistReleaseThreshold = threshold(HEURISTIC.fistReleaseScore);
    if (features.fistScore >= fistThreshold || (this.fist && features.fistScore >= fistReleaseThreshold)) {
      return this.processFist(features, timestamp, elapsed, cooldownMs);
    }
    this.fist = null;
    const isContact = features.pinchDistance <= threshold(HEURISTIC.contactDistance)
      && features.middleRadius >= HEURISTIC.minContactRadius;

    if (this.needsOpen) {
      if (features.pinchDistance >= threshold(HEURISTIC.releaseDistance)) {
        this.needsOpen = false;
        this.setDiagnostic({ phase: 'stabilizing', reason: 'fresh-open-hand-required', landmarksUsable: true, trackingQuality: 'model-thresholded', sampleGapMs: elapsed });
      } else {
        this.setDiagnostic({ phase: 'idle', reason: 'waiting-for-open-hand', landmarksUsable: true, trackingQuality: 'model-thresholded', sampleGapMs: elapsed });
      }
      return this.result(features, releaseVelocity);
    }
    if (this.contact && !this.release && timestamp - this.contact.startedAt > HEURISTIC.maxContactMs) {
      this.cancelContact(true);
      this.setDiagnostic({ phase: 'idle', reason: 'contact-held-too-long', landmarksUsable: true, trackingQuality: 'model-thresholded', sampleGapMs: elapsed });
      return this.result(features, releaseVelocity);
    }

    if (isContact && !this.release) {
      if (!this.contact) {
        this.contact = { startedAt: timestamp, frames: 0, last: features, lastAt: timestamp, armed: false };
      }
      this.contact.frames += 1;
      this.contact.last = features;
      this.contact.lastAt = timestamp;
      this.contact.armed = this.contact.frames >= HEURISTIC.contactFrames
        && timestamp - this.contact.startedAt >= HEURISTIC.contactMs
        && this.appearance.frames >= HEURISTIC.stableFrames
        && timestamp - this.appearance.since >= HEURISTIC.stableMs;
      this.setDiagnostic({
        phase: this.contact.armed ? 'contact' : 'stabilizing',
        reason: this.contact.armed ? 'contact-armed' : 'contact-stabilizing',
        landmarksUsable: true,
        trackingQuality: 'model-thresholded',
        sampleGapMs: elapsed,
        contactFrames: this.contact.frames,
        releaseFrames: 0
      });
    } else if (this.contact?.armed) {
      const contact = this.contact;
      const releaseElapsed = timestamp - contact.lastAt;
      if (isContact || releaseElapsed > HEURISTIC.releaseMs) {
        this.cancelContact(true);
        this.setDiagnostic({ phase: 'idle', reason: isContact ? 'contact-reformed' : 'release-window-expired', landmarksUsable: true, trackingQuality: 'model-thresholded', sampleGapMs: elapsed });
        return this.result(features, releaseVelocity);
      }
      if (!this.release) this.release = { evidenceAt: null, frames: 0 };
      const curl = contact.last.middleRadius - features.middleRadius;
      const movement = distance(contact.last.middle, features.middle);
      const released = features.pinchDistance >= threshold(HEURISTIC.releaseDistance)
        && features.pinchDistance - contact.last.pinchDistance >= threshold(HEURISTIC.separationGain)
        && curl >= threshold(HEURISTIC.curlDistance)
        && curl >= movement * HEURISTIC.minInwardFraction;
      // Speed is required at motion onset, not averaged over the confirmation
      // hold. A second frame must retain the curl instead of rebounding.
      const corroborated = this.release.frames === 0
        ? perSecond(curl, releaseElapsed) >= threshold(HEURISTIC.inwardSpeed)
        : previous !== null && features.middleRadius <= previous.middleRadius + HEURISTIC.maxCurlRebound;
      if (!released || !corroborated) {
        this.release = { evidenceAt: null, frames: 0 };
        this.setDiagnostic({
          phase: 'release',
          reason: !released ? 'release-shape-rejected' : 'release-speed-or-rebound-rejected',
          landmarksUsable: true,
          trackingQuality: 'model-thresholded',
          sampleGapMs: elapsed,
          contactFrames: contact.frames,
          releaseFrames: 0,
          middleRadius: features.middleRadius,
          middleRadiusDelta: contact.last.middleRadius - features.middleRadius,
          pinchDistance: features.pinchDistance,
          distanceDelta: features.pinchDistance - contact.last.pinchDistance,
          releaseVelocity: releaseVelocity
        });
      } else {
        this.release.evidenceAt ??= timestamp;
        this.release.frames += 1;
        this.setDiagnostic({
          phase: 'release',
          reason: 'release-confirming',
          landmarksUsable: true,
          trackingQuality: 'model-thresholded',
          sampleGapMs: elapsed,
          contactFrames: contact.frames,
          releaseFrames: this.release.frames,
          middleRadius: features.middleRadius,
          middleRadiusDelta: contact.last.middleRadius - features.middleRadius,
          pinchDistance: features.pinchDistance,
          distanceDelta: features.pinchDistance - contact.last.pinchDistance,
          releaseVelocity: releaseVelocity
        });
        if (this.release.frames >= HEURISTIC.confirmationFrames
          && timestamp - this.release.evidenceAt >= HEURISTIC.confirmationMs) {
          this.cooldownRemainingMs = Math.max(HEURISTIC.minCooldownMs,
            Number.isFinite(cooldownMs) ? cooldownMs : HEURISTIC.defaultCooldownMs);
          this.forgetHand();
          this.setDiagnostic({
            phase: 'cooldown',
            reason: 'confirmed',
            landmarksUsable: true,
            trackingQuality: 'model-thresholded',
            sampleGapMs: elapsed,
            cooldownRemainingMs: this.cooldownRemainingMs,
            releaseVelocity: releaseVelocity
          });
          return this.result(features, releaseVelocity, true, 'snap');
        }
      }
    } else {
      this.cancelContact(false);
      this.setDiagnostic({
        phase: this.appearance.frames >= HEURISTIC.stableFrames ? 'idle' : 'stabilizing',
        reason: isContact ? 'contact-not-yet-armed' : 'hand-stabilizing',
        landmarksUsable: true,
        trackingQuality: 'model-thresholded',
        sampleGapMs: elapsed,
        contactFrames: 0,
        releaseFrames: 0
      });
    }
    return this.result(features, releaseVelocity);
  }

  private processFist(features: HandFeatures, timestamp: number, elapsed: number, cooldownMs: number): GestureUpdate {
    this.cancelContact(false);
    if (!this.fist) this.fist = { startedAt: timestamp, frames: 0 };
    this.fist.frames += 1;
    const armed = this.fist.frames >= HEURISTIC.fistFrames
      && timestamp - this.fist.startedAt >= HEURISTIC.fistMs
      && this.appearance !== null
      && this.appearance.frames >= HEURISTIC.stableFrames
      && timestamp - this.appearance.since >= HEURISTIC.stableMs;
    this.setDiagnostic({
      phase: 'fist',
      reason: armed ? 'fist-armed' : 'fist-stabilizing',
      landmarksUsable: true,
      trackingQuality: 'model-thresholded',
      sampleGapMs: elapsed,
      fistScore: features.fistScore,
      contactFrames: this.fist.frames,
      releaseFrames: 0
    });
    if (armed) {
      this.cooldownRemainingMs = Math.max(HEURISTIC.minCooldownMs,
        Number.isFinite(cooldownMs) ? cooldownMs : HEURISTIC.defaultCooldownMs);
      this.fistLatched = true;
      this.fistOpenFrames = 0;
      this.forgetHand();
      this.setDiagnostic({
        phase: 'cooldown',
        reason: 'confirmed-fist',
        landmarksUsable: true,
        trackingQuality: 'model-thresholded',
        sampleGapMs: elapsed,
        cooldownRemainingMs: this.cooldownRemainingMs,
        fistScore: features.fistScore
      });
      return this.result(features, 0, true, 'fist');
    }
    return this.result(features);
  }

  private updateFistLatch(features: HandFeatures | null, sensitivity: number): void {
    if (!this.fistLatched) return;
    const level = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
    const threshold = HEURISTIC.fistReleaseScore[0]
      + (HEURISTIC.fistReleaseScore[1] - HEURISTIC.fistReleaseScore[0]) * level;
    if (features && features.fistScore <= threshold) this.fistOpenFrames += 1;
    else this.fistOpenFrames = 0;
    if (this.fistOpenFrames >= HEURISTIC.fistOpenFrames) {
      this.fistLatched = false;
      this.fistOpenFrames = 0;
    }
  }

  private result(features: HandFeatures | null, releaseVelocity = 0, confirmed = false, confirmedGesture?: GestureKind): GestureUpdate {
    const state = this.currentState;
    return {
      state,
      handTracked: features !== null,
      candidate: state === 'pinched' || state === 'fist',
      confirmed,
      pinchDistance: features?.pinchDistance ?? null,
      releaseVelocity,
      ...(confirmedGesture ? { confirmedGesture } : {})
    };
  }

  private cancelContact(needsOpen: boolean): void {
    this.contact = null;
    this.release = null;
    this.needsOpen = needsOpen;
  }

  private forgetHand(): void {
    this.previous = null;
    this.appearance = null;
    this.cancelContact(false);
    this.fist = null;
    this.missingFrames = 0;
  }

  /** Camera lifecycle reset: discard motion and rebase timestamps, keep cooldown. */
  reset(): void {
    this.fistLatched = false;
    this.fistOpenFrames = 0;
    this.forgetHand();
    this.lastTimestamp = null;
    this.setDiagnostic({ phase: 'idle', reason: 'camera-reset', landmarksUsable: false, trackingQuality: 'missing', sampleGapMs: null });
  }

  get diagnostics(): GestureDiagnostics {
    return { ...this.diagnostic };
  }

  get currentState(): GestureState {
    if (this.cooldownRemainingMs > 0) return 'cooldown';
    if (this.fist) return 'fist';
    return this.contact?.armed ? 'pinched' : 'idle';
  }

  private setDiagnostic(update: Partial<GestureDiagnostics>): void {
    this.diagnostic = {
      ...this.diagnostic,
      ...update,
      fistScore: update.fistScore !== undefined
        ? update.fistScore
        : update.landmarksUsable === false ? null : this.diagnostic.fistScore,
      contactFrames: update.contactFrames ?? this.contact?.frames ?? 0,
      releaseFrames: update.releaseFrames ?? this.release?.frames ?? 0,
      cooldownRemainingMs: update.cooldownRemainingMs ?? this.cooldownRemainingMs
    };
  }
}

function handFeatures(sample: GestureSample): HandFeatures | null {
  const points = sample.landmarks;
  const aspect = sample.frameAspectRatio === undefined ? 1 : sample.frameAspectRatio;
  if (sample.confidence !== undefined && (!Number.isFinite(sample.confidence) || sample.confidence < 0.65 || sample.confidence > 1)
    || !Array.isArray(points) || !Number.isInteger(points.length) || points.length !== 21
    || !Number.isFinite(aspect) || aspect <= 0
    || (sample.handedness !== undefined && sample.handedness !== 'Left' && sample.handedness !== 'Right')) return null;

  const hasDepth = points[0]?.z !== undefined;
  const vectors: Vector[] = [];
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || (point.z !== undefined) !== hasDepth || (hasDepth && !Number.isFinite(point.z))) return null;
    // MediaPipe x and z use image-width units; y uses image-height units.
    // Depth is relative model output, not calibrated physical distance.
    const vector = { x: point.x * aspect, y: point.y, z: (point.z ?? 0) * aspect };
    if (!finiteVector(vector)) return null;
    vectors.push(vector);
  }
  const wrist = vectors[WRIST];
  const length = distance(wrist, vectors[MIDDLE_MCP]);
  const width = distance(vectors[INDEX_MCP], vectors[PINKY_MCP]);
  const scale = Math.max(length, width);
  if (!Number.isFinite(scale) || scale < HEURISTIC.minPalmScale || Math.min(length, width) < scale * 0.25) return null;
  const center = { x: 0, y: 0, z: 0 };
  for (const index of PALM_ANCHORS) {
    center.x += vectors[index].x / PALM_ANCHORS.length;
    center.y += vectors[index].y / PALM_ANCHORS.length;
    center.z += vectors[index].z / PALM_ANCHORS.length;
  }
  const palm = PALM_ANCHORS.map(index => relative(vectors[index], wrist, scale));
  const middle = relative(vectors[MIDDLE_TIP], center, scale);
  const thumb = relative(vectors[THUMB_TIP], center, scale);
  const fistScore = normalizedFistScore(vectors, center, scale);
  const middleRadius = Math.hypot(middle.x, middle.y, middle.z);
  const pinchDistance = distance(middle, thumb);
  if (!palm.every(finiteVector) || !finiteVector(middle) || !finiteVector(thumb)
    || !Number.isFinite(pinchDistance) || middleRadius > HEURISTIC.maxTipRadius
    || Math.hypot(thumb.x, thumb.y, thumb.z) > HEURISTIC.maxTipRadius) return null;
  return { wrist, scale, palm, middle, middleRadius, pinchDistance, fistScore, hasDepth, aspect, handedness: sample.handedness };
}

function stableHand(current: HandFeatures, reference: HandFeatures, wristLimit: number, scaleLimit: number, palmLimit: number): boolean {
  return current.handedness === reference.handedness && current.hasDepth === reference.hasDepth
    && current.aspect === reference.aspect
    && distance(current.wrist, reference.wrist) / reference.scale <= wristLimit
    && Math.max(current.scale / reference.scale, reference.scale / current.scale) - 1 <= scaleLimit
    && current.palm.every((point, index) => distance(point, reference.palm[index]) <= palmLimit);
}

function relative(point: Vector, origin: Vector, scale: number): Vector {
  return { x: (point.x - origin.x) / scale, y: (point.y - origin.y) / scale, z: (point.z - origin.z) / scale };
}

function normalizedFistScore(points: Vector[], palmCenter: Vector, scale: number): number {
  const fingers = [
    [INDEX_MCP, INDEX_PIP, INDEX_TIP],
    [MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP],
    [RING_MCP, RING_PIP, RING_TIP],
    [PINKY_MCP, PINKY_PIP, PINKY_TIP]
  ] as const;
  const scores = fingers.map(([mcp, pip, tip]) => {
    const path = distance(points[mcp], points[pip]) + distance(points[pip], points[tip]);
    const direct = distance(points[mcp], points[tip]);
    const bend = path > 0 ? (path - direct) / path : 0;
    const palmDistance = distance(points[tip], palmCenter) / Math.max(scale, 1e-6);
    // A folded finger shortens its MCP-to-tip chord and brings its tip back
    // toward the palm. Combining both avoids treating a rotated, extended
    // finger as a fist merely because its 2D projection is foreshortened.
    return clamp((bend - 0.10) / 0.45, 0, 1) * 0.75
      + clamp((0.82 - palmDistance) / 0.46, 0, 1) * 0.25;
  });
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteVector(point: Vector): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function distance(left: Vector, right: Vector): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function perSecond(delta: number, elapsed: number): number {
  const velocity = delta * 1000 / Math.max(1, elapsed);
  return Number.isFinite(velocity) ? velocity : 0;
}
