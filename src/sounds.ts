// 8-bit style cues generated with Web Audio rather than bundled audio files, so
// the installer stays small and no asset loading can fail at runtime.

const MUTE_KEY = "vibeisland-muted";
const DEBOUNCE_MS = 2000;

type Cue = "attention" | "done" | "error";

const CUES: Record<Cue, { notes: number[]; step: number; gain: number }> = {
  attention: { notes: [660, 880], step: 0.09, gain: 0.06 },
  done: { notes: [523, 659, 784], step: 0.07, gain: 0.05 },
  error: { notes: [330, 247], step: 0.12, gain: 0.06 },
};

let ctx: AudioContext | null = null;
const lastPlayed = new Map<string, number>();

function audioContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(muted: boolean) {
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

export function playCue(cue: Cue, dedupeKey?: string) {
  if (isMuted()) return;

  if (dedupeKey) {
    const now = Date.now();
    const prev = lastPlayed.get(dedupeKey);
    if (prev && now - prev < DEBOUNCE_MS) return;
    lastPlayed.set(dedupeKey, now);
  }

  const audio = audioContext();
  if (!audio) return;
  if (audio.state === "suspended") void audio.resume();

  const { notes, step, gain } = CUES[cue];
  notes.forEach((freq, i) => {
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = "square";
    osc.frequency.value = freq;

    const start = audio.currentTime + i * step;
    const end = start + step;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(env).connect(audio.destination);
    osc.start(start);
    osc.stop(end);
  });
}

export function cueForStatus(status: string): Cue | null {
  switch (status) {
    case "waiting_input":
    case "waiting_permission":
      return "attention";
    case "error":
      return "error";
    default:
      return null;
  }
}
