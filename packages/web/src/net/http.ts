import type { ErrorCode } from "@gloam/shared/protocol";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "NETWORK";
  readonly detail: unknown;
  readonly retryAfterS: number | null;
  constructor(
    status: number,
    code: ErrorCode | "NETWORK",
    message: string,
    detail?: unknown,
    retryAfterS: number | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterS = retryAfterS;
  }
}

function csrfToken(): string | null {
  const m = /(?:^|;\s*)gloam_csrf=([^;]+)/.exec(document.cookie);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** REST call with the CSRF double-submit header; unwraps `{ data }` / throws ApiError for `{ error }`. */
export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = csrfToken();
  if (token && method !== "GET") headers["x-gloam-csrf"] = token;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the table right now.");
  }
  const text = await res.text();
  let json: { data?: T; error?: { code: ErrorCode; message: string; detail?: unknown } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok || json.error) {
    const retry = res.headers.get("retry-after");
    throw new ApiError(
      res.status,
      json.error?.code ?? "INVALID",
      json.error?.message ?? (text && text.length < 200 ? text : `Request failed (${res.status}).`),
      json.error?.detail,
      retry ? Number(retry) : null,
    );
  }
  return json.data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const patch = <T>(path: string, body: unknown = {}) => api<T>("PATCH", path, body);
export const del = <T>(path: string) => api<T>("DELETE", path);

/** Posts a client error to the local server (never a third party, SPEC §23.6); rate-limited. */
let sent = 0;
export function reportClientError(level: "error" | "warn", message: string, stack?: string): void {
  if (sent++ > 20) return;
  void post("/api/client-log", {
    level,
    message: message.slice(0, 2000),
    stack: stack?.slice(0, 8000),
    url: location.pathname,
  }).catch(() => {});
}
