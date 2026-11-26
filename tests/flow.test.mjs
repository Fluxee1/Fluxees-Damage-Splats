// End-to-end flow with a small Foundry stand-in: an HP change made on one
// client reaches the active GM, is planned (with Midi-QOL typed damage when
// cached) and broadcast, and every client draws the splat.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/* ---------------- Foundry stand-in ---------------- */

const hooks = { once: new Map(), on: new Map() };
globalThis.Hooks = {
  once(name, fn) { (hooks.once.get(name) ?? hooks.once.set(name, []).get(name)).push(fn); },
  on(name, fn) { (hooks.on.get(name) ?? hooks.on.set(name, []).get(name)).push(fn); },
  callAll(name, ...args) {
    for (const fn of hooks.once.get(name) ?? []) fn(...args);
    hooks.once.delete(name);
    for (const fn of hooks.on.get(name) ?? []) fn(...args);
  }
};

const settingsMeta = new Map();
const settingsValues = new Map();
const users = {
  gm: { id: "gm", name: "GM", isGM: true, get isSelf() { return game.user === this; } },
  player: { id: "pl", name: "Player", isGM: false, get isSelf() { return game.user === this; } }
};

globalThis.game = {
  user: users.gm,
  users: { get activeGM() { return users.gm; } },
  modules: new Map([["socketlib", { active: true }], ["midi-qol", { active: true }]]),
  actors: new Map(),
  settings: {
    settings: settingsMeta,
    register(scope, key, meta) { settingsMeta.set(`${scope}.${key}`, meta); if (!settingsValues.has(`${scope}.${key}`)) settingsValues.set(`${scope}.${key}`, meta.default); },
    registerMenu() {},
    get(scope, key) { return settingsValues.get(`${scope}.${key}`); },
    async set(scope, key, value) { settingsValues.set(`${scope}.${key}`, value); }
  }
};
const setSetting = (key, value) => settingsValues.set(`rs-damage-splats.${key}`, value);

const drawn = [];
class Container {
  constructor() { this.children = []; this.scale = { set() {}, x: 1, y: 1 }; this.position = { set: (x, y) => { this.x = x; this.y = y; } }; this.destroyed = false; }
  addChild(...children) { this.children.push(...children); }
  destroy() { this.destroyed = true; }
}
globalThis.PIXI = {
  Container,
  Sprite: class { constructor(texture) { this.texture = texture; this.anchor = { set() {} }; this.scale = { set() {} }; this.tint = 0xffffff; } },
  Text: class { constructor(text, style) { this.text = text; this.style = style; this.anchor = { set() {} }; } }
};

const missingPaths = new Set();
class InterfaceCanvasGroup {
  createScrollingText(origin, content) { nativeShown.push(String(content)); return Promise.resolve(); }
}
const nativeShown = [];

function makeToken(id, { actor, x = 100, y = 100, linked = true } = {}) {
  const token = {
    id,
    name: `Token ${id}`,
    actor,
    w: 100,
    h: 100,
    center: { x: x + 50, y: y + 50 },
    isVisible: true,
    document: { uuid: `Scene.s1.Token.${id}`, documentName: "Token", width: 1, height: 1, texture: { scaleX: 1, scaleY: 1 }, actorLink: linked, actorId: actor?.id }
  };
  token.document.object = token;
  return token;
}

const tokens = new Map();
globalThis.canvas = {
  grid: { size: 100 },
  interface: new InterfaceCanvasGroup(),
  tokens: {
    get: (id) => tokens.get(id) ?? null,
    get placeables() { return [...tokens.values()]; },
    get controlled() { return []; },
    addChild(container) { drawn.push(container); }
  }
};

const uuidIndex = new Map();
globalThis.fromUuidSync = (uuid) => uuidIndex.get(uuid) ?? null;
globalThis.CONFIG = { fontDefinitions: {} };
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.FontFace = class { load() { return Promise.resolve(this); } };
globalThis.document = { fonts: { add() {} } };

const soundsPlayed = [];
globalThis.foundry = {
  utils: { randomID: () => Math.random().toString(36).slice(2) },
  audio: { AudioHelper: { play: (data) => { soundsPlayed.push(data.src); return Promise.resolve(); } } },
  canvas: {
    loadTexture: async (path) => (missingPaths.has(path) ? null : { path, width: 200, height: 200, valid: true }),
    animation: { CanvasAnimation: { animate: async () => true } },
    groups: { InterfaceCanvasGroup }
  },
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {}
    }
  }
};

