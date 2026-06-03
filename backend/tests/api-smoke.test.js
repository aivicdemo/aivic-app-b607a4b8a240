import test from "node:test";
import assert from "node:assert/strict";

test("api handler export exists", async () => {
  const mod = await import("../functions/api.ts");
  assert.equal(typeof mod.handler, "function");
});
