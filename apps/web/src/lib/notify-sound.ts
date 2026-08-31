/**
 * The chime a finished run plays.
 *
 * Synthesised rather than shipped as a file: two oscillators cost nothing, need
 * no asset pipeline, and cannot 404. It also keeps the "done" and "failed"
 * cases one argument apart instead of two binaries.
 */

const MUTE_KEY = "nexux:notify-muted";

export function isMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Storage disabled: the toggle stops persisting, which is survivable.
  }
}

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/**
 * Two short notes — rising for a run that landed, falling for one that failed.
 *
 * Browsers refuse audio until the page has been interacted with, and a run can
 * finish before that ever happens. The context is resumed opportunistically and
 * every failure is swallowed: a missed chime is a missed chime, and must never
 * be the reason a notification does not appear.
 */
export function playChime(kind: "done" | "error" = "done"): void {
  if (isMuted()) return;
  const audio = audioContext();
  if (!audio) return;

  void audio.resume?.().catch(() => undefined);
  if (audio.state !== "running") return;

  const notes = kind === "error" ? [440, 330] : [660, 880];
  const now = audio.currentTime;

  notes.forEach((freq, i) => {
    const at = now + i * 0.12;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // A ramp, not a switch: an abrupt stop on a sine is an audible click.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  });
}
