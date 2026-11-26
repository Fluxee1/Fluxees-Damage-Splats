import {
  MODULE_ID,
  DEFAULT_REGULAR_SPLAT,
  DEFAULT_HEAL_SPLAT,
  DEFAULT_TEMP_HP_SPLAT,
  DEFAULT_SPLAT_SOUND,
  DEFAULT_FONT_PATH,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TINT_PICKER_COLOR,
  TYPE_ORDER,
  BUNDLED_TYPE_ART,
  IMAGE_MODE_LABELS,
  NativeTextGate,
  aggregateTypedDamage,
  collectWorkflowIdsFromUpdateOptions,
  computeSplatOffsets,
  cssUrl,
  detectHpUpdate,
  detectMaxHpDelta,
  detectTempHpDelta,
  findBestPendingCandidateGroup,
  flattenDamageCandidates,
  getDefaultDamageTypeStyles,
  isNumericScrollingText,
  maxHpPathsFor,
  mergePhaseEntriesByType,
  mergeStoredStyles,
  normalizeDamageType,
  planSplatsForChange,
  previewKindForType,
  resolveSplatVisual,
  sanitizeStyleRecord,
  scaleTypedDamage,
  selectTargetDamageTypes,
  shouldReplacePendingEntry,
  splitDamageAcrossTypes,
  splitPaths,
  toCssHexColor,
  tokenIdFromUuid,
  typeLabel
} from "./splat-core.mjs";

const DEFAULT_HP_PATHS = [
  "system.attributes.hp.value",
  "system.hp.value",
  "system.health.value",
  "system.health.current",
  "system.hitPoints.value",
  "system.resources.hp.value"
];
const DEFAULT_TEMP_HP_PATHS = [
  "system.attributes.hp.temp",
  "system.hp.temp",
  "system.health.temp",
  "system.hitPoints.temp",
  "system.resources.hp.temp"
];
// Manual Midi-QOL damage application can happen well after the damage roll. Keep
// the target-specific breakdown long enough for a GM to review and apply it.
const PENDING_TYPED_DAMAGE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_TYPED_DAMAGE_ENTRIES = 500;
// An HP write that changes nothing only borrows a typed roll this recent (or one
// whose workflow id is on the update), so a stale cached roll is never replayed.
const CLAMPED_UPDATE_MAX_AGE_MS = 20 * 1000;

const pendingTypedDamageStore = new Map();
const nativeTextGate = new NativeTextGate();
const missingTextureWarnings = new Set();
const styleCache = { raw: null, styles: null };
let splatSocket = null;
let socketReady = false;
let socketlibHookFired = false;

Hooks.once("init", () => {
  registerSettings();
  registerFontDefinition();
});

Hooks.once("socketlib.ready", () => {
  socketlibHookFired = true;
  ensureSocketRegistration("socketlib.ready");
});

Hooks.once("ready", () => {
  loadRuneScapeFont();
  patchNativeScrollingText();
  registerMidiQolHooks();
  if (!game.modules.get("socketlib")?.active) {
    console.warn(`${MODULE_ID} | socketlib is not active. Splats will only render on the client that changed HP.`);
    return;
  }
  if (!socketReady) ensureSocketRegistration("ready");
  if (!socketReady) {
    console.warn(`${MODULE_ID} | socketlib is active but the module socket is not ready yet. Splats may render locally only.`, {
      socketlibHookFired,
      hasSocket: Boolean(splatSocket)
    });
  }
});

// Pre-update hooks only run on the client that makes the change, so every client
// (player or GM) reports its own HP changes. The active GM turns the report into
// splats, because it holds the Midi-QOL typed damage cache.
Hooks.on("preUpdateActor", (actor, change, options, userId) => {
  if (userId && userId !== game.user?.id) return;
  try {
    const report = buildChangeReport(actor, change, options);
    if (report) dispatchChangeReport(report);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to read an HP change.`, error);
  }
});

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

function registerSettings() {
  const world = (key, data) => game.settings.register(MODULE_ID, key, { scope: "world", config: true, ...data });

  world("hpPaths", {
    name: "HP data paths",
    hint: "Comma-separated actor data paths checked when HP changes.",
    type: String,
    default: DEFAULT_HP_PATHS.join(", ")
  });
  world("useMidiQolTypedDamage", {
    name: "Use Midi-QOL typed damage",
    hint: "When Midi-QOL is active, use its typed damage breakdown to create per-type splats.",
    type: Boolean,
    default: true
  });
  world("regularSplatPath", {
    name: "Regular splat image",
    hint: "Image shown for damage types with no image or tint of their own.",
    type: String,
    default: DEFAULT_REGULAR_SPLAT
  });
  world("tempHpPaths", {
    name: "Temp HP data paths",
    hint: "Comma-separated actor data paths checked when temporary HP changes.",
    type: String,
    default: DEFAULT_TEMP_HP_PATHS.join(", ")
  });
  world("healSplatPath", {
    name: "Heal splat image",
    hint: "Image shown when an actor regains HP and Healing has no image or tint of its own.",
    type: String,
    default: DEFAULT_HEAL_SPLAT
  });
  world("tempHpSplatPath", {
    name: "Temp HP splat image",
    hint: "Image shown when temporary HP is gained and Temp HP has no image or tint of its own.",
    type: String,
    default: DEFAULT_TEMP_HP_SPLAT
  });
  world("splatScale", {
    name: "Splat scale",
    hint: "Overall size multiplier for splats and damage numbers. 0.5 is about half size.",
    type: Number,
    default: 0.5
  });
  world("durationMs", {
    name: "Splat duration (ms)",
    hint: "Total time the splat stays on screen, in milliseconds.",
    type: Number,
    default: 2000
  });
  world("multiSplatSpread", {
    name: "Multi-splat spread",
    hint: "Controls how far apart multi-type splats step from center.",
    type: Number,
    default: 0.18
  });
  world("multiSplatGap", {
    name: "Multi-splat gap",
    hint: "Pixel gap between multiple splats after sizing is applied.",
    type: Number,
    default: 0
  });
  world("multiSplatArc", {
    name: "Multi-splat arc lift",
    hint: "How much the outer splats lift upward in a multi-hit group.",
    type: Number,
    default: 0.12
  });
  world("fontPath", {
    name: "RuneScape font path",
    hint: "TTF font used for the damage numbers.",
    type: String,
    default: DEFAULT_FONT_PATH,
    onChange: () => loadRuneScapeFont()
  });
  world("fontFamily", {
    name: "Font family name",
    hint: "Font family used when drawing damage numbers.",
    type: String,
    default: "RuneScape UF",
    onChange: () => loadRuneScapeFont()
  });

  game.settings.register(MODULE_ID, "damageTypeStyles", {
    name: "Damage type styles",
    hint: "Stored damage-type style configuration.",
    scope: "world",
    config: false,
    type: String,
    default: JSON.stringify(getDefaultDamageTypeStyles(), null, 2)
  });

  game.settings.registerMenu(MODULE_ID, "damageTypeStylesMenu", {
    name: "Damage Type Styles",
    label: "Configure",
    hint: "Choose splat images, tints, text colors and sounds per type, and preview each one.",
    icon: "fas fa-burst",
    type: DamageTypeStylesConfig,
    restricted: true
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "Debug logging",
    hint: "Prints useful messages in the browser console while testing.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
  world("hideNativeScrollingText", {
    name: "Hide native damage/healing numbers",
    hint: "Hides Foundry's floating number on a token when a splat is shown for that token. Numbers with no splat still appear.",
    type: Boolean,
    default: true
  });
  world("defaultSplatSoundPath", {
    name: "Default splat sound path",
    hint: "Default sound used by damage types with sound enabled and no custom path.",
    type: String,
    default: DEFAULT_SPLAT_SOUND
  });
  game.settings.register(MODULE_ID, "enableSplatSounds", {
    name: "Enable splat sounds",
    hint: "Play hitsplat sounds on this client.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function getStoredDamageTypeStyles() {
  const raw = setting("damageTypeStyles");
  if (styleCache.raw === raw && styleCache.styles) return styleCache.styles;
  let styles;
  try {
    styles = mergeStoredStyles(raw);
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not parse damage type styles. Falling back to defaults.`, error);
    styles = getDefaultDamageTypeStyles();
  }
  styleCache.raw = raw;
  styleCache.styles = styles;
  return styles;
}

