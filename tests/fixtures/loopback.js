/* Only synthetic browser media is used by scripts/browser-smoke.mjs. This is
 * not a Meet/OmeTV call and never starts a microphone or saves camera footage. */
window.veylSmoke = { statuses: [], errors: [], replies: new Map(), stream: null, sender: null, remote: null };
const smoke = window.veylSmoke;
const sessionId = 'veyl-browser-fixture-session';
window.addEventListener('message', ({ data }) => {
  if (data?.source !== 'veyl-page') return;
  if (data.type === 'STATUS') { smoke.status = data.payload; smoke.statuses.push(data.payload); }
  if (data.type === 'ERROR') smoke.errors.push(data.payload);
  if (data.type === 'COMMAND_RESULT') smoke.replies.set(data.requestId, data.payload);
});

smoke.configure = (baseUrl, enabled = true, realTimeRemoval = true, characterStudio = false) => {
  const plate = document.createElement('canvas'); plate.width = 640; plate.height = 480;
  const context = plate.getContext('2d'); context.fillStyle = '#c02040'; context.fillRect(0, 0, 640, 480);
  window.postMessage({ source: 'veyl-content', type: 'CONFIG', sessionId, payload: {
    siteKey: location.origin, siteLabel: 'Synthetic loopback fixture', sessionId,
    siteEnabled: enabled, hostPermissionGranted: enabled, assetBaseUrl: baseUrl,
    settings: { realTimeRemoval, gestureDetection: true, characterStudio, gestureSensitivity: .62, gestureCooldownMs: 1100,
      animations: false, animationIntensity: 0, performanceMode: 'performance', useBackgroundPlate: true },
    background: { dataUrl: plate.toDataURL('image/png'), width: 640, height: 480, capturedAt: Date.now() }
  } }, location.origin);
};

smoke.start = async () => {
  smoke.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  smoke.processed = smoke.stream.getVideoTracks()[0];
  const local = new RTCPeerConnection({ iceServers: [] });
  const remote = new RTCPeerConnection({ iceServers: [] });
  smoke.local = local; smoke.receiver = remote;
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true;
  document.body.append(video); smoke.remote = video;
  remote.ontrack = ({ track }) => { video.srcObject = new MediaStream([track]); void video.play(); };
  smoke.sender = local.addTrack(smoke.processed, smoke.stream);
  await local.setLocalDescription(await local.createOffer()); await gathered(local);
  await remote.setRemoteDescription(local.localDescription);
  await remote.setLocalDescription(await remote.createAnswer()); await gathered(remote);
  await local.setRemoteDescription(remote.localDescription);
  return { outputType: smoke.processed.constructor.name, microphoneRequests: window.microphoneRequests ?? 0 };
};
smoke.toggle = () => {
  const requestId = crypto.randomUUID();
  window.postMessage({ source: 'veyl-content', type: 'TOGGLE_EFFECT', sessionId, requestId }, location.origin);
  return requestId;
};
smoke.pixel = () => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d'); context.drawImage(smoke.remote, -320, -240, 640, 480);
  return Array.from(context.getImageData(0, 0, 1, 1).data);
};
smoke.stop = () => {
  smoke.local?.close(); smoke.receiver?.close();
  smoke.stream?.getTracks().forEach((track) => track.stop());
};
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Loopback ICE gathering timed out')), 10000);
    const listener = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', listener); resolve(); } };
    pc.addEventListener('icegatheringstatechange', listener);
  });
}
