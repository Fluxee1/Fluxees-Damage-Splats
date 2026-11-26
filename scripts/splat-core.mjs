// Pure logic for Fluxee's Damage Splats. No Foundry, canvas or DOM access, so
// everything here is covered by `node --test tests/`.

export const MODULE_ID = "rs-damage-splats";
const ASSET_ROOT = `modules/${MODULE_ID}/assets`;

export const DEFAULT_REGULAR_SPLAT = `${ASSET_ROOT}/regularsplat.webp`;
export const DEFAULT_HEAL_SPLAT = `${ASSET_ROOT}/healsplat.webp`;
export const DEFAULT_TEMP_HP_SPLAT = `${ASSET_ROOT}/temphpsplat.webp`;
export const DEFAULT_TINT_SPLAT = `${ASSET_ROOT}/splattint.webp`;
export const DEFAULT_HEAL_TINT_SPLAT = `${ASSET_ROOT}/healtint.webp`;
export const DEFAULT_SPLAT_SOUND = `${ASSET_ROOT}/rssplathit.ogg`;
export const DEFAULT_FONT_PATH = `${ASSET_ROOT}/runescape_uf.ttf`;
export const DEFAULT_TEXT_COLOR = "#FFF7BD";
export const DEFAULT_TINT_PICKER_COLOR = "#FF0000";

export const TYPE_ORDER = [
  "heal",
  "temp-hp",
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
  "untyped"
];

export const TYPE_LABELS = {
  heal: "Healing",
  "temp-hp": "Temp HP",
  acid: "Acid",
  bludgeoning: "Bludgeoning",
  cold: "Cold",
  fire: "Fire",
  force: "Force",
  lightning: "Lightning",
  necrotic: "Necrotic",
  piercing: "Piercing",
  poison: "Poison",
  psychic: "Psychic",
  radiant: "Radiant",
  slashing: "Slashing",
  thunder: "Thunder",
  untyped: "Untyped"
};

const DEFAULT_TINTS = {
  acid: "#C8F36B",
  cold: "#9DE7FF",
  fire: "#FF8C69",
  force: "#D6A8FF",
  lightning: "#FFF1A8",
  necrotic: "#B48DFF",
  poison: "#B3E36D",
  psychic: "#FF9ADE",
  radiant: "#FFE58A",
  thunder: "#CDB6FF",
  untyped: "#FFFFFF"
};

/**
 * Optional pre-colored art shipped with the module. Defaults use the tint
 * base; the style manager offers these through "Use bundled art".
 */
export const BUNDLED_TYPE_ART = {
  heal: DEFAULT_HEAL_SPLAT,
  "temp-hp": DEFAULT_TEMP_HP_SPLAT,
  acid: `${ASSET_ROOT}/acidsplat.webp`,
  cold: `${ASSET_ROOT}/coldsplat.webp`,
  fire: `${ASSET_ROOT}/firesplat.webp`,
  force: `${ASSET_ROOT}/forcesplat.webp`,
  lightning: `${ASSET_ROOT}/lightningsplat.webp`,
  necrotic: `${ASSET_ROOT}/necroticsplat.webp`,
  poison: `${ASSET_ROOT}/poisonsplat.webp`,
  psychic: `${ASSET_ROOT}/psychicsplat.webp`,
  radiant: `${ASSET_ROOT}/radiantsplat.webp`,
  thunder: `${ASSET_ROOT}/thundersplat.webp`
};

/** Bundled images that are already colored, so a tint is drawn on the tint base instead. */
const PRE_COLORED_ART = new Set([
  ...Object.values(BUNDLED_TYPE_ART),
  DEFAULT_REGULAR_SPLAT,
  `${ASSET_ROOT}/crit-splat.webp`
]);

const TINT_BASES = new Set([DEFAULT_TINT_SPLAT, DEFAULT_HEAL_TINT_SPLAT]);

export function normalizeDamageType(value) {
  return String(value ?? "untyped")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

export function toTitleCase(value) {
  return String(value ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function typeLabel(type) {
  const normalized = normalizeDamageType(type);
  return TYPE_LABELS[normalized] ?? toTitleCase(normalized);
}

export function previewKindForType(type) {
  const normalized = normalizeDamageType(type);
  if (normalized === "heal") return "heal";
  if (normalized === "temp-hp") return "temp-hp";
  return "damage";
}

export function parseHexColor(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return Number.parseInt(normalized, 16);
}

export function toCssHexColor(value, fallback = DEFAULT_TEXT_COLOR) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
  }
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())) return value.trim();
  return fallback;
}

