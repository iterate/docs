// Copied from iterate/private's test/helpers/fake-ai.ts at a541c9d, with Docs' specs.
// Unchanged.

// helpers/fake-ai.ts — the one fake `itx.ai`: Cloudflare's Workers AI binding played by the test,
// what a row lends in its place (`provide("itx.ai", new FakeAi())`) so a run never pays for a model
// (docs/testing.md#real-model-rows). It answers a call only with a reply the test provided for it
// (`provideReply`), so a test reads in the order its model is asked.
//
// Typed scripts follow `ItxScriptBuilder` (iterate/iterate, apps/os/e2e/test-support/
// itx-script-builder.ts): the function's own source, wrapped so its `values` arrive as JSON, and
// refused when the test's transform left a helper in it.
import { RpcTarget } from "capnweb";
import type { IterateContextApi } from "iterate/api";
import { parseCodemodeResponse } from "iterate/agents/codemode-format";

/** One `run(model, inputs, options)` as the fake received it. `messages` is typed because chat rows
 *  read it; the Responses API's `input`, or a bare `prompt`, arrive instead, through the index. */
export type FakeAiCall = {
  model: string;
  inputs: { messages: { role: string; content: string }[]; [field: string]: any };
  options?: unknown;
};

/** What a provided reply is matched against: the call's newest input, as JSON (`newestInput`). A
 *  RegExp is one; so is what `thenReply` matches a script's output with. `toString` names it in a
 *  timeout's error. */
type CallMatch = { test(newestInput: string): boolean; toString(): string };

/** The `itx` a script gets: the platform's API, and whatever the project added (`itx.agents`, a
 *  test's own `itx.go`), untyped. */
type ScriptItx = IterateContextApi & { [name: string]: any };

/** An answer in code, as a model gives one: `status` (what the agent shows while it runs), prose
 *  beside it, and `script`, which runs in the agent's sandbox. The script sees nothing of the test
 *  but `values`, which reach it as JSON (unicorn-js/isolated-functions holds it to that). What it
 *  returns, `Result`, is what a function given to `thenReply` gets. */
export type ScriptReply<Values extends Record<string, unknown>, Result> = {
  status: string;
  prose?: string;
  values?: Values;
  script: (itx: ScriptItx, values: Values) => Promise<Result>;
};

/** An answer in itself: text, which Workers AI answers as `{ response }` and an `openai/…` partner
 *  model as the Responses API's stream (a `<codemode>` block in it is the model's script, for rows
 *  about malformed answers); a script; the stream's own frames (`sseResponse`); or an Error, thrown. */
type PlainReply = string | ScriptReply<any, unknown> | unknown[] | Error;

/** An answer: a plain one, or a function of the call returning what the binding would (an object,
 *  a `Response`). */
export type FakeAiReply = PlainReply | ((call: FakeAiCall) => unknown);

/** The binding, recording every call. A test provides each reply just after what asks for it (the
 *  person's words), so it reads in the order things happen. A call takes the first provided reply
 *  that matches it; with none, it waits `replyTimeoutMs` (a second) for one and then throws, naming
 *  what it was asked. A test that wants the model busy provides a stream held on a promise, not no
 *  reply. */
export class FakeAi extends RpcTarget {
  readonly calls: FakeAiCall[] = [];
  readonly #replyTimeoutMs: number;
  readonly #provided: ProvidedReply<any>[] = [];
  /** Settles when a reply is provided, so the calls waiting look again. */
  #replyProvided = Promise.withResolvers<void>();
  constructor({ replyTimeoutMs = 1000 }: { replyTimeoutMs?: number } = {}) {
    super();
    this.#replyTimeoutMs = replyTimeoutMs;
  }

  /** Answer the next call whose newest input matches: the person's words, an interrupt, or a
   *  script's output, never the instructions and history before them. `thenReply` on what it
   *  returns answers the call that follows its script. */
  provideReply<Values extends Record<string, unknown>, Result>(
    match: CallMatch,
    reply: ScriptReply<Values, Result>,
  ): ProvidedReply<Result>;
  /** A reply whose script, if it has one, is text: what that returns is `any` to `thenReply`. */
  provideReply(match: CallMatch, reply: FakeAiReply): ProvidedReply<any>;
  provideReply(match: CallMatch, reply: FakeAiReply) {
    return this.#provide(match, () => reply);
  }