function getSplatVisual(damageType, styles = getStoredDamageTypeStyles()) {
  const type = normalizeDamageType(damageType ?? "untyped");
  return resolveSplatVisual(type, styles[type], {
    regular: setting("regularSplatPath"),
    heal: setting("healSplatPath"),
    tempHp: setting("tempHpSplatPath"),
    sound: setting("defaultSplatSoundPath")
  });
}

/* ------------------------------------------------------------------ */
/* HP change reports                                                  */
/* ------------------------------------------------------------------ */

function buildChangeReport(actor, change, options) {
  const hpPaths = splitPaths(setting("hpPaths"));
  const hpUpdate = detectHpUpdate(actor, change, hpPaths);
  const tempHpDelta = detectTempHpDelta(actor, change, splitPaths(setting("tempHpPaths")));
  const maxHpDelta = detectMaxHpDelta(actor, change, maxHpPathsFor(hpPaths));
  if (!hpUpdate && !tempHpDelta && maxHpDelta?.kind !== "damage") return null;

  const tokenUuids = new Set(findTargetTokens(actor, options).map((token) => token.document?.uuid).filter(Boolean));
  // An unlinked token's actor belongs to exactly one token, even on a scene this client isn't viewing.
  if (actor.isToken && actor.token?.uuid) tokenUuids.add(actor.token.uuid);
  return {
    actorUuid: actor.uuid,
    actorId: actor.id,
    actorName: actor.name,
    tokenUuids: Array.from(tokenUuids),
    hpUpdate,
    tempHpDelta,
    maxHpDelta,
    workflowIds: Array.from(collectWorkflowIdsFromUpdateOptions(options)),
    fromUserId: game.user?.id ?? null
  };
}

function dispatchChangeReport(report) {
  const gm = game.users?.activeGM;
  if (gm && !gm.isSelf && socketReady && splatSocket) {
    debugLog("Sending HP change to the active GM.", { actor: report.actorName, gm: gm.name });
    void splatSocket.executeAsUser("processChangeReport", gm.id, report).catch((error) => {
      console.warn(`${MODULE_ID} | Could not reach the GM. Showing splats from this client instead.`, error);
      processChangeReport(report);
    });
    return;
  }
  processChangeReport(report);
}

function processChangeReport(report) {
  if (!report?.actorUuid) return;
  const tokenRefs = (report.tokenUuids ?? []).map((uuid) => ({ id: tokenIdFromUuid(uuid), uuid }));
  if (!tokenRefs.length) {
    const actor = fromUuidSync(report.actorUuid);
    for (const token of actor ? findTargetTokens(actor) : []) tokenRefs.push({ id: token.id, uuid: token.document.uuid });
  }
  const actorRef = { id: report.actorId, uuid: report.actorUuid, name: report.actorName };
  const workflowIds = new Set(report.workflowIds ?? []);

  const plan = planSplatsForChange(report, (appliedDamage, consumeOptions) =>
    consumePendingTypedDamage(actorRef, tokenRefs, appliedDamage, workflowIds, consumeOptions)
  );
  debugLog("Planned splats for HP change.", { actor: report.actorName, reason: plan.reason, entries: plan.entries, tokens: tokenRefs });
  if (!plan.entries.length) return;

  broadcastSplats({
    actorUuid: report.actorUuid,
    tokenUuids: tokenRefs.map((ref) => ref.uuid).filter(Boolean),
    entries: plan.entries.map((entry) => ({
      damage: Number(entry.damage) || 0,
      damageType: normalizeDamageType(entry.damageType ?? "untyped"),
      kind: entry.kind ?? "damage"
    }))
  });
}

function findTargetTokens(actor, options = {}) {
  const tokens = new Map();
  const add = (token) => {
    if (token?.id && token.document) tokens.set(token.id, token);
  };

  if (actor?.isToken) add(actor.token?.object);
  const optionTokenId = options?.tokenId ?? options?.token?.id ?? null;
  if (optionTokenId) add(canvas?.tokens?.get(optionTokenId));
  const optionTokenUuid = options?.tokenUuid ?? options?.token?.uuid ?? options?.token?.document?.uuid ?? null;
  if (optionTokenUuid) {
    const token = canvas?.tokens?.get(tokenIdFromUuid(optionTokenUuid));
    if (token?.document?.uuid === optionTokenUuid) add(token);
  }
  if (tokens.size) return Array.from(tokens.values());

  // Linked actor: every token for it on this scene.
  for (const token of actor?.getActiveTokens?.(false, false) ?? []) add(token);
  return Array.from(tokens.values());
}

/* ------------------------------------------------------------------ */
/* Sockets                                                            */
/* ------------------------------------------------------------------ */

function ensureSocketRegistration(source) {
  if (socketReady && splatSocket) return true;
  try {
    const socketApi = globalThis.socketlib ?? null;
    if (!socketApi?.registerModule) throw new Error(`socketlib API is unavailable during ${source}.`);
    splatSocket = socketApi.registerModule(MODULE_ID);
    if (!splatSocket?.register) throw new Error(`socketlib.registerModule did not return a valid socket during ${source}.`);
    splatSocket.register("renderSplats", renderSplats);
    splatSocket.register("processChangeReport", processChangeReportFromSocket);
    splatSocket.register("cacheRemoteTypedDamage", cacheRemoteTypedDamage);
    socketReady = true;
    debugLog("Registered splat socket.", { source });
    return true;
  } catch (error) {
    socketReady = false;
    splatSocket = null;
    console.warn(`${MODULE_ID} | Failed to register socket during ${source}.`, error);
    return false;
  }
}

function processChangeReportFromSocket(report) {
  if (!game.user?.isGM) return;
  processChangeReport(report);
}

function broadcastSplats(payload) {
  if (!payload?.entries?.length) return;
  if (socketReady && splatSocket) {
    void splatSocket.executeForEveryone("renderSplats", payload).catch((error) => {
      console.warn(`${MODULE_ID} | Could not broadcast splats. Rendering locally.`, error);
      void renderSplats(payload);
    });
    return;
  }
  void renderSplats(payload);
}

async function renderSplats(payload) {
  if (!payload || !Array.isArray(payload.entries)) return;
  const tokens = resolvePayloadTokens(payload);
  if (!tokens.length) {
    debugLog("No token on this scene for splat payload.", payload);
    return;
  }
  // Every token of the actor is noted before any animation starts, and the animations run together,
  // so a second token's splat is not held back until the first has finished.
  for (const token of tokens) nativeTextGate.noteSplat(token.id);
  await Promise.all(tokens.filter(canUserSeeSplatToken).map(token => showSplatEntries(token, payload.entries)));
}

function resolvePayloadTokens(payload) {
  if (!canvas?.tokens) return [];
  const tokens = new Map();
  for (const uuid of payload.tokenUuids ?? []) {
    const token = canvas.tokens.get(tokenIdFromUuid(uuid));
    if (token && token.document?.uuid === uuid) tokens.set(token.id, token);
  }
  if (!tokens.size && payload.actorUuid) {
    const actor = fromUuidSync(payload.actorUuid);
    for (const token of actor?.getActiveTokens?.(false, false) ?? []) tokens.set(token.id, token);
  }
  return Array.from(tokens.values());
}

