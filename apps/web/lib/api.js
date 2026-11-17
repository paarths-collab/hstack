import { findSecrets } from "../../../packages/security/secret-scanner.js";
import { getSession } from "./auth.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function handleApi(action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    // Never echo an unexpected database or auth error to a client.
    return json({ error: "The server could not complete this request." }, 500);
  }
}

export function requireSameOrigin(request) {
  const origin = request.headers.get("origin");
  let expected;
  try { expected = new URL(process.env.BETTER_AUTH_URL).origin; }
  catch { throw new ApiError(503, "Server authentication is not configured."); }
  if (!origin || origin !== expected) throw new ApiError(403, "A same-origin request is required.");
}

export async function requireUserId(request) {
  const session = await getSession(request);
  if (!session?.user?.id) throw new ApiError(401, "Sign in to use account storage.");
  return session.user.id;
}

export function requireJsonContentType(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new ApiError(415, "Send application/json.");
  }
}

export async function readJson(request, maxBytes = 1_000_000) {
  requireJsonContentType(request);
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new ApiError(413, "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "A JSON body is required.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

export function requireExactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(value, key))) {
    throw new ApiError(400, "Request fields are invalid.");
  }
}

export function requireId(value) {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new ApiError(400, "A valid id is required.");
  }
  return value;
}

function safeText(value, label, max, required) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) {
    throw new ApiError(400, `${label} must be ${required ? "nonempty " : ""}text of at most ${max} characters.`);
  }
  return value.trim();
}

/** A connection is a setup note only. No OAuth token or credential fields exist. */
export function parseConnection(value, { update = false } = {}) {
  requireExactFields(value, update ? ["id", "name", "kind", "endpoint", "notes"] : ["name", "kind", "endpoint", "notes"]);
  const id = update ? requireId(value.id) : undefined;
  const name = safeText(value.name, "name", 80, true);
  const kind = value.kind;
  if (!["github", "telegram", "custom"].includes(kind)) throw new ApiError(400, "kind must be github, telegram, or custom.");
  const endpoint = safeText(value.endpoint, "endpoint", 2048, false);
  const notes = safeText(value.notes, "notes", 1000, false);
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); }
    catch { throw new ApiError(400, "endpoint must be a public HTTPS URL or empty."); }
    if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password || url.hash || url.port ||
        /(?:^|\.)(?:localhost|local|internal|test)$/.test(url.hostname) ||
        /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) ||
        [...url.searchParams.keys()].some((key) => /auth|token|secret|password|passwd|credential|session|signature|bearer|jwt|api[-_]?key|access[-_]?key|^key$|^sig$|^code$/i.test(key))) {
      throw new ApiError(400, "endpoint must be a public HTTPS URL without credentials or authentication parameters.");
    }
  }
  const serialized = JSON.stringify({ name, kind, endpoint, notes });
  if (findSecrets(serialized).length || /\b(?:password|token|secret|api[_ -]?key|authorization)\s*[:=]\s*\S+/i.test(serialized)) {
    throw new ApiError(400, "Connection records cannot contain credentials. Configure access in your harness.");
  }
  return { ...(id ? { id } : {}), name, kind, endpoint, notes };
}
