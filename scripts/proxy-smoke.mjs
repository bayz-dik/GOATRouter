#!/usr/bin/env node
/**
 * Non-mocked proxy proof for Phase 4.
 *
 * Runs against a real on-disk SQLite database, real SOCKS5 and HTTP CONNECT
 * servers on loopback, real sockets, and a real `node:http` request through the
 * proxy agent. In-process unit tests cannot show that a tunneled request actually
 * completes, or that a password really is absent from the bytes on disk.
 *
 * Exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { get as httpGet, createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORAGE_ENTRY = fileURLToPath(
  new URL("../packages/storage/src/index.ts", import.meta.url),
);
const PROXY_ENTRY = fileURLToPath(
  new URL("../packages/proxy/src/index.ts", import.meta.url),
);

if (!process.env.BAYZ_PROXY_SMOKE_LOADER) {
  const relaunch = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, BAYZ_PROXY_SMOKE_LOADER: "1" } },
  );
  process.exit(relaunch.status ?? 1);
}

const PASSWORD = "hunter2-PROXY-SMOKE-must-never-touch-disk-7781";
const USERNAME = "bayz-smoke";
const KEK_HEX = Buffer.alloc(32, 0x2a).toString("hex");

const captured = [];
const failures = [];
let checks = 0;

/**
 * Record one check, numbered.
 *
 * The number is what makes a citation resolvable: 9L Task 1's `resolveEvidence` refuses
 * `smoke:<script>#<n>` against a script that prints no numbers, because `#n` cannot be looked up in
 * output that has none — and 9L Task 2's feature inventory needs exactly that citation for the
 * Phase 1-8 features this script proves. **Numbers are contractual: append checks, never insert
 * one**, or every citation after the insertion point silently starts pointing at the wrong check.
 */
function check(label, condition) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${String(checks).padStart(2)}  ${label}`);
  } else {
    console.error(`  FAIL ${String(checks).padStart(2)}  ${label}`);
    failures.push(`#${checks} ${label}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function logger(payload) {
  captured.push(JSON.stringify(payload));
}

const openSockets = new Set();

function track(socket) {
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}

/** A real origin server, reached only through a proxy in this script. */
async function startOrigin() {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`origin:${request.url}`);
  });
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/** A real HTTP CONNECT proxy that requires Basic auth and pipes both ways. */
async function startConnectProxy(originPort) {
  const transcript = [];
  const server = createServer((client) => {
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, Buffer.from(chunk)]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      client.off("data", onData);
      const request = head.subarray(0, end).toString("utf8");
      transcript.push(request);

      const auth = /proxy-authorization: Basic (\S+)/i.exec(request);
      const expected = Buffer.from(`${USERNAME}:${PASSWORD}`, "utf8").toString("base64");
      if (auth === null || auth[1] !== expected) {
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.end();
        return;
      }

      const rest = head.subarray(end + 4);
      const upstream = track(
        connect({ host: "127.0.0.1", port: originPort }, () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) {
            upstream.write(rest);
          }
          client.pipe(upstream);
          upstream.pipe(client);
        }),
      );
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, transcript };
}

