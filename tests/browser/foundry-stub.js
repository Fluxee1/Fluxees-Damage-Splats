// Minimal Foundry V13 stand-ins so the real Damage Type Styles window can run in
// a plain browser page. Serve a folder whose modules/rs-damage-splats points at
// this module, then open /modules/rs-damage-splats/tests/browser/index.html.

/* A tiny Handlebars subset: {{var}}, {{#if}}{{else}}{{/if}}, {{#each}}. */
function renderTemplate(source, context) {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tokens = source.split(/({{[#/]?(?:if|each)?[^}]*}})/);
  let index = 0;
  function block(ctx, stopAt) {
    let out = "";
    while (index < tokens.length) {
      const token = tokens[index++];
      const tag = /^{{([#/]?)(\w+)?\s*([^}]*)}}$/.exec(token);
      if (!tag) { out += token; continue; }
      const [, sigil, name, arg] = tag;
      if (sigil === "/" || (name === "else" && stopAt.includes("else"))) { index -= name === "else" ? 0 : 0; return { out, end: name === "else" ? "else" : "close" }; }
      if (sigil === "#" && name === "if") {
        const value = ctx[arg.trim()];
        const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
        const first = block(ctx, ["else"]);
        let second = { out: "" };
        if (first.end === "else") second = block(ctx, []);
        out += truthy ? first.out : second.out;
        continue;
      }
      if (sigil === "#" && name === "each") {
        const list = ctx[arg.trim()] ?? [];
        const start = index;
        let end = start;
        if (!list.length) { block(ctx, []); continue; }
        for (const item of list) { index = start; out += block({ ...ctx, ...item }, []).out; end = index; }
        index = end;
        continue;
      }
      out += escape(ctx[name]);
    }
    return { out, end: "eof" };
  }
  return block(context, []).out;
}

const instances = new Map();
class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    const chain = [];
    for (let cls = this.constructor; cls && cls !== Object; cls = Object.getPrototypeOf(cls)) chain.unshift(cls.DEFAULT_OPTIONS ?? {});
    this.options = Object.assign({}, ...chain.map((o) => structuredClone({ ...o, actions: undefined, form: undefined })), options);
    this.options.actions = Object.assign({}, ...chain.map((o) => o.actions ?? {}));
    this.options.form = Object.assign({}, ...chain.map((o) => o.form ?? {}));
    this.position = { ...(this.options.position ?? {}) };
  }
  get id() { return this.options.id; }
  get element() { return this._element; }
  async _prepareContext() { return {}; }
  async render(options = {}) {
    const first = !this._element;
    const context = await this._prepareContext(options);
    if (first) {
      const el = document.createElement(this.options.tag ?? "div");
      el.id = this.id;
      el.className = `application ${(this.options.classes ?? []).join(" ")}`;
      Object.assign(el.style, { position: "fixed", left: "8px", top: "8px", width: `${this.position.width}px`, height: `${this.position.height}px`, display: "flex", flexDirection: "column", background: "#222" });
      el.innerHTML = `<header class="window-header" style="height:32px;flex:0 0 auto;color:#ddd;padding:6px 10px;font:13px sans-serif">${this.options.window?.title ?? ""}</header><section class="window-content" style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column"></section>`;
      document.body.appendChild(el);
      this._element = el;
      el.addEventListener("click", (event) => {
        const target = event.target.closest("[data-action]");
        if (!target) return;
        const handler = this.options.actions[target.dataset.action];
        if (handler) { event.preventDefault(); handler.call(this, event, target); }
      });
      if (el.tagName === "FORM") el.addEventListener("submit", async (event) => {
        event.preventDefault();
        await this.options.form.handler?.call(this, event, el, null);
        if (this.options.form.closeOnSubmit) await this.close();
      });
    }
    const parts = this.constructor.PARTS ?? {};
    const html = [];
    for (const part of Object.values(parts)) {
      const path = part.template.replace(/^modules\/rs-damage-splats\//, "/modules/rs-damage-splats/");
      html.push(renderTemplate(await (await fetch(path)).text(), context));
    }
    this._element.querySelector(".window-content").innerHTML = html.join("");
    instances.set(this.id, this);
    if (first) this._onFirstRender?.(context, options);
    this._onRender?.(context, options);
    return this;
  }
  setPosition(position) {
    Object.assign(this.position, position);
    if (position.width) this._element.style.width = `${position.width}px`;
  }
  async close() { this._element?.remove(); this._element = null; instances.delete(this.id); window.__closed = true; }
}
const HandlebarsApplicationMixin = (Base) => class extends Base {};

const settingsMeta = new Map();
const settingsValues = new Map();
const hooks = new Map();
globalThis.Hooks = {
  once(name, fn) { (hooks.get(name) ?? hooks.set(name, []).get(name)).push(fn); },
  on(name, fn) { (hooks.get(name) ?? hooks.set(name, []).get(name)).push(fn); },
  callAll(name, ...args) { for (const fn of hooks.get(name) ?? []) fn(...args); }
};
const previewSplats = [];
const gm = { id: "gm", isGM: true, get isSelf() { return true; } };
globalThis.game = {
  user: gm,
  users: { activeGM: gm },
  modules: new Map(),
  settings: {
    settings: settingsMeta,
    menus: new Map(),
    register(scope, key, meta) { settingsMeta.set(`${scope}.${key}`, meta); if (!settingsValues.has(`${scope}.${key}`)) settingsValues.set(`${scope}.${key}`, meta.default); },
    registerMenu(scope, key, meta) { this.menus.set(`${scope}.${key}`, meta); },
    get(scope, key) { return settingsValues.get(`${scope}.${key}`); },
    async set(scope, key, value) { settingsValues.set(`${scope}.${key}`, value); window.__saves = (window.__saves ?? 0) + 1; }
  }
};
globalThis.CONFIG = { fontDefinitions: {} };
globalThis.ui = { notifications: { info: (m) => (window.__notes ??= []).push(["info", m]), warn: (m) => (window.__notes ??= []).push(["warn", m]), error() {} } };
globalThis.fromUuidSync = () => null;
const token = { id: "t1", name: "Test", center: { x: 50, y: 50 }, w: 100, h: 100, document: { uuid: "Scene.s.Token.t1", width: 1, height: 1, texture: {} } };
globalThis.PIXI = {
  Container: class { constructor() { this.children = []; this.scale = { set() {} }; this.position = { set() {} }; } addChild(...c) { this.children.push(...c); } destroy() {} },
  Sprite: class { constructor(t) { this.texture = t; this.anchor = { set() {} }; this.scale = { set() {} }; } },
  Text: class { constructor(text) { this.text = text; this.anchor = { set() {} }; } }
};
globalThis.canvas = {
  grid: { size: 100 },
  tokens: { controlled: [token], placeables: [token], get: () => token, addChild: (c) => previewSplats.push({ text: c.children[1].text, image: c.children[0].texture.path, tint: c.children[0].tint }) }
};
globalThis.foundry = {
  utils: { randomID: () => Math.random().toString(36).slice(2) },
  audio: { AudioHelper: { play: (d) => { (window.__sounds ??= []).push(d.src); } } },
  canvas: { loadTexture: async (path) => ({ path, width: 100, height: 100 }), animation: { CanvasAnimation: { animate: async () => {} } } },
  applications: {
    api: { ApplicationV2, HandlebarsApplicationMixin },
    apps: { FilePicker: { implementation: class { constructor(o) { window.__picker = o; } async render() {} } } }
  }
};
window.__previewSplats = previewSplats;
window.__settingsValues = settingsValues;