const socketCalls = [];
const handlers = new Map();
globalThis.socketlib = {
  registerModule: () => ({
    register: (name, fn) => handlers.set(name, fn),
    executeAsUser: async (name, userId, ...args) => { socketCalls.push({ name, userId, args }); },
    executeForEveryone: async (name, ...args) => { socketCalls.push({ name, everyone: true, args }); }
  })
};

/* ---------------- Fixtures ---------------- */

function makeActor(id, hp, { synthetic = false } = {}) {
  const actor = {
    id,
    name: `Actor ${id}`,
    uuid: synthetic ? `Scene.s1.Token.${synthetic}.Actor.${id}` : `Actor.${id}`,
    isToken: Boolean(synthetic),
    system: { attributes: { hp: { value: hp, temp: 0, max: 40 } } },
    getActiveTokens: () => [...tokens.values()].filter((token) => token.actor === actor)
  };
  uuidIndex.set(actor.uuid, actor);
  return actor;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function deliver() {
  // Play socket traffic: GM processes reports, then every client renders.
  while (socketCalls.length) {
    const call = socketCalls.shift();
    if (call.name === "processChangeReport") { game.user = users.gm; handlers.get("processChangeReport")(...call.args); }
    else if (call.name === "cacheRemoteTypedDamage") { game.user = users.gm; handlers.get("cacheRemoteTypedDamage")(...call.args); }
    else if (call.name === "renderSplats") await handlers.get("renderSplats")(...call.args);
    await flush();
  }
  await flush();
}

const splatSummary = () => drawn.map((container) => ({
  text: container.children[1].text,
  image: container.children[0].texture.path,
  tint: container.children[0].tint
}));

before(async () => {
  await import("../scripts/rs-damage-splats.js");
  Hooks.callAll("init");
  Hooks.callAll("socketlib.ready");
  Hooks.callAll("ready");
  setSetting("durationMs", 150);
});

beforeEach(() => {
  drawn.length = 0;
  socketCalls.length = 0;
  soundsPlayed.length = 0;
  nativeShown.length = 0;
  tokens.clear();
  missingPaths.clear();
  game.user = users.gm;
  setSetting("damageTypeStyles", JSON.stringify({}));
});

/* ---------------- Tests ---------------- */

test("a player's own HP change is sent to the GM and splats for everyone", async () => {
  const actor = makeActor("hero", 30);
  tokens.set("t1", makeToken("t1", { actor }));
  game.user = users.player;
  Hooks.callAll("preUpdateActor", actor, { system: { attributes: { hp: { value: 24 } } } }, {}, "pl");
  assert.equal(socketCalls[0]?.name, "processChangeReport");
  assert.equal(socketCalls[0].userId, "gm");
  await deliver();
  assert.deepEqual(splatSummary().map((splat) => splat.text), ["6"]);
});

test("updates initiated by another user are ignored on this client", async () => {
  const actor = makeActor("hero", 30);
  tokens.set("t1", makeToken("t1", { actor }));
  Hooks.callAll("preUpdateActor", actor, { system: { attributes: { hp: { value: 24 } } } }, {}, "someone-else");
  await deliver();
  assert.equal(drawn.length, 0);
});

test("healing uses the heal style and no sound by default", async () => {
  const actor = makeActor("hero", 20);
  tokens.set("t1", makeToken("t1", { actor }));
  Hooks.callAll("preUpdateActor", actor, { system: { attributes: { hp: { value: 27 } } } }, {}, "gm");
  await deliver();
  assert.deepEqual(splatSummary(), [{ text: "7", image: "modules/rs-damage-splats/assets/healsplat.webp", tint: 0xffffff }]);
  assert.equal(soundsPlayed.length, 0);
});

test("Midi-QOL typed damage from a player's roll reaches the GM cache and splits the splat", async () => {
  const goblin = makeActor("gob", 15, { synthetic: "g1" });
  tokens.set("g1", makeToken("g1", { actor: goblin, linked: false }));
  game.user = users.player;
  Hooks.callAll("midi-qol.DamageRollComplete", {
    id: "wf1",
    damageList: [{ tokenUuid: "Scene.s1.Token.g1", damageDetail: [{ type: "fire", value: 5 }, { type: "slashing", value: 4 }] }]
  });
  assert.equal(socketCalls[0]?.name, "cacheRemoteTypedDamage");
  await deliver();
  game.user = users.gm;
  Hooks.callAll("preUpdateActor", goblin, { system: { attributes: { hp: { value: 6 } } } }, {}, "gm");
  await deliver();
  const splats = splatSummary();
  assert.deepEqual(splats.map((splat) => splat.text).sort(), ["4", "5"]);
  assert.equal(splats.find((splat) => splat.text === "5").tint, 0xff8c69, "fire uses its default tint on the tint base");
});

test("a disabled type draws nothing; other types in the same hit still draw", async () => {
  setSetting("damageTypeStyles", JSON.stringify({ fire: { enabled: false } }));
  const goblin = makeActor("gob2", 15, { synthetic: "g2" });
  tokens.set("g2", makeToken("g2", { actor: goblin, linked: false }));
  Hooks.callAll("midi-qol.DamageRollComplete", {
    id: "wf2",
    damageList: [{ tokenUuid: "Scene.s1.Token.g2", damageDetail: [{ type: "fire", value: 5 }, { type: "cold", value: 3 }] }]
  });
  Hooks.callAll("preUpdateActor", goblin, { system: { attributes: { hp: { value: 7 } } } }, {}, "gm");
  await deliver();
  assert.deepEqual(splatSummary().map((splat) => splat.text), ["3"]);
});

test("a broken custom image falls back to the default splat instead of a blank one", async () => {
  setSetting("damageTypeStyles", JSON.stringify({ untyped: { image: "worlds/missing.webp", tint: "" } }));
  missingPaths.add("worlds/missing.webp");
  const actor = makeActor("hero", 30);
  tokens.set("t1", makeToken("t1", { actor }));
  Hooks.callAll("preUpdateActor", actor, { system: { attributes: { hp: { value: 25 } } } }, {}, "gm");
  await deliver();
  assert.equal(splatSummary()[0].image, "modules/rs-damage-splats/assets/regularsplat.webp");
});

test("an unchanged HP write does not replay an old cached roll", async () => {
  const goblin = makeActor("gob3", 15, { synthetic: "g3" });
  tokens.set("g3", makeToken("g3", { actor: goblin, linked: false }));
  Hooks.callAll("midi-qol.DamageRollComplete", { id: "old", damageList: [{ tokenUuid: "Scene.s1.Token.g3", damageDetail: [{ type: "necrotic", value: 9 }] }] });
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    Hooks.callAll("preUpdateActor", goblin, { system: { attributes: { hp: { value: 15 } } } }, {}, "gm");
    await deliver();
  } finally {
    Date.now = realNow;
  }
  assert.equal(drawn.length, 0);
});

