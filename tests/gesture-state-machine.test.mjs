import assert from 'node:assert/strict';
import test from 'node:test';
import { FingerGestureStateMachine } from '../src/gestures/gesture-state-machine.ts';

// A synthetic palm in local palm-length units. Only thumb/middle tips move in
// the snap; palm anchors stay fixed. These tests exercise temporal behavior,
// not recognition accuracy on real camera/model output.
const HAND = [
  [0, 0, 0], [-0.6, 0.25, 0], [-0.5, 0.65, -0.03], [-0.15, 1.2, -0.05], [0.12, 1.7, -0.05],
  [-0.45, 0.85, 0], [-0.5, 1.3, -0.02], [-0.52, 1.6, -0.04], [-0.52, 1.87, -0.04],
  [0, 1, 0], [0.02, 1.38, -0.03], [0, 1.58, -0.05], [0, 1.72, -0.05],
  [0.3, 0.88, 0], [0.4, 1.25, -0.04], [0.42, 1.5, -0.04], [0.45, 1.7, -0.04],
  [0.55, 0.7, 0], [0.73, 1.04, -0.01], [0.77, 1.25, -0.03], [0.8, 1.43, -0.02]
];
const RELEASED = [0.03, 0.83, -0.1];
const CURLED = [0.02, 0.76, -0.1];
const SENSITIVITY = 0.62;
const COOLDOWN = 1100;

function sample(timestamp, options = {}) {
  const {
    middle = HAND[12], thumb = HAND[4], scale = 0.16, shift = [0, 0, 0],
    rotation = 0, aspect = 1, depth = true, confidence = 0.95, handedness
  } = options;
  const landmarks = HAND.map((original, index) => {
    const [x, y, z] = index === 12 ? middle : index === 4 ? thumb : original;
    const point = {
      x: (0.5 + (x * Math.cos(rotation) - y * Math.sin(rotation) + shift[0]) * scale) / aspect,
      y: 0.75 - (x * Math.sin(rotation) + y * Math.cos(rotation) + shift[1]) * scale
    };
    if (depth) point.z = (z + shift[2]) * scale / aspect;
    return point;
  });
  return { timestamp, landmarks, confidence, frameAspectRatio: aspect, ...(handedness ? { handedness } : {}) };
}

function contactFrames(start = 0, interval = 40, options = {}) {
  return [0, 1, 2].map(index => sample(start + index * interval, options));
}

function snapFrames(start = 0, interval = 40, options = {}) {
  return [
    ...contactFrames(start, interval, options),
    sample(start + 3 * interval, { ...options, middle: RELEASED }),
    sample(start + 4 * interval, { ...options, middle: CURLED })
  ];
}

function feed(machine, samples, sensitivity = SENSITIVITY, cooldown = COOLDOWN) {
  return samples.map(frame => machine.update(frame, sensitivity, cooldown));
}

function confirmations(updates) {
  return updates.filter(update => update.confirmed).length;
}

function arm(machine, options = {}, sensitivity = SENSITIVITY) {
  const updates = feed(machine, contactFrames(0, 40, options), sensitivity);
  assert.deepEqual(updates.map(update => update.candidate), [false, false, true]);
  assert.equal(confirmations(updates), 0);
}

test('a stable thumb–middle snap toggles once, requires fresh rearming, and obeys cooldown', () => {
  const machine = new FingerGestureStateMachine();
  const first = feed(machine, snapFrames(), SENSITIVITY, 500);
  assert.deepEqual(first.map(update => update.confirmed), [false, false, false, false, true]);
  assert.deepEqual(first.map(update => update.state), ['idle', 'idle', 'pinched', 'pinched', 'cooldown']);
  assert.equal(first[3].releaseVelocity > 0, true);
  assert.equal(first[4].candidate, false);

  const held = feed(machine, [200, 240, 280].map(timestamp => sample(timestamp, { middle: CURLED })), SENSITIVITY, 500);
  const tooSoon = feed(machine, snapFrames(300), SENSITIVITY, 500);
  assert.equal(confirmations([...held, ...tooSoon]), 0);
  assert.equal(tooSoon.every(update => update.state === 'cooldown' && !update.candidate), true);

  const rearmed = feed(machine, snapFrames(660), SENSITIVITY, 500);
  assert.deepEqual(rearmed.map(update => update.confirmed), [false, false, false, false, true]);
  assert.equal(confirmations([...first, ...held, ...tooSoon, ...rearmed]), 2);
});