  /** Queue a reply, given by `replyFor` once a call has taken it. */
  #provide(match: CallMatch, replyFor: (call: FakeAiCall) => FakeAiReply): ProvidedReply<any> {
    const provided = new ProvidedReply(match, replyFor, (next, nextFor) =>
      this.#provide(next, nextFor),
    );
    this.#provided.push(provided);
    this.#replyProvided.resolve();
    this.#replyProvided = Promise.withResolvers<void>();
    return provided;
  }

  async run(model: string, inputs: FakeAiCall["inputs"], options?: unknown) {
    const call = { model, inputs, options };
    this.calls.push(call);
    const callId = `call_${String(this.calls.length)}`;
    const provided = await this.#take(call);
    provided.callId = callId;
    const reply = provided.replyFor(call);
    if (reply instanceof Error) throw reply;
    if (Array.isArray(reply)) return sseResponse(reply);
    const answer =
      typeof reply === "string"
        ? { response: reply }
        : typeof reply === "function"
          ? await reply(call)
          : { response: codemodeText(reply) };
    const text = (answer as { response?: unknown } | null)?.response;
    return model.startsWith("openai/") && typeof text === "string"
      ? responsesAnswer(text, callId)
      : answer;
  }

  async #take(call: FakeAiCall): Promise<ProvidedReply<any>> {
    const newest = newestInput(call);
    const deadline = Date.now() + this.#replyTimeoutMs;
    for (;;) {
      const index = this.#provided.findIndex(({ match }) => match.test(newest));
      if (index >= 0) return this.#provided.splice(index, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(
          `FakeAi: no reply provided within ${String(this.#replyTimeoutMs)} ms for a call whose newest input is ${newest}. Provided and not taken: ${this.#provided.map(({ match }) => String(match)).join(", ") || "none"}`,
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.#replyProvided.promise,
        new Promise((resolve) => (timer = setTimeout(resolve, left))),
      ]);
      clearTimeout(timer);
    }
  }
}

/** A reply the test provided, and the call id its script got once a call took it. `Result` is what
 *  its script returns. */
class ProvidedReply<Result> {
  readonly match: CallMatch;
  /** The reply, given the call that took it (a `thenReply` function reads the script's result off
   *  it). */
  readonly replyFor: (call: FakeAiCall) => FakeAiReply;
  callId: string | undefined;
  readonly #provide: (
    match: CallMatch,
    replyFor: (call: FakeAiCall) => FakeAiReply,
  ) => ProvidedReply<any>;
  constructor(
    match: CallMatch,
    replyFor: (call: FakeAiCall) => FakeAiReply,
    provide: (match: CallMatch, replyFor: (call: FakeAiCall) => FakeAiReply) => ProvidedReply<any>,
  ) {
    this.match = match;
    this.replyFor = replyFor;
    this.#provide = provide;
  }

  /** Answer the call that shows the model what this reply's script returned: with a reply, or with
   *  a function of what it returned (typed as the script's return) that gives one. A script that
   *  failed returned nothing: the function is skipped and the answer is the script's error, so a
   *  row's check on the answer names it. */
  thenReply<Values extends Record<string, unknown>, NextResult>(
    reply: ScriptReply<Values, NextResult>,
  ): ProvidedReply<NextResult>;
  thenReply(reply: PlainReply | ((result: Result) => PlainReply)): ProvidedReply<any>;
  thenReply(reply: PlainReply | ((result: Result) => PlainReply)) {
    return this.#provide(this.#output, (call) =>
      typeof reply === "function" ? replyToResult(call, reply) : reply,
    );
  }

  /** Matches the call whose newest input is this reply's script output, by the call id it got. */
  readonly #output: CallMatch = {
    test: (newest) => {
      const item = newest ? JSON.parse(newest) : null;
      return item?.type === "function_call_output" && item.call_id === this.callId;
    },
    toString: () => `the output of the script answering ${String(this.match)}`,
  };
}

/** A call's newest input, as JSON: the last item of the Responses API's `input` (or the last chat
 *  message) that isn't the platform's own developer or system message, such as the time the agent
 *  made the request; or the bare prompt; or nothing, for a call with no inputs at all. */
