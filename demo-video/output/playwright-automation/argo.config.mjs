import { defineConfig, engines } from '@argo-video/cli';

// PLUME demo video. The app is laid out for ~1512–1600 px wide screens, so the browser runs at 1600×900 CSS px,
// is captured at 2× (3200×1800, CDP jpeg-stitch from system Chrome) and downscaled once with lanczos to 1920×1080.
export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: {
    // Local Kokoro 82M (full-precision weights), no API key.
    engine: engines.kokoro({ dtype: 'fp32' }),
    defaultVoice: 'af_heart',
    defaultSpeed: 1.05,
  },
  video: {
    width: 1600,
    height: 900,
    fps: 30,
    browser: 'chromium',
    browserChannel: 'chrome',
    captureMode: 'jpeg-stitch',
    jpegQuality: 92,
    deviceScaleFactor: 2,
    cursorHighlight: { mode: 'click', color: '#f2a93b', radius: 20, opacity: 0.85 },
    contextOptions: { colorScheme: 'dark', reducedMotion: 'no-preference' },
  },
  export: {
    preset: 'slow',
    crf: 16,
    outputWidth: 1920,
    outputHeight: 1080,
    audio: { loudnorm: true },
  },
  overlays: {
    autoBackground: false,
  },
});
