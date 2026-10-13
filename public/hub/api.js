// Client for the hub API (/hub/api). Same-origin JSON only.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// keepalive lets a save finish while the page is being hidden or closed.
// A Blob body is sent as is, with its own type (image uploads).
// raw returns the Response itself (downloads).
async function request(method, path, body, { keepalive = false, raw = false } = {}) {
  const init = {
    method,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    keepalive,
    // An expired Access session answers with a redirect to the login page.
    redirect: "manual"
  };

  if (body instanceof Blob) {
    init.headers["Content-Type"] = body.type;
    init.body = body;
  } else if (method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }

  let response;

  try {
    response = await fetch(`/hub/api${path}`, init);
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }

  if (response.type === "opaqueredirect") {
    throw new ApiError(401, "Your session has expired. Reload the page to log in again.");
  }

  if (raw && response.ok) {
    return response;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status, data?.error || `Request failed (${response.status}).`);
  }

  return data;
}

const boardPath = (id) => `/boards/${encodeURIComponent(id)}`;

export const api = {
  listBoards: () => request("GET", "/boards"),
  getBoard: (id) => request("GET", boardPath(id)),
  getBoardRev: (id) => request("GET", `${boardPath(id)}/rev`),
  createBoard: (board) => request("POST", "/boards", board),
  updateBoard: (id, changes, options) => request("PATCH", boardPath(id), changes, options),
  deleteBoard: (id) => request("DELETE", boardPath(id)),
  saveChanges: (id, ops, options) => request("POST", `${boardPath(id)}/changes`, { ops }, options),
  uploadFile: (blob) => request("POST", "/files", blob),
  exportAll: () => request("GET", "/export", undefined, { raw: true }),
  importExport: (data) => request("POST", "/import", data)
};

export const fileUrl = (fileId) => `/hub/api/files/${encodeURIComponent(fileId)}`;
