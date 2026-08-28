import {
  dispatchToolCalls,
  lookupCapability,
  type DispatchOutcome,
  type DispatchPrincipal,
} from "@bayz/capability";
import type { ChatResult, Router } from "@bayz/router";

/**
 * How many upstream turns one client request may consume.
 *
 * Bounded in *turns*, not wall-clock: a turn is a real upstream request that costs
 * money and holds a socket, so the count is the thing an operator can reason about and
 * the thing a hostile model can inflate. Four allows a genuine chain — call, refine,
 * call, answer — while making the worst case boring.
 *
 * The last turn is never allowed to dispatch: reaching it means the model asked for
 * another tool after its budget was spent, so the request is refused rather than
 * answered with a half-finished conversation.
 */
export const MAX_DISPATCH_TURNS = 4;

export type ToolLoopErrorCode = "tool_dispatch_exhausted" | "tool_dispatch_split";

/**
 * Fixed messages, for the same reason every other Bayz error class uses them: this
 * error is produced in response to **model output**, and its message reaches an
 * operator's structured log and the client's error body. Interpolating anything the
 * upstream said would be an instruction-smuggling path.
 */
const MESSAGES: Record<ToolLoopErrorCode, string> = {
  tool_dispatch_exhausted:
    "tool_dispatch_exhausted: the model requested more tool turns than this deployment allows",
  tool_dispatch_split:
    "tool_dispatch_split: a response mixed server-dispatched and client-side tool calls",
};

export class ToolLoopError extends Error {
  readonly code: ToolLoopErrorCode;
  readonly stage: string | undefined;

  constructor(code: ToolLoopErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "ToolLoopError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * A refusal from the dispatch pipeline, re-thrown so the HTTP error map can render it.
 *
 * `code` and `stage` are carried verbatim because both are fixed vocabulary from
 * `@bayz/capability`; the model's arguments, name, and the handler's own error message
 * are all absent by construction.
 */
export class CapabilityRefusedError extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(outcome: Extract<DispatchOutcome, { status: "refused" }>) {
    super(`${outcome.code}: the tool call was refused (stage: ${outcome.stage})`);
    this.name = "CapabilityRefusedError";
    this.code = outcome.code;
    this.stage = outcome.stage;
  }
}

/** The wire shape of one tool call, as the router hands it back. */
type WireToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type RunToolLoopOptions = {
  readonly router: Router;
  readonly principal: DispatchPrincipal;
  /**
   * The normalized request, exactly as the gateway produced it.
   *
   * Deliberately **not** inspected before the router has validated it — see
   * `runToolLoop`. The type is permissive for the same reason: narrowing it here would
   * imply a guarantee this layer has not checked.
   */
  readonly request: Record<string, unknown>;
  readonly requestId: string;
};

/**
 * Run a chat request, dispatching any tool calls this deployment can service itself.
 *
 * The whole design rests on one distinction: a tool call BAYZ has a **registered
 * capability** for is BAYZ's to run, and everything else belongs to the client. With an
 * empty registry — the shipped default — this function makes exactly one router call
 * and returns exactly what Phase 9B returned, which is why adding it changes no
 * existing deployment's behaviour.
 *
 * Client-side tools remain the client's business. An unregistered call is handed back
 * untouched rather than refused: BAYZ has nothing to run, and inventing a refusal would
 * break every client that declares its own tools — which is most of them.
 */
export async function runToolLoop(options: RunToolLoopOptions): Promise<ChatResult> {
  const { router, principal, requestId } = options;

  /*
   * The first turn passes the request through **untouched**.
   *
   * This is load-bearing. `router.chat` owns request validation, and it must be the
   * thing that rejects a malformed body — a `{}` payload has no `messages` at all, and
   * reading `.messages` here to seed the loop turned a clean 400 `invalid_request` into
   * a 500 on a `[...undefined]` spread. Found by `chat-api.test.ts`, which pins that
   * exact refusal.
   *
   * So the conversation is only reconstructed *after* a turn has come back with tool
   * calls, at which point the request is known to have validated.
   */
  let pending: Record<string, unknown> = options.request;

  for (let turn = 1; turn <= MAX_DISPATCH_TURNS; turn += 1) {
    const result = await router.chat(pending, { requestId });

    const calls = result.toolCalls as WireToolCall[] | undefined;
    if (calls === undefined || calls.length === 0) {
      return result;
    }

    /*
     * Partition by what is registered, and refuse a split batch.
     *
     * Running the server-side half and handing the client-side half back would perform
     * a side effect and then return a conversation neither party can reconcile: the
     * client cannot know which calls already ran, and the model's next turn would be
     * missing a result it is expecting. Refusing is the only outcome with no ambiguity
     * in it, and it happens before anything is dispatched.
     */
    const dispatchable = calls.filter(
      (call) => lookupCapability(call.function.name) !== undefined,
    );
    if (dispatchable.length === 0) {
      // Nothing here is ours. Forward the response exactly as 9B did.
      return result;
    }
    if (dispatchable.length !== calls.length) {
      throw new ToolLoopError("tool_dispatch_split", "tool-loop-partition");
    }

    if (turn === MAX_DISPATCH_TURNS) {
      // The budget is spent and the model wants another tool. Refusing beats returning
      // a conversation whose last turn is an unanswered call.
      throw new ToolLoopError("tool_dispatch_exhausted", "tool-loop-turns");
    }

    /*
     * Authority is re-established here, on every turn, from the authenticated
     * principal — never from the previous turn's output. `dispatchToolCalls` checks the
     * scope before it calls a handler's `parse`, so an unauthorized caller's input never
     * reaches attacker-reachable validation code.
     */
    const outcomes = await dispatchToolCalls({ principal, calls, depth: 1 });

    const refused = outcomes.find((outcome) => outcome.status === "refused");
    if (refused !== undefined && refused.status === "refused") {
      // Surfaced as a fixed code. A partial batch is not reported as a success: if any
      // call in the response was refused, the request fails.
      throw new CapabilityRefusedError(refused);
    }

    /*
     * Carry the conversation forward.
     *
     * The assistant's tool-call message is replayed before the results, because a
     * `role: "tool"` message is only interpretable next to the call it answers — the
     * router's own parser enforces exactly that by requiring a known `tool_call_id`.
     *
     * `pending.messages` is safe to read now: the request validated on the turn that
     * produced these calls, so `messages` is a non-empty array.
     */
    pending = {
      ...pending,
      messages: [
        ...(pending.messages as unknown[]),
        { role: "assistant", content: null, tool_calls: calls },
        ...outcomes.map((outcome) => ({
          role: "tool",
          tool_call_id: outcome.id,
          // Serialized here rather than in the capability so a handler returns data and
          // never has to think about the wire. Bounded by dispatch before it arrives.
          content: JSON.stringify(outcome.status === "ok" ? outcome.output : null),
        })),
      ],
    };
  }

  // Unreachable: the `turn === MAX_DISPATCH_TURNS` branch above refuses first. Present
  // so the function is total rather than relying on that reasoning holding after an
  // edit.
  throw new ToolLoopError("tool_dispatch_exhausted", "tool-loop-fallthrough");
}