test("native floating numbers: hidden when a splat shows for the token, kept otherwise", async () => {
  const actor = makeActor("hero", 30);
  const token = makeToken("t1", { actor });
  tokens.set("t1", token);
  Hooks.callAll("preUpdateActor", actor, { system: { attributes: { hp: { value: 22 } } } }, {}, "gm");
  await deliver();
  canvas.interface.createScrollingText(token.center, "-8");
  canvas.interface.createScrollingText({ x: 999, y: 999 }, "-3");
  canvas.interface.createScrollingText(token.center, "Prone");
  await new Promise((resolve) => setTimeout(resolve, 800)); // past the hold window
  assert.deepEqual(nativeShown, ["-3", "Prone"], "only the number on the splatted token is hidden");
});

test("native floating numbers on a token with no splat still appear after a short hold", async () => {
  const actor = makeActor("bystander", 30);
  const token = makeToken("t5", { actor, x: 500 });
  tokens.set("t5", token);
  canvas.interface.createScrollingText(token.center, "+2");
  assert.deepEqual(nativeShown, []);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.deepEqual(nativeShown, ["+2"]);
});

test("dnd5e 4.x activity damage types are used when Midi gives no per-type detail", async () => {
  const goblin = makeActor("gob4", 15, { synthetic: "g4" });
  const token = makeToken("g4", { actor: goblin, linked: false });
  tokens.set("g4", token);
  class AttackActivity { constructor() { this.type = "attack"; this.damage = { parts: [{ types: new Set(["fire"]) }] }; } }
  Hooks.callAll("midi-qol.DamageRollComplete", {
    id: "wf4",
    activity: new AttackActivity(),
    hitTargets: new Set([token]),
    damageRolls: [{ total: 7 }],
    damageList: [{ tokenUuid: "Scene.s1.Token.g4", appliedDamage: 7 }]
  });
  Hooks.callAll("preUpdateActor", goblin, { system: { attributes: { hp: { value: 8 } } } }, {}, "gm");
  await deliver();
  assert.deepEqual(splatSummary().map((splat) => [splat.text, splat.tint]), [["7", 0xff8c69]], "fire, not the activity's 'attack' type");
});
