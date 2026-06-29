// Pure-unit test for compactSnapshot. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { compactSnapshot, _internals } = require("./snapshot");

// Lightweight fixture: shape { tagName, attrs?, children?, textContent? }
function el(tagName, attrs, children, textContent) {
  return {
    tagName,
    attrs: attrs || {},
    children: children || [],
    textContent: textContent || "",
  };
}

test("emits SPEC §4.1 schema_version + ref_map + source", () => {
  const root = el("body", {}, [el("h1", {}, [], "Hello")]);
  const out = compactSnapshot(root);
  assert.equal(out.schema_version, "1");
  assert.ok(out.ref_map);
  assert.equal(out.source.kind, "browser");
  assert.equal(out.source.id, "active-tab");
});

test("assigns unique @refN tokens per node", () => {
  const root = el("body", {}, [
    el("h1", {}, [], "Title"),
    el("button", { "aria-label": "Submit" }),
    el("input", { type: "text", placeholder: "Email" }),
  ]);
  const out = compactSnapshot(root);
  const refs = Object.keys(out.ref_map);
  assert.equal(new Set(refs).size, refs.length);
  assert.ok(refs.includes("@ref0"));
});

test("interactive_only:true filters non-actionable nodes", () => {
  const root = el("body", {}, [
    el("p", {}, [], "lorem"),
    el("button", { "aria-label": "Go" }),
  ]);
  const out = compactSnapshot(root, { interactiveOnly: true });
  const roles = Object.values(out.ref_map).map((v) => v.role);
  assert.ok(roles.includes("button"));
  assert.ok(!roles.includes("generic"));
  // body/p shouldn't appear because non-actionable
  assert.ok(!out.text.includes("paragraph"));
});

test("roleOf maps tags to ARIA roles", () => {
  const { roleOf } = _internals;
  assert.equal(roleOf(el("a")), "link");
  assert.equal(roleOf(el("button")), "button");
  assert.equal(roleOf(el("input", { type: "checkbox" })), "checkbox");
  assert.equal(roleOf(el("input", { type: "search" })), "searchbox");
  assert.equal(roleOf(el("h2")), "heading");
});

test("nameOf prefers aria-label > placeholder > textContent", () => {
  const { nameOf, roleOf } = _internals;
  const aria = el("input", { "aria-label": "Email", type: "text" });
  assert.equal(nameOf(aria, roleOf(aria)), "Email");
  const ph = el("input", { placeholder: "Search…", type: "search" });
  assert.equal(nameOf(ph, roleOf(ph)), "Search…");
  const txt = el("button", {}, [], "Click me");
  assert.equal(nameOf(txt, roleOf(txt)), "Click me");
});

test("truncates at maxNodes and sets truncated:true", () => {
  const kids = [];
  for (let i = 0; i < 50; i++) {
    kids.push(el("button", { "aria-label": `b${i}` }));
  }
  const root = el("body", {}, kids);
  const out = compactSnapshot(root, { maxNodes: 10 });
  assert.equal(out.truncated, true);
  assert.equal(Object.keys(out.ref_map).length, 10);
});

test("isActionable detects role+tag+tabindex+onclick", () => {
  const { isActionable, roleOf } = _internals;
  const b = el("button");
  assert.equal(isActionable(b, roleOf(b)), true);
  const div = el("div", { tabindex: "0", role: "button" });
  assert.equal(isActionable(div, roleOf(div)), true);
  const span = el("span", { onclick: "doit()" });
  assert.equal(isActionable(span, roleOf(span)), true);
  const inert = el("p");
  assert.equal(isActionable(inert, roleOf(inert)), false);
});
