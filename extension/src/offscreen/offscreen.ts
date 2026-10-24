// Runs the camera + Face Landmarker at ~5 fps and reports one averaged set of numbers per
// second. Frames are never stored or sent anywhere. Offscreen documents can only use
// chrome.runtime, so the service worker applies the calibration baseline.
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, extractFeatures } from '../shared/face';
import { averageRaw, type RawFace } from '../shared/faceSignals';
import type { Msg } from '../shared/messages';

const FRAME_MS = 200;
const REPORT_MS = 1000;

const video = document.getElementById('cam') as HTMLVideoElement;
let landmarker: FaceLandmarker | null = null;

const send = (msg: Msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 15 }, audio: false });
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => send({ type: 'camera-status', ok: false, error: 'Camera disconnected' }));
    }
    video.srcObject = stream;
    await video.play();
    landmarker = await createLandmarker();
    send({ type: 'camera-status', ok: true, error: null });
    loop();
  } catch (e) {
    send({ type: 'camera-status', ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
}

let samples: RawFace[] = [];
let frames = 0;
let awayFrames = 0;
let lastReport = performance.now();

function loop() {
  // Offscreen documents aren't rendered, so requestAnimationFrame won't tick; use timers.
  setTimeout(loop, FRAME_MS);
  if (!landmarker || video.readyState < 2) return;
  const f = extractFeatures(landmarker.detectForVideo(video, performance.now()));
  frames++;
  if (f.raw) {
    samples.push(f.raw);
    if (f.gazeAway) awayFrames++;
  }

  const now = performance.now();
  if (now - lastReport < REPORT_MS) return;
  const facePresent = samples.length / Math.max(1, frames) >= 0.5;
  send({
    type: 'face-reading',
    facePresent,
    gazeAway: facePresent && awayFrames / samples.length >= 0.5,
    raw: facePresent ? averageRaw(samples) : null,
  });
  samples = [];
  frames = awayFrames = 0;
  lastReport = now;
}

start();
