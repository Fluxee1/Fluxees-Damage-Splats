import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLED_TYPE_ART,
  DEFAULT_HEAL_SPLAT,
  DEFAULT_HEAL_TINT_SPLAT,
  DEFAULT_REGULAR_SPLAT,
  DEFAULT_TINT_SPLAT,
  NativeTextGate,
  cssUrl,
  detectHpUpdate,
  detectMaxHpDelta,
  detectTempHpDelta,
  findBestPendingCandidateGroup,
  getDefaultDamageTypeStyles,
  isNumericScrollingText,
  mergeStoredStyles,
  planSplatsForChange,
  resolveSplatVisual,
  scaleTypedDamage,
  selectTargetDamageTypes,
  splitDamageAcrossTypes,
  tokenIdFromUuid
} from "../scripts/splat-core.mjs";

const hp = (value, temp = 0) => ({ system: { attributes: { hp: { value, temp, max: 40 } } } });
const HP = ["system.attributes.hp.value"];
const TEMP = ["system.attributes.hp.temp"];

test("defaults: every damage type except physical uses the tint base", () => {
  const styles = getDefaultDamageTypeStyles();
  assert.equal(styles.fire.image, DEFAULT_TINT_SPLAT);
  assert.equal(styles.fire.tint, "#FF8C69");
  assert.equal(styles.slashing.image, "");
  assert.equal(styles.heal.image, DEFAULT_HEAL_SPLAT);
  assert.equal(styles.heal.soundEnabled, false);
});

test("disabled types are not drawn", () => {
  const visual = resolveSplatVisual("fire", { enabled: false, tint: "#ff0000" });
  assert.equal(visual.enabled, false);
  assert.equal(visual.sound, "");
});

test("tint colors a custom image instead of replacing it", () => {
  const visual = resolveSplatVisual("fire", { image: "worlds/x/my-fire.webp", tint: "#ff0000" });
  assert.equal(visual.image, "worlds/x/my-fire.webp");
  assert.equal(visual.tint, 0xff0000);
  assert.equal(visual.mode, "custom-tinted");
  assert.equal(visual.fallbackImage, DEFAULT_TINT_SPLAT);
});

test("tint on bundled pre-colored art uses the greyscale tint base", () => {
  assert.equal(resolveSplatVisual("fire", { image: BUNDLED_TYPE_ART.fire, tint: "#ff0000" }).image, DEFAULT_TINT_SPLAT);
  assert.equal(resolveSplatVisual("heal", { image: DEFAULT_HEAL_SPLAT, tint: "#00ff00" }).image, DEFAULT_HEAL_TINT_SPLAT);
});

test("bundled art without tint is used as-is", () => {
  const visual = resolveSplatVisual("acid", { image: BUNDLED_TYPE_ART.acid, tint: "" });
  assert.equal(visual.image, BUNDLED_TYPE_ART.acid);
  assert.equal(visual.tint, null);
  assert.equal(visual.mode, "bundled-art");
});

test("no image and no tint falls back to the kind's setting", () => {
  const visual = resolveSplatVisual("slashing", { image: "", tint: "" }, { regular: "custom/regular.webp" });
  assert.equal(visual.image, "custom/regular.webp");
  assert.equal(visual.mode, "fallback");
  assert.equal(resolveSplatVisual("bludgeoning", {}).image, DEFAULT_REGULAR_SPLAT);
});

test("stored styles merge over defaults and keep heal sound off unless set", () => {
  const merged = mergeStoredStyles(JSON.stringify({ heal: { image: "a.webp" }, "Custom Type": { tint: "#123456" } }));
  assert.equal(merged.heal.soundEnabled, false);
  assert.equal(merged.heal.image, "a.webp");
  assert.equal(merged["custom-type"].tint, "#123456");
  assert.equal(merged["custom-type"].soundEnabled, true);
  assert.throws(() => mergeStoredStyles("{not json"));
});

test("HP detection: damage, heal, unchanged write and nothing", () => {
  assert.deepEqual(detectHpUpdate(hp(30), { system: { attributes: { hp: { value: 22 } } } }, HP).kind, "damage");
  assert.equal(detectHpUpdate(hp(30), { system: { attributes: { hp: { value: 35 } } } }, HP).amount, 5);
  assert.equal(detectHpUpdate(hp(30), { system: { attributes: { hp: { value: 30 } } } }, HP).kind, "same");
  assert.equal(detectHpUpdate(hp(30), { name: "x" }, HP), null);
  assert.equal(detectHpUpdate(hp(30), { "system.attributes.hp.value": 20 }, HP).amount, 10, "flat dotted keys");
});

test("temp HP and max HP detection", () => {
  assert.equal(detectTempHpDelta(hp(30, 5), { system: { attributes: { hp: { temp: 0 } } } }, TEMP).kind, "loss");
  assert.equal(detectTempHpDelta(hp(30, 0), { system: { attributes: { hp: { temp: 8 } } } }, TEMP).amount, 8);
  const maxPaths = ["system.attributes.hp.max"];
  assert.equal(detectMaxHpDelta(hp(30), { system: { attributes: { hp: { max: 32 } } } }, maxPaths).kind, "damage");
});

