// MediaPipe's WebAssembly runtime prints routine startup notices through console.warn and console.error
// ("Sets FaceBlendshapesGraph acceleration to xnnpack by default", "OpenGL error checking is disabled",
// "INFO: Created TensorFlow Lite XNNPACK delegate for CPU"). Chrome lists every one of them under the
// extension's Errors, which makes a healthy camera look broken. This drops only those known notices;
// everything else still logs normally.
const NOTICE = /face_landmarker_graph\.cc|gl_context\.cc|XNNPACK delegate|Created TensorFlow Lite/;

type Sink = Pick<Console, 'warn' | 'error' | 'info' | 'log'>;
const wrapped = new WeakSet<object>();

export function isMediaPipeNotice(text: unknown): boolean {
  return typeof text === 'string' && NOTICE.test(text);
}

export function silenceMediaPipeNotices(target: Sink = console): void {
  if (wrapped.has(target)) return;
  wrapped.add(target);
  for (const level of ['warn', 'error', 'info', 'log'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      if (!isMediaPipeNotice(args[0])) original(...args);
    };
  }
}
