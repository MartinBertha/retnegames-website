// Shared request and response helpers for the hub API.

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_HEADERS, ...extraHeaders }
  });
}

export function errorJson(status, message, extraHeaders = {}) {
  return json({ error: message }, status, extraHeaders);
}

export function isMutation(method) {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

// CSRF protection: state-changing requests must come from the hub's own origin.
export function checkSameOrigin(request, url) {
  if (request.headers.get("Origin") !== url.origin) {
    throw new HttpError(403, "Forbidden.");
  }
}

export function checkJsonContentType(request) {
  const type = (request.headers.get("Content-Type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (type !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
}

// Reads at most maxBytes before parsing, whatever Content-Length claims.
export async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);

  if (declared > maxBytes) {
    throw new HttpError(413, "Request too large.");
  }

  if (!request.body) {
    throw new HttpError(400, "Invalid JSON.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request too large.");
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}
