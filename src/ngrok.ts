/**
 * ngrok URL Detection Utility
 *
 * Auto-detects the ngrok public URL from its local API,
 * or reads it from the NGROK_URL environment variable.
 *
 * Used by both call.ts (to build TwiML) and call-server.ts (to log the URL).
 */

/**
 * Try to auto-detect the ngrok public URL.
 * Checks NGROK_URL env var first, then queries ngrok's local API.
 * Returns a wss:// URL, or null if ngrok is not available.
 */
export async function getNgrokUrl(): Promise<string | null> {
  // Prefer explicit env var
  const envUrl = process.env.NGROK_URL;
  if (envUrl) {
    // Normalize to wss://
    return envUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
  }

  // Try ngrok local API (runs on port 4040 by default)
  try {
    const resp = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(2000),
    });
    const data = (await resp.json()) as {
      tunnels: Array<{ public_url: string; proto: string }>;
    };
    const tunnel = data.tunnels.find((t) => t.proto === "https");
    if (tunnel) {
      return tunnel.public_url.replace(/^https:\/\//, "wss://");
    }
  } catch {
    // ngrok not running or API not available
  }

  return null;
}