/** A real SOCKS5 proxy requiring username/password, piping to the origin. */
async function startSocks5Proxy(originPort) {
  const transcript = [];
  const server = createServer((client) => {
    track(client);
    let stage = "greeting";
    let buffer = Buffer.alloc(0);

    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      transcript.push(Buffer.from(chunk));

      if (stage === "greeting" && buffer.length >= 2) {
        const count = buffer[1];
        if (buffer.length < 2 + count) {
          return;
        }
        const methods = [...buffer.subarray(2, 2 + count)];
        buffer = buffer.subarray(2 + count);
        if (!methods.includes(0x02)) {
          client.write(Buffer.from([0x05, 0xff]));
          client.end();
          return;
        }
        client.write(Buffer.from([0x05, 0x02]));
        stage = "auth";
      }

      if (stage === "auth" && buffer.length >= 2) {
        const userLen = buffer[1];
        if (buffer.length < 2 + userLen + 1) {
          return;
        }
        const passLen = buffer[2 + userLen];
        if (buffer.length < 3 + userLen + passLen) {
          return;
        }
        const user = buffer.subarray(2, 2 + userLen).toString("utf8");
        const pass = buffer
          .subarray(3 + userLen, 3 + userLen + passLen)
          .toString("utf8");
        buffer = buffer.subarray(3 + userLen + passLen);
        if (user !== USERNAME || pass !== PASSWORD) {
          client.write(Buffer.from([0x01, 0x01]));
          client.end();
          return;
        }
        client.write(Buffer.from([0x01, 0x00]));
        stage = "connect";
      }

      if (stage === "connect" && buffer.length >= 5) {
        const atyp = buffer[3];
        let headerLength;
        if (atyp === 0x01) {
          headerLength = 4 + 4 + 2;
        } else if (atyp === 0x03) {
          headerLength = 4 + 1 + buffer[4] + 2;
        } else if (atyp === 0x04) {
          headerLength = 4 + 16 + 2;
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.end();
          return;
        }
        if (buffer.length < headerLength) {
          return;
        }
        const rest = buffer.subarray(headerLength);
        buffer = Buffer.alloc(0);
        stage = "piping";

        const upstream = track(
          connect({ host: "127.0.0.1", port: originPort }, () => {
            client.write(
              Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]),
            );
            if (rest.length > 0) {
              upstream.write(rest);
            }
            client.pipe(upstream);
            upstream.pipe(client);
          }),
        );
        upstream.on("error", () => client.destroy());
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, transcript };
}

function readDatabaseBytes(dataDir) {
  const base = join(dataDir, "bayz.db");
  const parts = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) {
      parts.push(readFileSync(file));
    }
  }
  return Buffer.concat(parts);
}

