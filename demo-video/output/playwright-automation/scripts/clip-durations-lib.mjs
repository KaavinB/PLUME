// Locates Argo's cached TTS clip for a scene (same cache key as @argo-video/cli tts/cache.js) and measures it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import config from '../argo.config.mjs';

export const VOICE = config.tts.defaultVoice;
export const SPEED = config.tts.defaultSpeed;

export function clipPath(capture, scene, text) {
  const h = createHash('sha256').update(JSON.stringify({ scene, text, voice: VOICE, speed: SPEED })).digest('hex');
  return join('.argo', capture, 'clips', `${h}.wav`);
}

export function clipMs(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString();
  return Math.round(Number(out) * 1000);
}
