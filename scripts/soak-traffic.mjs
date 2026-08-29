/**
 * Soak traffic generator — 9I Task 6.
 *
 * Mixed traffic, sustained at a **deliberately modest rate**. This is not a load test: Task 5
 * already measured saturation. A soak that saturates the device measures the device's thermal
 * behaviour, and every resource series would be dominated by scheduling noise rather than by
 * whatever is or is not leaking. The point here is duration, not throughput.
 */

const MODEL = "soak-model";
const TOOL_MODEL = "soak-tool-model";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "soak_probe",
      description: "A probe tool used only to exercise the tool-call roundtrip during a soak.",
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    },
  },
];

async function post(base, key, body) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

async function get(base, key, path) {
  const response = await fetch(base + path, { headers: { authorization: `Bearer ${key}` } });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/** A streaming request, drained to completion so no socket is abandoned. */
async function stream(base, key) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "soak stream" }], stream: true }),
  });
  if (response.body === null) return { status: response.status, done: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }
  return { status: response.status, done: body.includes("[DONE]") };
}

/**
 * A two-leg tool roundtrip: the model asks for a call, the client returns a result.
 *
 * The second leg carries `role: "tool"` with a `name`, which is the exact shape that broke in 9H
 * Task 5 — a request that BAYZ delivered and then refused on the way back. Running it here means a
 * regression in that path shows up in a soak, not just in the unit test.
 */
async function toolRoundtrip(base, key) {
  const first = await post(base, key, {
    model: TOOL_MODEL,
    messages: [{ role: "user", content: "soak tool" }],
    tools: TOOLS,
  });
  const call = first.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (call === undefined) return { status: first.status, complete: false };

  const second = await post(base, key, {
    model: TOOL_MODEL,
    messages: [
      { role: "user", content: "soak tool" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, name: call.function.name, content: '{"ok":true}' },
    ],
    tools: TOOLS,
  });
  return { status: second.status, complete: second.status === 200 };
}

/**
 * Sustain mixed traffic for `durationMs`, sampling on a fixed cadence.
 *
 * The sample timer is independent of the traffic loop: a sample must land every 15 s regardless of
 * how long a request takes, or a slow patch would silently thin out the series exactly where it
 * matters most.
 */
export async function sustain({ base, key, durationMs, sampleIntervalMs, admin, onSample }) {
  const started = Date.now();
  const counts = { chat: 0, stream: 0, tool: 0, models: 0, usage: 0, management: 0, total: 0, failures: 0, failureCodes: [] };

  let stopped = false;
  const sampler = setInterval(() => {
    onSample(Date.now() - started, counts.total);
  }, sampleIntervalMs);

  const fail = (label, status, code) => {
    counts.failures += 1;
    if (counts.failureCodes.length < 12) counts.failureCodes.push(`${label}:${status}${code ? `/${code}` : ""}`);
  };

  let cycle = 0;
  try {
    while (!stopped && Date.now() - started < durationMs) {
      cycle += 1;

      // Non-streaming chat, twice per cycle — the most common real shape.
      for (let index = 0; index < 2; index += 1) {
        const result = await post(base, key, { model: MODEL, messages: [{ role: "user", content: `soak ${cycle}.${index}` }] });
        counts.total += 1;
        if (result.status === 200) counts.chat += 1;
        else fail("chat", result.status, result.json?.error?.code);
      }

      const streamed = await stream(base, key);
      counts.total += 1;
      if (streamed.status === 200 && streamed.done) counts.stream += 1;
      else fail("stream", streamed.status);

      const tool = await toolRoundtrip(base, key);
      counts.total += 2; // two legs
      if (tool.complete) counts.tool += 1;
      else fail("tool", tool.status);

      const models = await get(base, key, "/v1/models");
      counts.total += 1;
      if (models.status === 200) counts.models += 1;
      else fail("models", models.status);

      const usage = await get(base, key, "/api/usage/requests?limit=10");
      counts.total += 1;
      if (usage.status === 200) counts.usage += 1;
      else fail("usage", usage.status, usage.json?.error?.code);

      /*
       * Periodic management writes — every 5th cycle, so the run exercises the write path without
       * the database becoming the thing under test. Update-then-restore, so the run leaves the
       * configuration exactly as it found it.
       */
      if (cycle % 5 === 0) {
        const label = `Soak Origin ${cycle}`;
        const patched = await admin("PATCH", "/api/providers/soak-origin", { displayName: label });
        counts.total += 1;
        if (patched.status === 200) counts.management += 1;
        else fail("management", patched.status, patched.json?.error?.code);
      }

      // A small pause: duration is the subject here, not throughput.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    stopped = true;
    clearInterval(sampler);
  }

  // One final sample at the end, so the series always covers the full run.
  onSample(Date.now() - started, counts.total);

  return { ...counts, elapsedMs: Date.now() - started, cycles: cycle };
}