/* ------------------------------------------------------------------ */
/* Style records                                                      */
/* ------------------------------------------------------------------ */

export function getDefaultDamageTypeStyles() {
  const styles = {};
  for (const type of TYPE_ORDER) {
    const tint = DEFAULT_TINTS[type] ?? "";
    let image = "";
    if (type === "heal") image = DEFAULT_HEAL_SPLAT;
    else if (type === "temp-hp") image = DEFAULT_TEMP_HP_SPLAT;
    else if (tint) image = DEFAULT_TINT_SPLAT;
    styles[type] = {
      label: TYPE_LABELS[type],
      enabled: true,
      image,
      soundEnabled: type !== "heal" && type !== "temp-hp",
      sound: "",
      tint,
      text: ""
    };
  }
  return styles;
}

export function sanitizeStyleRecord(rawConfig, fallbackLabel, { soundDefault = true } = {}) {
  return {
    label: String(rawConfig?.label ?? fallbackLabel ?? "").trim() || fallbackLabel,
    enabled: rawConfig?.enabled !== false,
    image: String(rawConfig?.image ?? "").trim(),
    soundEnabled: rawConfig?.soundEnabled === undefined ? soundDefault : rawConfig.soundEnabled !== false,
    sound: String(rawConfig?.sound ?? "").trim(),
    tint: String(rawConfig?.tint ?? "").trim(),
    text: String(rawConfig?.text ?? "").trim()
  };
}

/** Merge a stored style JSON string over the defaults. Throws on malformed JSON. */
export function mergeStoredStyles(rawValue) {
  const parsed = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
  if (!parsed || typeof parsed !== "object") throw new Error("Style map is not an object.");
  const merged = getDefaultDamageTypeStyles();
  for (const [rawType, rawConfig] of Object.entries(parsed)) {
    const type = normalizeDamageType(rawType);
    const existing = merged[type] ?? {
      label: typeLabel(type),
      enabled: true,
      image: "",
      soundEnabled: true,
      sound: "",
      tint: "",
      text: ""
    };
    merged[type] = {
      ...existing,
      ...sanitizeStyleRecord(rawConfig, existing.label, { soundDefault: existing.soundEnabled })
    };
  }
  return merged;
}

/**
 * Work out what a splat looks like for one type.
 * - Disabled types return `enabled: false` and are not drawn at all.
 * - A tint colors whatever image is chosen. Empty or pre-colored bundled
 *   art is swapped for the matching greyscale tint base first, so the tint
 *   reads cleanly; a custom image is tinted as-is.
 * - With no tint, the chosen image is used, or the kind's fallback image.
 */
export function resolveSplatVisual(type, record, fallbacks = {}) {
  const normalized = normalizeDamageType(type);
  const style = sanitizeStyleRecord(record ?? {}, typeLabel(normalized));
  if (!style.enabled) {
    return { enabled: false, image: "", tint: null, textColor: null, sound: "", soundEnabled: false, mode: "off" };
  }
  const kind = previewKindForType(normalized);
  const fallbackImage = kind === "heal"
    ? fallbacks.heal || DEFAULT_HEAL_SPLAT
    : kind === "temp-hp"
      ? fallbacks.tempHp || DEFAULT_TEMP_HP_SPLAT
      : fallbacks.regular || DEFAULT_REGULAR_SPLAT;
  const tint = parseHexColor(style.tint);
  const tintBase = kind === "damage" ? DEFAULT_TINT_SPLAT : DEFAULT_HEAL_TINT_SPLAT;
  let image;
  let mode;
  if (tint !== null) {
    const customImage = style.image && !PRE_COLORED_ART.has(style.image) && !TINT_BASES.has(style.image);
    image = customImage ? style.image : (TINT_BASES.has(style.image) ? style.image : tintBase);
    mode = customImage ? "custom-tinted" : "tint-base";
  } else {
    image = style.image || fallbackImage;
    mode = !style.image ? "fallback" : PRE_COLORED_ART.has(style.image) ? "bundled-art" : "custom";
  }
  return {
    enabled: true,
    image,
    fallbackImage: tint !== null ? tintBase : fallbackImage,
    tint,
    textColor: parseHexColor(style.text),
    soundEnabled: style.soundEnabled,
    sound: style.soundEnabled ? (style.sound || fallbacks.sound || DEFAULT_SPLAT_SOUND) : "",
    mode
  };
}