test('a held released pose does not retrigger even after cooldown expires', () => {
  const machine = new FingerGestureStateMachine();
  const updates = feed(machine, [
    ...snapFrames(),
    ...Array.from({ length: 40 }, (_, index) => sample(200 + index * 40, { middle: CURLED }))
  ]);
  assert.equal(confirmations(updates), 1);
  assert.equal(machine.currentState, 'idle');
});

test('the snap is recognized at the caller’s 10 Hz cadence and with uneven frame intervals', () => {
  for (const timestamps of [[0, 100, 200, 300, 400], [0, 35, 95, 165, 250]]) {
    const machine = new FingerGestureStateMachine();
    const frames = snapFrames().map((frame, index) => ({ ...frame, timestamp: timestamps[index] }));
    assert.equal(confirmations(feed(machine, frames)), 1);
  }
});

test('missing hand cancels armed and partially confirmed releases, then permits a fresh snap', () => {
  for (const duringRelease of [false, true]) {
    const machine = new FingerGestureStateMachine();
    assert.equal(machine.update(null, SENSITIVITY, COOLDOWN).handTracked, false);
    arm(machine);
    if (duringRelease) machine.update(sample(100, { middle: RELEASED }), SENSITIVITY, COOLDOWN);
    const missing = machine.update(null, SENSITIVITY, COOLDOWN);
    assert.deepEqual(missing, {
      state: 'idle', handTracked: false, candidate: false, confirmed: false, pinchDistance: null, releaseVelocity: 0
    });
    assert.equal(confirmations(feed(machine, [sample(140, { middle: RELEASED }), sample(180, { middle: CURLED })])), 0);
    assert.equal(confirmations(feed(machine, snapFrames(220))), 1);
  }
});

test('hand loss and unreliable frames cannot clear or pre-arm a running cooldown', () => {
  const machine = new FingerGestureStateMachine();
  assert.equal(confirmations(feed(machine, snapFrames())), 1);
  for (const frame of [null, sample(200, { confidence: 0.2 }), null, sample(240, { confidence: NaN })]) {
    const update = machine.update(frame, SENSITIVITY, COOLDOWN);
    assert.equal(update.state, 'cooldown');
    assert.equal(update.confirmed, false);
  }
  assert.equal(confirmations(feed(machine, snapFrames(300))), 0);
  // Contact held through the deadline cannot contribute pre-deadline frames.
  const deadline = feed(machine, [1180, 1220, 1260].map(timestamp => sample(timestamp)));
  assert.equal(deadline.every(update => !update.candidate), true);
  assert.equal(confirmations(feed(machine, [sample(1300, { middle: RELEASED }), sample(1340, { middle: CURLED })])), 0);
  assert.equal(confirmations(feed(machine, snapFrames(1400))), 1);
});

