// Fish Audio TTS — confirmed via API docs that /v1/tts accepts plain JSON
// (not just the Python SDK's MessagePack encoding), so no msgpack library
// needed here. The "model" header selects the backend ("s2.1-pro" etc.),
// same as FISH_TTS_BACKEND in orchestrator_modal.py.

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";

export interface TtsOptions {
  apiKey: string;
  voiceId: string;
  backend: string;
  text: string;
  signal?: AbortSignal;
}

/**
 * Synthesise text via Fish Audio. Retries once on any error — fetch()
 * doesn't need the Python version's manual session-reuse workaround, but a
 * single retry still covers a transient network blip.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function synthesizeSpeech(opts: TtsOptions): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(500); // brief backoff before the retry
    try {
      const resp = await fetch(FISH_TTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          model: opts.backend,
        },
        body: JSON.stringify({
          reference_id: opts.voiceId,
          text: opts.text,
          format: "mp3",
          mp3_bitrate: 128,
          latency: "balanced",
          normalize: true,
        }),
        signal: opts.signal,
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Fish Audio TTS ${resp.status}: ${body.slice(0, 300)}`);
      }
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      lastErr = e;
      if (attempt === 0) continue;
    }
  }
  throw lastErr;
}
