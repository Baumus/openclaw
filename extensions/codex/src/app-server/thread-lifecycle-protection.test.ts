import { afterEach, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  protectCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import { releaseCodexBoundLiveThread } from "./thread-lifecycle-warm.js";

const clients: CodexAppServerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function fixture() {
  const { client } = createClientHarness();
  clients.push(client);
  ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/synthetic-agent" });
  const unsubscribe = vi.fn(async () => undefined);
  await retainCodexAppServerLiveThread(client, "parent", unsubscribe, "old-policy");
  const options = {
    client,
    threadId: "parent",
    lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
  };
  return { client, unsubscribe, options };
}

it("defers cold resume until every child releases protection, without unsubscribing early", async () => {
  const { client, unsubscribe, options } = await fixture();
  const first = protectCodexAppServerLiveThread(client, "parent");
  const second = protectCodexAppServerLiveThread(client, "parent");
  const result = releaseCodexBoundLiveThread(options);
  const checked = expect(result).resolves.toBe(true);
  first();
  await Promise.resolve();
  expect(unsubscribe).not.toHaveBeenCalled();
  second();
  await checked;
  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith("parent");
});

it("cancels the waiting request without removing child protection", async () => {
  const { client, unsubscribe, options } = await fixture();
  const release = protectCodexAppServerLiveThread(client, "parent");
  const controller = new AbortController();
  const cancelled = new Error("cancelled request");
  const result = releaseCodexBoundLiveThread({ ...options, signal: controller.signal });
  const checked = expect(result).rejects.toBe(cancelled);
  controller.abort(cancelled);
  await checked;
  expect(unsubscribe).not.toHaveBeenCalled();
  release();
  await expect(releaseCodexBoundLiveThread(options)).resolves.toBe(true);
});

it("revalidates authority after child settlement before releasing the subscription", async () => {
  const { client, unsubscribe, options } = await fixture();
  const release = protectCodexAppServerLiveThread(client, "parent");
  let current = true;
  const changed = new Error("session replaced");
  const result = releaseCodexBoundLiveThread({
    ...options,
    assertCurrent: () => {
      if (!current) throw changed;
    },
  });
  const checked = expect(result).rejects.toBe(changed);
  current = false;
  release();
  await checked;
  expect(unsubscribe).not.toHaveBeenCalled();
});

it("fails pending resume when the physical client closes", async () => {
  const { client, unsubscribe, options } = await fixture();
  protectCodexAppServerLiveThread(client, "parent");
  const result = releaseCodexBoundLiveThread(options);
  const checked = expect(result).rejects.toThrow(/closed/);
  client.close();
  await checked;
  expect(unsubscribe).not.toHaveBeenCalled();
});

it("still rejects a genuine foreground claim", async () => {
  const { client, unsubscribe, options } = await fixture();
  await consumeCodexAppServerLiveThread(client, "parent");
  await expect(releaseCodexBoundLiveThread(options)).rejects.toThrow("claimed by active work");
  expect(unsubscribe).not.toHaveBeenCalled();
});

it("does not unsubscribe if another child acquires protection during wakeup", async () => {
  const { client, unsubscribe, options } = await fixture();
  const first = protectCodexAppServerLiveThread(client, "parent");
  const result = releaseCodexBoundLiveThread(options);
  first();
  const second = protectCodexAppServerLiveThread(client, "parent");
  await Promise.resolve();
  await Promise.resolve();
  expect(unsubscribe).not.toHaveBeenCalled();
  second();
  await expect(result).resolves.toBe(true);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("rejects a new foreground owner acquired during protection wakeup", async () => {
  const { client, unsubscribe, options } = await fixture();
  const release = protectCodexAppServerLiveThread(client, "parent");
  const result = releaseCodexBoundLiveThread(options);
  const checked = expect(result).rejects.toThrow("claimed by active work");
  release();
  await consumeCodexAppServerLiveThread(client, "parent");
  await checked;
  expect(unsubscribe).not.toHaveBeenCalled();
});
