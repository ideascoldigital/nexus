const STORAGE_KEY = "nexux:task-sound";

export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

export function setSoundEnabled(enabled: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
}

// Synthesized with Web Audio — no asset to ship, no network fetch, and it
// respects the browser's autoplay rules (any prior click unlocks it).
function tone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  gain: number,
) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;

  // Short attack/release so it reads as a chime, not a click.
  amp.gain.setValueAtTime(0, startAt);
  amp.gain.linearRampToValueAtTime(gain, startAt + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(amp).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

type SoundKind = "success" | "error";

export function playTaskSound(kind: SoundKind) {
  if (!isSoundEnabled()) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;

    if (kind === "success") {
      // Rising major third — "done".
      tone(ctx, 659.25, now, 0.14, 0.12); // E5
      tone(ctx, 987.77, now + 0.12, 0.22, 0.1); // B5
    } else {
      // Falling minor second — "something's wrong".
      tone(ctx, 392.0, now, 0.16, 0.11); // G4
      tone(ctx, 311.13, now + 0.14, 0.28, 0.1); // Eb4
    }

    // Release the context once the sound has played out.
    setTimeout(() => ctx.close().catch(() => undefined), 800);
  } catch {
    // Autoplay blocked or Web Audio unavailable — the toast still shows.
  }
}
