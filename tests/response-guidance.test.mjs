import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prompt = readFileSync(
  new URL("../pi/append-system/APPEND_SYSTEM.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../pi/append-system/README.md", import.meta.url),
  "utf8",
);

// Static authoring contracts, not evidence that a model follows these instructions.
test("Next summarizes state while immediate user actions stay separate", () => {
  for (const rule of [
    "summarizing the next step or state",
    "no commands, detailed user instructions, or multiple choices",
    "without promising automatic continuation",
    "**Next:** Nothing required.",
    "Put concrete actions the user must take now before that line",
    "a short list, table, or code block",
    "a `Next` summary grants no permission",
    "exact/verbatim output contracts",
    "endings that forbid an added footer",
  ]) {
    assert.ok(prompt.includes(rule), `missing rule: ${rule}`);
  }
  assert.ok(!prompt.includes("action that genuinely needs the user"));
});

test("continuation and approval boundaries survive the formatting change", () => {
  for (const rule of [
    "do it before the final response",
    "Read-only advice or verification alone never authorizes implementation or finalization",
    "never substitutes for required explicit approval",
    "Keep approval requests in their required confirmation flow",
    "A commit never implies permission to push",
    "immediately before a remote Git action",
    "its own visible command",
  ]) {
    assert.ok(prompt.includes(rule), `missing boundary: ${rule}`);
  }
});

test("examples cover waiting, completion, continued work and strict output", () => {
  for (const scenario of [
    "Authorized work remains",
    "A choice is required",
    "A runtime check needs the user",
    "A push needs approval",
    "Work is complete",
    "A workflow requires verbatim output or a final protocol line",
  ]) {
    assert.ok(readme.includes(scenario), `missing example: ${scenario}`);
  }
  const [, example] = readme.match(/````markdown\n([\s\S]*?)\n````/);
  assert.ok(example.includes("```text\n   /name orca-dynamic-titles\n   ```"));
  assert.ok(example.includes("share the tab/sidebar screenshot"));
  assert.equal(example.split("\n").at(-1), "**Next:** Waiting for the renamed-session check.");
  assert.ok(readme.includes("not captured model runs"));
});