function newestInput(call: FakeAiCall) {
  const { input, messages, prompt } = call.inputs || {};
  const items: any[] = Array.isArray(input) ? input : messages || [];
  return (
    JSON.stringify(
      items.findLast((item) => item.role !== "developer" && item.role !== "system") ||
        input ||
        prompt,
    ) || ""
  );
}

/** What a `thenReply` function replies for `call`, given what the script returned: read off how the
 *  agent showed it to the model (core/lib/src/agents/result-render.ts), a string from its plain
 *  fence, anything else from its JSON fence. A script that failed is answered with its error. */
function replyToResult(call: FakeAiCall, reply: (result: any) => PlainReply): PlainReply {
  const output = String(JSON.parse(newestInput(call)).output);
  if (output.startsWith("Your script failed"))
    return `FakeAi: the script failed, so there is no result to reply to.\n${output}`;
  const fenced = /^Your script returned(?: \([^)]*\))?:\n```(json)?\n([^]*?)\n```/.exec(output);
  if (!fenced) throw new Error(`FakeAi: no result to read in the script's output:\n${output}`);
  return reply(fenced[1] ? JSON.parse(fenced[2]!) : fenced[2]);
}

/** What a test's transform can leave in a function's source that the agent's sandbox doesn't
 *  have: Vite's import bindings, Oxc's and esbuild's spellings of `using` and async helpers. */
const TRANSFORM_LEFTOVERS = [
  /(?<![\w$])__vite_ssr_import_/,
  /(?<![\w$])_usingCtx(?![\w$])/,
  /(?<![\w$])__(?:using|async|await|name)\s*\(/,
];

/** A script reply as the model's text: its prose, then the `<codemode>` block, the script being
 *  the test's own function called with its values. */
function codemodeText({ status, prose, values, script }: ScriptReply<any, unknown>) {
  const source = script.toString();
  if (!/^async\s*\([^]*?\)\s*=>\s*\{[^]*\}$/.test(source))
    throw new Error(
      `FakeAi: a script is an async arrow function with a block body, taking (itx) or (itx, values). Got:\n${source}`,
    );
  const leftover = TRANSFORM_LEFTOVERS.find((marker) => marker.test(source));
  if (leftover)
    throw new Error(
      `FakeAi: the script holds ${String(leftover)}, a helper the test's transform added, which the agent's sandbox doesn't have. Got:\n${source}`,
    );
  const code = `async (itx) => {\n  return await (${source})(itx, ${JSON.stringify(values || {})});\n}`;
  return `${prose ? `${prose}\n` : ""}<codemode status="${status}">\n${code}\n</codemode>`;
}

/** A streamed answer: each frame one Server-Sent Event's `data:` line, in order. A promise among the
 *  frames holds the stream until it settles; one that never settles never ends it. */
function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        if (frame instanceof Promise) await frame;
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

/** The model's text as the agent loop's model answers it through the Responses API: the prose as a
 *  message, and a `<codemode status="…">` block as a call of the one tool, `run({ status, script })`
 *  (core/lib/src/agents/render.ts `RUN_TOOL`), with `callId`. */
function responsesAnswer(text: string, callId: string) {
  const parsed = parseCodemodeResponse(text);
  const prose = parsed.kind === "script" || parsed.kind === "none" ? parsed.prose?.trim() : text;
  const output = [
    ...(prose ? [messageItem(prose)] : []),
    ...(parsed.kind === "script"
      ? [
          {
            type: "function_call",
            call_id: callId,
            name: "run",
            arguments: JSON.stringify({ status: parsed.status || "", script: parsed.code }),
          },
        ]
      : []),
  ];
  return sseResponse([
    ...(prose ? [{ type: "response.output_text.delta", delta: prose }] : []),
    {
      type: "response.completed",
      response: { output, usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ]);
}

/** The Responses API's output item for prose, as `response.completed` lists it: the agent loop reads
 *  its answer from the items (core/lib/src/agents/processor.ts `#stream`), the deltas only stream. */
export function messageItem(text: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

/** `sseStream(frames)` as a partner model's (the Responses API's) HTTP answer. */
export function sseResponse(frames: unknown[]) {
  return new Response(sseStream(frames), { headers: { "content-type": "text/event-stream" } });
}