const invalidSamples = [
  ['low confidence', frame => { frame.confidence = 0.2; }],
  ['NaN confidence', frame => { frame.confidence = NaN; }],
  ['infinite confidence', frame => { frame.confidence = Infinity; }],
  ['out-of-range confidence', frame => { frame.confidence = 1.1; }],
  ['NaN x on an unused finger', frame => { frame.landmarks[20].x = NaN; }],
  ['infinite y', frame => { frame.landmarks[4].y = Infinity; }],
  ['NaN depth', frame => { frame.landmarks[12].z = NaN; }],
  ['infinite depth', frame => { frame.landmarks[0].z = -Infinity; }],
  ['mixed missing/present depth', frame => { delete frame.landmarks[4].z; }],
  ['short landmark array', frame => { frame.landmarks.pop(); }],
  ['long landmark array', frame => { frame.landmarks.push({ x: 0, y: 0, z: 0 }); }],
  ['sparse landmark array', frame => { delete frame.landmarks[14]; }],
  ['missing landmark array', frame => { delete frame.landmarks; }],
  ['fractional array-like length', frame => { frame.landmarks = { ...frame.landmarks, length: 20.5 }; }],
  ['non-array landmark collection', frame => { frame.landmarks = { ...frame.landmarks, length: 21 }; }],
  ['null landmark', frame => { frame.landmarks[10] = null; }],
  ['non-numeric coordinate', frame => { frame.landmarks[10].x = '0.5'; }],
  ['collapsed palm', frame => { frame.landmarks = frame.landmarks.map(() => ({ x: 0.5, y: 0.5, z: 0 })); }],
  ['too-small palm', frame => { frame.landmarks = sample(120, { scale: 0.001 }).landmarks; }],
  ['NaN timestamp', frame => { frame.timestamp = NaN; }],
  ['infinite timestamp', frame => { frame.timestamp = Infinity; }],
  ['negative timestamp', frame => { frame.timestamp = -1; }],
  ['NaN aspect ratio', frame => { frame.frameAspectRatio = NaN; }],
  ['zero aspect ratio', frame => { frame.frameAspectRatio = 0; }],
  ['infinite aspect ratio', frame => { frame.frameAspectRatio = Infinity; }],
  ['invalid handedness', frame => { frame.handedness = 'unknown'; }]
];

for (const [name, invalidate] of invalidSamples) {
  test(`${name} is rejected without retaining a stale contact`, () => {
    const machine = new FingerGestureStateMachine();
    arm(machine);
    const bad = sample(120, { middle: RELEASED });
    invalidate(bad);
    const update = machine.update(bad, SENSITIVITY, COOLDOWN);
    assert.deepEqual(update, {
      state: 'idle', handTracked: false, candidate: false, confirmed: false, pinchDistance: null, releaseVelocity: 0
    });
    assert.equal(confirmations(feed(machine, [sample(160, { middle: RELEASED }), sample(200, { middle: CURLED })])), 0);
    assert.equal(confirmations(feed(machine, snapFrames(240))), 1);
  });
}

test('single contact glitches, two contact frames, and too-short holds cannot arm', () => {
  const sequences = [
    [sample(0, { middle: RELEASED }), sample(40, { middle: RELEASED }), sample(80)],
    [sample(0), sample(100)],
    [sample(0), sample(10), sample(20), sample(30)]
  ];
  for (const frames of sequences) {
    const machine = new FingerGestureStateMachine();
    const timestamp = frames.at(-1).timestamp;
    const updates = feed(machine, [
      ...frames, sample(timestamp + 40, { middle: RELEASED }), sample(timestamp + 80, { middle: CURLED })
    ]);
    assert.equal(updates.every(update => !update.candidate && !update.confirmed), true);
  }
});

test('one released frame followed by contact is a rejected glitch, not a toggle', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  const updates = feed(machine, [sample(120, { middle: RELEASED }), sample(160), sample(200), sample(240)]);
  assert.equal(confirmations(updates), 0);
  assert.equal(machine.currentState, 'idle');
});

test('release confirmation needs elapsed time as well as a second frame', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  const updates = feed(machine, [
    sample(120, { middle: RELEASED }), sample(121, { middle: CURLED }), sample(150, { middle: CURLED })
  ]);
  assert.deepEqual(updates.map(update => update.confirmed), [false, false, true]);
});

test('static contact expires and requires opening before a new contact can arm', () => {
  const machine = new FingerGestureStateMachine();
  const held = Array.from({ length: 31 }, (_, index) => sample(index * 40));
  assert.equal(confirmations(feed(machine, held)), 0);
  assert.equal(machine.currentState, 'idle');
  assert.equal(confirmations(feed(machine, [sample(1240, { middle: RELEASED }), sample(1280, { middle: CURLED })])), 0);
  assert.equal(confirmations(feed(machine, snapFrames(1320))), 1);
});

