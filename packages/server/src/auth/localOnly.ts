import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const CF_HEADERS = ["cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor"] as const;

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return LOOPBACK.has(addr) || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

export function viaCloudflare(headers: IncomingHttpHeaders | Headers): boolean {
  if (headers instanceof Headers) return CF_HEADERS.some((h) => headers.has(h));
  return CF_HEADERS.some((h) => headers[h] !== undefined);
}

function header(headers: IncomingHttpHeaders | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A request counts as local only if the socket peer is loopback, it carries no Cloudflare headers and the Host
 * is localhost/127.0.0.1/[::1] (SPEC §22.3). Tunnel traffic arrives from cloudflared on loopback, so the header
 * check is what distinguishes the doorway from the host PC.
 */
export function isLocalRequest(peer: string | undefined, headers: IncomingHttpHeaders | Headers): boolean {
  const host = (header(headers, "host") ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
  return (
    isLoopback(peer) && !viaCloudflare(headers) && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
  );
}

/**
 * Client IP (AC-AUTH-01): `cf-connecting-ip` when the socket peer is loopback and the header is present;
 * otherwise the socket address. Never trusts forwarding headers from non-loopback peers.
 */
export function clientIp(peer: string | undefined, headers: IncomingHttpHeaders | Headers): string {
  if (isLoopback(peer)) {
    const cf = header(headers, "cf-connecting-ip");
    if (cf && /^[0-9a-fA-F:.]{2,45}$/.test(cf.trim())) return cf.trim();
  }
  return (peer ?? "unknown").replace(/^::ffff:/, "");
}

/** "HTTPS" = TLS socket, or `x-forwarded-proto: https` on a loopback request that came through Cloudflare. */
export function isHttpsRequest(
  encrypted: boolean,
  peer: string | undefined,
  headers: IncomingHttpHeaders | Headers,
): boolean {
  if (encrypted) return true;
  return isLoopback(peer) && viaCloudflare(headers) && header(headers, "x-forwarded-proto") === "https";
}
