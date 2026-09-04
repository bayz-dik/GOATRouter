/**
 * Minimal CDP driver over the `ws` already in this repo's node_modules.
 *
 * Chrome runs headless with --remote-debugging-port=9222. This opens one target,
 * navigates, waits for load, and evaluates expressions — enough to measure real
 * layout, which jsdom cannot do.
 */
import WebSocket from "ws";

const BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

async function httpJson(path, method = "GET") {
  const response = await fetch(`${BASE}${path}`, { method });
  return response.json();
}

export async function connect() {
  const target = await httpJson("/json/new?about:blank", "PUT").catch(() => undefined);
  const list = await httpJson("/json/list");
  const page =
    (target?.webSocketDebuggerUrl !== undefined ? target : undefined) ??
    list.find((entry) => entry.type === "page");
  if (page === undefined) {
    throw new Error("no page target");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry !== undefined) {
        if (message.error !== undefined) {
          entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? null)})`));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    events.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.method === message.method) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`timeout: ${method}`));
        }
      }, 30_000);
    });

  const waitEvent = (method, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const existing = events.find((event) => event.method === method);
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`timeout waiting ${method}`)), timeoutMs);
      waiters.push({ method, resolve, reject, timer });
    });

  await send("Page.enable");
  await send("Runtime.enable");

  return {
    send,
    waitEvent,
    close: () => socket.close(),
    /** Navigate and wait for the load event. */
    async goto(url) {
      events.length = 0;
      const loaded = waitEvent("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
    },
    /** Evaluate an expression and return its JSON value. */
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression: `(() => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(
          `evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },
    /** Resize the layout viewport, mobile-emulation style. */
    setViewport(width, height, mobile = false) {
      return send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
    },
    screenshot: () => send("Page.captureScreenshot", { format: "png" }),
  };
}