export const IMAGE_MODE_LABELS = {
  off: "Disabled",
  "tint-base": "Tint Base",
  "custom-tinted": "Custom Image + Tint",
  "bundled-art": "Bundled Art",
  custom: "Custom Image",
  fallback: "Fallback Image"
};

/* ------------------------------------------------------------------ */
/* HP change detection                                                */
/* ------------------------------------------------------------------ */

export function getProperty(object, path) {
  if (object && typeof object === "object" && path in object) return object[path];
  let target = object;
  for (const key of String(path).split(".")) {
    if (target === null || target === undefined) return undefined;
    target = target[key];
  }
  return target;
}

export function hasProperty(object, path) {
  if (object && typeof object === "object" && path in object) return true;
  let target = object;
  for (const key of String(path).split(".")) {
    if (target === null || typeof target !== "object" || !(key in target)) return false;
    target = target[key];
  }
  return true;
}

export function splitPaths(value) {
  return String(value ?? "").split(",").map((path) => path.trim()).filter(Boolean);
}

export function maxHpPathsFor(hpPaths) {
  return hpPaths
    .flatMap((path) => {
      const base = path.replace(/\.(?:value|current)$/, "");
      return [`${base}.max`, `${base}.effectiveMax`, `${base}.tempmax`];
    })
    .filter((path, index, paths) => paths.indexOf(path) === index);
}

/** HP change: kind heal | damage | same (written but unchanged), or null. */
export function detectHpUpdate(actor, change, paths) {
  let unchangedWrite = null;
  for (const path of paths) {
    if (!hasProperty(change, path)) continue;
    const previousHp = Number(getProperty(actor, path));
    const nextHp = Number(getProperty(change, path));
    if (!Number.isFinite(previousHp) || !Number.isFinite(nextHp)) continue;
    if (nextHp === previousHp) {
      unchangedWrite ??= { path, previousHp, nextHp, amount: 0, kind: "same" };
      continue;
    }
    return { path, previousHp, nextHp, amount: Math.abs(nextHp - previousHp), kind: nextHp > previousHp ? "heal" : "damage" };
  }
  return unchangedWrite;
}

export function detectMaxHpDelta(actor, change, paths) {
  for (const path of paths) {
    if (!hasProperty(change, path)) continue;
    const isTempMax = path.endsWith(".tempmax");
    const previousValue = getProperty(actor, path);
    const nextValue = getProperty(change, path);
    const previousMaxHp = Number(isTempMax ? (previousValue ?? 0) : previousValue);
    const nextMaxHp = Number(isTempMax ? (nextValue ?? 0) : nextValue);
    if (!Number.isFinite(previousMaxHp) || !Number.isFinite(nextMaxHp) || nextMaxHp === previousMaxHp) continue;
    return { path, previousMaxHp, nextMaxHp, amount: Math.abs(nextMaxHp - previousMaxHp), kind: nextMaxHp > previousMaxHp ? "gain" : "damage" };
  }
  return null;
}

export function detectTempHpDelta(actor, change, paths) {
  for (const path of paths) {
    if (!hasProperty(change, path)) continue;
    const previousValue = Number(getProperty(actor, path) ?? 0);
    const nextValue = Number(getProperty(change, path) ?? 0);
    if (!Number.isFinite(previousValue) || !Number.isFinite(nextValue) || nextValue === previousValue) continue;
    return { path, previousValue, nextValue, amount: Math.abs(nextValue - previousValue), kind: nextValue > previousValue ? "gain" : "loss" };
  }
  return null;
}

/**
 * Turn one actor change into the splats to draw. `lookupTyped(totalDamage,
 * consumeOptions)` returns the typed breakdown from the Midi-QOL cache or null.
 */
