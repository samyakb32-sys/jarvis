// Small synthesized sounds (no audio files): a rising chime when a card needs
// you, a soft ping when something finishes, a low tone on a denial or failure.
// Off unless the user turns them on in Settings.

export type Sound = "ask" | "done" | "deny";

const NOTES: Record<Sound, { f: number; at: number; len: number }[]> = {
  ask: [
    { f: 784, at: 0, len: 0.16 },
    { f: 1175, at: 0.11, len: 0.22 },
  ],
  done: [{ f: 1047, at: 0, len: 0.28 }],
  deny: [{ f: 262, at: 0, len: 0.26 }],
};

let ctx: AudioContext | null = null;

export function play(sound: Sound, volume = 0.22): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const n of NOTES[sound]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = sound === "deny" ? "triangle" : "sine";
      osc.frequency.value = n.f;
      // a soft attack and an exponential tail, so nothing clicks
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + n.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.len + 0.05);
    }
  } catch {
    // no audio device: stay silent
  }
}