test("plan: plain damage, heal, temp gain and absorbed damage", () => {
  assert.deepEqual(planSplatsForChange({ hpUpdate: { kind: "damage", amount: 7 } }).entries, [{ damage: 7, damageType: "untyped", kind: "damage" }]);
  assert.deepEqual(planSplatsForChange({ hpUpdate: { kind: "heal", amount: 4 } }).entries, [{ damage: 4, damageType: "heal", kind: "heal" }]);
  assert.deepEqual(planSplatsForChange({ tempHpDelta: { kind: "gain", amount: 6 } }).entries, [{ damage: 6, damageType: "temp-hp", kind: "temp-hp" }]);
  const absorbed = planSplatsForChange({ hpUpdate: { kind: "damage", amount: 3 }, tempHpDelta: { kind: "loss", amount: 5 } });
  assert.equal(absorbed.entries[0].damage, 8);
});

test("plan: typed damage replaces the untyped splat", () => {
  const plan = planSplatsForChange({ hpUpdate: { kind: "damage", amount: 12 } }, (total) => ({
    totalDamage: total,
    types: [{ type: "fire", damage: 8 }, { type: "slashing", damage: 4 }]
  }));
  assert.deepEqual(plan.entries.map((entry) => entry.damageType), ["fire", "slashing"]);
});

test("plan: an unchanged HP write only borrows typed damage, never invents a splat", () => {
  let asked = null;
  const none = planSplatsForChange({ hpUpdate: { kind: "same", amount: 0 } }, (total, options) => { asked = options; return null; });
  assert.equal(none.entries.length, 0);
  assert.equal(asked.allowCachedDamage, true);
  const typed = planSplatsForChange({ hpUpdate: { kind: "same" } }, () => ({ types: [{ type: "necrotic", damage: 9 }] }));
  assert.equal(typed.entries[0].damageType, "necrotic");
});

test("damage maths", () => {
  assert.deepEqual(splitDamageAcrossTypes(["a", "b", "c"], 10).map((entry) => entry.damage), [4, 3, 3]);
  assert.deepEqual(scaleTypedDamage([{ type: "a", damage: 6 }, { type: "b", damage: 4 }], 5).map((entry) => entry.damage), [3, 2]);
  assert.deepEqual(selectTargetDamageTypes(["piercing", "poison"], { isAttack: true, isHitTarget: false, isFailedSaveTarget: true }), ["poison"]);
  assert.deepEqual(selectTargetDamageTypes(["piercing", "poison"], { isAttack: true, isHitTarget: true, isFailedSaveTarget: false }), ["piercing", "poison"]);
});

test("pending groups prefer workflow id, then closest total", () => {
  const entry = (workflowId, total, createdAt = 1) => ({ entry: { workflowId, source: "explicit-midi-detail", totalDamage: total, createdAt, types: [{ type: "fire", damage: total }] } });
  assert.equal(findBestPendingCandidateGroup([entry("a", 10), entry("b", 7)], 7).workflowId, "b");
  assert.equal(findBestPendingCandidateGroup([entry("a", 10), entry("b", 7)], 7, new Set(["a"])).workflowId, "a");
});

test("token ids from token and synthetic actor UUIDs", () => {
  assert.equal(tokenIdFromUuid("Scene.s1.Token.t9"), "t9");
  assert.equal(tokenIdFromUuid("Scene.s1.Token.t9.Actor.a1"), "t9");
  assert.equal(tokenIdFromUuid("Actor.a1"), null);
});

test("numeric scrolling text and CSS url escaping", () => {
  assert.equal(isNumericScrollingText("<span>−12</span>"), true);
  assert.equal(isNumericScrollingText("+5"), true);
  assert.equal(isNumericScrollingText("Prone"), false);
  assert.equal(cssUrl('fonts/my "odd" font.ttf'), 'url("fonts/my \\22 odd\\22  font.ttf")');
});

test("native text gate: suppress after a splat, hold then drop before a splat, show when no splat comes", () => {
  let now = 0;
  const timers = [];
  const gate = new NativeTextGate({ now: () => now, schedule: (fn, ms) => timers.push({ fn, at: now + ms }) });
  const run = () => timers.splice(0).forEach((timer) => { now = Math.max(now, timer.at); timer.fn(); });
  const shown = [];

  gate.noteSplat("t1");
  assert.equal(gate.offer("t1", () => shown.push("a")), "suppress");

  now = 5000;
  assert.equal(gate.offer("t2", () => shown.push("b")), "held");
  gate.noteSplat("t2");
  run();
  assert.deepEqual(shown, []);

  assert.equal(gate.offer("t3", () => shown.push("c")), "held");
  assert.equal(gate.offer("t3", () => shown.push("d")), "held");
  run();
  assert.deepEqual(shown, ["c", "d"], "both held numbers appear when no splat arrives");
});