export function planSplatsForChange({ hpUpdate, tempHpDelta, maxHpDelta }, lookupTyped = () => null) {
  const hpDelta = hpUpdate?.kind === "same" ? null : hpUpdate;
  const isMaxHpDamage = maxHpDelta?.kind === "damage";
  const isClampedHpDamage = hpUpdate?.kind === "same";

  if (!hpDelta && !tempHpDelta && (isMaxHpDamage || isClampedHpDamage)) {
    // Some Midi-QOL abilities (Life Drain) apply damage through a max-HP
    // reduction, and at full HP dnd5e can clamp current HP so the explicit
    // damage write looks unchanged. Only a recent typed roll is trusted here.
    const typed = lookupTyped(isMaxHpDamage ? maxHpDelta.amount : 0, {
      allowCachedDamage: isClampedHpDamage && !isMaxHpDamage
    });
    if (typed?.types?.length) {
      return { reason: "typed-special", entries: typed.types.map((entry) => ({ damage: entry.damage, damageType: entry.type, kind: "damage" })) };
    }
  }

  if (!hpDelta && !tempHpDelta) return { reason: "none", entries: [] };

  const entries = [];
  if (tempHpDelta?.kind === "gain") {
    entries.push({ damage: tempHpDelta.amount, damageType: "temp-hp", kind: "temp-hp" });
  }

  const absorbed = tempHpDelta?.kind === "loss" ? tempHpDelta.amount : 0;
  const hpDamage = hpDelta?.kind === "damage" ? hpDelta.amount : 0;
  const totalDamage = absorbed + hpDamage;
  if (totalDamage > 0) {
    const typed = lookupTyped(totalDamage, {});
    if (typed?.types?.length) {
      entries.push(...typed.types.map((entry) => ({ damage: entry.damage, damageType: entry.type, kind: "damage" })));
      return { reason: "typed", entries };
    }
    entries.push({ damage: totalDamage, damageType: "untyped", kind: "damage" });
    return { reason: "damage", entries };
  }

  if (hpDelta?.kind === "heal") entries.push({ damage: hpDelta.amount, damageType: "heal", kind: "heal" });
  return { reason: entries.length ? "heal-or-temp" : "none", entries };
}

/* ------------------------------------------------------------------ */
/* Typed damage maths                                                 */
/* ------------------------------------------------------------------ */

export function splitDamageAcrossTypes(types, totalDamage) {
  if (!types.length) return [];
  const evenSplit = Math.floor(totalDamage / types.length);
  let remainder = totalDamage - evenSplit * types.length;
  return types.map((type) => {
    const bonus = remainder > 0 ? 1 : 0;
    remainder -= bonus;
    return { type, damage: evenSplit + bonus };
  }).filter((entry) => entry.damage > 0);
}

export function scaleTypedDamage(types, targetTotal) {
  const currentTotal = types.reduce((sum, entry) => sum + entry.damage, 0);
  if (currentTotal <= 0 || targetTotal <= 0) return [];
  const roundedTarget = Math.round(targetTotal);
  let remaining = roundedTarget;
  const scaled = types.map((entry, index) => {
    if (index === types.length - 1) return { ...entry, damage: Math.max(remaining, 0) };
    const amount = Math.max(Math.round((entry.damage / currentTotal) * roundedTarget), 0);
    remaining -= amount;
    return { ...entry, damage: amount };
  });
  return scaled.filter((entry) => entry.damage > 0);
}

export function mergePhaseEntriesByType(phaseEntries) {
  if (!Array.isArray(phaseEntries) || !phaseEntries.length) return [];
  const merged = new Map();
  for (const phaseEntry of phaseEntries) {
    const type = normalizeDamageType(phaseEntry?.type);
    const damage = Number(phaseEntry?.damage) || 0;
    if (damage <= 0) continue;
    merged.set(type, (merged.get(type) ?? 0) + damage);
  }
  return Array.from(merged.entries()).map(([type, damage]) => ({ type, damage }));
}

export function flattenDamageCandidates(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate.flatMap((entry) => flattenDamageCandidates(entry));
  if (typeof candidate === "object") {
    if ("type" in candidate || "damageType" in candidate || "damage" in candidate || "value" in candidate || "amount" in candidate) {
      return [candidate];
    }
    return Object.values(candidate).flatMap((entry) => flattenDamageCandidates(entry));
  }
  return [];
}

export function normalizeDamageDetailEntry(rawEntry) {
  if (!rawEntry) return [];
  if (Array.isArray(rawEntry)) return rawEntry.flatMap((entry) => normalizeDamageDetailEntry(entry));
  if (typeof rawEntry === "number") return rawEntry > 0 ? [{ type: "untyped", damage: rawEntry }] : [];
  if (typeof rawEntry === "string") return [];

  const nested = [rawEntry.damageDetail, rawEntry.damageDetails, rawEntry.details, rawEntry.breakdown, rawEntry.byType]
    .filter((value) => value !== undefined);
  if (nested.length) {
    const results = nested.flatMap((candidate) =>
      flattenDamageCandidates(candidate).flatMap((entry) => normalizeDamageDetailEntry(entry))
    );
    if (results.length) return results;
  }

  const type = normalizeDamageType(
    rawEntry.type ?? rawEntry.damageType ?? rawEntry.damageTypeId ?? rawEntry.kind ?? rawEntry.category ?? "untyped"
  );
  const damage = Number(rawEntry.value ?? rawEntry.damage ?? rawEntry.appliedDamage ?? rawEntry.amount ?? rawEntry.total ?? 0);
  return Number.isFinite(damage) && damage > 0 ? [{ type, damage }] : [];
}

