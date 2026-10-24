// Camera grant + 10s neutral-face calibration. The offscreen document can't show a
// permission prompt itself, so the grant has to happen here on a visible extension page.
import type { FaceLandmarker } from '@mediapipe/tasks-vision';
import { useEffect, useRef, useState } from 'react';
import { createLandmarker, extractFeatures } from '../shared/face';
import { buildBaseline, type RawFace } from '../shared/faceSignals';
import { send } from '../shared/messages';
import type { Settings } from '../shared/settings';

const CALIBRATION_MS = 10_000;

export function CameraSetup({ settings, onChange }: { settings: Settings; onChange: (p: Partial<Settings>) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<string>('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micOk, setMicOk] = useState<boolean | null>(null);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  async function allow() {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play();
      }
      await onChange({ cameraGranted: true });
      setStatus('Camera allowed. Now calibrate so Gongo learns your neutral face.');
    } catch (e) {
      await onChange({ cameraGranted: false });
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Camera permission was blocked. Click the camera icon in the address bar to allow it, then try again. Gongo needs the camera to work.'
          : `Couldn't start the camera: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function calibrate() {
    if (!stream || !videoRef.current) await allow();
    const video = videoRef.current!;
    setError(null);
    setStatus('Loading face model…');
    let lm: FaceLandmarker;
    try {
      lm = await createLandmarker();
    } catch (e) {
      setError(`Couldn't load the face model: ${e instanceof Error ? e.message : e}`);
      return;
    }
    setStatus('Look at the screen like you normally do while reading. Relax your face.');
    const samples: RawFace[] = [];
    const start = performance.now();
    await new Promise<void>((done) => {
      const id = setInterval(() => {
        const elapsed = performance.now() - start;
        setProgress(Math.min(1, elapsed / CALIBRATION_MS));
        if (video.readyState >= 2) {
          const f = extractFeatures(lm.detectForVideo(video, performance.now()));
          if (f.raw && !f.gazeAway) samples.push(f.raw);
        }
        if (elapsed >= CALIBRATION_MS) {
          clearInterval(id);
          done();
        }
      }, 100);
    });
    lm.close();
    setProgress(null);
    if (samples.length < 30) {
      setError('I could barely see your face. Make sure you are well lit and centered, then try again.');
      return;
    }
    await onChange({ calibration: buildBaseline(samples) });
    setStatus(`Calibrated from ${samples.length} frames ✓`);
    setStream(null);
    await send({ type: 'restart-camera' });
  }

  async function allowMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicOk(true);
    } catch {
      setMicOk(false);
    }
  }

  return (
    <section className="card">
      <h2>2. Camera (required)</h2>
      <p className="small muted">
        Gongo uses your webcam to notice signs of confusion (a furrowed brow, a head tilt). Video is processed on this device and never stored or
        sent anywhere.
      </p>
      <div className="cam-row">
        <video ref={videoRef} className={`cam ${stream ? '' : 'off'}`} muted playsInline />
        <div className="stack">
          <div className="row">
            <span className={`chip ${settings.cameraGranted ? 'good' : 'warn'}`}>{settings.cameraGranted ? '✓ Camera allowed' : 'Camera not allowed yet'}</span>
            <span className={`chip ${settings.calibration ? 'good' : 'warn'}`}>
              {settings.calibration ? `✓ Calibrated ${new Date(settings.calibration.capturedAt).toLocaleDateString()}` : 'Not calibrated'}
            </span>
          </div>
          <div className="row">
            {!stream && <button onClick={allow}>Allow camera</button>}
            <button className="primary" onClick={calibrate} disabled={progress !== null}>
              {settings.calibration ? 'Recalibrate (10s)' : 'Calibrate (10s)'}
            </button>
          </div>
          {progress !== null && (
            <div className="meter-track" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="meter-fill" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          {status && <p className="small">{status}</p>}
          {error && <p className="small error">{error}</p>}
          <div className="row small">
            <button onClick={allowMic}>Allow microphone (optional, for voice answers)</button>
            {micOk === true && <span>✓</span>}
            {micOk === false && <span className="error">Blocked</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
