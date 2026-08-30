// Port of the /deepgram-token route from orchestrator_modal.py. See
// CHANGELOG.md 2026-08-09 "Security: Deepgram key exposure" for why this
// exists — the real key never reaches the browser.
//
// (The old /stt REST proxy that used to live here was removed — it was
// dead code, never called by any frontend page, which just made it extra
// unauthenticated surface area. See CHANGELOG.md for the removal note.)

const TOKEN_TTL_SECONDS = 60;

/**
 * Issue a short-lived Deepgram credential for the browser.
 *
 * Uses POST /v1/auth/grant, which returns a temporary access token and
 * creates nothing. The browser presents it as the `bearer` WebSocket
 * subprotocol.
 *
 * This previously created a real, 60-second-expiry API key per connection
 * via /projects/{id}/keys. That worked until 2026-08-19, when it took the
 * whole app down: Deepgram caps how many keys a project may create per day,
 * we hit the cap, and every session start failed with 502 until the next
 * UTC midnight. Deepgram's own error text says to use token auth instead.
 *
 * Key-minting is therefore not an option to "fall back" to — it is the bug.
 * See CHANGELOG.md 2026-08-19.
 */
export async function mintDeepgramToken(apiKey: string): Promise<Response> {
  if (!apiKey) {
    return jsonError(500, "DEEPGRAM_API_KEY not configured on the server");
  }
  try {
    const resp = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    });
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 300);
      // Log it. The old code returned the reason to the browser and kept no
      // server-side record, so a day-long outage showed up in the logs as a
      // bare 502 with no cause.
      console.error(
        JSON.stringify({ event: "deepgram_grant_failed", status: resp.status, body, ts: Date.now() }),
      );
      return jsonError(502, `Deepgram token grant failed: ${body}`);
    }
    const data = await resp.json<{ access_token: string; expires_in: number }>();
    return Response.json({
      token: data.access_token,
      expires_in: data.expires_in ?? TOKEN_TTL_SECONDS,
      // Tells the browser which WebSocket subprotocol to present.
      auth: "bearer",
    });
  } catch (e) {
    const detail = (e as Error).message;
    console.error(
      JSON.stringify({ event: "deepgram_grant_exception", detail, ts: Date.now() }),
    );
    return jsonError(502, `Deepgram token grant failed: ${detail}`);
  }
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}