function canUserSeeSplatToken(token) {
  if (!token) return false;
  if (game.user?.isGM) return true;
  if (typeof token.isVisible === "boolean") return token.isVisible;
  return token.visible !== false && token.renderable !== false;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

async function showSplatEntries(token, entries, styleOverrides = null) {
  if (!canvas?.tokens || !entries?.length) return;
  const styles = styleOverrides ?? getStoredDamageTypeStyles();
  const visible = entries
    .map((entry) => ({ entry, visual: getSplatVisual(entry.damageType, styles) }))
    .filter(({ visual }) => visual.enabled);
  if (!visible.length) return;

  try {
    const prepared = (await Promise.all(
      visible.map(({ entry, visual }) => prepareSplatData(token, entry, visual, visible.length))
    )).filter(Boolean);
    if (!prepared.length) return;

    playSplatSound(prepared.find((splat) => splat.visual.sound)?.visual.sound);
    const offsets = computeSplatOffsets(prepared, {
      spread: setting("multiSplatSpread"),
      gap: setting("multiSplatGap"),
      arc: setting("multiSplatArc")
    });
    await Promise.allSettled(prepared.map((splat, index) => renderPreparedSplat(token, splat, offsets[index])));
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to display splats.`, error);
  }
}

async function loadSplatTexture(path) {
  if (!path) return null;
  try {
    const texture = await foundry.canvas.loadTexture(path);
    if (texture && texture.valid !== false) return texture;
  } catch (_error) {
    // Reported below.
  }
  if (!missingTextureWarnings.has(path)) {
    missingTextureWarnings.add(path);
    console.warn(`${MODULE_ID} | Could not load splat image "${path}". Using the default splat instead.`);
  }
  return null;
}

async function prepareSplatData(token, entry, visual, multiCount = 1) {
  const texture = (await loadSplatTexture(visual.image))
    ?? (visual.fallbackImage !== visual.image ? await loadSplatTexture(visual.fallbackImage) : null);
  if (!texture) return null;

  const dimensions = getTokenDimensions(token);
  const sizeMultiplier = multiCount > 1 ? 0.75 : 1;
  const targetSize = Math.max(dimensions.size * 0.48 * dimensions.finalScale, 48) * sizeMultiplier;
  const textureWidth = Math.max(texture.width ?? 1, 1);
  const textureHeight = Math.max(texture.height ?? 1, 1);
  const scale = targetSize / Math.max(textureWidth, textureHeight, 1);
  return {
    entry,
    visual,
    texture,
    scale,
    renderedWidth: textureWidth * scale,
    renderedHeight: textureHeight * scale,
    fontSize: Math.max(Math.round(dimensions.size * 0.16 * dimensions.finalScale * sizeMultiplier), 18)
  };
}

function getTokenDimensions(token) {
  const width = token.w ?? (token.document.width * canvas.grid.size);
  const height = token.h ?? (token.document.height * canvas.grid.size);
  const textureScaleX = Number(token.document.texture?.scaleX ?? 1);
  const textureScaleY = Number(token.document.texture?.scaleY ?? 1);
  const actorScale = Math.max(Math.abs(textureScaleX), Math.abs(textureScaleY), 0.1);
  const splatScale = Math.max(Number(setting("splatScale")) || 0.5, 0.05);
  return { width, height, size: Math.max(width, height), finalScale: actorScale * splatScale };
}

async function renderPreparedSplat(token, splat, offset) {
  const container = new PIXI.Container();
  const sprite = new PIXI.Sprite(splat.texture);
  const text = createDamageText(splat.entry.damage, splat.fontSize, splat.visual);

  sprite.anchor.set(0.5);
  sprite.scale.set(splat.scale);
  if (splat.visual.tint !== null) sprite.tint = splat.visual.tint;
  text.anchor.set(0.5);

  container.addChild(sprite, text);
  container.position.set(token.center.x + offset.x, token.center.y + offset.y);
  container.alpha = 0;
  container.scale.set(0.6);
  container.zIndex = 999999;
  container.eventMode = "none";

  canvas.tokens.addChild(container);
  try {
    await animateSplat(container);
  } finally {
    // The layer may have been torn down by a scene change mid-animation.
    if (!container.destroyed) container.destroy({ children: true });
  }
}

function createDamageText(value, fontSize, visual) {
  return new PIXI.Text(String(value), {
    fontFamily: setting("fontFamily"),
    fontSize,
    fill: visual.textColor ?? 0xfff7bd,
    stroke: 0x000000,
    strokeThickness: Math.max(Math.round(fontSize * 0.12), 4),
    align: "center",
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowBlur: 0,
    dropShadowDistance: Math.max(Math.round(fontSize * 0.08), 2)
  });
}

async function animateSplat(container) {
  const CanvasAnimation = foundry.canvas.animation.CanvasAnimation;
  const totalDuration = Math.max(Number(setting("durationMs")) || 2000, 150);
  const introDuration = Math.min(120, Math.round(totalDuration * 0.15));
  const settleDuration = Math.min(90, Math.round(totalDuration * 0.1));
  const outroDuration = Math.max(Math.round(totalDuration * 0.3), 180);
  const holdDuration = Math.max(totalDuration - introDuration - settleDuration - outroDuration, 0);

  await CanvasAnimation.animate(
    [
      { parent: container, attribute: "alpha", from: 0, to: 1 },
      { parent: container.scale, attribute: "x", from: 0.6, to: 1.05 },
      { parent: container.scale, attribute: "y", from: 0.6, to: 1.05 }
    ],
    { duration: introDuration }
  );
  if (container.destroyed) return;
  await CanvasAnimation.animate(
    [
      { parent: container.scale, attribute: "x", from: 1.05, to: 1 },
      { parent: container.scale, attribute: "y", from: 1.05, to: 1 }
    ],
    { duration: settleDuration }
  );
  if (holdDuration > 0) await wait(holdDuration);
  if (container.destroyed) return;
  await CanvasAnimation.animate(
    [
      { parent: container, attribute: "alpha", from: 1, to: 0 },
      { parent: container, attribute: "y", from: container.y, to: container.y - 18 }
    ],
    { duration: outroDuration }
  );
}

/* ------------------------------------------------------------------ */
/* Font                                                               */
/* ------------------------------------------------------------------ */

function registerFontDefinition() {
  // Lists the font in Foundry's font pickers. Damage numbers load it directly below.
  try {
    const family = setting("fontFamily");
    const path = setting("fontPath");
    if (family && path && CONFIG.fontDefinitions && !CONFIG.fontDefinitions[family]) {
      CONFIG.fontDefinitions[family] = { editor: true, fonts: [{ urls: [path] }] };
    }
  } catch (error) {
    debugLog("Could not register the splat font with Foundry.", { error });
  }
}

function loadRuneScapeFont() {
  const fontPath = setting("fontPath");
  const fontFamily = setting("fontFamily");
  if (!fontPath || !fontFamily || !document?.fonts) return;
  new FontFace(fontFamily, cssUrl(fontPath))
    .load()
    .then((face) => document.fonts.add(face))
    .then(() => debugLog("Font loaded.", { fontPath, fontFamily }))
    .catch((error) => console.warn(`${MODULE_ID} | Could not load font at ${fontPath}`, error));
}

/* ------------------------------------------------------------------ */
/* Native floating numbers                                            */
/* ------------------------------------------------------------------ */

function patchNativeScrollingText() {
  const proto = foundry.canvas?.groups?.InterfaceCanvasGroup?.prototype
    ?? (canvas?.interface ? Object.getPrototypeOf(canvas.interface) : null);
  if (!proto || proto._rsDamageSplatsPatched || typeof proto.createScrollingText !== "function") return;
  const original = proto.createScrollingText;
  proto.createScrollingText = function wrappedCreateScrollingText(...args) {
    const [origin, content] = args;
    if (!setting("hideNativeScrollingText") || !isNumericScrollingText(content)) return original.apply(this, args);
    const token = tokenAtOrigin(origin);
    if (!token) return original.apply(this, args);
    const verdict = nativeTextGate.offer(token.id, () => original.apply(this, args));
    debugLog("Native floating number gated.", { token: token.name, content, verdict });
    return verdict === "pass" ? original.apply(this, args) : null;
  };
  proto._rsDamageSplatsPatched = true;
}

function tokenAtOrigin(origin) {
  if (!origin || !canvas?.tokens) return null;
  if (origin.document?.documentName === "Token") return origin;
  const x = Number(origin.x);
  const y = Number(origin.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return canvas.tokens.placeables.find((token) =>
    Math.abs(token.center.x - x) < 2 && Math.abs(token.center.y - y) < 2
  ) ?? null;
}

/* ------------------------------------------------------------------ */
/* Sound                                                              */
/* ------------------------------------------------------------------ */

function playSound(src, label) {
  const path = String(src ?? "").trim();
  if (!path) return false;
  const audioHelper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  if (!audioHelper?.play) {
    console.warn(`${MODULE_ID} | Audio helper is not available for ${label} playback.`);
    return false;
  }
  try {
    const result = audioHelper.play({ src: path, volume: 0.8, autoplay: true, loop: false }, false);
    result?.catch?.((error) => console.warn(`${MODULE_ID} | Could not play ${label} at ${path}`, error));
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not play ${label} at ${path}`, error);
    return false;
  }
}