test('a static separated hand appearing suddenly cannot trigger', () => {
  const machine = new FingerGestureStateMachine();
  machine.update(null, SENSITIVITY, COOLDOWN);
  const updates = feed(machine, Array.from({ length: 30 }, (_, index) => sample(index * 40, { middle: CURLED })));
  assert.equal(updates.every(update => update.handTracked && !update.candidate && !update.confirmed), true);
});

test('slow middle-finger release times out instead of becoming a snap', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  const updates = feed(machine, [1.55, 1.38, 1.21, 1.04, 0.87, 0.76].map((y, index) =>
    sample(180 + index * 100, { middle: [0, y, -0.05] })));
  assert.equal(confirmations(updates), 0);
  assert.equal(machine.currentState, 'idle');
});

test('a release that only reaches the palm after the deadline is rejected', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  const updates = feed(machine, [
    sample(180, { thumb: [0.8, 1.7, -0.05] }),
    sample(280, { thumb: [0.8, 1.7, -0.05] }),
    sample(380, { middle: RELEASED }), sample(420, { middle: CURLED })
  ]);
  assert.equal(confirmations(updates), 0);
});

test('thumb-only separation and middle movement away from the palm do not trigger', () => {
  const motions = [
    [{ thumb: [0.8, 1.7, -0.05] }, { thumb: [0.9, 1.7, -0.05] }],
    [{ middle: [0, 2.4, -0.05] }, { middle: [0, 2.5, -0.05] }],
    [{ middle: [0.9, 1.2, -0.05] }, { middle: [0.95, 1.2, -0.05] }]
  ];
  for (const [first, second] of motions) {
    const machine = new FingerGestureStateMachine();
    arm(machine);
    assert.equal(confirmations(feed(machine, [sample(120, first), sample(160, second)])), 0);
  }
});

test('pinching and releasing the INDEX finger is not a middle-finger snap', () => {
  const machine = new FingerGestureStateMachine();
  const frames = snapFrames().map((frame, index) => {
    frame.landmarks[12] = sample(frame.timestamp, { middle: [-0.05, 2.1, -0.05] }).landmarks[12];
    frame.landmarks[8] = index < 3 ? { ...frame.landmarks[4] } : sample(frame.timestamp).landmarks[8];
    return frame;
  });
  assert.equal(feed(machine, frames).every(update => !update.candidate && !update.confirmed), true);
});

test('overlap in 2D with thumb/middle separated in depth is not contact', () => {
  const machine = new FingerGestureStateMachine();
  const frames = snapFrames(0, 40, { thumb: [0, 1.72, -0.9] });
  assert.equal(feed(machine, frames).every(update => !update.candidate && !update.confirmed), true);
});

test('middle motion toward the palm in depth is recognized, even with unchanged tip x/y', () => {
  const machine = new FingerGestureStateMachine();
  const options = { middle: [0, 1, -1.2], thumb: [0.08, 1, -1.2] };
  const frames = [
    ...contactFrames(0, 40, options),
    sample(120, { ...options, middle: [0, 1, -0.1] }), sample(160, { ...options, middle: [0, 1, -0.08] })
  ];
  assert.equal(confirmations(feed(machine, frames)), 1);
});

test('consistent 2D-only samples still work and optional metadata can be omitted', () => {
  const machine = new FingerGestureStateMachine();
  const frames = snapFrames(0, 40, { depth: false });
  for (const frame of frames) delete frame.frameAspectRatio;
  assert.equal(confirmations(feed(machine, frames)), 1);
});

test('palm normalization works at different fixed sizes, aspect ratios, and handedness', () => {
  for (const options of [
    { scale: 0.07 }, { scale: 0.24 }, { aspect: 16 / 9 }, { aspect: 9 / 16, depth: false },
    { handedness: 'Left' }, { handedness: 'Right' }
  ]) {
    assert.equal(confirmations(feed(new FingerGestureStateMachine(), snapFrames(0, 40, options))), 1);
  }
});

