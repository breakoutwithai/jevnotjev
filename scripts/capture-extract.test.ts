import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractHealth, extractNginx, nginxRecord } from "./capture-extract.ts";

// #86 / #89 gate: the fixture capture writes only allowlisted facts, never raw config or bodies.
// Expected values are the literals written into each input below, not recomputed by the extractor.
const SECRET = "SYNTHETIC_SECRET_9f2c";

const NGINX_T = [
  "# configuration file /etc/nginx/nginx.conf:",
  "user www-data;",
  "worker_processes auto;",
  "http {",
  "    # configuration file /etc/nginx/sites-enabled/a.example.com:",
  "    server {",
  "        listen 443 ssl;",
  "        listen [::]:443 ssl;",
  "        server_name a.example.com www.a.example.com;",
  `        proxy_set_header Authorization "Basic ${SECRET}";`,
  `        set $api_key ${SECRET};`,
  `        # a comment that names ${SECRET}`,
  "        location / {",
  `            proxy_set_header X-Multi "first part`,
  `                ${SECRET} continued on the next line";`,
  "            proxy_pass http://127.0.0.1:3000;",
  "        }",
  "    }",
  "    server {",
  "        listen 80;",
  "        server_name jevnotjev.breakoutwithai.com;",
  `        add_header X-Note '${SECRET} in single quotes';`,
  "        include /etc/nginx/snippets/jevnotjev-backstage.conf;",
  "    }",
  "}",
].join("\n");

describe("nginx allowlist extraction", () => {
  test("[unit] #86 server_name, listen ports and user are extracted exactly", () => {
    expect(extractNginx(NGINX_T)).toEqual({
      user: "www-data",
      servers: [
        { serverNames: ["a.example.com", "www.a.example.com"], listen: [443] },
        { serverNames: ["jevnotjev.breakoutwithai.com"], listen: [80] },
      ],
    });
  });

  test("[unit] #86 a secret anywhere else (single line, multiline quoted, comment, quoted) never reaches the record", () => {
    const record = nginxRecord(NGINX_T, "yes", "a".repeat(64));
    expect(record).not.toContain(SECRET);
    expect(record).not.toContain("Basic");
    expect(JSON.parse(record)).toEqual({
      user: "www-data",
      servers: [
        { serverNames: ["a.example.com", "www.a.example.com"], listen: [443] },
        { serverNames: ["jevnotjev.breakoutwithai.com"], listen: [80] },
      ],
      snippet: { auth: "yes", sha256: "a".repeat(64) },
    });
  });

  test("[unit] #86 unparseable input fails instead of emitting text", () => {
    expect(() => extractNginx("server {\n listen 443;\n")).toThrow("unbalanced");
    expect(() => extractNginx(`server { proxy_set_header X "unterminated ${SECRET};\n}`)).toThrow("unterminated");
    expect(() => extractNginx("server { server_name ~^(?<x>.+)$; }")).toThrow("server_name");
    expect(() => extractNginx("server { listen unix:/run/x.sock; }")).toThrow("listen");
    expect(() => extractNginx("user nobody nogroup extra;")).toThrow("user");
    for (const bad of [() => extractNginx("server { server_name ~^(?<x>.+)$; }"), () => extractNginx(`server { server_name ${SECRET}\u0000; }`)]) {
      try {
        bad();
      } catch (e) {
        expect(String(e)).not.toContain(SECRET);
        expect(String(e)).not.toContain("(?<x>");
      }
    }
  });

  test("[unit] #86 the snippet facts are validated: auth yes|no|unknown, a 64-hex sha256", () => {
    expect(() => nginxRecord(NGINX_T, "maybe", "a".repeat(64))).toThrow("auth");
    expect(() => nginxRecord(NGINX_T, "yes", "not-a-sha")).toThrow("sha256");
  });

  test("[unit] #86 the repo's own Backstage snippet parses (locations are not servers)", () => {
    const snippet = readFileSync(join(import.meta.dir, "..", ".deploy/backstage-nginx.conf"), "utf8");
    expect(extractNginx(snippet)).toEqual({ user: null, servers: [] });
  });
});

describe("committed fixtures have the capture's allowlisted shape", () => {
  test("[unit] #86 no fixture carries a page body; health bodies are the four fields; DEPLOYED_SHA a SHA token", () => {
    const dir = join(import.meta.dir, "..", ".deploy/tests/fixtures");
    const files = [...new Bun.Glob("**/http/*.txt").scanSync(dir)];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const body = text.slice(text.indexOf("\n---\n") + 5).trim();
      if (body === "") continue;
      if (file.includes("_DEPLOYED_SHA")) {
        expect(body).toMatch(/^(\{\{STATIC_SHA\}\}|[0-9a-f]{40})$/);
      } else {
        expect(file).toContain("_api_backstage_health");
        const filled = body.replace("{{BACKSTAGE_SHA}}", "0123456789abcdef0123456789abcdef01234567");
        expect(JSON.parse(filled)).toEqual(extractHealth(filled));
      }
    }
  });
});

describe("health allowlist extraction", () => {
  // Shape of src/backstage/server.ts:117-140 (the /api/backstage/health body).
  const body = JSON.stringify({
    protocol: "backstage/2",
    version: "0123456789abcdef0123456789abcdef01234567",
    catalogVersion: "2026-10-04.1",
    catalog: { version: "NESTED", note: SECRET },
    origin: "https://jevnotjev.breakoutwithai.com",
    trial: { available: false, reason: `Trial unavailable ${SECRET}` },
  });

  test("[unit] #86 only version, protocol, catalogVersion and trial.available are kept", () => {
    expect(extractHealth(body)).toEqual({
      version: "0123456789abcdef0123456789abcdef01234567",
      protocol: "backstage/2",
      catalogVersion: "2026-10-04.1",
      trial: { available: false },
    });
    expect(JSON.stringify(extractHealth(body))).not.toContain(SECRET);
  });

  test("[unit] #86 a body that is not the health shape fails", () => {
    expect(() => extractHealth("<html>502 Bad Gateway</html>")).toThrow("JSON");
    expect(() => extractHealth(JSON.stringify({ version: "x" }))).toThrow();
    expect(() => extractHealth(body.replace('"available":false', '"available":"no"'))).toThrow("trial.available");
    expect(() => extractHealth(body.replace("backstage/2", `backstage/2 ${SECRET}`))).toThrow("protocol");
  });
});