function playSplatSound(src) {
  if (!setting("enableSplatSounds")) return;
  playSound(src, "splat sound");
}

/* ------------------------------------------------------------------ */
/* Midi-QOL typed damage                                              */
/* ------------------------------------------------------------------ */

function registerMidiQolHooks() {
  if (!game.modules.get("midi-qol")?.active) {
    debugLog("Midi-QOL is not active. Typed damage splats are disabled.");
    return;
  }
  Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
    if (!setting("useMidiQolTypedDamage")) return;
    cacheMidiQolWorkflow(workflow);
  });
  debugLog("Registered Midi-QOL typed damage hook on midi-qol.DamageRollComplete.");
}

/** The typed cache lives on the active GM, who turns HP changes into splats. */
function typedCacheOwner() {
  const gm = game.users?.activeGM;
  if (!gm || gm.isSelf) return null;
  return gm;
}

function cacheMidiQolWorkflow(workflow) {
  try {
    const damageEntries = extractMidiDamageEntries(workflow);
    if (!damageEntries.length) {
      debugLog("Midi-QOL workflow had no typed damage entries.", { workflow });
      return;
    }
    const owner = typedCacheOwner();
    if (owner) {
      forwardTypedDamageEntries(owner, workflow, damageEntries);
      return;
    }
    for (const entry of damageEntries) {
      if (!entry.actor || !entry.types.length) continue;
      storePendingTypedDamage(entry.actor, entry.token, workflow, entry.types, entry.source, entry.phases);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to process Midi-QOL typed damage.`, error);
  }
}

function extractMidiDamageEntries(workflow) {
  const rawDamageList = Array.isArray(workflow?.damageList)
    ? workflow.damageList
    : Array.isArray(workflow?.damageData)
      ? workflow.damageData
      : [];

  const targetEntries = [];
  for (const item of rawDamageList) {
    const entry = buildMidiDamageEntry(item, workflow) ?? buildFallbackMidiDamageEntry(item, workflow);
    if (entry) targetEntries.push(entry);
  }
  if (targetEntries.length) return targetEntries;

  const workflowWideTypes = collectTypedDamageFromMidiWorkflow(workflow);
  if (!workflowWideTypes.length) return [];
  return findWorkflowTargets(workflow)
    .map((token) => ({
      actor: token.actor,
      token,
      source: "workflow-item-fallback",
      phases: workflowWideTypes.map((entry) => ({ phase: "save-burst", type: entry.type, damage: entry.damage })),
      types: workflowWideTypes
    }))
    .filter((entry) => entry.actor && entry.types.length);
}

function buildMidiDamageEntry(item, workflow) {
  const token = findTokenFromMidiItem(item);
  const actor = token?.actor ?? findActorFromMidiItem(item);
  if (!actor) return null;
  const resolved = resolveTypedDamageForTarget(item, workflow, token, actor);
  const typedDamage = resolved.types.filter((entry) => entry.damage > 0);
  if (!typedDamage.length) return null;
  return { actor, token, phases: resolved.phases, source: resolved.source, types: typedDamage };
}

function buildFallbackMidiDamageEntry(item, workflow) {
  const token = findTokenFromMidiItem(item);
  const actor = token?.actor ?? findActorFromMidiItem(item);
  if (!actor) return null;

  const phaseEntries = inferTypedPhaseEntriesForTarget(item, workflow, token, actor);
  const phasedTypes = mergePhaseEntriesByType(phaseEntries);
  if (phasedTypes.length) {
    return { actor, token, phases: phaseEntries, source: "workflow-item-fallback", types: phasedTypes };
  }

  const targetTotalDamage = resolveMidiItemAppliedDamage(item, workflow);
  if (targetTotalDamage <= 0) return null;
  const workflowWideTypes = collectTypedDamageFromMidiWorkflow(workflow);
  if (!workflowWideTypes.length) return null;
  const scaledTypes = scaleTypedDamage(workflowWideTypes, targetTotalDamage)
    .map((entry) => ({ type: normalizeDamageType(entry.type), damage: Number(entry.damage) || 0 }))
    .filter((entry) => entry.damage > 0);
  if (!scaledTypes.length) return null;
  return {
    actor,
    token,
    phases: deriveWorkflowPhases(workflow, token, actor, scaledTypes),
    source: "workflow-item-fallback",
    types: scaledTypes
  };
}

function findTokenFromMidiItem(item) {
  if (!canvas?.tokens) return null;
  const tokenId = item?.tokenId ?? tokenIdFromUuid(item?.tokenUuid) ?? tokenIdFromUuid(item?.actorUuid);
  if (tokenId) {
    const token = canvas.tokens.get(tokenId);
    if (token) return token;
  }
  // Only a linked actor maps safely to "its" token; unlinked tokens share a base actor id.
  const actorId = item?.actorId ?? String(item?.actorUuid ?? "").split(".").at(-1);
  if (!actorId) return null;
  return canvas.tokens.placeables.find((token) => token.document.actorLink && token.document.actorId === actorId) ?? null;
}

function findActorFromMidiItem(item) {
  if (item?.actorUuid) {
    const actor = fromUuidSync(item.actorUuid);
    if (actor) return actor;
  }
  return item?.actorId ? game.actors?.get(item.actorId) ?? null : null;
}

function resolveTypedDamageForTarget(item, workflow, token, actor) {
  const explicit = collectExplicitTypedDamage(item, workflow);
  const explicitConcrete = explicit.filter((entry) => entry.type !== "untyped");

  // A per-target Midi damage detail already includes saves, resistances,
  // immunities, and mixed damage. It is more trustworthy than item inference.
  if (explicitConcrete.length) {
    return {
      source: "explicit-midi-detail",
      phases: deriveWorkflowPhases(workflow, token, actor, explicitConcrete),
      types: explicitConcrete
    };
  }

  const derivedPhases = inferTypedPhaseEntriesForTarget(item, workflow, token, actor);
  const derivedConcrete = mergePhaseEntriesByType(derivedPhases).filter((entry) => entry.type !== "untyped");
  if (derivedConcrete.length) {
    return { source: "workflow-item-fallback", phases: derivedPhases, types: derivedConcrete };
  }

  if (explicit.length) {
    return { source: "explicit-midi-untyped", phases: deriveWorkflowPhases(workflow, token, actor, explicit), types: explicit };
  }
  return { source: "none", phases: [], types: [] };
}

function collectExplicitTypedDamage(item, workflow) {
  const itemSpecific = [
    item?.damageDetail,
    item?.damageDetails,
    item?.damageDetailApplied,
    item?.appliedDamageDetail,
    item?.calcDamageOptions?.damageDetail,
    item?.calcDamageOptions?.damageDetails
  ];
  const workflowWide = [
    workflow?.damageDetail,
    workflow?.damageDetails,
    workflow?.damageItem?.damageDetail,
    workflow?.damageItem?.damageDetails
  ];
  const hasItemSpecific = itemSpecific.some((candidate) => flattenDamageCandidates(candidate).length > 0);
  return aggregateTypedDamage(hasItemSpecific ? itemSpecific : workflowWide);
}

function collectTypedDamageFromMidiWorkflow(workflow) {
  const aggregated = aggregateTypedDamage([
    workflow?.damageDetail,
    workflow?.damageDetails,
    workflow?.damageItem?.damageDetail,
    workflow?.damageItem?.damageDetails,
    workflow?.workflowOptions?.damageDetail,
    workflow?.workflowOptions?.damageDetails
  ]);
  if (aggregated.length) return aggregated;

  const types = collectWorkflowItemDamageTypes(workflow);
  if (!types.length) return [];
  const totalDamage = resolveWorkflowTotalDamage(workflow);
  if (totalDamage <= 0) return [];
  if (types.length === 1) return [{ type: types[0], damage: totalDamage }];
  return splitDamageAcrossTypes(types, totalDamage);
}

function activityKind(workflow) {
  const name = workflow?.activity?.constructor?.name ?? "";
  return { isAttack: /Attack/i.test(name), isSave: /Save/i.test(name) };
}

function inferTypedPhaseEntriesForTarget(item, workflow, token, actor) {
  const targetInfo = getWorkflowTargetInfo(workflow, token, actor);
  const { isAttack, isSave } = activityKind(workflow);
  const types = selectTargetDamageTypes(collectWorkflowItemDamageTypes(workflow), { isAttack, ...targetInfo });
  if (!types.length) return [];

  const isMixedAttackSave = isAttack && types.length > 1 && (targetInfo.isAnySaveTarget || hasWorkflowSaveTargets(workflow));
  const rollTotals = resolveWorkflowDamageRollTotals(workflow);

  if (isMixedAttackSave && rollTotals.length >= 2) {
    const phases = [];
    const primaryDamage = rollTotals[0];
    const secondaryDamage = rollTotals.slice(1).reduce((sum, value) => sum + value, 0);
    if (targetInfo.isHitTarget && primaryDamage > 0) {
      phases.push({ phase: "attack-hit", type: types[0], damage: primaryDamage });
    }
    if (targetInfo.isAnySaveTarget && secondaryDamage > 0) {
      for (const entry of splitDamageAcrossTypes(types.slice(1), secondaryDamage)) {
        phases.push({ phase: "save-burst", type: entry.type, damage: entry.damage });
      }
    }
    if (phases.length) return phases;
  }

  const totalDamage = resolveMidiItemAppliedDamage(item, workflow);
  if (totalDamage <= 0) return [];

  if (isSave) {
    return splitDamageAcrossTypes(types, totalDamage).map((entry, index) => ({
      phase: index === 0 ? "save-burst" : `save-burst-${index}`,
      type: entry.type,
      damage: entry.damage
    }));
  }
  if (types.length === 1) {
    return [{ phase: isAttack ? "attack-hit" : "damage", type: types[0], damage: totalDamage }];
  }
  return splitDamageAcrossTypes(types, totalDamage).map((entry, index) => ({
    phase: index === 0 && isAttack ? "attack-hit" : "save-burst",
    type: entry.type,
    damage: entry.damage
  }));
}

function collectWorkflowItemDamageTypes(workflow) {
  // Damage parts only: an activity's own `type` ("attack", "save") is not a damage type.
  const activityParts = workflow?.activity
    ? [workflow.activity.damage?.parts]
    : Array.from(workflow?.item?.system?.activities?.values?.() ?? []).map((activity) => activity?.damage?.parts);
  const partsCandidates = [
    workflow?.item?.system?.damage?.parts,
    workflow?.item?.system?.damage?.value,
    workflow?.item?.system?.formula?.parts,
    workflow?.activity?.damage?.value,
    ...activityParts
  ];
  const types = [];
  for (const candidate of partsCandidates) {
    for (const type of flattenDamagePartTypes(candidate)) if (type) types.push(type);
  }
  return Array.from(new Set(types));
}

function flattenDamagePartTypes(candidate, depth = 0) {
  if (!candidate || typeof candidate !== "object" || depth > 4) return [];
  if (Array.isArray(candidate)) {
    // Legacy dnd5e part: ["1d8 + @mod", "slashing"].
    if (candidate.length === 2 && typeof candidate[0] === "string" && typeof candidate[1] === "string") {
      return candidate[1].trim() ? [normalizeDamageType(candidate[1])] : [];
    }
    return candidate.flatMap((part) => flattenDamagePartTypes(part, depth + 1));
  }
  // dnd5e 4.x damage parts list their types as a Set (an array in source data).
  const typeList = candidate.types instanceof Set ? Array.from(candidate.types) : candidate.types;
  if (Array.isArray(typeList)) {
    return typeList.filter((type) => typeof type === "string" && type.trim()).map((type) => normalizeDamageType(type));
  }
  const directType = candidate.type ?? candidate.damageType ?? "";
  if (typeof directType === "string" && directType.trim()) return [normalizeDamageType(directType)];
  return [];
}

function deriveWorkflowPhases(workflow, token, actor, typedEntries) {
  const targetInfo = getWorkflowTargetInfo(workflow, token, actor);
  const { isAttack, isSave } = activityKind(workflow);
  if (isSave) return typedEntries.map((entry) => ({ phase: "save-burst", type: entry.type, damage: entry.damage }));
  if (!isAttack) return typedEntries.map((entry) => ({ phase: "damage", type: entry.type, damage: entry.damage }));
  if (typedEntries.length === 1) {
    return [{
      phase: targetInfo.isFailedSaveTarget ? "save-burst" : "attack-hit",
      type: typedEntries[0].type,
      damage: typedEntries[0].damage
    }];
  }
  return typedEntries.map((entry, index) => ({
    phase: index === 0 && targetInfo.isHitTarget ? "attack-hit" : "save-burst",
    type: entry.type,
    damage: entry.damage
  }));
}

function getWorkflowTargetInfo(workflow, token, actor) {
  const tokenId = token?.id ?? null;
  const actorUuid = actor?.uuid ?? token?.actor?.uuid ?? null;
  // Match by token where we know it; unlinked tokens share their base actor id.
  const matches = (collection) =>
    normalizeTargetCollection(collection).some((candidate) =>
      tokenId ? candidate?.id === tokenId : Boolean(actorUuid) && candidate?.actor?.uuid === actorUuid
    );
  return {
    isHitTarget: matches(workflow?.hitTargets),
    isFailedSaveTarget: matches(workflow?.failedSaves),
    isTarget: matches(workflow?.targets),
    isAnySaveTarget:
      matches(workflow?.failedSaves) ||
      matches(workflow?.saves) ||
      matches(workflow?.superSavers) ||
      matches(workflow?.semiSuperSavers)
  };
}

function hasWorkflowSaveTargets(workflow) {
  return [workflow?.failedSaves, workflow?.saves, workflow?.superSavers, workflow?.semiSuperSavers]
    .some((collection) => normalizeTargetCollection(collection).length > 0);
}

function resolveWorkflowTotalDamage(workflow) {
  for (const candidate of [workflow?.damageTotal, workflow?.damageItem?.hpDamage, workflow?.damageItem?.appliedDamage, workflow?.damageRoll?.total]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  }
  const sum = resolveWorkflowDamageRollTotals(workflow).reduce((acc, value) => acc + value, 0);
  return sum > 0 ? sum : 0;
}

function resolveWorkflowDamageRollTotals(workflow) {
  const totals = [];
  for (const roll of Array.isArray(workflow?.damageRolls) ? workflow.damageRolls : []) {
    const numeric = Number(roll?.total);
    if (Number.isFinite(numeric) && numeric > 0) totals.push(Math.round(numeric));
  }
  if (!totals.length) {
    const single = Number(workflow?.damageRoll?.total);
    if (Number.isFinite(single) && single > 0) totals.push(Math.round(single));
  }
  return totals;
}

function resolveMidiItemAppliedDamage(item, workflow) {
  const candidates = [
    item?.appliedDamage,
    item?.hpDamage,
    item?.totalDamage,
    item?.damage,
    item?.appliedTotal,
    item?.newHP !== undefined && item?.oldHP !== undefined ? Number(item.oldHP) - Number(item.newHP) : undefined
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  }
  return resolveWorkflowTotalDamage(workflow);
}

function findWorkflowTargets(workflow) {
  const tokens = new Map();
  const candidates = [
    workflow?.hitTargets,
    workflow?.targets,
    workflow?.failedSaves,
    workflow?.saves,
    workflow?.superSavers,
    workflow?.semiSuperSavers,
    workflow?.applicationTargets,
    workflow?.damageList?.map?.((entry) => entry?.tokenUuid ?? entry?.tokenId),
    workflow?.damageData?.map?.((entry) => entry?.tokenUuid ?? entry?.tokenId)
  ];
  for (const candidate of candidates) {
    for (const token of normalizeTargetCollection(candidate)) if (token?.id) tokens.set(token.id, token);
  }
  return Array.from(tokens.values());
}

function normalizeTargetCollection(candidate) {
  if (!candidate) return [];
  if (candidate instanceof Set) return Array.from(candidate).flatMap((entry) => normalizeTargetCollection(entry));
  if (Array.isArray(candidate)) return candidate.flatMap((entry) => normalizeTargetCollection(entry));
  if (typeof candidate === "string") {
    const token = canvas?.tokens?.get(tokenIdFromUuid(candidate) ?? candidate);
    return token ? [token] : [];
  }
  if (candidate.object?.documentName === "Token") return [candidate.object];
  if (candidate.document?.documentName === "Token") return [candidate];
  if (candidate.documentName === "Token") return candidate.object ? [candidate.object] : [];
  if (candidate.token?.documentName === "Token") return candidate.token.object ? [candidate.token.object] : [];
  if (candidate.id && canvas?.tokens?.get(candidate.id)) return [canvas.tokens.get(candidate.id)];
  return [];
}

/* ------------------------------------------------------------------ */
/* Pending typed damage cache                                         */
/* ------------------------------------------------------------------ */

function buildPendingTargetKey(actorUuid, actorId, tokenUuid, tokenId) {
  return [actorUuid ?? "", actorId ?? "", tokenUuid ?? "", tokenId ?? ""].join("|");
}

function getWorkflowCacheId(workflow) {
  return String(workflow?.uuid ?? workflow?.id ?? foundry.utils.randomID());
}

function storePendingTypedDamage(actor, token, workflow, types, source = "unknown", phases = null) {
  if (!actor?.uuid || !Array.isArray(types) || !types.length) return;
  storePendingTypedDamagePayload({
    workflowId: getWorkflowCacheId(workflow),
    actorId: actor.id,
    actorUuid: actor.uuid,
    actorName: actor.name,
    tokenId: token?.id ?? null,
    tokenUuid: token?.document?.uuid ?? null,
    tokenName: token?.name ?? null,
    source,
    phases: Array.isArray(phases) && phases.length
      ? phases
      : types.map((entry) => ({ phase: "damage", type: entry.type, damage: entry.damage }))
  });
}

function forwardTypedDamageEntries(owner, workflow, damageEntries) {
  const workflowId = getWorkflowCacheId(workflow);
  const payloads = damageEntries
    .filter((entry) => entry?.actor && Array.isArray(entry.types) && entry.types.length)
    .map((entry) => ({
      workflowId,
      actorId: entry.actor.id ?? null,
      actorUuid: entry.actor.uuid ?? null,
      actorName: entry.actor.name ?? null,
      tokenId: entry.token?.id ?? null,
      tokenUuid: entry.token?.document?.uuid ?? null,
      tokenName: entry.token?.name ?? null,
      source: String(entry.source ?? "unknown").startsWith("remote:") ? entry.source : `remote:${entry.source}`,
      phases: (Array.isArray(entry.phases) && entry.phases.length
        ? entry.phases
        : entry.types.map((typed) => ({ phase: "damage", type: typed.type, damage: typed.damage })))
        .map((phase) => ({ phase: String(phase.phase ?? "damage"), type: normalizeDamageType(phase.type), damage: Number(phase.damage) || 0 }))
        .filter((phase) => phase.damage > 0)
    }))
    .filter((payload) => payload.phases.length);
  if (!payloads.length) return;
  if (!socketReady || !splatSocket) {
    debugLog("socketlib unavailable. Could not forward typed damage to the GM.", { workflowId });
    return;
  }
  void splatSocket.executeAsUser("cacheRemoteTypedDamage", owner.id, payloads).catch((error) => {
    console.warn(`${MODULE_ID} | Could not forward typed damage payloads to the GM.`, error);
  });
}

function cacheRemoteTypedDamage(payloads) {
  if (!game.user?.isGM || !Array.isArray(payloads)) return;
  for (const payload of payloads) storePendingTypedDamagePayload(payload);
}

function storePendingTypedDamagePayload(payload) {
  const actorId = payload?.actorId ?? null;
  const actorUuid = payload?.actorUuid ?? null;
  const tokenId = payload?.tokenId ?? null;
  const tokenUuid = payload?.tokenUuid ?? null;
  const phases = Array.isArray(payload?.phases) ? payload.phases : [];
  if (!phases.length || !(actorId || actorUuid)) return;

  cleanupExpiredPendingTypedDamage();
  const workflowId = String(payload?.workflowId ?? foundry.utils.randomID());
  const targetKey = buildPendingTargetKey(actorUuid, actorId, tokenUuid, tokenId);
  const source = String(payload?.source ?? "unknown");
  const createdAt = Date.now();

  for (const [index, phaseEntry] of phases.entries()) {
    const type = normalizeDamageType(phaseEntry.type);
    const totalDamage = Number(phaseEntry.damage) || 0;
    if (totalDamage <= 0) continue;
    const storeKey = `${workflowId}::${targetKey}::${phaseEntry.phase}::${type}::${index}`;
    const pendingEntry = {
      workflowId,
      actorId,
      actorUuid,
      tokenId,
      tokenUuid,
      phase: String(phaseEntry.phase ?? "damage"),
      createdAt,
      expiresAt: createdAt + PENDING_TYPED_DAMAGE_TTL_MS,
      totalDamage,
      source,
      types: [{ type, damage: totalDamage }]
    };
    const existing = pendingTypedDamageStore.get(storeKey);
    if (existing && !shouldReplacePendingEntry(existing, pendingEntry)) continue;
    pendingTypedDamageStore.set(storeKey, pendingEntry);
    trimPendingTypedDamageStore();
    debugLog("Stored pending typed damage entry.", {
      actor: payload?.actorName,
      token: payload?.tokenName,
      workflowId,
      phase: pendingEntry.phase,
      source,
      totalDamage
    });
  }
}

function consumePendingTypedDamage(actorRef, tokenRefs, appliedDamage, workflowIds = new Set(), consumeOptions = {}) {
  cleanupExpiredPendingTypedDamage();
  const numericAppliedDamage = Number(appliedDamage) || 0;
  const useCachedDamage = numericAppliedDamage <= 0 && consumeOptions.allowCachedDamage === true;
  if (numericAppliedDamage <= 0 && !useCachedDamage) return null;
  if (!pendingTypedDamageStore.size) return null;

  const tokenIds = new Set(tokenRefs.map((ref) => ref.id).filter(Boolean));
  const tokenUuids = new Set(tokenRefs.map((ref) => ref.uuid).filter(Boolean));
  const now = Date.now();

  const candidates = Array.from(pendingTypedDamageStore.entries())
    .map(([storeKey, entry]) => ({ storeKey, entry }))
    .filter(({ entry }) => {
      const actorMatch = entry.actorUuid && actorRef.uuid
        ? entry.actorUuid === actorRef.uuid
        : Boolean(actorRef.id) && entry.actorId === actorRef.id;
      const tokenMatch = !tokenIds.size || !entry.tokenId || tokenIds.has(entry.tokenId) || tokenUuids.has(entry.tokenUuid);
      if (!actorMatch || !tokenMatch) return false;
      if (useCachedDamage) {
        return workflowIds.has(String(entry.workflowId)) || now - entry.createdAt <= CLAMPED_UPDATE_MAX_AGE_MS;
      }
      return true;
    });
  if (!candidates.length) {
    debugLog("No matching typed damage for HP change.", { actor: actorRef.name, appliedDamage: numericAppliedDamage });
    return null;
  }

  const group = findBestPendingCandidateGroup(candidates, useCachedDamage ? null : numericAppliedDamage, workflowIds);
  if (!group) return null;
  for (const item of group.items) pendingTypedDamageStore.delete(item.storeKey);
  if (group.totalDamage <= 0) return null;

  debugLog("Matched typed damage for HP change.", {
    actor: actorRef.name,
    workflowId: group.workflowId,
    source: group.source,
    appliedDamage: numericAppliedDamage,
    cachedTotal: group.totalDamage,
    types: group.types
  });

  if (useCachedDamage || Math.abs(group.totalDamage - numericAppliedDamage) <= 0.01) {
    return { totalDamage: group.totalDamage, types: group.types };
  }
  return { totalDamage: numericAppliedDamage, types: scaleTypedDamage(group.types, numericAppliedDamage) };
}

function trimPendingTypedDamageStore() {
  const overflow = pendingTypedDamageStore.size - MAX_PENDING_TYPED_DAMAGE_ENTRIES;
  if (overflow <= 0) return;
  const oldestKeys = Array.from(pendingTypedDamageStore.entries())
    .sort((left, right) => (left[1]?.createdAt ?? 0) - (right[1]?.createdAt ?? 0))
    .slice(0, overflow)
    .map(([storeKey]) => storeKey);
  for (const storeKey of oldestKeys) pendingTypedDamageStore.delete(storeKey);
}

function cleanupExpiredPendingTypedDamage() {
  const now = Date.now();
  for (const [storeKey, entry] of pendingTypedDamageStore.entries()) {
    if (entry.expiresAt < now) pendingTypedDamageStore.delete(storeKey);
  }
}

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

function wait(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function debugLog(message, data = {}) {
  if (!game.settings?.settings?.has?.(`${MODULE_ID}.debug`) || !setting("debug")) return;
  console.log(`${MODULE_ID} | ${message}`, data);
}

function findPreviewToken() {
  return canvas?.tokens?.controlled?.[0]
    ?? game.user?.character?.getActiveTokens?.()[0]
    ?? canvas?.tokens?.placeables?.find((token) => token.actor?.isOwner)
    ?? null;
}

const previewImageCache = new Map();

function loadPreviewImage(path) {
  const normalizedPath = String(path ?? "").trim();
  if (!normalizedPath) return Promise.resolve(null);
  if (previewImageCache.has(normalizedPath)) return previewImageCache.get(normalizedPath);
  const promise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = normalizedPath;
  });
  previewImageCache.set(normalizedPath, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/* Damage Type Styles manager                                         */
/* ------------------------------------------------------------------ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DamageTypeStylesConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-damage-type-styles`,
    tag: "form",
    classes: ["rsds-config-window"],
    window: {
      title: "Fluxee's Damage Splats: Damage Type Styles",
      icon: "fas fa-burst",
      resizable: true
    },
    position: { width: 1040, height: 900 },
    form: {
      handler: DamageTypeStylesConfig.#onSubmit,
      closeOnSubmit: true,
      submitOnChange: false
    },
    actions: {
      apply: DamageTypeStylesConfig.#onApply,
      "reset-all": DamageTypeStylesConfig.#onResetAll,
      preview: DamageTypeStylesConfig.#onPreview,
      "test-sound": DamageTypeStylesConfig.#onTestSound,
      reset: DamageTypeStylesConfig.#onResetRow,
      "bundled-art": DamageTypeStylesConfig.#onBundledArt,
      "browse-image": DamageTypeStylesConfig.#onBrowseImage,
      "browse-sound": DamageTypeStylesConfig.#onBrowseSound
    }
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/damage-type-styles-config.html`,
      scrollable: [".rsds-manager-list"]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const styles = getStoredDamageTypeStyles();
    const rows = Object.entries(styles)
      .sort(([typeA], [typeB]) => {
        const indexA = TYPE_ORDER.indexOf(typeA);
        const indexB = TYPE_ORDER.indexOf(typeB);
        if (indexA === -1 && indexB === -1) return typeA.localeCompare(typeB);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      })
      .map(([type, style]) => {
        const visual = getSplatVisual(type, styles);
        return {
          type,
          label: style.label,
          enabled: style.enabled,
          image: style.image,
          soundEnabled: style.soundEnabled,
          sound: style.sound,
          tint: style.tint,
          text: style.text,
          bundledArt: BUNDLED_TYPE_ART[type] ?? "",
          previewAmount: type === "heal" ? 12 : 9,
          imageModeLabel: IMAGE_MODE_LABELS[visual.mode] ?? "",
          soundModeLabel: !style.soundEnabled ? "Sound Off" : style.sound ? "Custom Sound" : "Default Sound",
          textColor: style.text || DEFAULT_TEXT_COLOR,
          tintColor: style.tint || DEFAULT_TINT_PICKER_COLOR
        };
      });
    return { ...context, rows };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const sync = (event) => {
      const row = event.target.closest?.(".rsds-row[data-type]");
      this._syncColorToggleStates(row ?? this.element);
      this._syncRowPreviews(row ?? this.element);
    };
    this.element.addEventListener("input", sync);
    this.element.addEventListener("change", sync);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._syncColorToggleStates();
    this._syncRowPreviews();
  }

  static async #onSubmit() {
    await this._saveStyles();
  }

  static async #onApply() {
    await this._saveStyles();
  }

  static #onResetAll() {
    for (const row of this.element.querySelectorAll(".rsds-row[data-type]")) {
      this._resetRowToDefaults(row, normalizeDamageType(row.dataset.type));
    }
    ui.notifications?.info("Damage type rows reset to bundled defaults. Save to keep them.");
  }

  static async #onPreview(_event, button) {
    const type = normalizeDamageType(button.dataset.type);
    const token = findPreviewToken();
    if (!token) {
      ui.notifications?.warn("Select or control a token before testing a splat.");
      return;
    }
    const styleOverrides = this._collectStylesFromForm();
    if (!getSplatVisual(type, styleOverrides).enabled) {
      ui.notifications?.warn(`${typeLabel(type)} splats are disabled. Tick Enabled to test this type.`);
      return;
    }
    const amount = Number(button.dataset.amount ?? 9) || 9;
    await showSplatEntries(token, [{ damage: amount, damageType: type, kind: previewKindForType(type) }], styleOverrides);
  }

  static #onTestSound(_event, button) {
    const row = button.closest(".rsds-row[data-type]");
    if (!row) return;
    const type = normalizeDamageType(row.dataset.type);
    if (!row.querySelector(`[name="styles.${type}.soundEnabled"]`)?.checked) {
      ui.notifications?.warn("Enable sound for this row before testing it.");
      return;
    }
    const customPath = String(row.querySelector(`[name="styles.${type}.sound"]`)?.value ?? "").trim();
    const soundPath = customPath || setting("defaultSplatSoundPath");
    if (!soundPath) {
      ui.notifications?.warn("This row does not have a sound path to test.");
      return;
    }
    playSound(soundPath, "preview sound");
  }

  static #onResetRow(_event, button) {
    const type = normalizeDamageType(button.dataset.type);
    const row = this._row(type);
    if (row) this._resetRowToDefaults(row, type);
  }

  static #onBundledArt(_event, button) {
    const type = normalizeDamageType(button.dataset.type);
    const row = this._row(type);
    const art = BUNDLED_TYPE_ART[type];
    if (!row || !art) return;
    row.querySelector(`[name="styles.${type}.image"]`).value = art;
    // Bundled art is already colored; a tint would be drawn on the tint base instead.
    row.querySelector(`[name="styles.${type}.tintEnabled"]`).checked = false;
    this._syncColorToggleStates(row);
    this._syncRowPreviews(row);
  }

  static async #onBrowseImage(_event, button) {
    await this._browseForPath(button, "image");
  }

  static async #onBrowseSound(_event, button) {
    await this._browseForPath(button, "audio");
  }

  _row(type) {
    return this.element.querySelector(`.rsds-row[data-type="${CSS.escape(type)}"]`);
  }

  _syncColorToggleStates(scope = this.element) {
    if (!scope) return;
    const rows = scope.matches?.(".rsds-row[data-type]") ? [scope] : scope.querySelectorAll(".rsds-row[data-type]");
    for (const row of rows) {
      const type = normalizeDamageType(row.dataset.type);
      for (const key of ["text", "tint"]) {
        const toggle = row.querySelector(`[name="styles.${type}.${key}Enabled"]`);
        const input = row.querySelector(`[name="styles.${type}.${key}"]`);
        if (toggle && input) input.disabled = !toggle.checked;
      }
    }
  }

  _syncRowPreviews(scope = this.element) {
    if (!scope) return;
    const styleOverrides = this._collectStylesFromForm();
    const rows = scope.matches?.(".rsds-row[data-type]") ? [scope] : scope.querySelectorAll(".rsds-row[data-type]");
    for (const row of rows) {
      const type = normalizeDamageType(row.dataset.type);
      const visual = getSplatVisual(type, styleOverrides);
      const previewBox = row.querySelector("[data-preview-box]");
      const previewText = row.querySelector("[data-preview-text]");
      const imageModeBadge = row.querySelector("[data-derived='image-mode']");
      const soundModeBadge = row.querySelector("[data-derived='sound-mode']");
      const soundEnabled = Boolean(row.querySelector(`[name="styles.${type}.soundEnabled"]`)?.checked);
      const textColor = toCssHexColor(visual.textColor, DEFAULT_TEXT_COLOR);

      row.classList.toggle("is-disabled", !visual.enabled);
      row.classList.toggle("rsds-uses-tint-base", visual.mode === "tint-base");
      if (previewBox) previewBox.style.setProperty("--rsds-preview-text", textColor);
      if (previewText) previewText.style.color = textColor;
      if (imageModeBadge) imageModeBadge.textContent = IMAGE_MODE_LABELS[visual.mode] ?? "";
      if (soundModeBadge) {
        const custom = String(row.querySelector(`[name="styles.${type}.sound"]`)?.value ?? "").trim();
        soundModeBadge.textContent = !soundEnabled ? "Sound Off" : custom ? "Custom Sound" : "Default Sound";
      }
      // A disabled type still previews its look, dimmed, so it can be re-enabled knowingly.
      const look = visual.enabled ? visual : getSplatVisual(type, { ...styleOverrides, [type]: { ...styleOverrides[type], enabled: true } });
      void this._renderPreviewCanvas(row.querySelector("[data-preview-canvas]"), look.image, look.fallbackImage, look.tint, previewBox);
    }
  }

  async _renderPreviewCanvas(canvasElement, imagePath, fallbackPath, tintValue, previewBox) {
    if (!(canvasElement instanceof HTMLCanvasElement)) return;
    const context = canvasElement.getContext("2d");
    if (!context) return;
    const requestKey = `${imagePath || ""}|${tintValue ?? ""}`;
    canvasElement.dataset.previewRequestKey = requestKey;

    const dpr = window.devicePixelRatio || 1;
    const baseSize = 144;
    if (canvasElement.width !== baseSize * dpr || canvasElement.height !== baseSize * dpr) {
      canvasElement.width = baseSize * dpr;
      canvasElement.height = baseSize * dpr;
    }

    const primary = await loadPreviewImage(imagePath);
    const loadedImage = primary ?? (fallbackPath && fallbackPath !== imagePath ? await loadPreviewImage(fallbackPath) : null);
    if (canvasElement.dataset.previewRequestKey !== requestKey) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvasElement.width, canvasElement.height);
    context.scale(dpr, dpr);
    previewBox?.classList.toggle("is-empty", !loadedImage);
    // The splat would fall back to the default image; flag the bad path.
    previewBox?.classList.toggle("is-broken", Boolean(imagePath) && !primary);
    if (previewBox) previewBox.title = imagePath && !primary ? `Can't load ${imagePath}. The default splat is shown instead.` : "";
    if (!loadedImage) return;

    const maxSize = baseSize - 16;
    const naturalWidth = loadedImage.naturalWidth || loadedImage.width || maxSize;
    const naturalHeight = loadedImage.naturalHeight || loadedImage.height || maxSize;
    const scale = Math.min(maxSize / naturalWidth, maxSize / naturalHeight, 1);
    const drawWidth = Math.max(Math.round(naturalWidth * scale), 1);
    const drawHeight = Math.max(Math.round(naturalHeight * scale), 1);
    const drawX = Math.round((baseSize - drawWidth) / 2);
    const drawY = Math.round((baseSize - drawHeight) / 2);

    context.imageSmoothingEnabled = true;
    context.drawImage(loadedImage, drawX, drawY, drawWidth, drawHeight);
    if (tintValue !== null && tintValue !== undefined) {
      // Same result as PIXI's multiply tint: image color × tint, original alpha.
      context.globalCompositeOperation = "source-atop";
      context.fillStyle = toCssHexColor(tintValue, DEFAULT_TINT_PICKER_COLOR);
      context.fillRect(drawX, drawY, drawWidth, drawHeight);
      context.globalCompositeOperation = "multiply";
      context.drawImage(loadedImage, drawX, drawY, drawWidth, drawHeight);
      context.globalCompositeOperation = "destination-atop";
      context.drawImage(loadedImage, drawX, drawY, drawWidth, drawHeight);
      context.globalCompositeOperation = "source-over";
    }
  }

  async _browseForPath(button, fileType) {
    const inputSelector = button?.dataset?.target;
    const input = inputSelector ? this.element.querySelector(inputSelector) : null;
    if (!input) return;
    const current = String(input.value ?? "").trim();
    const Picker = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const picker = new Picker({
      type: fileType === "audio" ? "audio" : "image",
      current: current.includes("/") ? current.split("/").slice(0, -1).join("/") : "",
      callback: (path) => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await picker.render({ force: true });
  }

  _resetRowToDefaults(row, type) {
    const defaults = getDefaultDamageTypeStyles()[type];
    if (!defaults) return;
    const field = (key) => row.querySelector(`[name="styles.${type}.${key}"]`);
    field("enabled").checked = defaults.enabled !== false;
    field("image").value = defaults.image ?? "";
    field("soundEnabled").checked = defaults.soundEnabled !== false;
    field("sound").value = defaults.sound ?? "";
    field("tintEnabled").checked = Boolean(defaults.tint);
    field("textEnabled").checked = Boolean(defaults.text);
    field("tint").value = defaults.tint || DEFAULT_TINT_PICKER_COLOR;
    field("text").value = defaults.text || DEFAULT_TEXT_COLOR;
    this._syncColorToggleStates(row);
    this._syncRowPreviews(row);
  }

  _collectStylesFromForm() {
    const normalized = {};
    for (const row of this.element.querySelectorAll(".rsds-row[data-type]")) {
      const type = normalizeDamageType(row.dataset.type);
      const label = row.dataset.label || typeLabel(type);
      const field = (key) => row.querySelector(`[name="styles.${type}.${key}"]`);
      normalized[type] = sanitizeStyleRecord({
        label,
        enabled: Boolean(field("enabled")?.checked),
        image: field("image")?.value ?? "",
        soundEnabled: Boolean(field("soundEnabled")?.checked),
        sound: field("sound")?.value ?? "",
        tint: field("tintEnabled")?.checked ? (field("tint")?.value ?? "") : "",
        text: field("textEnabled")?.checked ? (field("text")?.value ?? "") : ""
      }, label);
    }
    return normalized;
  }

  async _saveStyles() {
    await game.settings.set(MODULE_ID, "damageTypeStyles", JSON.stringify(this._collectStylesFromForm(), null, 2));
    ui.notifications?.info("Damage type splat settings saved.");
  }
}
