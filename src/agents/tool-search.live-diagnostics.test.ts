import { describe, expect, it } from "vitest";
import {
  nonceStopCategory,
  nonceTextMetrics,
  observeNonceDispatch,
  type NonceDispatch,
  observeNonceResponse,
  summarizeNonceRequest,
  summarizeNonceRun,
} from "./tool-search.live-diagnostics.js";

const nonce = "RECEIPT_synthetic_nonce";
const privateText = "private-content-must-not-escape";
const sse = (event: unknown) => "data: " + JSON.stringify(event) + "\r\n\r\n";

async function observeChunks(text: string, width = 7) {
  const bytes = new TextEncoder().encode(text);
  const input = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += width) {
          controller.enqueue(bytes.slice(i, i + width));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "x-fixture": "preserved" } },
  );
  const observed = observeNonceResponse(input, () => nonce);
  expect(await observed.response.text()).toBe(text);
  expect(observed.response.status).toBe(200);
  expect(observed.response.headers.get("x-fixture")).toBe("preserved");
  const serialized = JSON.stringify(observed.diagnostic);
  expect(serialized.includes(nonce)).toBe(false);
  expect(serialized.includes(privateText)).toBe(false);
  return observed.diagnostic;
}

describe("content-free live nonce boundaries", () => {
  it("counts only model-bound tool output, never prompts or call arguments", () => {
    const summary = summarizeNonceRequest(
      {
        model: "fixture",
        stream: true,
        input: [
          { role: "user", content: nonce },
          { type: "function_call", call_id: "call", name: "fixture", arguments: nonce },
          { type: "function_call_output", call_id: "call", output: nonce + nonce },
        ],
      },
      nonce,
    );
    expect(summary.toolResultCount).toBe(1);
    expect(summary.toolResults[0]?.nonceCount).toBe(2);
    expect(JSON.stringify(summary).includes(nonce)).toBe(false);
    expect(nonceTextMetrics(nonce, undefined).nonceCount).toBeNull();
  });

  it("observes snapshot-only visible text without mixing deltas or reasoning", async () => {
    const item = {
      type: "message",
      id: "synthetic-message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "é " + nonce, annotations: [] },
        { type: "refusal", refusal: privateText },
      ],
    };
    const result = await observeChunks(
      sse({ type: "response.output_item.done", output_index: 0, item }) +
        sse({
          type: "response.completed",
          response: { output: [{ type: "reasoning", summary: [{ text: nonce }] }, item] },
        }),
    );
    expect(result).toMatchObject({
      terminal: "completed",
      streamEnded: true,
      observationIncomplete: false,
      itemSnapshots: [{ bytes: Buffer.byteLength("é " + nonce + privateText), nonceCount: 1 }],
      terminalSnapshot: [{ bytes: Buffer.byteLength("é " + nonce + privateText), nonceCount: 1 }],
    });
  });

  it("keeps item and terminal snapshots separate when they replace streamed text", async () => {
    const result = await observeChunks(
      sse({ type: "response.output_text.delta", delta: nonce }) +
        sse({ type: "response.output_text.done", text: nonce }) +
        sse({
          type: "response.output_item.done",
          item: { type: "message", content: [{ type: "output_text", text: privateText }] },
        }) +
        sse({
          type: "response.completed",
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: nonce }] }],
          },
        }),
    );
    expect(result.itemSnapshots).toEqual([{ bytes: privateText.length, nonceCount: 0 }]);
    expect(result.terminalSnapshot).toEqual([{ bytes: nonce.length, nonceCount: 1 }]);
  });

  it.each(["failed", "incomplete", "error"])(
    "keeps %s separate from successful provider omission",
    async (terminal) => {
      const result = await observeChunks(
        sse({
          type: terminal === "error" ? "error" : "response." + terminal,
          error: { message: privateText + nonce },
        }),
      );
      expect(result.terminal).toBe(terminal);
      expect(result.itemSnapshots).toEqual([]);
      expect(result.terminalSnapshot).toBeNull();
    },
  );

  it("flags malformed or oversized frames without changing the returned wire bytes", async () => {
    const result = await observeChunks("data: not-json\n\ndata: " + "x".repeat(1_048_577), 64_000);
    expect(result.observationIncomplete).toBe(true);
    expect(result.malformedFrames).toBe(1);
    expect(result.terminal).toBe("unobserved");
  });

  it("reserves failed dispatches before fetch and pairs a later response with its own request", async () => {
    const dispatches: NonceDispatch[] = [];
    const request = {
      model: "fixture",
      stream: true as const,
      input: [{ type: "function_call_output" as const, call_id: "call", output: nonce }],
    };
    const failed = observeNonceDispatch(
      dispatches,
      request,
      () => nonce,
      async () => {
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0]?.response).toBeUndefined();
        throw new Error(privateText);
      },
    );
    await expect(failed).rejects.toThrow(privateText);
    const response = await observeNonceDispatch(
      dispatches,
      { model: "fixture", stream: true, input: [] },
      () => nonce,
      async () => {
        expect(dispatches).toHaveLength(2);
        expect(dispatches[1]?.response).toBeUndefined();
        return new Response(sse({ type: "response.completed", response: { output: [] } }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    await response.text();
    expect(dispatches[0]).toEqual({ request: summarizeNonceRequest(request, nonce) });
    expect(dispatches[1]).toMatchObject({
      request: { toolResultCount: 0 },
      response: { terminal: "completed", terminalSnapshot: [] },
    });
    expect(JSON.stringify(dispatches)).not.toContain(nonce);
    expect(JSON.stringify(dispatches)).not.toContain(privateText);
  });

  it("distinguishes stored visible text, selected text, payload loss and error categories", () => {
    const summary = summarizeNonceRun(
      [
        { role: "user", content: [{ type: "text", text: nonce }] },
        { role: "toolResult", content: [{ type: "text", text: nonce }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: nonce },
            { type: "text", text: privateText },
          ],
          stopReason: privateText,
        },
      ],
      {
        payloads: [{ text: privateText, isError: true }],
        meta: {
          durationMs: 1,
          finalAssistantVisibleText: nonce,
          aborted: true,
          stopReason: "aborted",
          error: { kind: "incomplete_turn", message: privateText },
        },
      },
      nonce,
    );
    expect(summary.transcript.map((item) => item.nonceCount)).toEqual([1, 0]);
    expect(summary.selectedAssistant.nonceCount).toBe(1);
    expect(summary.payloads).toEqual([{ bytes: privateText.length, nonceCount: 0, isError: true }]);
    expect(summary.run).toMatchObject({
      returned: true,
      aborted: true,
      hasError: true,
      stop: "aborted",
    });
    expect(summary.transcript[1]?.stop).toBe("other");
    expect(JSON.stringify(summary).includes(nonce)).toBe(false);
    expect(JSON.stringify(summary).includes(privateText)).toBe(false);
    expect(nonceStopCategory(undefined)).toBe("absent");
    expect(summarizeNonceRun([], undefined, undefined).run.returned).toBe(false);
  });
});