export function aggregateTypedDamage(detailCandidates) {
  const aggregated = new Map();
  for (const candidate of detailCandidates) {
    for (const rawEntry of flattenDamageCandidates(candidate)) {
      for (const normalized of normalizeDamageDetailEntry(rawEntry)) {
        const current = aggregated.get(normalized.type) ?? { type: normalized.type, damage: 0 };
        current.damage += normalized.damage;
        aggregated.set(normalized.type, current);
      }
    }
  }
  return Array.from(aggregated.values()).filter((entry) => entry.damage > 0);
}

/** For a missed attack whose rider damage needed a failed save, only the last type applies. */
export function selectTargetDamageTypes(orderedTypes, { isAttack, isHitTarget, isFailedSaveTarget }) {
  if (orderedTypes.length > 1 && isAttack && !isHitTarget && isFailedSaveTarget) return orderedTypes.slice(-1);
  return orderedTypes;
}

/* ------------------------------------------------------------------ */
/* Pending typed damage cache                                         */
/* ------------------------------------------------------------------ */

export function getTypedDamageSourcePriority(source) {
  const normalized = String(source ?? "").replace(/^remote:/, "").trim();
  if (normalized === "explicit-midi-detail") return 4;
  if (normalized === "explicit-midi-untyped") return 3;
  if (normalized === "workflow-item-fallback") return 1;
  if (normalized === "none") return 0;
  return 2;
}

export function shouldReplacePendingEntry(existingEntry, nextEntry) {
  const existingPriority = getTypedDamageSourcePriority(existingEntry?.source);
  const nextPriority = getTypedDamageSourcePriority(nextEntry?.source);
  if (nextPriority !== existingPriority) return nextPriority > existingPriority;
  return (nextEntry?.createdAt ?? 0) >= (existingEntry?.createdAt ?? 0);
}