test('small landmark jitter does not discard a reliable snap', () => {
  const frames = snapFrames().map((frame, index) => {
    for (const [pointIndex, point] of frame.landmarks.entries()) {
      point.x += Math.sin(index + pointIndex) * 0.0007;
      point.y += Math.cos(index + pointIndex) * 0.0007;
      point.z += Math.sin(index - pointIndex) * 0.0003;
    }
    return frame;
  });
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), frames)), 1);
});

const discontinuities = [
  ['whole-hand lateral translation', { shift: [0.4, 0, 0] }],
  ['whole-hand depth translation', { shift: [0, 0, 0.4] }],
  ['large scale growth toward the camera', { scale: 0.16 * 1.35 }],
  ['large scale shrink', { scale: 0.16 * 0.7 }],
  ['palm rotation/wave', { rotation: 0.4 }],
  ['frame aspect change', { aspect: 16 / 9 }],
  ['depth availability change', { depth: false }],
  ['handedness jump', { handedness: 'Left' }]
];

for (const [name, options] of discontinuities) {
  test(`${name} cancels an armed snap instead of explaining it as finger motion`, () => {
    const machine = new FingerGestureStateMachine();
    arm(machine, { handedness: 'Right' });
    const updates = feed(machine, [
      sample(120, { handedness: 'Right', ...options, middle: RELEASED }),
      sample(160, { handedness: 'Right', ...options, middle: CURLED })
    ]);
    assert.equal(updates.every(update => !update.candidate && !update.confirmed), true);
  });
}

test('a moving whole hand must settle before contact can arm', () => {
  const machine = new FingerGestureStateMachine();
  const moving = [0, 1, 2, 3, 4].map(index => sample(index * 40, { shift: [index * 0.2, 0, 0] }));
  assert.equal(feed(machine, moving).every(update => !update.candidate && !update.confirmed), true);
  assert.equal(confirmations(feed(machine, snapFrames(200, 40, { shift: [0.8, 0, 0] }))), 1);
});

test('cumulative wrist drift and gradual approach toward the camera invalidate confirmation', () => {
  for (const transform of [
    index => ({ shift: [index * 0.065, 0, 0] }),
    index => ({ scale: 0.16 * (1 + index * 0.04) })
  ]) {
    const frames = snapFrames().map((frame, index) => sample(frame.timestamp, {
      ...transform(index), ...(index >= 3 ? { middle: index === 3 ? RELEASED : CURLED } : {})
    }));
    const updates = feed(new FingerGestureStateMachine(), frames);
    assert.equal(updates[2].candidate, true);
    assert.equal(confirmations(updates), 0);
    assert.equal(updates.at(-1).candidate, false);
  }
});

test('palm-shape changes invalidate release even when wrist and overall scale are fixed', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  const releases = [sample(120, { middle: RELEASED }), sample(160, { middle: CURLED })];
  for (const frame of releases) frame.landmarks[13].y += 0.08;
  assert.equal(feed(machine, releases).every(update => !update.candidate && !update.confirmed), true);
});

test('duplicate/out-of-order timestamps and large frame gaps reset temporal evidence', () => {
  for (const timestamp of [80, 60, 400]) {
    const machine = new FingerGestureStateMachine();
    arm(machine);
    const interrupted = machine.update(sample(timestamp, { middle: RELEASED }), SENSITIVITY, COOLDOWN);
    assert.equal(interrupted.candidate, false);
    assert.equal(interrupted.confirmed, false);
    const resumeAt = Math.max(timestamp, 80) + 40;
    assert.equal(confirmations(feed(machine, [sample(resumeAt, { middle: RELEASED }), sample(resumeAt + 40, { middle: CURLED })])), 0);
    assert.equal(confirmations(feed(machine, snapFrames(resumeAt + 80))), 1);
  }
});

test('a large gap during release cannot serve as its confirmation frame', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  assert.equal(machine.update(sample(120, { middle: RELEASED }), SENSITIVITY, COOLDOWN).confirmed, false);
  const late = machine.update(sample(500, { middle: CURLED }), SENSITIVITY, COOLDOWN);
  assert.equal(late.confirmed, false);
  assert.equal(late.candidate, false);
});

