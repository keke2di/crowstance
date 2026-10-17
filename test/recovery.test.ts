import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { Delivery } from "../src/delivery.ts";
import { FakeChat } from "./fakes.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) { if (store.db.open) store.close(); } });
describe("file-backed recovery", () => {
  it("does not lose an outbound event across close and reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crowstance-recovery-"));
    const file = path.join(dir, "db.sqlite");
    const first = new Store(file); stores.push(first);
    first.enqueueOutbound({ id: "restart", kind: "text", payload: { text: "survive" }, chunks: ["survive"] });
    first.close();
    const second = new Store(file); stores.push(second);
    const chat = new FakeChat();
    const delivery = new Delivery(second, chat);
    await delivery.flush();
    expect(second.outboundEvent("restart")?.state).toBe("sent");
  });

  it("paginates assistant output through a durable watermark instead of relying on a 40-message window", () => {
    const store = new Store(":memory:"); stores.push(store);
    for (let i = 0; i < 60; i++) store.insertInbound({ text: `message-${i}`, receivedAt: i });
    expect(store.bufferedInbound()).toHaveLength(60);
    store.markInboundConsumed([1, 2, 3]);
    expect(store.bufferedInbound()).toHaveLength(57);
  });
});