function requestThrough(agent, originPort, path) {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host: "127.0.0.1", port: originPort, path, agent },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("error", reject);
  });
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "bayz-proxy-smoke-"));
  const dataDir = join(root, ".bayz");
  const { openSecretStorage, StorageError } = await import(STORAGE_ENTRY);
  const { createProxyManager, ProxyError } = await import(PROXY_ENTRY);

  const origin = await startOrigin();
  const connectProxy = await startConnectProxy(origin.port);
  const socksProxy = await startSocks5Proxy(origin.port);

  try {
    section(
      `1. Register real proxies (CONNECT :${connectProxy.port}, SOCKS5 :${socksProxy.port})`,
    );
    let manager = createProxyManager({
      storage: openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
        logger,
      }),
      logger,
    });

    try {
      const httpProxy = manager.createProxy({
        id: "smoke-http",
        kind: "http",
        host: "127.0.0.1",
        port: connectProxy.port,
        username: USERNAME,
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "127.0.0.1",
          healthCheckPort: origin.port,
        },
      });
      check("http proxy row created", httpProxy.id === "smoke-http");
      check("password absent at creation", httpProxy.passwordPresent === false);
      check("database file exists on disk", existsSync(join(dataDir, "bayz.db")));

      const socks = manager.createProxy({
        id: "smoke-socks5",
        kind: "socks5",
        host: "127.0.0.1",
        port: socksProxy.port,
        username: USERNAME,
        config: {
          connectTimeoutMs: 5000,
          healthCheckHost: "127.0.0.1",
          healthCheckPort: origin.port,
        },
      });
      check("socks5 proxy row created", socks.kind === "socks5");
      check(
        "no password accessor is exposed",
        typeof manager.getPassword === "undefined",
      );

      section("2. A dial without a stored password fails closed");
      let missingCode;
      try {
        await manager.checkProxy("smoke-http");
      } catch (error) {
        missingCode = error instanceof ProxyError ? error.code : "unknown";
      }
      check("missing password is refused", missingCode === "password_missing");

      section("3. Store passwords through envelope encryption");
      manager.setPassword("smoke-http", PASSWORD);
      manager.setPassword("smoke-socks5", PASSWORD);
      check("password presence is reported", manager.hasPassword("smoke-http"));
      check(
        "password presence appears on the view",
        manager.requireProxy("smoke-socks5").passwordPresent === true,
      );

      section("4. Check both proxies over real sockets");
      const httpCheck = await manager.checkProxy("smoke-http");
      check("http proxy check succeeded", httpCheck.ok === true);
      check("http proxy check reports latency", typeof httpCheck.latencyMs === "number");
      const socksCheck = await manager.checkProxy("smoke-socks5");
      check("socks5 proxy check succeeded", socksCheck.ok === true);
      check("socks5 proxy check reports its kind", socksCheck.kind === "socks5");

      section("5. Complete a real HTTP request through the CONNECT proxy");
      const agent = manager.agentFor("smoke-http");
      const body = await requestThrough(agent, origin.port, "/through-connect");
      agent.destroy();
      check(
        "the tunneled response came from the origin",
        body === "origin:/through-connect",
      );
      check(
        "the proxy really saw a CONNECT request",
        connectProxy.transcript.some((entry) => entry.startsWith("CONNECT ")),
      );
      check(
        "no proxy request line carried the raw password",
        connectProxy.transcript.every((entry) => !entry.includes(PASSWORD)),
      );

      section("6. Complete a real HTTP request through the SOCKS5 proxy");
      const socksAgent = manager.agentFor("smoke-socks5");
      const socksBody = await requestThrough(socksAgent, origin.port, "/through-socks");
      socksAgent.destroy();
      check(
        "the socks-tunneled response came from the origin",
        socksBody === "origin:/through-socks",
      );
      const socksBytes = Buffer.concat(socksProxy.transcript);
      check(
        "the socks5 password appears only in the RFC 1929 exchange",
        socksBytes.includes(Buffer.from(PASSWORD, "utf8")),
      );
      check(
        "the socks5 greeting itself carries no password",
        !socksProxy.transcript[0]?.includes(Buffer.from(PASSWORD, "utf8")),
      );

      section("7. A wrong password is rejected by the real proxy");
      manager.setPassword("smoke-http", "wrong-password-value");
      let authCode;
      let authMessage = "";
      try {
        await manager.checkProxy("smoke-http");
      } catch (error) {
        authCode = error instanceof ProxyError ? error.code : "unknown";
        authMessage = String(error?.message ?? "");
      }
      check("a rejected password maps to auth_failed", authCode === "auth_failed");
      check(
        "the proxy response never reaches the message",
        !authMessage.includes("wrong-password-value"),
      );
      manager.setPassword("smoke-http", PASSWORD);

      section("8. Hostile registration input is refused");
      let idCode;
      try {
        manager.createProxy({
          id: "bad'; DROP TABLE proxies; --",
          kind: "http",
          host: "127.0.0.1",
          port: 8080,
        });
      } catch (error) {
        idCode = error instanceof ProxyError ? error.code : "unknown";
      }
      check("an injection-shaped id is rejected", idCode === "invalid_proxy_id");
      check("the registry is intact", manager.listProxies().length === 2);

      let hostCode;
      try {
        manager.createProxy({
          id: "url-host",
          kind: "http",
          host: "http://127.0.0.1",
          port: 8080,
        });
      } catch (error) {
        hostCode = error instanceof ProxyError ? error.code : "unknown";
      }
      check("a URL in the host field is rejected", hostCode === "invalid_proxy_config");
    } finally {
      manager.close();
    }

    section("9. Reopen in a SEPARATE PROCESS and confirm persistence");
    {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
          const { openSecretStorage } = await import(${JSON.stringify(STORAGE_ENTRY)});
          const { createProxyManager } = await import(${JSON.stringify(PROXY_ENTRY)});
          const manager = createProxyManager({
            storage: openSecretStorage({
              dataDir: ${JSON.stringify(dataDir)},
              env: { BAYZ_MASTER_KEY: ${JSON.stringify(KEK_HEX)} },
            }),
          });
          try {
            process.stdout.write(JSON.stringify({
              ids: manager.listProxies().map((p) => p.id),
              passwordPresent: manager.requireProxy("smoke-http").passwordPresent,
              hasAccessor: typeof manager.getPassword !== "undefined",
            }));
          } finally {
            manager.close();
          }
        `,
        ],
        { encoding: "utf8", env: { ...process.env, BAYZ_PROXY_SMOKE_LOADER: "1" } },
      );
      check("child process reopened the database", child.status === 0);
      let parsed = {};
      try {
        parsed = JSON.parse(child.stdout.trim());
      } catch {
        // Reported by the checks below.
      }
      check(
        "proxy rows survived the reopen",
        JSON.stringify(parsed.ids) === JSON.stringify(["smoke-http", "smoke-socks5"]),
      );
      check(
        "password survived the reopen and is still only reported as present",
        parsed.passwordPresent === true && parsed.hasAccessor === false,
      );
    }

    section("10. Scan the real bytes on disk");
    {
      const bytes = readDatabaseBytes(dataDir);
      check("database bytes were read", bytes.byteLength > 0);
      check(
        "the password is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(PASSWORD, "utf8")),
      );
      check(
        "no base64 form of the password is on disk",
        !bytes.includes(
          Buffer.from(
            Buffer.from(`${USERNAME}:${PASSWORD}`, "utf8").toString("base64"),
            "utf8",
          ),
        ),
      );
      check(
        "the root key is absent from bayz.db, -wal, and -shm",
        !bytes.includes(Buffer.from(KEK_HEX, "utf8")),
      );
      check(
        "the username is present, proving the scan reads real content",
        bytes.includes(Buffer.from(USERNAME, "utf8")),
      );
    }

    section("11. Scan captured log output");
    {
      const logs = captured.join("\n");
      check("log output was captured", captured.length > 0);
      check("no password in the logs", !logs.includes(PASSWORD));
      check("no root key in the logs", !logs.includes(KEK_HEX));
      check("the check was logged", logs.includes("proxy_checked"));
    }

    section("12. A tampered password fails closed");
    {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
      });
      const tamperedManager = createProxyManager({ storage });
      try {
        storage.corruptForTest("proxy:smoke-http:password", "ciphertext");
        let code;
        let returned = Symbol("untouched");
        try {
          returned = tamperedManager.hasPassword("smoke-http");
        } catch (error) {
          code = error instanceof StorageError ? error.code : "unknown";
        }
        check("tampering raises secret_corrupt", code === "secret_corrupt");
        check(
          "tampering never reports the password as merely absent",
          returned !== false,
        );
      } finally {
        tamperedManager.close();
      }
    }

    section("13. Deleting a proxy removes its password");
    {
      const storage = openSecretStorage({
        dataDir,
        env: { BAYZ_MASTER_KEY: KEK_HEX },
      });
      const cleanupManager = createProxyManager({ storage });
      try {
        cleanupManager.deleteProxy("smoke-http");
        cleanupManager.deleteProxy("smoke-socks5");
        check("no proxy rows remain", cleanupManager.listProxies().length === 0);
        check("no password outlives its proxy", storage.list().length === 0);
      } finally {
        cleanupManager.close();
      }
    }
  } finally {
    for (const socket of openSockets) {
      socket.destroy();
    }
    await new Promise((resolve) => connectProxy.server.close(resolve));
    await new Promise((resolve) => socksProxy.server.close(resolve));
    await new Promise((resolve) => origin.server.close(resolve));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.error("proxy smoke: FAIL");
    process.exit(1);
  }
  console.log("proxy smoke: PASS");
}

main().catch((error) => {
  console.error("proxy smoke: FAIL");
  console.error(error);
  process.exit(1);
});
