// Cloudflare Access token verification for /hub (docs/hub-spec.md, section 3).
// Access already gates /hub at the edge; this is the Worker's own check.
// Web Crypto only, no external libraries.

const KEYS_TTL_MS = 60 * 60 * 1000;
const KEYS_MIN_REFETCH_MS = 30 * 1000;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8192;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

// Signing keys per team domain: { fetchedAt, keys: Map<kid, CryptoKey> }.
const keyCache = new Map();

function fail(reason, detail) {
  return { ok: false, reason, detail };
}

export function parseList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function base64UrlDecode(segment) {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error("invalid base64url");
  }

  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJsonSegment(segment) {
  const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("not a JSON object");
  }

  return value;
}

// The Cf-Access-Jwt-Assertion header, or the CF_Authorization cookie.
export function getAccessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");

  if (header) {
    return header.trim();
  }

  const cookies = request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");

    if (separator > 0 && part.slice(0, separator).trim() === "CF_Authorization") {
      return part.slice(separator + 1).trim();
    }
  }

  return "";
}

async function fetchSigningKeys(teamDomain) {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);

  if (!response.ok) {
    throw new Error(`Access certs request failed with ${response.status}`);
  }

  const body = await response.json();
  const keys = new Map();

  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (
      jwk?.kty !== "RSA"
      || typeof jwk.kid !== "string"
      || (jwk.alg && jwk.alg !== "RS256")
    ) {
      continue;
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    keys.set(jwk.kid, key);
  }

  return keys;
}

// Cached for about an hour; an unknown kid triggers a refetch (at most every 30 s).
export async function getSigningKey(teamDomain, kid, now = Date.now()) {
  const cached = keyCache.get(teamDomain);
  const fresh = cached && now - cached.fetchedAt < KEYS_TTL_MS;

  if (fresh && cached.keys.has(kid)) {
    return cached.keys.get(kid);
  }

  if (fresh && now - cached.fetchedAt < KEYS_MIN_REFETCH_MS) {
    return null;
  }

  const keys = await fetchSigningKeys(teamDomain);
  keyCache.set(teamDomain, { fetchedAt: now, keys });

  return keys.get(kid) || null;
}

// config: { teamDomain, audiences: string[], allowedEmails: string[] (lower case) }
// getKey: async (kid) => CryptoKey | null
export async function verifyAccessJwt(token, config, getKey, now = Date.now()) {
  if (typeof token !== "string" || !token) {
    return fail("missing token");
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return fail("malformed token");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    return fail("malformed token");
  }

  let header;
  let payload;
  let signature;

  try {
    header = decodeJsonSegment(parts[0]);
    payload = decodeJsonSegment(parts[1]);
    signature = base64UrlDecode(parts[2]);
  } catch {
    return fail("malformed token");
  }

  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return fail("unsupported token algorithm");
  }

  const key = await getKey(header.kid);

  if (!key) {
    return fail("unknown signing key", { kid: header.kid });
  }

  const signatureValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!signatureValid) {
    return fail("invalid signature");
  }

  const nowSeconds = Math.floor(now / 1000);

  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    return fail("token expired");
  }

  if (
    payload.nbf !== undefined
    && (typeof payload.nbf !== "number" || payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds)
  ) {
    return fail("token not yet valid");
  }

  if (payload.iss !== `https://${config.teamDomain}`) {
    return fail("wrong issuer", { iss: payload.iss });
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

  if (!audiences.some((aud) => typeof aud === "string" && config.audiences.includes(aud))) {
    return fail("wrong audience", { aud: payload.aud });
  }

  const email = typeof payload.email === "string"
    ? payload.email.trim().toLowerCase()
    : "";

  if (!email || !config.allowedEmails.includes(email)) {
    return fail("email not allowed", { email: payload.email });
  }

  return { ok: true, email };
}

export async function authenticate(request, env, url) {
  if (env.DEV_AUTH_BYPASS === "true" && LOCAL_HOSTS.has(url.hostname)) {
    return { ok: true, email: "local-dev", bypass: true };
  }

  const config = {
    teamDomain: String(env.ACCESS_TEAM_DOMAIN || "").trim().toLowerCase(),
    audiences: parseList(env.ACCESS_AUDIENCES),
    allowedEmails: parseList(env.HUB_ALLOWED_EMAILS).map((email) => email.toLowerCase())
  };

  if (
    !TEAM_DOMAIN_PATTERN.test(config.teamDomain)
    || !config.audiences.length
    || !config.allowedEmails.length
  ) {
    return fail("hub auth is not configured");
  }

  try {
    return await verifyAccessJwt(
      getAccessToken(request),
      config,
      (kid) => getSigningKey(config.teamDomain, kid)
    );
  } catch (error) {
    return fail("verification error", { message: error?.message });
  }
}
