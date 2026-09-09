import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { RawAsrSegment } from "@clip/sdk";

export interface MockFunasrServerOptions {
  host?: string;
  port?: number;
  fixturePath: string;
}

export async function startMockFunasrServer(options: MockFunasrServerOptions): Promise<() => Promise<void>> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 17860;
  const fixture = JSON.parse(await readFile(options.fixturePath, "utf-8")) as RawAsrSegment[];
  const durationMs = fixture.at(-1)?.endMs ?? 0;

  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "mock" }));
      return;
    }

    if (req.url === "/v1/transcribe" && req.method === "POST") {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ rawSegments: fixture, durationMs }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`mock funasr listening on http://${host}:${port}`);

  return async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
