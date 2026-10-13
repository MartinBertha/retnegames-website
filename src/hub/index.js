// Entry point for /hub and /hub/* (docs/hub-spec.md). Every request, static or
// API, must carry a valid Cloudflare Access token for an allowed email.

import { handleApi } from "./api.js";
import { authenticate } from "./auth.js";
import { errorJson } from "./http.js";

let loggedAccessOk = false;

// Decoded and case-insensitive, so odd spellings of /hub still go through auth.
export function isHubPath(pathname) {
  let path = pathname;

  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Keep the raw path; it can't map to a real file anyway.
  }

  return /^\/+hub(\/|$)/i.test(path);
}

function isApiPath(pathname) {
  return pathname === "/hub/api" || pathname.startsWith("/hub/api/");
}

async function serveHubAsset(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" }
    });
  }

  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);

  // Private app files: never stored by shared caches, always revalidated.
  headers.set("cache-control", "private, no-cache");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function handleHub(request, env, url) {
  const auth = await authenticate(request, env, url);

  if (!auth.ok) {
    // Private log only (wrangler tail); the client just gets 403.
    console.warn("hub auth rejected:", auth.reason, JSON.stringify(auth.detail ?? {}));

    if (isApiPath(url.pathname)) {
      return errorJson(403, "Forbidden.");
    }

    return new Response("Forbidden.", {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  if (!loggedAccessOk && !auth.bypass) {
    console.log("hub auth: Access token verified (issuer, audience and email passed)");
    loggedAccessOk = true;
  }

  if (isApiPath(url.pathname)) {
    return handleApi(request, env, url);
  }

  return serveHubAsset(request, env);
}
