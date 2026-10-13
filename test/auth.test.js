// Checks for the hub's Access token verification (docs/hub-spec.md, section 8.2).
// Run with `npm test` (Node 20+, no dependencies).

import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";

import {
  authenticate,
  getAccessToken,
  getSigningKey,
  verifyAccessJwt
} from "../src/hub/auth.js";

const TEAM = "example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = "test-key";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const NOW_S = NOW / 1000;

const config = {
  teamDomain: TEAM,
  audiences: [AUD, "b".repeat(64)],
  allowedEmails: ["admin@retne.games"]
};

let signingKeys;
let otherKeys;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeToken(claims = {}, { header = {}, privateKey = signingKeys.privateKey } = {}) {
  const head = encodeJson({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const body = encodeJson({
    aud: [AUD],
    email: "admin@retne.games",
    exp: NOW_S + 3600,
    iat: NOW_S - 60,
    nbf: NOW_S - 60,
    iss: `https://${TEAM}`,
    sub: "user-id",
    type: "app",
    ...claims
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );

  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

function generateKeys() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
}

const getKey = async (kid) => (kid === KID ? signingKeys.publicKey : null);
const verify = (token) => verifyAccessJwt(token, config, getKey, NOW);

before(async () => {
  signingKeys = await generateKeys();
  otherKeys = await generateKeys();
});

describe("verifyAccessJwt", () => {
  it("accepts a valid token", async () => {
    const result = await verify(await makeToken());
    assert.deepEqual(result, { ok: true, email: "admin@retne.games" });
  });

  it("accepts aud as a plain string and any configured audience", async () => {
    assert.equal((await verify(await makeToken({ aud: AUD }))).ok, true);
    assert.equal((await verify(await makeToken({ aud: ["x", "b".repeat(64)] }))).ok, true);
  });

  it("compares emails case-insensitively", async () => {
    const result = await verify(await makeToken({ email: "Admin@Retne.Games" }));
    assert.equal(result.ok, true);
  });

  it("allows small clock skew", async () => {
    assert.equal((await verify(await makeToken({ exp: NOW_S - 10 }))).ok, true);
    assert.equal((await verify(await makeToken({ nbf: NOW_S + 10 }))).ok, true);
  });

  it("rejects an expired token", async () => {
    const result = await verify(await makeToken({ exp: NOW_S - 3600 }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "token expired");
  });

  it("rejects a token without exp", async () => {
    const result = await verify(await makeToken({ exp: undefined }));
    assert.equal(result.reason, "token expired");
  });

  it("rejects a token that is not valid yet", async () => {
    const result = await verify(await makeToken({ nbf: NOW_S + 3600 }));
    assert.equal(result.reason, "token not yet valid");
  });

  it("rejects the wrong audience", async () => {
    const result = await verify(await makeToken({ aud: ["c".repeat(64)] }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "wrong audience");
  });

  it("rejects a missing audience", async () => {
    const result = await verify(await makeToken({ aud: undefined }));
    assert.equal(result.reason, "wrong audience");
  });

  it("rejects the wrong issuer", async () => {
    const result = await verify(await makeToken({ iss: "https://other-team.cloudflareaccess.com" }));
    assert.equal(result.reason, "wrong issuer");
  });

  it("rejects an email that is not allowed", async () => {
    const result = await verify(await makeToken({ email: "someone@example.com" }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "email not allowed");
  });

  it("rejects a token without an email (e.g. a service token)", async () => {
    const result = await verify(await makeToken({ email: undefined, common_name: "svc" }));
    assert.equal(result.reason, "email not allowed");
  });

  it("rejects a signature from another key", async () => {
    const token = await makeToken({}, { privateKey: otherKeys.privateKey });
    const result = await verify(token);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid signature");
  });

  it("rejects a tampered payload", async () => {
    const [head, , signature] = (await makeToken()).split(".");
    const forged = encodeJson({
      aud: [AUD],
      email: "admin@retne.games",
      exp: NOW_S + 999999,
      iss: `https://${TEAM}`
    });
    const result = await verify(`${head}.${forged}.${signature}`);
    assert.equal(result.reason, "invalid signature");
  });

  it("rejects a missing or empty signature", async () => {
    const [head, body] = (await makeToken()).split(".");
    assert.equal((await verify(`${head}.${body}.`)).reason, "invalid signature");
    assert.equal((await verify(`${head}.${body}`)).reason, "malformed token");
  });

  it("rejects other algorithms", async () => {
    for (const alg of ["none", "HS256", "RS512", "ES256"]) {
      const result = await verify(await makeToken({}, { header: { alg } }));
      assert.equal(result.reason, "unsupported token algorithm", alg);
    }
  });

  it("rejects an unknown key id", async () => {
    const result = await verify(await makeToken({}, { header: { kid: "other" } }));
    assert.equal(result.reason, "unknown signing key");
  });

  it("rejects missing and malformed tokens", async () => {
    for (const token of ["", undefined, "abc", "a.b.c", "a.b.c.d", "x".repeat(9000), "!!.??.**"]) {
      const result = await verify(token);
      assert.equal(result.ok, false, String(token).slice(0, 20));
    }
  });
});

describe("getAccessToken", () => {
  const request = (headers) => new Request("https://retne.games/hub/", { headers });

  it("reads the Cf-Access-Jwt-Assertion header first", () => {
    const token = getAccessToken(request({
      "Cf-Access-Jwt-Assertion": "header-token",
      Cookie: "CF_Authorization=cookie-token"
    }));
    assert.equal(token, "header-token");
  });

  it("falls back to the CF_Authorization cookie", () => {
    const token = getAccessToken(request({ Cookie: "a=1; CF_Authorization=cookie.to=ken; b=2" }));
    assert.equal(token, "cookie.to=ken");
  });

  it("ignores similarly named cookies", () => {
    assert.equal(getAccessToken(request({ Cookie: "XCF_Authorization=nope" })), "");
  });
});

describe("authenticate", () => {
  const env = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUDIENCES: AUD,
    HUB_ALLOWED_EMAILS: "admin@retne.games"
  };

  const run = (url, extraEnv = {}, headers = {}) => authenticate(
    new Request(url, { headers }),
    { ...env, ...extraEnv },
    new URL(url)
  );

  it("rejects a request without a token", async () => {
    const result = await run("https://retne.games/hub/api/boards");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing token");
  });

  it("only honours DEV_AUTH_BYPASS on localhost", async () => {
    const bypass = { DEV_AUTH_BYPASS: "true" };
    assert.equal((await run("http://localhost:8787/hub/", bypass)).ok, true);
    assert.equal((await run("http://127.0.0.1:8787/hub/", bypass)).ok, true);
    assert.equal((await run("https://retne.games/hub/", bypass)).ok, false);
    assert.equal((await run("https://localhost.evil.example/hub/", bypass)).ok, false);
    assert.equal((await run("http://localhost:8787/hub/", { DEV_AUTH_BYPASS: "1" })).ok, false);
  });

  it("fails closed when not configured", async () => {
    for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUDIENCES", "HUB_ALLOWED_EMAILS"]) {
      const result = await run("https://retne.games/hub/", { [missing]: "" }, {
        "Cf-Access-Jwt-Assertion": await makeToken()
      });
      assert.equal(result.reason, "hub auth is not configured", missing);
    }
  });
});

describe("getSigningKey", () => {
  const realFetch = globalThis.fetch;
  let team = 0;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function jwk(keys, kid) {
    return { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, alg: "RS256", use: "sig" };
  }

  function mockCerts(getKeys) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ keys: await getKeys() });
    };
    return calls;
  }

  it("fetches the team's certs once and caches them", async () => {
    const domain = `cache-${team++}.cloudflareaccess.com`;
    const calls = mockCerts(async () => [await jwk(signingKeys, KID)]);

    assert.ok(await getSigningKey(domain, KID, NOW));
    assert.ok(await getSigningKey(domain, KID, NOW + 30 * 60 * 1000));
    assert.deepEqual(calls, [`https://${domain}/cdn-cgi/access/certs`]);

    await getSigningKey(domain, KID, NOW + 61 * 60 * 1000);
    assert.equal(calls.length, 2, "refetches after an hour");
  });

  it("refetches on an unknown kid, at most every 30 seconds", async () => {
    const domain = `rotate-${team++}.cloudflareaccess.com`;
    let published = [await jwk(signingKeys, KID)];
    const calls = mockCerts(async () => published);

    await getSigningKey(domain, KID, NOW);
    assert.equal(await getSigningKey(domain, "new", NOW + 1000), null);
    assert.equal(calls.length, 1, "no refetch within 30 s");

    published = [...published, await jwk(otherKeys, "new")];
    assert.ok(await getSigningKey(domain, "new", NOW + 31 * 1000));
    assert.equal(calls.length, 2);
  });

  it("verifies a token end to end with fetched keys", async () => {
    const domain = `e2e-${team++}.cloudflareaccess.com`;
    mockCerts(async () => [await jwk(signingKeys, KID)]);

    const token = await makeToken({ iss: `https://${domain}` });
    const result = await verifyAccessJwt(
      token,
      { ...config, teamDomain: domain },
      (kid) => getSigningKey(domain, kid, NOW),
      NOW
    );
    assert.equal(result.ok, true);
  });
});