test('out-of-order frames cannot rewind the cooldown accounting clock', () => {
  const machine = new FingerGestureStateMachine();
  assert.equal(confirmations(feed(machine, snapFrames())), 1);
  assert.equal(machine.update(sample(100), SENSITIVITY, COOLDOWN).state, 'cooldown');
  assert.equal(machine.update(sample(200), SENSITIVITY, COOLDOWN).state, 'cooldown');
  assert.equal(machine.update(sample(160), SENSITIVITY, COOLDOWN).state, 'cooldown');
  const beforeDeadline = feed(machine, snapFrames(1080));
  assert.equal(beforeDeadline.every(update => update.state === 'cooldown' && !update.confirmed), true);
});

test('camera reset clears contact/release evidence and allows a new timestamp origin', () => {
  const machine = new FingerGestureStateMachine();
  arm(machine);
  machine.update(sample(120, { middle: RELEASED }), SENSITIVITY, COOLDOWN);
  machine.reset();
  assert.equal(machine.currentState, 'idle');
  assert.equal(confirmations(feed(machine, [sample(0, { middle: RELEASED }), sample(40, { middle: CURLED })])), 0);
  assert.equal(confirmations(feed(machine, snapFrames(80))), 1);
});

test('camera reset preserves remaining cooldown even when timestamps restart or jump', () => {
  for (const origin of [0, 10000]) {
    const machine = new FingerGestureStateMachine();
    assert.equal(confirmations(feed(machine, snapFrames(), SENSITIVITY, 500)), 1);
    machine.reset();
    assert.equal(machine.currentState, 'cooldown');
    const early = feed(machine, snapFrames(origin), SENSITIVITY, 500);
    assert.equal(early.every(update => update.state === 'cooldown' && !update.confirmed), true);
    assert.equal(confirmations(feed(machine, snapFrames(origin + 500), SENSITIVITY, 500)), 1);
  }
});

test('higher sensitivity permits looser contact while low sensitivity stays stricter', () => {
  const frames = snapFrames(0, 40, { thumb: [0.30, 1.72, -0.05] });
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), frames, 0)), 0);
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), frames, 1)), 1);
});

test('higher sensitivity permits smaller/slower inward motion, still requiring a temporal snap', () => {
  const frames = [
    ...contactFrames(0, 100),
    sample(300, { middle: [0, 1.46, -0.05], thumb: [0.75, 1.7, -0.05] }),
    sample(400, { middle: [0, 1.46, -0.05], thumb: [0.75, 1.7, -0.05] })
  ];
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), frames, 0)), 0);
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), frames, 1)), 1);
});

test('sensitivity is clamped at both boundaries and non-finite settings use a finite default', () => {
  const softContact = snapFrames(0, 40, { thumb: [0.30, 1.72, -0.05] });
  for (const level of [-10, 0, 0.5, 1, 10, NaN, Infinity, -Infinity]) {
    assert.equal(confirmations(feed(new FingerGestureStateMachine(), snapFrames(), level)), 1);
  }
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), softContact, -10)), 0);
  assert.equal(confirmations(feed(new FingerGestureStateMachine(), softContact, 10)), 1);
  // Highest sensitivity still cannot recognize a static or single-frame pose.
  const machine = new FingerGestureStateMachine();
  assert.equal(confirmations(feed(machine, [sample(0), sample(40, { middle: RELEASED }), sample(80, { middle: CURLED })], 1)), 0);
});

test('invalid or too-small cooldown settings retain a finite minimum/default cooldown', () => {
  for (const cooldown of [-100, 0, NaN, Infinity]) {
    const machine = new FingerGestureStateMachine();
    assert.equal(confirmations(feed(machine, snapFrames(), SENSITIVITY, cooldown)), 1);
    assert.equal(confirmations(feed(machine, snapFrames(200), SENSITIVITY, cooldown)), 0);
    assert.equal(confirmations(feed(machine, snapFrames(2000), SENSITIVITY, cooldown)), 1);
  }
});