export function findBestPendingCandidateGroup(candidates, targetDamage, preferredWorkflowIds = new Set()) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.entry.workflowId}::${candidate.entry.source}`;
    const group = grouped.get(key) ?? { workflowId: candidate.entry.workflowId, source: candidate.entry.source, items: [] };
    group.items.push(candidate);
    grouped.set(key, group);
  }

  const groups = Array.from(grouped.values()).map((group) => {
    const typeTotals = new Map();
    let totalDamage = 0;
    let newestCreatedAt = 0;
    for (const item of group.items) {
      totalDamage += item.entry.totalDamage;
      newestCreatedAt = Math.max(newestCreatedAt, Number(item.entry.createdAt) || 0);
      for (const typed of item.entry.types) typeTotals.set(typed.type, (typeTotals.get(typed.type) ?? 0) + typed.damage);
    }
    const types = Array.from(typeTotals.entries()).map(([type, damage]) => ({ type, damage }));
    const concreteTypeCount = types.filter((entry) => normalizeDamageType(entry.type) !== "untyped").length;
    return {
      ...group,
      totalDamage,
      types,
      newestCreatedAt,
      sourcePriority: getTypedDamageSourcePriority(group.source),
      concreteTypeCount,
      untypedTypeCount: types.length - concreteTypeCount,
      workflowMatch: preferredWorkflowIds.has(String(group.workflowId))
    };
  });

  groups.sort((left, right) => {
    if (left.workflowMatch !== right.workflowMatch) return left.workflowMatch ? -1 : 1;
    if (targetDamage !== null && targetDamage !== undefined) {
      const difference = Math.abs(left.totalDamage - targetDamage) - Math.abs(right.totalDamage - targetDamage);
      if (difference !== 0) return difference;
    }
    if (right.sourcePriority !== left.sourcePriority) return right.sourcePriority - left.sourcePriority;
    if (right.concreteTypeCount !== left.concreteTypeCount) return right.concreteTypeCount - left.concreteTypeCount;
    if (left.untypedTypeCount !== right.untypedTypeCount) return left.untypedTypeCount - right.untypedTypeCount;
    return right.newestCreatedAt - left.newestCreatedAt;
  });
  return groups[0] ?? null;
}

export function collectWorkflowIdsFromUpdateOptions(options) {
  const ids = new Set();
  const visited = new Set();
  const workflowKeyPattern = /^(workflow(?:Id|Uuid)?|workflowData|originWorkflow|midiWorkflowId)$/i;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 4 || visited.has(value)) return;
    visited.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (workflowKeyPattern.test(key) && (typeof nested === "string" || typeof nested === "number")) ids.add(String(nested));
      else if (nested && typeof nested === "object") visit(nested, depth + 1);
    }
  };
  visit(options);
  return ids;
}

/** Token id from a token or synthetic-actor UUID ("Scene.s.Token.t" or "Scene.s.Token.t.Actor.a"). */
export function tokenIdFromUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  const index = parts.lastIndexOf("Token");
  return index >= 0 && parts[index + 1] ? parts[index + 1] : null;
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                  */
/* ------------------------------------------------------------------ */

export function computeSplatOffsets(prepared, { spread = 0.18, gap = 0, arc = 0.12 } = {}) {
  if (prepared.length <= 1) return prepared.map(() => ({ x: 0, y: 0 }));
  const spreadSetting = Math.max(Number(spread) || 0, 0);
  const gapSetting = Math.max(Number(gap) || 0, 0);
  const arcSetting = Math.max(Number(arc) || 0, 0);
  const averageWidth = prepared.reduce((sum, splat) => sum + splat.renderedWidth, 0) / prepared.length;
  const step = Math.max(averageWidth * (0.28 + spreadSetting) + gapSetting, 4);
  const centerIndex = (prepared.length - 1) / 2;
  return prepared.map((splat, index) => {
    const centerDistance = Math.abs(index - centerIndex);
    return { x: (index - centerIndex) * step, y: -(splat.renderedHeight * arcSetting * centerDistance) };
  });
}

export function normalizeScrollingTextContent(content) {
  if (content === null || content === undefined) return "";
  return String(content)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[−–—]/g, "-")
    .replace(/[＋]/g, "+")
    .trim();
}

export function isNumericScrollingText(content) {
  return /^[+-]?\d+$/.test(normalizeScrollingTextContent(content));
}

/** Escape a path for use inside CSS url("..."). */
export function cssUrl(path) {
  return `url("${String(path).replace(/["\\\n\r]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)}")`;
}

/**
 * Pairs Foundry's native floating numbers with this module's splats on one
 * client. A native number for a token is held briefly; it is dropped if a
 * splat for the same token was or will be drawn within the window, and shown
 * otherwise. Works whichever of the two arrives first.
 */
export class NativeTextGate {
  constructor({ windowMs = 1500, holdMs = 700, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
    this.windowMs = windowMs;
    this.holdMs = holdMs;
    this.now = now;
    this.schedule = schedule;
    this.splats = new Map();
    this.held = new Map();
  }

  /** Record a splat for `tokenId`; cancels any held native number for it. */
  noteSplat(tokenId) {
    if (!tokenId) return;
    this.splats.set(tokenId, this.now());
    for (const ticket of this.held.get(tokenId) ?? []) ticket.cancelled = true;
    this.held.delete(tokenId);
    if (this.splats.size > 200) {
      const cutoff = this.now() - this.windowMs;
      for (const [id, at] of this.splats) if (at < cutoff) this.splats.delete(id);
    }
  }

  recentlySplatted(tokenId) {
    const at = this.splats.get(tokenId);
    return at !== undefined && this.now() - at <= this.windowMs;
  }

  /**
   * Offer a native number. Returns "suppress" if a splat is already showing,
   * otherwise holds it and calls `show()` later unless a splat arrives.
   */
  offer(tokenId, show) {
    if (!tokenId) return "pass";
    if (this.recentlySplatted(tokenId)) return "suppress";
    const ticket = { cancelled: false };
    const tickets = this.held.get(tokenId) ?? new Set();
    tickets.add(ticket);
    this.held.set(tokenId, tickets);
    this.schedule(() => {
      tickets.delete(ticket);
      if (!tickets.size && this.held.get(tokenId) === tickets) this.held.delete(tokenId);
      if (!ticket.cancelled) show();
    }, this.holdMs);
    return "held";
  }
}
