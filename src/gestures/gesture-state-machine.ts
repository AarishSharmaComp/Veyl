export interface GestureLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface GestureSample {
  timestamp: number;
  landmarks: GestureLandmark[];
  confidence: number;
  handedness?: 'Left' | 'Right';
  /** Image width / height. Omit for square-coordinate input. */
  frameAspectRatio?: number;
}

export type GestureState = 'idle' | 'pinched' | 'cooldown';

export interface GestureUpdate {
  state: GestureState;
  handTracked: boolean;
  candidate: boolean;
  confirmed: boolean;
  pinchDistance: number | null;
  releaseVelocity: number;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const PINKY_MCP = 17;
const PALM_ANCHORS = [WRIST, INDEX_MCP, MIDDLE_MCP, 13, PINKY_MCP];

// Tunable visual heuristics, not a physical/sound snap classifier. Distances are
// palm lengths, speeds are palm lengths/second, and durations are milliseconds.
// The release window includes a second observation at the caller's ~10 Hz rate.
const HEURISTIC = {
  confidence: 0.65,
  minPalmScale: 0.025,
  minContactRadius: 0.65,
  maxTipRadius: 3,
  stableFrames: 3,
  stableMs: 80,
  contactFrames: 3,
  contactMs: 80,
  maxContactMs: 1000,
  maxFrameGapMs: 220,
  releaseMs: 260,
  confirmationFrames: 2,
  confirmationMs: 24,
  maxWristStep: 0.14,
  maxWristDrift: 0.24,
  maxScaleStep: 0.10,
  maxScaleDrift: 0.15,
  maxPalmStep: 0.14,
  maxPalmDrift: 0.22,
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

export class FingerGestureStateMachine {
  private previous: HandFeatures | null = null;
  private appearance: { reference: HandFeatures; since: number; frames: number } | null = null;
  private contact: Contact | null = null;
  private release: { evidenceAt: number | null; frames: number } | null = null;
  private needsOpen = false;
  private cooldownRemainingMs = 0;
  private lastTimestamp: number | null = null;

  update(sample: GestureSample | null, sensitivity: number, cooldownMs: number): GestureUpdate {
    if (!sample || !Number.isFinite(sample.timestamp) || sample.timestamp < 0) {
      this.forgetHand();
      return this.result(null);
    }

    const timestamp = sample.timestamp;
    const elapsed = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
    if (this.lastTimestamp !== null && elapsed <= 0) {
      // Reject duplicates/out-of-order frames without rewinding the clock (and
      // accidentally spending cooldown twice). reset() explicitly rebases it.
      this.forgetHand();
      return this.result(null);
    }
    this.lastTimestamp = timestamp;
    this.cooldownRemainingMs = Math.max(0, this.cooldownRemainingMs - elapsed);
    if (elapsed > HEURISTIC.maxFrameGapMs) this.forgetHand();

    const features = handFeatures(sample);
    if (!features || this.cooldownRemainingMs > 0) {
      this.forgetHand();
      return this.result(features);
    }

    if (this.previous && this.appearance && (
      !stableHand(features, this.previous, HEURISTIC.maxWristStep, HEURISTIC.maxScaleStep, HEURISTIC.maxPalmStep)
      || !stableHand(features, this.appearance.reference, HEURISTIC.maxWristDrift, HEURISTIC.maxScaleDrift, HEURISTIC.maxPalmDrift)
    )) this.forgetHand();

    if (!this.appearance) this.appearance = { reference: features, since: timestamp, frames: 0 };
    this.appearance.frames += 1;
    const previous = this.previous;
    const releaseVelocity = previous === null || elapsed === 0
      ? 0
      : perSecond(features.pinchDistance - previous.pinchDistance, elapsed);
    this.previous = features;
    const level = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
    const threshold = (range: readonly [number, number]): number => range[0] + (range[1] - range[0]) * level;
    const isContact = features.pinchDistance <= threshold(HEURISTIC.contactDistance)
      && features.middleRadius >= HEURISTIC.minContactRadius;

    if (this.needsOpen) {
      if (features.pinchDistance >= threshold(HEURISTIC.releaseDistance)) this.needsOpen = false;
      return this.result(features, releaseVelocity);
    }
    if (this.contact && !this.release && timestamp - this.contact.startedAt > HEURISTIC.maxContactMs) {
      this.cancelContact(true);
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
    } else if (this.contact?.armed) {
      const contact = this.contact;
      const releaseElapsed = timestamp - contact.lastAt;
      if (isContact || releaseElapsed > HEURISTIC.releaseMs) {
        this.cancelContact(true);
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
      } else {
        this.release.evidenceAt ??= timestamp;
        this.release.frames += 1;
        if (this.release.frames >= HEURISTIC.confirmationFrames
          && timestamp - this.release.evidenceAt >= HEURISTIC.confirmationMs) {
          this.cooldownRemainingMs = Math.max(HEURISTIC.minCooldownMs,
            Number.isFinite(cooldownMs) ? cooldownMs : HEURISTIC.defaultCooldownMs);
          this.forgetHand();
          return this.result(features, releaseVelocity, true);
        }
      }
    } else {
      this.cancelContact(false);
    }
    return this.result(features, releaseVelocity);
  }

  private result(features: HandFeatures | null, releaseVelocity = 0, confirmed = false): GestureUpdate {
    const state = this.currentState;
    return {
      state,
      handTracked: features !== null,
      candidate: state === 'pinched',
      confirmed,
      pinchDistance: features?.pinchDistance ?? null,
      releaseVelocity
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
  }

  /** Camera lifecycle reset: discard motion and rebase timestamps, keep cooldown. */
  reset(): void {
    this.forgetHand();
    this.lastTimestamp = null;
  }

  get currentState(): GestureState {
    if (this.cooldownRemainingMs > 0) return 'cooldown';
    return this.contact?.armed ? 'pinched' : 'idle';
  }
}

function handFeatures(sample: GestureSample): HandFeatures | null {
  const points = sample.landmarks;
  const aspect = sample.frameAspectRatio === undefined ? 1 : sample.frameAspectRatio;
  if (!Number.isFinite(sample.confidence) || sample.confidence < HEURISTIC.confidence || sample.confidence > 1
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
  const middleRadius = Math.hypot(middle.x, middle.y, middle.z);
  const pinchDistance = distance(middle, thumb);
  if (!palm.every(finiteVector) || !finiteVector(middle) || !finiteVector(thumb)
    || !Number.isFinite(pinchDistance) || middleRadius > HEURISTIC.maxTipRadius
    || Math.hypot(thumb.x, thumb.y, thumb.z) > HEURISTIC.maxTipRadius) return null;
  return { wrist, scale, palm, middle, middleRadius, pinchDistance, hasDepth, aspect, handedness: sample.handedness };
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
