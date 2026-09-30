import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import { clientIp, isLoopback } from "../auth/localOnly.ts";
import type { BucketMap } from "../auth/rateLimit.ts";

/** The most a matchmaking request's body may hold: a room id and a join ticket are a few hundred bytes. */
export const MATCHMAKE_MAX_BODY = 16 * 1024;

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Colyseus answers `/matchmake/…` itself, ahead of Express (its request listener is prepended), and reads a request's
 * whole JSON body before its room ever judges it: the body limit, the rate limit and the checks Express applies never
 * ran there — a few chunked 100-MB posts, with no invite code, took the server's memory (security review M1). Every
 * request listener the server has is wrapped once it's listening: a matchmaking request is judged first — a body
 * without a declared length, chunked, or over 16 KiB is refused unread (the connection closed rather than drained),
 * and one address may make only so many — then the request goes on to the listeners as before, in their order.
 */
export function guardMatchmaking(server: HttpServer, limiter: BucketMap): void {
  const listeners = server.listeners("request") as Listener[];
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/matchmake/")) {
      const refuse = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        // (The body isn't read: the socket goes once the answer is out.)
        res.end(JSON.stringify({ error: message }), () => req.socket.destroy());
      };
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        const length = Number(req.headers["content-length"]);
        if (
          req.headers["transfer-encoding"] !== undefined ||
          !Number.isFinite(length) ||
          length > MATCHMAKE_MAX_BODY
        )
          return refuse(413, "Too large");
      }
      // (This computer's own requests aren't counted: it's the host, trusted everywhere else too.)
      const ip = clientIp(req.socket.remoteAddress, req.headers);
      if (!isLoopback(ip) && !limiter.take(`ip:${ip}`)) return refuse(429, "Slow down");
    }
    for (const l of listeners) l.call(server, req, res);
  });
}
