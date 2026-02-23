/**
 * MS365 Device Code Login
 *
 * Does the OAuth2 device code flow directly (no ms365-mcp-server needed).
 * Writes the MSAL-compatible token cache to the path expected by ms365.ts.
 *
 * Usage: bun run scripts/ms365-login.ts
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { dirname } from "path";

const CLIENT_ID = process.env.MS365_MCP_CLIENT_ID || "084a3e9f-a9f4-43f7-89f9-d229cf97853e";
const TENANT_ID = process.env.MS365_MCP_TENANT_ID || "c5076972-58d0-45f3-bc1c-25cd8d4821ed";
const TOKEN_CACHE_PATH = process.env.MS365_TOKEN_CACHE_PATH ||
  (process.env.USERPROFILE || process.env.HOME || "~") + "/.ms365-tokens/.token-cache.json";

const SCOPES = "Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.ReadWrite Files.Read.All Files.ReadWrite Notes.Create Notes.Read Tasks.ReadWrite User.Read openid profile email offline_access";

const DEVICE_CODE_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  ext_expires_in: number;
}

async function main() {
  console.log("=== MS365 Device Code Login ===\n");
  console.log(`Client ID: ${CLIENT_ID}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log(`Token cache: ${TOKEN_CACHE_PATH}\n`);

  // Step 1: Request device code
  const dcResp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }),
  });

  if (!dcResp.ok) {
    const err = await dcResp.text();
    console.error(`Device code request failed (${dcResp.status}): ${err}`);
    process.exit(1);
  }

  const dc: DeviceCodeResponse = await dcResp.json();
  console.log("========================================");
  console.log(dc.message);
  console.log("========================================\n");

  // Step 2: Poll for token
  const startTime = Date.now();
  const timeout = dc.expires_in * 1000;
  const interval = (dc.interval || 5) * 1000;

  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, interval));

    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: dc.device_code,
      }),
    });

    const body = await tokenResp.json();

    if (tokenResp.ok) {
      const tokens = body as TokenResponse;
      console.log("\nAuthentication successful!");
      console.log(`Scopes: ${tokens.scope}`);

      // Step 3: Build MSAL-compatible cache
      await buildAndSaveCache(tokens);
      console.log(`\nToken cache saved to: ${TOKEN_CACHE_PATH}`);
      console.log("Done! MS365 integration should now work.");
      process.exit(0);
    }

    const error = body.error;
    if (error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    } else if (error === "slow_down") {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    } else if (error === "expired_token") {
      console.error("\nDevice code expired. Please run again.");
      process.exit(1);
    } else {
      console.error(`\nUnexpected error: ${error} — ${body.error_description}`);
      process.exit(1);
    }
  }

  console.error("\nTimeout waiting for authentication.");
  process.exit(1);
}

async function buildAndSaveCache(tokens: TokenResponse) {
  // Parse the ID token to extract user info (it's a JWT)
  const idPayload = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()
  );

  const homeAccountId = `${idPayload.oid}.${idPayload.tid}`;
  const env = "login.windows.net";
  const realm = idPayload.tid;
  const username = idPayload.preferred_username || idPayload.upn || "";
  const name = idPayload.name || "";

  // Build the account key
  const accountKey = `${homeAccountId}-${env}-${realm}`;

  // Build scopes string for target (lowercase, space-separated)
  const target = tokens.scope;

  const nowSec = Math.floor(Date.now() / 1000);

  // Build MSAL cache structure
  const cache: any = {
    Account: {
      [accountKey]: {
        home_account_id: homeAccountId,
        environment: env,
        realm,
        local_account_id: idPayload.oid,
        username,
        authority_type: "MSSTS",
        name,
      },
    },
    IdToken: {
      [`${homeAccountId}-${env}-idtoken-${CLIENT_ID}-${realm}---`]: {
        home_account_id: homeAccountId,
        environment: env,
        credential_type: "IdToken",
        client_id: CLIENT_ID,
        secret: tokens.id_token,
        realm,
      },
    },
    AccessToken: {
      [`${homeAccountId}-${env}-accesstoken-${CLIENT_ID}-${realm}-${target.toLowerCase().replace(/ /g, " ")}--`]: {
        home_account_id: homeAccountId,
        environment: env,
        credential_type: "AccessToken",
        client_id: CLIENT_ID,
        secret: tokens.access_token,
        realm,
        target,
        cached_at: String(nowSec),
        expires_on: String(nowSec + tokens.expires_in),
        extended_expires_on: String(nowSec + (tokens.ext_expires_in || tokens.expires_in)),
        token_type: "Bearer",
      },
    },
    RefreshToken: {
      [`${homeAccountId}-${env}-refreshtoken-${CLIENT_ID}----`]: {
        home_account_id: homeAccountId,
        environment: env,
        credential_type: "RefreshToken",
        client_id: CLIENT_ID,
        secret: tokens.refresh_token,
      },
    },
    AppMetadata: {},
  };

  // Ensure directory exists
  await mkdir(dirname(TOKEN_CACHE_PATH), { recursive: true });
  await writeFile(TOKEN_CACHE_PATH, JSON.stringify(cache), "utf-8");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
