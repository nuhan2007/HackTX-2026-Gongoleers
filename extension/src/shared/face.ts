// Face Landmarker setup + blendshapes → raw features. Shared by the offscreen camera loop
// and the options-page calibration so both measure exactly the same thing.
// (Kept separate from faceSignals.ts so the service worker never loads MediaPipe.)
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { RawFace } from './faceSignals';
import { silenceMediaPipeNotices } from './quietConsole';

silenceMediaPipeNotices();

export async function createLandmarker(): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe/wasm'));
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'), delegate },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    return FaceLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

export interface FrameFeatures {
  facePresent: boolean;
  gazeAway: boolean;
  raw: RawFace | null;
}

const DEG = 180 / Math.PI;

export function extractFeatures(result: FaceLandmarkerResult): FrameFeatures {
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (!shapes || !matrix) return { facePresent: false, gazeAway: false, raw: null };

  const b = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
  const avg = (a: string, c: string) => (b(a) + b(c)) / 2;

  // Column-major 4x4: rotation part gives head pose.
  const [r00, r10, r20, , , , r21, , , , r22] = matrix;
  const roll = Math.atan2(r10, r00) * DEG;
  const yaw = Math.asin(Math.max(-1, Math.min(1, -r20))) * DEG;
  const pitch = Math.atan2(r21, r22) * DEG;
  const lookingDown = avg('eyeLookDownLeft', 'eyeLookDownRight') > 0.55;
  const gazeAway = Math.abs(yaw) > 30 || Math.abs(pitch) > 25 || lookingDown;

  return {
    facePresent: true,
    gazeAway,
    raw: {
      browFurrow: avg('browDownLeft', 'browDownRight'),
      browRaise: b('browInnerUp'),
      squint: avg('eyeSquintLeft', 'eyeSquintRight'),
      lipPress: Math.max(avg('mouthPressLeft', 'mouthPressRight'), avg('mouthFrownLeft', 'mouthFrownRight')),
      headTilt: Math.abs(roll),
    },
  };
}
