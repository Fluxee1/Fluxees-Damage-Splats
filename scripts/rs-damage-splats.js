const MODULE_ID = "rs-damage-splats";
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
const DEFAULT_REGULAR_SPLAT = "modules/rs-damage-splats/assets/RegularSplat.webp";
const DEFAULT_HEAL_SPLAT = "modules/rs-damage-splats/assets/HealSplat.webp";
const DEFAULT_TEMP_HP_SPLAT = "modules/rs-damage-splats/assets/TempHPSplat.webp";
const DEFAULT_TINT_SPLAT = "modules/rs-damage-splats/assets/SplatTint.webp";
const DEFAULT_HEAL_TINT_SPLAT = "modules/rs-damage-splats/assets/HealTint.webp";
const DEFAULT_SPLAT_SOUND = "modules/rs-damage-splats/assets/rssplathit.ogg";
const DEFAULT_FONT_PATH = "modules/rs-damage-splats/assets/runescape_bold.ttf";
const PENDING_TYPED_DAMAGE_TTL_MS = 15000;
const TYPE_ORDER = [
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
const TYPE_LABELS = {
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
const pendingTypedDamageStore = new Map();
let splatSocket = null;
let socketReady = false;
let socketlibHookFired = false;

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("socketlib.ready", () => {
  socketlibHookFired = true;
  ensureSocketRegistration("socketlib.ready");
});

Hooks.once("ready", () => {
  loadRuneScapeFont();
  patchNativeScrollingText();
  patchTokenScrollingText();
  registerMidiQolHooks();
  const socketlibActive = game.modules.get("socketlib")?.active;
  if (!socketlibActive) {
    console.warn(`${MODULE_ID} | socketlib is not active. Splats will only render locally.`);
    return;
  }

  if (!socketReady) {
    ensureSocketRegistration("ready");
  }

  if (!socketReady) {
    console.warn(`${MODULE_ID} | socketlib is active but the module socket is not ready yet. Splats may render locally only.`, {
      socketlibHookFired,
      hasSocket: Boolean(splatSocket)
    });
  }
});

Hooks.on("preUpdateActor", (actor, change, options) => {
  if (!game.user?.isGM) return;

  const tokens = findTargetTokens(actor, options);
  const hpDelta = detectHpDelta(actor, change);
  const tempHpDelta = detectTempHpDelta(actor, change);

  if (!hpDelta && !tempHpDelta) {
    debugLog("No HP delta detected for actor update.", { actor: actor.name, change });
    return;
  }

  if (!tokens.length) {
    debugLog("HP or temp HP delta detected, but no active token was found.", {
      actor: actor.name,
      hpDelta,
      tempHpDelta
    });
    return;
  }

  if (tempHpDelta?.kind === "gain") {
    debugLog("Displaying temp HP splat.", {
      actor: actor.name,
      amount: tempHpDelta.amount,
      kind: tempHpDelta.kind,
      tokenCount: tokens.length
    });

    broadcastSplatEvents(tokens, [{
      damage: tempHpDelta.amount,
      damageType: "temp-hp",
      kind: "temp-hp"
    }], { actorName: actor.name });
  }

  const absorbedDamage = tempHpDelta?.kind === "loss" ? tempHpDelta.amount : 0;
  const hpDamage = hpDelta?.kind === "damage" ? hpDelta.amount : 0;
  const totalDamage = absorbedDamage + hpDamage;

  if (totalDamage > 0) {
    const typedEntry = consumePendingTypedDamage(actor, tokens, totalDamage);
    if (typedEntry?.types?.length) {
      debugLog("Displaying typed splats on HP application.", {
        actor: actor.name,
        totalDamage,
        typedDamage: typedEntry.types
      });

      broadcastSplatEvents(
        tokens,
        typedEntry.types.map((entry) => ({
          damage: entry.damage,
          damageType: entry.type,
          kind: "damage"
        })),
        { actorName: actor.name, typed: true }
      );
      return;
    }

    debugLog("Displaying fallback damage splat.", {
      actor: actor.name,
      amount: totalDamage,
      tokenCount: tokens.length,
      absorbedDamage,
      hpDamage
    });

    broadcastSplatEvents(tokens, [{
      damage: totalDamage,
      damageType: "untyped",
      kind: "damage"
    }], { actorName: actor.name, fallback: true });
    return;
  }

  if (!hpDelta) return;

  if (hpDelta.kind === "heal") {
    debugLog("Displaying heal splat.", {
      actor: actor.name,
      amount: hpDelta.amount,
      tokenCount: tokens.length
    });

    broadcastSplatEvents(tokens, [{
      damage: hpDelta.amount,
      damageType: "heal",
      kind: "heal"
    }], { actorName: actor.name });
    return;
  }
});

function registerSettings() {
  game.settings.register(MODULE_ID, "hpPaths", {
    name: "HP data paths",
    hint: "Comma-separated actor data paths checked when HP changes.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_HP_PATHS.join(", ")
  });

  game.settings.register(MODULE_ID, "useMidiQolTypedDamage", {
    name: "Use Midi-QOL typed damage",
    hint: "When Midi-QOL is active, use its typed damage breakdown to create per-type splats.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "regularSplatPath", {
    name: "Regular splat image",
    hint: "Image shown for standard damage splats.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_REGULAR_SPLAT
  });

  game.settings.register(MODULE_ID, "tempHpPaths", {
    name: "Temp HP data paths",
    hint: "Comma-separated actor data paths checked when temporary HP changes.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_TEMP_HP_PATHS.join(", ")
  });

  game.settings.register(MODULE_ID, "healSplatPath", {
    name: "Heal splat image",
    hint: "Image shown when an actor regains HP.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_HEAL_SPLAT
  });

  game.settings.register(MODULE_ID, "tempHpSplatPath", {
    name: "Temp HP splat image",
    hint: "Image shown when temporary HP changes.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_TEMP_HP_SPLAT
  });

  game.settings.register(MODULE_ID, "splatScale", {
    name: "Splat scale",
    hint: "Overall size multiplier for splats and damage numbers. 0.5 is about half size.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.5
  });

  game.settings.register(MODULE_ID, "durationMs", {
    name: "Splat duration (ms)",
    hint: "Total time the splat stays on screen, in milliseconds.",
    scope: "world",
    config: true,
    type: Number,
    default: 2000
  });

  game.settings.register(MODULE_ID, "multiSplatSpread", {
    name: "Multi-splat spread",
    hint: "Controls how far apart multi-type splats step from center.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.18
  });

  game.settings.register(MODULE_ID, "multiSplatGap", {
    name: "Multi-splat gap",
    hint: "Pixel gap between multiple splats after sizing is applied.",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "multiSplatArc", {
    name: "Multi-splat arc lift",
    hint: "How much the outer splats lift upward in a multi-hit group.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.12
  });

  game.settings.register(MODULE_ID, "fontPath", {
    name: "RuneScape font path",
    hint: "TTF font used for the damage numbers.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_FONT_PATH,
    onChange: () => loadRuneScapeFont()
  });

  game.settings.register(MODULE_ID, "fontFamily", {
    name: "Font family name",
    hint: "Font family used when drawing damage numbers.",
    scope: "world",
    config: true,
    type: String,
    default: "RuneScape Bold"
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
    hint: "Choose custom splat images, text colors, and preview each type.",
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

  game.settings.register(MODULE_ID, "hideNativeScrollingText", {
    name: "Hide native damage/healing numbers",
    hint: "Suppresses Foundry's built-in floating combat numbers when they are simple numeric HP changes.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "defaultSplatSoundPath", {
    name: "Default splat sound path",
    hint: "Default sound used by damage types with sound enabled and no custom path.",
    scope: "world",
    config: true,
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

function getDefaultDamageTypeStyles() {
  const styleMap = {};
  const tintDrivenTypes = new Set([
    "acid",
    "cold",
    "fire",
    "force",
    "lightning",
    "necrotic",
    "poison",
    "psychic",
    "radiant",
    "thunder",
    "untyped"
  ]);
  const explicitImages = {
    heal: DEFAULT_HEAL_SPLAT,
    acid: DEFAULT_TINT_SPLAT,
    cold: DEFAULT_TINT_SPLAT,
    fire: DEFAULT_TINT_SPLAT,
    force: DEFAULT_TINT_SPLAT,
    lightning: DEFAULT_TINT_SPLAT,
    necrotic: DEFAULT_TINT_SPLAT,
    poison: DEFAULT_TINT_SPLAT,
    psychic: DEFAULT_TINT_SPLAT,
    radiant: DEFAULT_TINT_SPLAT,
    thunder: DEFAULT_TINT_SPLAT,
    untyped: DEFAULT_TINT_SPLAT
  };

  for (const type of TYPE_ORDER) {
    const title = TYPE_LABELS[type];
    const defaultImage =
      type === "temp-hp"
        ? DEFAULT_TEMP_HP_SPLAT
        : explicitImages[type] ?? "";

    styleMap[type] = {
      label: title,
      enabled: true,
      image: defaultImage,
      soundEnabled: type !== "heal" && type !== "temp-hp",
      sound: "",
      tint: tintDrivenTypes.has(type) ? getDefaultTintColorForType(type) : "",
      text: ""
    };
  }

  return styleMap;
}

function getStoredDamageTypeStyles() {
  const rawValue = game.settings.get(MODULE_ID, "damageTypeStyles");

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object") throw new Error("Style map is not an object.");

    const merged = foundry.utils.deepClone(getDefaultDamageTypeStyles());
    for (const [rawType, rawConfig] of Object.entries(parsed)) {
      const type = normalizeDamageType(rawType);
      const existing = merged[type] ?? {
        label: TYPE_LABELS[type] ?? toTitleCase(type),
        enabled: true,
        image: "",
        tint: "",
        text: ""
      };

      merged[type] = {
        ...existing,
        ...sanitizeStyleRecord(rawConfig, existing.label)
      };

      if (type === "heal" || type === "temp-hp") {
        merged[type].soundEnabled = Boolean(rawConfig?.soundEnabled);
        merged[type].sound = String(rawConfig?.sound ?? "").trim();
      }
    }

    return merged;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not parse damage type styles. Falling back to defaults.`, error);
    return getDefaultDamageTypeStyles();
  }
}

function sanitizeStyleRecord(rawConfig, fallbackLabel) {
  return {
    label: String(rawConfig?.label ?? fallbackLabel ?? "").trim() || fallbackLabel,
    enabled: rawConfig?.enabled !== false,
    image: String(rawConfig?.image ?? "").trim(),
    soundEnabled: rawConfig?.soundEnabled !== false,
    sound: String(rawConfig?.sound ?? "").trim(),
    tint: String(rawConfig?.tint ?? "").trim(),
    text: String(rawConfig?.text ?? "").trim()
  };
}

function getDefaultTintColorForType(type) {
  const tintMap = {
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

  return tintMap[normalizeDamageType(type)] ?? "";
}

function registerMidiQolHooks() {
  if (!game.modules.get("midi-qol")?.active) {
    debugLog("Midi-QOL is not active. Typed damage splats are disabled.");
    return;
  }

  Hooks.on("midi-qol.DamageRollComplete", (workflow) => {
    if (!game.settings.get(MODULE_ID, "useMidiQolTypedDamage")) return;
    cacheMidiQolWorkflow(workflow);
  });

  debugLog("Registered Midi-QOL typed damage hook on midi-qol.DamageRollComplete.");
}

function cacheMidiQolWorkflow(workflow) {
  try {
    const damageEntries = extractMidiDamageEntries(workflow);
    if (!damageEntries.length) {
      debugLog("Midi-QOL workflow had no typed damage entries.", { workflow });
      return;
    }

    if (!game.user?.isGM) {
      forwardTypedDamageEntriesToGM(workflow, damageEntries);
      return;
    }

    for (const entry of damageEntries) {
      if (!entry.actor || !entry.types.length) continue;
      storePendingTypedDamage(entry.actor, entry.token, workflow, entry.types, entry.source, entry.phases);
      debugLog("Cached typed Midi-QOL splats for HP application.", {
        actor: entry.actor.name,
        token: entry.token?.name,
        source: entry.source,
        phases: entry.phases,
        types: entry.types
      });
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

  const targetEntries = rawDamageList
    .map((item) => buildMidiDamageEntry(item, workflow))
    .filter(Boolean);

  if (targetEntries.length) return targetEntries;

  const workflowWideTypes = collectTypedDamageFromMidiWorkflow(workflow);
  if (!workflowWideTypes.length) return [];

  return findWorkflowTargets(workflow)
    .map((token) => ({
      actor: token.actor,
      token,
      source: "workflow-item-fallback",
      phases: workflowWideTypes.map((entry) => ({
        phase: "save-burst",
        type: entry.type,
        damage: entry.damage
      })),
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

  return {
    actor,
    token,
    phases: resolved.phases,
    source: resolved.source,
    types: typedDamage
  };
}

function findTokenFromMidiItem(item) {
  const tokenId = item?.tokenId ?? item?.tokenUuid?.split(".").at(-1);
  if (tokenId && canvas?.tokens) {
    const token = canvas.tokens.get(tokenId);
    if (token) return token;
  }

  const actorId = item?.actorId ?? item?.actorUuid?.split(".").at(-1);
  if (actorId) {
    return (canvas?.tokens?.placeables ?? []).find((token) => token.actor?.id === actorId) ?? null;
  }

  return null;
}

function findActorFromMidiItem(item) {
  const actorId = item?.actorId ?? item?.actorUuid?.split(".").at(-1);
  if (!actorId) return null;
  return game.actors?.get(actorId) ?? null;
}

function resolveTypedDamageForTarget(item, workflow, token, actor) {
  const explicit = collectExplicitTypedDamage(item, workflow);
  const derivedPhases = inferTypedPhaseEntriesForTarget(item, workflow, token, actor);
  const derived = inferTypedDamageForTarget(item, workflow, token, actor);
  const explicitConcrete = explicit.filter((entry) => entry.type !== "untyped");
  const derivedConcrete = derived.filter((entry) => entry.type !== "untyped");

  if (explicitConcrete.length && explicitConcrete.length >= derivedConcrete.length) {
    return {
      source: "explicit-midi-detail",
      phases: deriveWorkflowPhases(workflow, token, actor, explicitConcrete),
      types: explicitConcrete
    };
  }

  if (derivedConcrete.length) {
    return {
      source: "workflow-item-fallback",
      phases: derivedPhases,
      types: derivedConcrete
    };
  }

  if (explicit.length) {
    return {
      source: "explicit-midi-untyped",
      phases: deriveWorkflowPhases(workflow, token, actor, explicit),
      types: explicit
    };
  }

  return { source: "none", phases: [], types: [] };
}

function collectExplicitTypedDamage(item, workflow) {
  const itemSpecificCandidates = [
    item?.damageDetail,
    item?.damageDetails,
    item?.damageDetailApplied,
    item?.appliedDamageDetail,
    item?.calcDamageOptions?.damageDetail,
    item?.calcDamageOptions?.damageDetails
  ];
  const workflowWideCandidates = [
    workflow?.damageDetail,
    workflow?.damageDetails,
    workflow?.damageItem?.damageDetail,
    workflow?.damageItem?.damageDetails
  ];

  return aggregateTypedDamage(
    itemSpecificCandidates.some(Array.isArray) ? itemSpecificCandidates : workflowWideCandidates
  );
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
  return collectTypedDamageFromWorkflowItem(workflow);
}

function aggregateTypedDamage(detailCandidates) {
  const aggregated = new Map();

  for (const candidate of detailCandidates) {
    for (const rawEntry of flattenDamageCandidates(candidate)) {
      const normalizedEntries = normalizeDamageDetailEntry(rawEntry);
      for (const normalized of normalizedEntries) {
        const current = aggregated.get(normalized.type) ?? {
          type: normalized.type,
          damage: 0
        };
        current.damage += normalized.damage;
        aggregated.set(normalized.type, current);
      }
    }
  }

  return Array.from(aggregated.values()).filter((entry) => entry.damage > 0);
}

function flattenDamageCandidates(candidate) {
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

function normalizeDamageDetailEntry(rawEntry) {
  if (!rawEntry) return [];
  if (Array.isArray(rawEntry)) return rawEntry.flatMap((entry) => normalizeDamageDetailEntry(entry));
  if (typeof rawEntry === "number") return rawEntry > 0 ? [{ type: "untyped", damage: rawEntry }] : [];
  if (typeof rawEntry === "string") return [];

  const nestedCandidates = [
    rawEntry.damageDetail,
    rawEntry.damageDetails,
    rawEntry.details,
    rawEntry.breakdown,
    rawEntry.byType
  ].filter((value) => value !== undefined);

  if (nestedCandidates.length) {
    const nestedResults = nestedCandidates.flatMap((candidate) =>
      flattenDamageCandidates(candidate).flatMap((entry) => normalizeDamageDetailEntry(entry))
    );
    if (nestedResults.length) return nestedResults;
  }

  const type = normalizeDamageType(
    rawEntry.type ??
    rawEntry.damageType ??
    rawEntry.damageTypeId ??
    rawEntry.kind ??
    rawEntry.category ??
    "untyped"
  );

  const damage = Number(
    rawEntry.value ??
    rawEntry.damage ??
    rawEntry.appliedDamage ??
    rawEntry.amount ??
    rawEntry.total ??
    0
  );

  return Number.isFinite(damage) && damage > 0 ? [{ type, damage }] : [];
}

function inferTypedDamageForTarget(item, workflow, token, actor) {
  const phaseEntries = inferTypedPhaseEntriesForTarget(item, workflow, token, actor);
  if (!phaseEntries.length) return [];

  const merged = new Map();
  for (const phase of phaseEntries) {
    const type = normalizeDamageType(phase.type);
    merged.set(type, (merged.get(type) ?? 0) + (Number(phase.damage) || 0));
  }

  return Array.from(merged.entries())
    .map(([type, damage]) => ({ type, damage }))
    .filter((entry) => entry.damage > 0);
}

function inferTypedPhaseEntriesForTarget(item, workflow, token, actor) {
  const types = resolveTargetWorkflowDamageTypes(workflow, token, actor);
  if (!types.length) return [];

  const targetInfo = getWorkflowTargetInfo(workflow, token, actor);
  const activityName = workflow?.activity?.constructor?.name ?? "";
  const isAttackActivity = /Attack/i.test(activityName);
  const isSaveActivity = /Save/i.test(activityName);
  const isMixedAttackSaveWorkflow = isAttackActivity && types.length > 1 && (targetInfo.isAnySaveTarget || hasWorkflowSaveTargets(workflow));
  const rollTotals = resolveWorkflowDamageRollTotals(workflow);

  if (isMixedAttackSaveWorkflow && rollTotals.length >= 2) {
    const phases = [];
    const primaryDamage = rollTotals[0];
    const secondaryDamage = rollTotals.slice(1).reduce((sum, value) => sum + value, 0);

    if (targetInfo.isHitTarget && primaryDamage > 0) {
      phases.push({
        phase: "attack-hit",
        type: types[0],
        damage: primaryDamage
      });
    }

    if (targetInfo.isAnySaveTarget && secondaryDamage > 0) {
      const secondaryTypes = types.slice(1);
      if (secondaryTypes.length === 1) {
        phases.push({
          phase: "save-burst",
          type: secondaryTypes[0],
          damage: secondaryDamage
        });
      } else {
        phases.push(
          ...splitDamageAcrossTypes(secondaryTypes, secondaryDamage).map((entry) => ({
            phase: "save-burst",
            type: entry.type,
            damage: entry.damage
          }))
        );
      }
    }

    if (phases.length) {
      debugLog("Resolved mixed workflow phase entries.", {
        actor: actor?.name,
        token: token?.name,
        item: workflow?.item?.name,
        rollTotals,
        targetInfo,
        phases
      });
      return phases;
    }
  }

  const totalDamage = resolveMidiItemAppliedDamage(item, workflow);
  if (totalDamage <= 0) return [];

  if (isSaveActivity) {
    return types.map((type, index) => ({
      phase: index === 0 ? "save-burst" : `save-burst-${index}`,
      type,
      damage: splitDamageAcrossTypes(types, totalDamage)[index]?.damage ?? 0
    })).filter((entry) => entry.damage > 0);
  }

  if (types.length === 1) {
    return [{
      phase: isAttackActivity ? "attack-hit" : "damage",
      type: types[0],
      damage: totalDamage
    }];
  }

  return splitDamageAcrossTypes(types, totalDamage).map((entry, index) => ({
    phase: index === 0 && isAttackActivity ? "attack-hit" : "save-burst",
    type: entry.type,
    damage: entry.damage
  }));
}

function splitDamageAcrossTypes(types, totalDamage) {
  const evenSplit = Math.floor(totalDamage / types.length);
  let remainder = totalDamage - evenSplit * types.length;

  return types.map((type) => {
    const bonus = remainder > 0 ? 1 : 0;
    remainder -= bonus;
    return { type, damage: evenSplit + bonus };
  }).filter((entry) => entry.damage > 0);
}

function collectTypedDamageFromWorkflowItem(workflow) {
  const types = collectWorkflowItemDamageTypes(workflow);
  if (!types.length) return [];

  const totalDamage = resolveWorkflowTotalDamage(workflow);
  if (totalDamage <= 0) return [];
  if (types.length === 1) return [{ type: types[0], damage: totalDamage }];
  return splitDamageAcrossTypes(types, totalDamage);
}

function collectWorkflowItemDamageTypes(workflow) {
  const partsCandidates = [
    workflow?.item?.system?.damage?.parts,
    workflow?.item?.system?.damage?.value,
    workflow?.item?.system?.formula?.parts,
    workflow?.activity?.damage?.parts,
    workflow?.activity?.damage?.value,
    workflow?.item?.system?.activities,
    workflow?.item?.system?.activities?.contents
  ];

  const types = [];
  for (const candidate of partsCandidates) {
    if (!candidate) continue;
    for (const type of flattenDamagePartTypes(candidate)) {
      if (type) types.push(type);
    }
  }

  return Array.from(new Set(types));
}

function flattenDamagePartTypes(candidate) {
  if (!candidate) return [];
  if (Array.isArray(candidate)) return candidate.flatMap((part) => flattenDamagePartTypes(part));

  if (typeof candidate === "object") {
    const directType = normalizeDamageType(
      candidate.type ??
      candidate.damageType ??
      candidate.kind ??
      ""
    );

    if (directType) return [directType];
    return Object.values(candidate).flatMap((value) => flattenDamagePartTypes(value));
  }

  return [];
}

function resolveTargetWorkflowDamageTypes(workflow, token, actor) {
  const orderedTypes = collectWorkflowItemDamageTypes(workflow);
  if (orderedTypes.length <= 1) return orderedTypes;

  const targetInfo = getWorkflowTargetInfo(workflow, token, actor);
  const activityName = workflow?.activity?.constructor?.name ?? "";
  const isSaveActivity = /Save/i.test(activityName);
  const isAttackActivity = /Attack/i.test(activityName);

  if (isSaveActivity) return orderedTypes;
  if (isAttackActivity && targetInfo.isHitTarget && targetInfo.isFailedSaveTarget) return orderedTypes;
  if (isAttackActivity && targetInfo.isHitTarget && !targetInfo.isFailedSaveTarget) return orderedTypes;
  if (isAttackActivity && !targetInfo.isHitTarget && targetInfo.isFailedSaveTarget) return orderedTypes.slice(-1);
  return orderedTypes;
}

function deriveWorkflowPhases(workflow, token, actor, typedEntries) {
  const targetInfo = getWorkflowTargetInfo(workflow, token, actor);
  const activityName = workflow?.activity?.constructor?.name ?? "";
  const isAttackActivity = /Attack/i.test(activityName);
  const isSaveActivity = /Save/i.test(activityName);

  if (isSaveActivity) {
    return typedEntries.map((entry) => ({
      phase: "save-burst",
      type: entry.type,
      damage: entry.damage
    }));
  }

  if (!isAttackActivity) {
    return typedEntries.map((entry) => ({
      phase: "damage",
      type: entry.type,
      damage: entry.damage
    }));
  }

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
  const actorId = actor?.id ?? token?.actor?.id ?? null;

  const matches = (collection) =>
    normalizeTargetCollection(collection).some((candidate) =>
      candidate?.id === tokenId || candidate?.actor?.id === actorId
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
  return [
    workflow?.failedSaves,
    workflow?.saves,
    workflow?.superSavers,
    workflow?.semiSuperSavers
  ].some((collection) => normalizeTargetCollection(collection).length > 0);
}

function resolveWorkflowTotalDamage(workflow) {
  const candidates = [
    workflow?.damageTotal,
    workflow?.damageItem?.hpDamage,
    workflow?.damageItem?.appliedDamage,
    workflow?.damageRoll?.total
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  }

  const rollTotals = Array.isArray(workflow?.damageRolls)
    ? workflow.damageRolls.map((roll) => Number(roll?.total))
    : [];
  const sum = rollTotals.filter(Number.isFinite).reduce((acc, value) => acc + value, 0);
  return sum > 0 ? Math.round(sum) : 0;
}

function resolveWorkflowDamageRollTotals(workflow) {
  const totals = [];

  if (Array.isArray(workflow?.damageRolls)) {
    for (const roll of workflow.damageRolls) {
      const numeric = Number(roll?.total);
      if (Number.isFinite(numeric) && numeric > 0) totals.push(Math.round(numeric));
    }
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
  const tokenSet = new Map();
  const candidates = [
    workflow?.hitTargets,
    workflow?.targets,
    workflow?.failedSaves,
    workflow?.saves,
    workflow?.superSavers,
    workflow?.semiSuperSavers,
    workflow?.applicationTargets,
    workflow?.damageList?.map((entry) => entry?.tokenUuid ?? entry?.tokenId),
    workflow?.damageData?.map?.((entry) => entry?.tokenUuid ?? entry?.tokenId)
  ];

  for (const candidate of candidates) {
    for (const token of normalizeTargetCollection(candidate)) {
      if (token?.id) tokenSet.set(token.id, token);
    }
  }

  return Array.from(tokenSet.values());
}

function normalizeTargetCollection(candidate) {
  if (!candidate) return [];
  if (candidate instanceof Set) return Array.from(candidate).flatMap((entry) => normalizeTargetCollection(entry));
  if (Array.isArray(candidate)) return candidate.flatMap((entry) => normalizeTargetCollection(entry));

  if (typeof candidate === "string") {
    const token = canvas?.tokens?.get(candidate) ?? canvas?.tokens?.placeables?.find((placeable) =>
      placeable?.document?.uuid === candidate || placeable?.uuid === candidate
    );
    return token ? [token] : [];
  }

  if (candidate.object?.documentName === "Token") return [candidate.object];
  if (candidate.documentName === "Token") return [candidate];
  if (candidate.token?.documentName === "Token") return [candidate.token];
  if (candidate.id && canvas?.tokens?.get(candidate.id)) return [canvas.tokens.get(candidate.id)];
  return [];
}

function storePendingTypedDamage(actor, token, workflow, types, source = "unknown", phases = null) {
  if (!actor?.uuid || !Array.isArray(types) || !types.length) return;

  cleanupExpiredPendingTypedDamage();
  const workflowId = getWorkflowCacheId(workflow);
  const targetKey = buildPendingTargetKey(actor, token);
  const phaseEntries = Array.isArray(phases) && phases.length
    ? phases
    : types.map((entry) => ({
        phase: "damage",
        type: entry.type,
        damage: entry.damage
      }));

  for (const [index, phaseEntry] of phaseEntries.entries()) {
    const storeKey = `${workflowId}::${targetKey}::${phaseEntry.phase}::${normalizeDamageType(phaseEntry.type)}::${index}`;
    const pendingEntry = {
      workflowId,
      actorId: actor?.id ?? null,
      actorUuid: actor?.uuid ?? null,
      tokenId: token?.id ?? null,
      tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
      targetKey,
      phase: phaseEntry.phase,
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_TYPED_DAMAGE_TTL_MS,
      totalDamage: Number(phaseEntry.damage) || 0,
      source,
      types: [{
        type: normalizeDamageType(phaseEntry.type),
        damage: Number(phaseEntry.damage) || 0
      }]
    };

    const stored = setPendingTypedDamageEntry(storeKey, pendingEntry, {
      actorName: actor?.name,
      tokenName: token?.name
    });
    if (!stored) continue;

    debugLog("Stored pending typed damage entry.", {
      storeKey,
      actor: actor?.name,
      token: token?.name,
      workflowId,
      phase: pendingEntry.phase,
      source,
      totalDamage: pendingEntry.totalDamage,
      storeSize: pendingTypedDamageStore.size
    });
  }
}

function consumePendingTypedDamage(actor, tokens, appliedDamage) {
  cleanupExpiredPendingTypedDamage();

  const numericAppliedDamage = Number(appliedDamage) || 0;
  const actorId = actor?.id ?? null;
  const actorUuid = actor?.uuid ?? null;
  const tokenIds = new Set((tokens ?? []).map((token) => token.id).filter(Boolean));
  const tokenUuids = new Set((tokens ?? []).map((token) => token?.document?.uuid ?? token?.uuid).filter(Boolean));

  if (!pendingTypedDamageStore.size) {
    debugLog("No pending typed damage cache found for actor update.", {
      actor: actor?.name,
      appliedDamage
    });
    return null;
  }

  const candidates = Array.from(pendingTypedDamageStore.entries())
    .map(([storeKey, entry]) => ({ storeKey, entry }))
    .filter(({ entry }) => {
      const actorMatch =
        (actorUuid && entry.actorUuid === actorUuid) ||
        (actorId && entry.actorId === actorId);
      const tokenMatch =
        !tokenIds.size ||
        !entry.tokenId ||
        tokenIds.has(entry.tokenId) ||
        tokenUuids.has(entry.tokenUuid);
      return actorMatch && tokenMatch;
    });

  debugLog("Looking up pending typed damage entry for actor update.", {
    actor: actor?.name,
    actorId,
    actorUuid,
    tokenIds: Array.from(tokenIds),
    tokenUuids: Array.from(tokenUuids),
    appliedDamage: numericAppliedDamage,
    candidateCount: candidates.length,
    storeSize: pendingTypedDamageStore.size
  });

  if (!candidates.length) {
    debugLog("No matching pending typed damage entry found for actor update.", {
      actor: actor?.name,
      actorId,
      actorUuid,
      tokenIds: Array.from(tokenIds),
      tokenUuids: Array.from(tokenUuids),
      appliedDamage,
      pendingEntries: Array.from(pendingTypedDamageStore.values()).map((entry) => ({
        workflowId: entry.workflowId,
        phase: entry.phase,
        actorId: entry.actorId,
        actorUuid: entry.actorUuid,
        tokenId: entry.tokenId,
        tokenUuid: entry.tokenUuid,
        totalDamage: entry.totalDamage,
        source: entry.source
      }))
    });
    return null;
  }

  const mergedCandidate = findBestPendingCandidateGroup(candidates, numericAppliedDamage);
  if (!mergedCandidate) {
    debugLog("No usable pending typed damage entry group found for actor update.", {
      actor: actor?.name,
      appliedDamage: numericAppliedDamage
    });
    return null;
  }

  for (const item of mergedCandidate.items) {
    pendingTypedDamageStore.delete(item.storeKey);
  }

  const pending = {
    workflowId: mergedCandidate.workflowId,
    actorId,
    actorUuid,
    tokenId: Array.from(tokenIds)[0] ?? null,
    tokenUuid: Array.from(tokenUuids)[0] ?? null,
    source: mergedCandidate.source,
    totalDamage: mergedCandidate.totalDamage,
    types: mergedCandidate.types
  };

  debugLog("Matched and consumed pending typed damage entry.", {
    actor: actor?.name,
    workflowId: pending.workflowId,
    source: pending.source,
    appliedDamage: numericAppliedDamage,
    cachedTotalDamage: pending.totalDamage,
    phases: mergedCandidate.items.map((item) => item.entry.phase),
    mergedTypes: pending.types,
    remainingStoreSize: pendingTypedDamageStore.size
  });

  if (numericAppliedDamage <= 0) return null;
  if (pending.totalDamage <= 0) return null;

  if (Math.abs(pending.totalDamage - numericAppliedDamage) <= 0.01) {
    debugLog("Consumed typed damage payload.", {
      actor: actor?.name,
      source: pending.source,
      appliedDamage: numericAppliedDamage,
      types: pending.types
    });
    return pending;
  }

  const scaled = {
    ...pending,
    totalDamage: numericAppliedDamage,
    types: scaleTypedDamage(pending.types, numericAppliedDamage)
  };

  debugLog("Consumed scaled typed damage payload.", {
    actor: actor?.name,
    source: pending.source,
    appliedDamage: numericAppliedDamage,
    originalTotal: pending.totalDamage,
    types: scaled.types
  });
  return scaled;
}

function findBestPendingCandidateGroup(candidates, targetDamage) {
  const grouped = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.entry.workflowId}::${candidate.entry.source}`;
    const group = grouped.get(key) ?? {
      workflowId: candidate.entry.workflowId,
      source: candidate.entry.source,
      items: []
    };
    group.items.push(candidate);
    grouped.set(key, group);
  }

  const groups = Array.from(grouped.values()).map((group) => {
    const mergedTypesMap = new Map();
    let totalDamage = 0;

    for (const item of group.items) {
      totalDamage += item.entry.totalDamage;
      for (const typed of item.entry.types) {
        mergedTypesMap.set(typed.type, (mergedTypesMap.get(typed.type) ?? 0) + typed.damage);
      }
    }

    return {
      ...group,
      totalDamage,
      types: Array.from(mergedTypesMap.entries()).map(([type, damage]) => ({ type, damage }))
    };
  });

  const exact = groups.find((group) => Math.abs(group.totalDamage - targetDamage) <= 0.01);
  if (exact) return exact;
  return groups.sort((left, right) => Math.abs(left.totalDamage - targetDamage) - Math.abs(right.totalDamage - targetDamage))[0] ?? null;
}

function scaleTypedDamage(types, targetTotal) {
  const currentTotal = types.reduce((sum, entry) => sum + entry.damage, 0);
  if (currentTotal <= 0 || targetTotal <= 0) return [];

  const roundedTarget = Math.round(targetTotal);
  let remaining = roundedTarget;
  const scaled = [];

  for (let index = 0; index < types.length; index += 1) {
    const entry = types[index];
    if (index === types.length - 1) {
      scaled.push({ ...entry, damage: Math.max(remaining, 0) });
      continue;
    }

    const amount = Math.max(Math.round((entry.damage / currentTotal) * roundedTarget), 0);
    scaled.push({ ...entry, damage: amount });
    remaining -= amount;
  }

  return scaled.filter((entry) => entry.damage > 0);
}

function buildPendingTargetKey(actor, token) {
  return [
    actor?.uuid ?? "",
    actor?.id ?? "",
    token?.document?.uuid ?? token?.uuid ?? "",
    token?.id ?? ""
  ].join("|");
}

function getWorkflowCacheId(workflow) {
  return String(workflow?.uuid ?? workflow?.id ?? foundry.utils.randomID());
}

function getTypedDamageSourcePriority(source) {
  const normalized = String(source ?? "")
    .replace(/^remote:/, "")
    .trim();

  if (normalized === "explicit-midi-detail") return 4;
  if (normalized === "explicit-midi-untyped") return 3;
  if (normalized === "workflow-item-fallback") return 1;
  if (normalized === "none") return 0;
  return 2;
}

function shouldReplacePendingEntry(existingEntry, nextEntry) {
  const existingPriority = getTypedDamageSourcePriority(existingEntry?.source);
  const nextPriority = getTypedDamageSourcePriority(nextEntry?.source);
  if (nextPriority !== existingPriority) return nextPriority > existingPriority;
  return (nextEntry?.createdAt ?? 0) >= (existingEntry?.createdAt ?? 0);
}

function setPendingTypedDamageEntry(storeKey, pendingEntry, context = {}) {
  const existingEntry = pendingTypedDamageStore.get(storeKey);
  if (existingEntry && !shouldReplacePendingEntry(existingEntry, pendingEntry)) {
    debugLog("Skipped lower-priority pending typed damage entry.", {
      storeKey,
      workflowId: pendingEntry.workflowId,
      phase: pendingEntry.phase,
      existingSource: existingEntry.source,
      incomingSource: pendingEntry.source,
      actor: context.actorName,
      token: context.tokenName
    });
    return false;
  }

  pendingTypedDamageStore.set(storeKey, pendingEntry);

  if (existingEntry && existingEntry.source !== pendingEntry.source) {
    debugLog("Upgraded pending typed damage entry source.", {
      storeKey,
      workflowId: pendingEntry.workflowId,
      phase: pendingEntry.phase,
      previousSource: existingEntry.source,
      nextSource: pendingEntry.source,
      actor: context.actorName,
      token: context.tokenName,
      storeSize: pendingTypedDamageStore.size
    });
  }

  return true;
}

function cleanupExpiredPendingTypedDamage() {
  const now = Date.now();
  for (const [storeKey, entry] of pendingTypedDamageStore.entries()) {
    if (entry.expiresAt < now) {
      pendingTypedDamageStore.delete(storeKey);
      debugLog("Expired pending typed damage entry.", {
        storeKey,
        workflowId: entry.workflowId,
        actorId: entry.actorId,
        actorUuid: entry.actorUuid,
        tokenId: entry.tokenId,
        tokenUuid: entry.tokenUuid,
        phase: entry.phase,
        ageMs: now - entry.createdAt,
        source: entry.source,
        remainingStoreSize: pendingTypedDamageStore.size
      });
    }
  }
}

function detectHpDelta(actor, change) {
  for (const path of getConfiguredHpPaths()) {
    const previousHp = Number(foundry.utils.getProperty(actor, path));
    if (!foundry.utils.hasProperty(change, path)) continue;
    const nextHp = Number(foundry.utils.getProperty(change, path));
    if (!Number.isFinite(previousHp) || !Number.isFinite(nextHp) || nextHp === previousHp) continue;

    return {
      path,
      previousHp,
      nextHp,
      amount: Math.abs(nextHp - previousHp),
      kind: nextHp > previousHp ? "heal" : "damage"
    };
  }

  return null;
}

function detectTempHpDelta(actor, change) {
  for (const path of getConfiguredTempHpPaths()) {
    const previousValue = Number(foundry.utils.getProperty(actor, path) ?? 0);
    if (!foundry.utils.hasProperty(change, path)) continue;
    const nextValue = Number(foundry.utils.getProperty(change, path) ?? 0);
    if (!Number.isFinite(previousValue) || !Number.isFinite(nextValue) || nextValue === previousValue) continue;

    return {
      path,
      previousValue,
      nextValue,
      amount: Math.abs(nextValue - previousValue),
      kind: nextValue > previousValue ? "gain" : "loss"
    };
  }

  return null;
}

function getConfiguredHpPaths() {
  return game.settings.get(MODULE_ID, "hpPaths")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

function getConfiguredTempHpPaths() {
  return game.settings.get(MODULE_ID, "tempHpPaths")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
}

function findTargetTokens(actor, options = {}) {
  const exactTokenMatches = [];
  const seen = new Set();

  const addToken = (token) => {
    if (!token?.id || seen.has(token.id)) return;
    seen.add(token.id);
    exactTokenMatches.push(token);
  };

  const actorParent = actor?.parent;
  if (actorParent?.documentName === "Token") {
    addToken(actorParent.object ?? canvas?.tokens?.get(actorParent.id) ?? null);
  }

  const actorToken = actor?.token;
  if (actorToken?.documentName === "Token") {
    addToken(actorToken.object ?? canvas?.tokens?.get(actorToken.id) ?? null);
  } else if (actorToken?.id) {
    addToken(canvas?.tokens?.get(actorToken.id) ?? null);
  }

  const optionTokenId = options?.tokenId ?? options?.token?.id ?? null;
  if (optionTokenId) {
    addToken(canvas?.tokens?.get(optionTokenId) ?? null);
  }

  const optionTokenUuid = options?.tokenUuid ?? options?.token?.uuid ?? options?.token?.document?.uuid ?? null;
  if (optionTokenUuid) {
    addToken(
      canvas?.tokens?.placeables?.find((token) =>
        token?.document?.uuid === optionTokenUuid || token?.uuid === optionTokenUuid
      ) ?? null
    );
  }

  if (exactTokenMatches.length) {
    debugLog("Resolved exact token targets for actor update.", {
      actor: actor?.name,
      tokenIds: exactTokenMatches.map((token) => token.id),
      tokenNames: exactTokenMatches.map((token) => token.name)
    });
    return exactTokenMatches;
  }

  const actorMatches = (canvas?.tokens?.placeables ?? []).filter((token) => token.actor?.id === actor.id);
  debugLog("Falling back to actor-wide token lookup for actor update.", {
    actor: actor?.name,
    actorId: actor?.id,
    tokenIds: actorMatches.map((token) => token.id),
    tokenNames: actorMatches.map((token) => token.name)
  });
  return actorMatches;
}

function ensureSocketRegistration(source) {
  if (socketReady && splatSocket) return true;

  try {
    const socketApi = globalThis.socketlib ?? globalThis.window?.socketlib ?? null;
    if (!socketApi?.registerModule) {
      throw new Error(`socketlib API is unavailable during ${source}.`);
    }

    splatSocket = socketApi.registerModule(MODULE_ID);
    if (!splatSocket?.register) {
      throw new Error(`socketlib.registerModule did not return a valid socket during ${source}.`);
    }

    splatSocket.register("renderRemoteSplats", renderRemoteSplats);
    splatSocket.register("renderRemoteSplatsAsGM", renderRemoteSplatsAsGM);
    splatSocket.register("cacheRemoteTypedDamage", cacheRemoteTypedDamage);
    socketReady = true;
    debugLog("Registered remote splat socket.", {
      source,
      socketReady,
      hasSocket: Boolean(splatSocket)
    });
    return true;
  } catch (error) {
    socketReady = false;
    splatSocket = null;
    console.warn(`${MODULE_ID} | Failed to register socket during ${source}.`, error);
    return false;
  }
}

function broadcastSplatEvents(tokens, entries, metadata = {}) {
  if (!entries?.length || !tokens?.length) return;

  const payloads = tokens.map((token) => ({
    tokenId: token.id,
    tokenUuid: token.document?.uuid ?? token.uuid ?? null,
    entries: entries.map((entry) => ({
      damage: Number(entry.damage) || 0,
      damageType: normalizeDamageType(entry.damageType ?? "untyped"),
      kind: entry.kind ?? "damage"
    }))
  }));

  debugLog("Built splat payloads for broadcast.", {
    actor: metadata.actorName,
    payloads
  });

  if (game.user?.isGM && socketReady && splatSocket) {
    debugLog("Broadcasting splat payloads to all clients.", {
      actor: metadata.actorName,
      payloadCount: payloads.length,
      socketReady,
      hasSocket: Boolean(splatSocket)
    });
    void splatSocket.executeForEveryone("renderRemoteSplats", payloads);
    return;
  }

  if (socketReady && splatSocket) {
    debugLog("Sending splat payload request to GM.", {
      actor: metadata.actorName,
      payloadCount: payloads.length
    });
    void splatSocket.executeAsGM("renderRemoteSplatsAsGM", payloads).catch((error) => {
      console.warn(`${MODULE_ID} | Could not send splat payload to GM. Falling back to local render.`, error);
      void renderRemoteSplats(payloads);
    });
    return;
  }

  debugLog("socketlib unavailable. Rendering splats locally only.", {
    actor: metadata.actorName,
    payloadCount: payloads.length,
    socketReady,
    hasSocket: Boolean(splatSocket),
    socketlibActive: game.modules.get("socketlib")?.active,
    socketlibHookFired
  });
  void renderRemoteSplats(payloads);
}

async function renderRemoteSplats(payloads) {
  debugLog("Received remote splat payloads.", {
    payloadCount: Array.isArray(payloads) ? payloads.length : 0
  });

  if (!Array.isArray(payloads)) return;

  for (const payload of payloads) {
    const token = resolveRemoteToken(payload);
    if (!token) {
      debugLog("Could not resolve token for remote splat payload.", payload);
      continue;
    }

    await showSplatEntries(token, payload.entries);
  }
}

async function renderRemoteSplatsAsGM(payloads) {
  if (!game.user?.isGM) return;
  if (!socketReady || !splatSocket) {
    return renderRemoteSplats(payloads);
  }

  debugLog("GM received splat payload request and is rebroadcasting.", {
    payloadCount: Array.isArray(payloads) ? payloads.length : 0
  });
  await splatSocket.executeForEveryone("renderRemoteSplats", payloads);
}

function forwardTypedDamageEntriesToGM(workflow, damageEntries) {
  const payloads = buildRemoteTypedDamagePayloads(workflow, damageEntries);
  if (!payloads.length) {
    debugLog("No player-side typed damage payloads were available to forward to the GM.", {
      workflowId: getWorkflowCacheId(workflow)
    });
    return;
  }

  debugLog("Forwarding typed damage payloads to GM.", {
    workflowId: getWorkflowCacheId(workflow),
    payloadCount: payloads.length,
    sources: Array.from(new Set(payloads.map((payload) => payload.source)))
  });

  if (!socketReady || !splatSocket) {
    debugLog("socketlib unavailable. Could not forward typed damage payloads to GM.", {
      workflowId: getWorkflowCacheId(workflow),
      payloadCount: payloads.length,
      socketReady,
      hasSocket: Boolean(splatSocket)
    });
    return;
  }

  void splatSocket.executeAsGM("cacheRemoteTypedDamage", payloads).catch((error) => {
    console.warn(`${MODULE_ID} | Could not forward typed damage payloads to the GM.`, error);
  });
}

function buildRemoteTypedDamagePayloads(workflow, damageEntries) {
  const workflowId = getWorkflowCacheId(workflow);

  return damageEntries
    .filter((entry) => entry?.actor && Array.isArray(entry.types) && entry.types.length)
    .map((entry) => ({
      workflowId,
      actorId: entry.actor?.id ?? null,
      actorUuid: entry.actor?.uuid ?? null,
      actorName: entry.actor?.name ?? null,
      tokenId: entry.token?.id ?? null,
      tokenUuid: entry.token?.document?.uuid ?? entry.token?.uuid ?? null,
      tokenName: entry.token?.name ?? null,
      targetKey: buildPendingTargetKey(entry.actor, entry.token),
      source: entry.source?.startsWith("remote:") ? entry.source : `remote:${entry.source}`,
      totalDamage: entry.types.reduce((sum, typed) => sum + (Number(typed.damage) || 0), 0),
      phases: (Array.isArray(entry.phases) ? entry.phases : entry.types.map((typed) => ({
        phase: "damage",
        type: typed.type,
        damage: typed.damage
      })))
        .map((phaseEntry) => ({
          phase: String(phaseEntry.phase ?? "damage"),
          type: normalizeDamageType(phaseEntry.type),
          damage: Number(phaseEntry.damage) || 0
        }))
        .filter((phaseEntry) => phaseEntry.damage > 0),
      types: entry.types
        .map((typed) => ({
          type: normalizeDamageType(typed.type),
          damage: Number(typed.damage) || 0
        }))
        .filter((typed) => typed.damage > 0)
    }))
    .filter((payload) => payload.phases.length && payload.types.length);
}

function cacheRemoteTypedDamage(payloads) {
  if (!game.user?.isGM || !Array.isArray(payloads)) return;

  debugLog("GM received remote typed damage payloads.", {
    payloadCount: payloads.length,
    sources: Array.from(new Set(payloads.map((payload) => payload?.source).filter(Boolean)))
  });

  for (const payload of payloads) {
    storePendingTypedDamagePayload(payload);
  }
}

function storePendingTypedDamagePayload(payload) {
  const actorId = payload?.actorId ?? null;
  const actorUuid = payload?.actorUuid ?? null;
  const tokenId = payload?.tokenId ?? null;
  const tokenUuid = payload?.tokenUuid ?? null;
  const workflowId = String(payload?.workflowId ?? foundry.utils.randomID());
  const targetKey = String(payload?.targetKey ?? [actorUuid ?? "", actorId ?? "", tokenUuid ?? "", tokenId ?? ""].join("|"));
  const phases = Array.isArray(payload?.phases) ? payload.phases : [];
  const source = String(payload?.source ?? "remote:unknown");
  const actorName = payload?.actorName ?? game.actors?.get(actorId)?.name ?? null;
  const tokenName =
    payload?.tokenName ??
    canvas?.tokens?.get(tokenId)?.name ??
    canvas?.tokens?.placeables?.find((placeable) => placeable?.document?.uuid === tokenUuid || placeable?.uuid === tokenUuid)?.name ??
    null;

  if (!phases.length || !(actorId || actorUuid)) return;

  cleanupExpiredPendingTypedDamage();
  const createdAt = Date.now();

  for (const [index, phaseEntry] of phases.entries()) {
    const normalizedType = normalizeDamageType(phaseEntry.type);
    const totalDamage = Number(phaseEntry.damage) || 0;
    if (totalDamage <= 0) continue;

    const storeKey = `${workflowId}::${targetKey}::${phaseEntry.phase}::${normalizedType}::${index}`;
    const pendingEntry = {
      workflowId,
      actorId,
      actorUuid,
      tokenId,
      tokenUuid,
      targetKey,
      phase: String(phaseEntry.phase ?? "damage"),
      createdAt,
      expiresAt: createdAt + PENDING_TYPED_DAMAGE_TTL_MS,
      totalDamage,
      source,
      types: [{
        type: normalizedType,
        damage: totalDamage
      }]
    };

    const stored = setPendingTypedDamageEntry(storeKey, pendingEntry, { actorName, tokenName });
    if (!stored) continue;

    debugLog("Stored remote typed damage entry on GM.", {
      storeKey,
      actor: actorName,
      token: tokenName,
      workflowId,
      phase: pendingEntry.phase,
      source,
      totalDamage: pendingEntry.totalDamage,
      storeSize: pendingTypedDamageStore.size
    });
  }
}

function resolveRemoteToken(payload) {
  if (!canvas?.tokens) return null;
  if (payload?.tokenId) {
    const byId = canvas.tokens.get(payload.tokenId);
    if (byId) return byId;
  }

  if (payload?.tokenUuid) {
    return canvas.tokens.placeables.find((token) =>
      token.document?.uuid === payload.tokenUuid || token.uuid === payload.tokenUuid
    ) ?? null;
  }

  return null;
}

async function showSplatEntries(token, entries, styleOverrides = null) {
  if (!canvas?.tokens || !entries.length) return;

  try {
    const multiCount = entries.length;
    const prepared = await Promise.all(
      entries.map((entry) => prepareSplatData(token, entry, { multiCount, styleOverrides }))
    );

    playSplatSound(prepared.find((splat) => String(splat?.style?.sound ?? "").trim())?.style);

    const offsets = computeSplatOffsets(prepared);
    const renderPromises = prepared.map((splat, index) => renderPreparedSplat(token, splat, offsets[index]));
    await Promise.allSettled(renderPromises);
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to display splats.`, error);
  }
}

async function prepareSplatData(token, entry, options = {}) {
  const dimensions = getTokenDimensions(token);
  const multiCount = options.multiCount ?? 1;
  const sizeMultiplier = multiCount > 1 ? 0.75 : 1;
  const style = getDamageTypeStyle(entry.damageType, options.styleOverrides);
  const texturePath = style.image || getFallbackSplatPath(entry);
  const texture = await foundry.canvas.loadTexture(texturePath);
  const baseTargetSize = Math.max(dimensions.size * 0.48 * dimensions.finalScale, 48);
  const targetSize = baseTargetSize * sizeMultiplier;
  const textureWidth = Math.max(texture?.width ?? 1, 1);
  const textureHeight = Math.max(texture?.height ?? 1, 1);
  const sourceSize = Math.max(textureWidth, textureHeight, 1);
  const scale = targetSize / sourceSize;
  const renderedWidth = textureWidth * scale;
  const renderedHeight = textureHeight * scale;
  const fontSize = Math.max(Math.round(dimensions.size * 0.16 * dimensions.finalScale * sizeMultiplier), 18);

  return {
    entry,
    style,
    texture,
    scale,
    renderedWidth,
    renderedHeight,
    fontSize
  };
}

function getTokenDimensions(token) {
  const width = token.w ?? (token.document.width * canvas.grid.size);
  const height = token.h ?? (token.document.height * canvas.grid.size);
  const textureScaleX = Number(token.document.texture?.scaleX ?? 1);
  const textureScaleY = Number(token.document.texture?.scaleY ?? 1);
  const actorScale = Math.max(Math.abs(textureScaleX), Math.abs(textureScaleY), 0.1);
  const splatScale = Math.max(Number(game.settings.get(MODULE_ID, "splatScale")) || 0.5, 0.05);

  return {
    width,
    height,
    size: Math.max(width, height),
    finalScale: actorScale * splatScale
  };
}

function getFallbackSplatPath(entry) {
  if (entry.kind === "heal") return game.settings.get(MODULE_ID, "healSplatPath");
  if (entry.kind === "temp-hp") return game.settings.get(MODULE_ID, "tempHpSplatPath");
  return game.settings.get(MODULE_ID, "regularSplatPath");
}

function getTintBaseSplatPath(type) {
  const normalizedType = normalizeDamageType(type);
  if (normalizedType === "heal" || normalizedType === "temp-hp") return DEFAULT_HEAL_TINT_SPLAT;
  return DEFAULT_TINT_SPLAT;
}

function getDamageTypeStyle(damageType, styleOverrides = null) {
  const styleMap = styleOverrides ?? getStoredDamageTypeStyles();
  const type = normalizeDamageType(damageType ?? "untyped");
  const existing = styleMap[type] ?? {
    label: TYPE_LABELS[type] ?? toTitleCase(type),
    enabled: true,
    image: "",
    tint: "",
    text: ""
  };

  const style = sanitizeStyleRecord(existing, existing.label);
  if (!style.enabled) {
    return { image: "", tint: null, textColor: null };
  }

  const tintColor = parseHexColor(style.tint);
  const usesTintBase = tintColor !== null;

  return {
    image: usesTintBase ? getTintBaseSplatPath(type) : style.image,
    sound: style.soundEnabled
      ? (style.sound || game.settings.get(MODULE_ID, "defaultSplatSoundPath"))
      : "",
    soundEnabled: style.soundEnabled,
    tint: tintColor,
    textColor: parseHexColor(style.text)
  };
}

function computeSplatOffsets(preparedSplats) {
  if (preparedSplats.length <= 1) return [{ x: 0, y: 0 }];

  const spreadSetting = Math.max(Number(game.settings.get(MODULE_ID, "multiSplatSpread")) || 0, 0);
  const gap = Math.max(Number(game.settings.get(MODULE_ID, "multiSplatGap")) || 0, 0);
  const arcLiftMultiplier = Math.max(Number(game.settings.get(MODULE_ID, "multiSplatArc")) || 0, 0);
  const averageWidth = preparedSplats.reduce((sum, splat) => sum + splat.renderedWidth, 0) / preparedSplats.length;
  const compactFactor = 0.28 + spreadSetting;
  const step = Math.max((averageWidth * compactFactor) + gap, 4);
  const centerIndex = (preparedSplats.length - 1) / 2;

  return preparedSplats.map((splat, index) => {
    const x = (index - centerIndex) * step;
    const centerDistance = Math.abs(index - centerIndex);
    const y = -(splat.renderedHeight * arcLiftMultiplier * centerDistance);
    return { x, y };
  });
}

async function renderPreparedSplat(token, splat, offset) {
  const container = new PIXI.Container();
  const sprite = new PIXI.Sprite(splat.texture);
  const text = createDamageText(splat.entry.damage, splat.fontSize, splat.style);

  sprite.anchor.set(0.5);
  sprite.scale.set(splat.scale);
  if (splat.style.tint !== null) sprite.tint = splat.style.tint;
  text.anchor.set(0.5);

  container.addChild(sprite);
  container.addChild(text);
  container.position.set(token.center.x + offset.x, token.center.y + offset.y);
  container.alpha = 0;
  container.scale.set(0.6);
  container.zIndex = 999999;
  container.eventMode = "none";

  canvas.tokens.addChild(container);
  await animateSplat(container);
  container.destroy({ children: true });
}

function createDamageText(value, fontSize, style) {
  const fontFamily = game.settings.get(MODULE_ID, "fontFamily");

  return new PIXI.Text(String(value), {
    fontFamily,
    fontSize,
    fill: style.textColor ?? 0xfff7bd,
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
  const totalDuration = Math.max(Number(game.settings.get(MODULE_ID, "durationMs")) || 2000, 150);
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

  await CanvasAnimation.animate(
    [
      { parent: container.scale, attribute: "x", from: 1.05, to: 1 },
      { parent: container.scale, attribute: "y", from: 1.05, to: 1 }
    ],
    { duration: settleDuration }
  );

  if (holdDuration > 0) await wait(holdDuration);

  await CanvasAnimation.animate(
    [
      { parent: container, attribute: "alpha", from: 1, to: 0 },
      { parent: container, attribute: "y", from: container.y, to: container.y - 18 }
    ],
    { duration: outroDuration }
  );
}

function loadRuneScapeFont() {
  const fontPath = game.settings.get(MODULE_ID, "fontPath");
  const fontFamily = game.settings.get(MODULE_ID, "fontFamily");
  if (!fontPath || !fontFamily || !document?.fonts) return;

  const fontFace = new FontFace(fontFamily, `url("${fontPath}")`);
  fontFace
    .load()
    .then((loadedFace) => document.fonts.add(loadedFace))
    .then(() => debugLog("Font loaded.", { fontPath, fontFamily }))
    .catch((error) => {
      console.warn(`${MODULE_ID} | Could not load font at ${fontPath}`, error);
    });
}

function patchNativeScrollingText() {
  const scrollingTextLayer = canvas?.interface;
  if (!scrollingTextLayer || scrollingTextLayer._rsDamageSplatsPatched) return;

  const originalCreateScrollingText = scrollingTextLayer.createScrollingText;
  if (typeof originalCreateScrollingText !== "function") return;

  scrollingTextLayer.createScrollingText = function wrappedCreateScrollingText(...args) {
    const [origin, content] = args;
    debugLog("canvas.interface.createScrollingText called.", {
      originType: origin?.constructor?.name,
      content
    });

    if (shouldSuppressNativeScrollingText(origin, content)) {
      debugLog("Suppressed native scrolling text.", { content });
      return null;
    }

    return originalCreateScrollingText.apply(this, args);
  };

  scrollingTextLayer._rsDamageSplatsPatched = true;
}

function patchTokenScrollingText() {
  const tokenPrototype = CONFIG?.Token?.objectClass?.prototype;
  if (!tokenPrototype || tokenPrototype._rsDamageSplatsPatched) return;

  const originalShowScrollingText = tokenPrototype.showScrollingText;
  if (typeof originalShowScrollingText !== "function") return;

  tokenPrototype.showScrollingText = function wrappedShowScrollingText(...args) {
    const [content] = args;
    if (shouldSuppressNativeScrollingText(this, content)) return null;
    return originalShowScrollingText.apply(this, args);
  };

  tokenPrototype._rsDamageSplatsPatched = true;
}

function shouldSuppressNativeScrollingText(origin, content) {
  if (!game.settings.get(MODULE_ID, "hideNativeScrollingText")) return false;

  const normalizedContent = normalizeScrollingTextContent(content);
  if (!normalizedContent) return false;
  if (!/^[+-]?\d+$/.test(normalizedContent)) return false;

  debugLog("Matched native scrolling text for suppression.", {
    originType: origin?.constructor?.name,
    rawContent: content,
    normalizedContent
  });

  return true;
}

function normalizeScrollingTextContent(content) {
  if (content === null || content === undefined) return "";

  return String(content)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[−–—]/g, "-")
    .replace(/[＋]/g, "+")
    .trim();
}

function parseHexColor(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return Number.parseInt(normalized, 16);
}

function playSplatSound(style) {
  if (!game.settings.get(MODULE_ID, "enableSplatSounds")) return;
  const src = String(style?.sound ?? "").trim();
  if (!src) return;

  const audioHelper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper;
  if (!audioHelper?.play) {
    console.warn(`${MODULE_ID} | Audio helper is not available for splat sound playback.`);
    return;
  }

  try {
    const result = audioHelper.play({
      src,
      volume: 0.8,
      autoplay: true,
      loop: false
    }, false);

    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        console.warn(`${MODULE_ID} | Could not play splat sound at ${src}`, error);
      });
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not play splat sound at ${src}`, error);
  }
}

function normalizeDamageType(value) {
  return String(value ?? "untyped")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function toTitleCase(value) {
  return String(value ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function wait(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function debugLog(message, data = {}) {
  if (!game.settings.get(MODULE_ID, "debug")) return;
  console.log(`${MODULE_ID} | ${message}`, data);
}

function findPreviewToken() {
  return canvas?.tokens?.controlled?.[0]
    ?? game.user?.character?.getActiveTokens?.()[0]
    ?? canvas?.tokens?.placeables?.find((token) => token.actor?.isOwner)
    ?? null;
}

class DamageTypeStylesConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-damage-type-styles`,
      title: "Fluxee's Damage Splats: Damage Type Styles",
      template: `modules/${MODULE_ID}/templates/damage-type-styles-config.html`,
      width: 1500,
      height: 860,
      resizable: true,
      classes: ["rsds-config-window"],
      closeOnSubmit: false,
      submitOnChange: false
    });
  }

  getData() {
    const styles = getStoredDamageTypeStyles();
    const defaults = getDefaultDamageTypeStyles();
    const rows = Object.entries(styles)
      .sort(([typeA], [typeB]) => {
        const indexA = TYPE_ORDER.indexOf(typeA);
        const indexB = TYPE_ORDER.indexOf(typeB);
        if (indexA === -1 && indexB === -1) return typeA.localeCompare(typeB);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      })
      .map(([type, style]) => ({
        type,
        label: style.label,
        enabled: style.enabled,
        image: style.image,
        soundEnabled: style.soundEnabled,
        sound: style.sound,
        tint: style.tint,
        text: style.text,
        defaultImage: defaults[type]?.image ?? "",
        defaultSoundEnabled: defaults[type]?.soundEnabled !== false,
        defaultSound: defaults[type]?.sound ?? "",
        defaultTint: defaults[type]?.tint ?? "",
        defaultText: defaults[type]?.text ?? "",
        defaultEnabled: defaults[type]?.enabled !== false,
        previewAmount: type === "heal" ? 12 : 9
      }));

    return { rows };
  }

  activateListeners(html) {
    super.activateListeners(html);
    this._setupResponsiveLayout();
    this._syncColorToggleStates();
    this._syncTintBaseHints();
    this._closeAfterSave = false;

    html.find(".rsds-color-toggle").on("change", () => {
      this._syncColorToggleStates();
      this._syncTintBaseHints();
    });

    html.find("[name$='.image']").on("input", () => {
      this._syncTintBaseHints();
    });

    html.find("[data-action='apply']").on("click", async (event) => {
      event.preventDefault();
      await this._saveStyles({ closeAfterSave: false });
    });

    html.find("[data-action='save']").on("click", () => {
      this._closeAfterSave = true;
    });

    html.find("[data-action='preview']").on("click", async (event) => {
      event.preventDefault();
      const button = event.currentTarget;
      const type = button.dataset.type;
      const token = findPreviewToken();
      if (!token) {
        ui.notifications?.warn("Select or control a token before testing a splat.");
        return;
      }

      const styleOverrides = this._collectStylesFromForm();
      const amount = Number(button.dataset.amount ?? 9) || 9;
      const kind = type === "heal" ? "heal" : "damage";

      await showSplatEntries(
        token,
        [{ damage: amount, damageType: type, kind }],
        styleOverrides
      );
    });

    html.find("[data-action='reset']").on("click", (event) => {
      event.preventDefault();
      const button = event.currentTarget;
      const type = button.dataset.type;
      const defaults = getDefaultDamageTypeStyles()[type];
      if (!defaults) return;

      const row = this.form.querySelector(`.rsds-row[data-type="${type}"]`);
      if (!row) return;

      row.querySelector(`[name="styles.${type}.enabled"]`).checked = defaults.enabled !== false;
      row.querySelector(`[name="styles.${type}.image"]`).value = defaults.image ?? "";
      row.querySelector(`[name="styles.${type}.soundEnabled"]`).checked = defaults.soundEnabled !== false;
      row.querySelector(`[name="styles.${type}.sound"]`).value = defaults.sound ?? "";
      row.querySelector(`[name="styles.${type}.tintEnabled"]`).checked = Boolean(defaults.tint);
      row.querySelector(`[name="styles.${type}.textEnabled"]`).checked = Boolean(defaults.text);
      row.querySelector(`[name="styles.${type}.tint"]`).value = defaults.tint || "#FF0000";
      row.querySelector(`[name="styles.${type}.text"]`).value = defaults.text || "#FFF7BD";
      this._syncColorToggleStates(row);
      this._syncTintBaseHints(row);
    });
  }

  setPosition(position = {}) {
    const result = super.setPosition(position);
    this._syncResponsiveLayoutClass();
    return result;
  }

  close(options) {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    return super.close(options);
  }

  _setupResponsiveLayout() {
    this._syncResponsiveLayoutClass();
    if (this._resizeObserver || !this.form || typeof ResizeObserver === "undefined") return;

    const target = this.element?.[0] ?? this.form;
    if (!target) return;

    this._resizeObserver = new ResizeObserver(() => {
      this._syncResponsiveLayoutClass();
    });
    this._resizeObserver.observe(target);
  }

  _syncResponsiveLayoutClass() {
    const app = this.element?.[0];
    if (!app) return;

    const width = app.clientWidth || this.position?.width || 0;
    app.classList.toggle("rsds-layout-stacked", width > 0 && width < 980);
    app.classList.toggle("rsds-layout-compact", width >= 980 && width < 1320);
  }

  _syncColorToggleStates(scope = this.form) {
    if (!scope) return;

    for (const row of scope.matches?.(".rsds-row[data-type]") ? [scope] : scope.querySelectorAll(".rsds-row[data-type]")) {
      const type = normalizeDamageType(row.dataset.type);
      const pairs = [
        {
          toggle: row.querySelector(`[name="styles.${type}.textEnabled"]`),
          input: row.querySelector(`[name="styles.${type}.text"]`)
        },
        {
          toggle: row.querySelector(`[name="styles.${type}.tintEnabled"]`),
          input: row.querySelector(`[name="styles.${type}.tint"]`)
        }
      ];

      for (const pair of pairs) {
        if (!pair.toggle || !pair.input) continue;
        pair.input.disabled = !pair.toggle.checked;
      }
    }
  }

  _syncTintBaseHints(scope = this.form) {
    if (!scope) return;

    for (const row of scope.matches?.(".rsds-row[data-type]") ? [scope] : scope.querySelectorAll(".rsds-row[data-type]")) {
      const type = normalizeDamageType(row.dataset.type);
      const tintEnabled = Boolean(row.querySelector(`[name="styles.${type}.tintEnabled"]`)?.checked);
      row.classList.toggle("rsds-uses-tint-base", tintEnabled);
    }
  }

  _collectStylesFromForm() {
    const normalized = {};

    for (const row of this.form.querySelectorAll(".rsds-row[data-type]")) {
      const type = normalizeDamageType(row.dataset.type);
      const label = row.dataset.label ?? TYPE_LABELS[type] ?? toTitleCase(type);
      const enabledInput = row.querySelector(`[name="styles.${type}.enabled"]`);
      const imageInput = row.querySelector(`[name="styles.${type}.image"]`);
      const soundEnabledInput = row.querySelector(`[name="styles.${type}.soundEnabled"]`);
      const soundInput = row.querySelector(`[name="styles.${type}.sound"]`);
      const tintEnabledInput = row.querySelector(`[name="styles.${type}.tintEnabled"]`);
      const tintInput = row.querySelector(`[name="styles.${type}.tint"]`);
      const textEnabledInput = row.querySelector(`[name="styles.${type}.textEnabled"]`);
      const textInput = row.querySelector(`[name="styles.${type}.text"]`);

      normalized[type] = sanitizeStyleRecord(
        {
          label,
          enabled: Boolean(enabledInput?.checked),
          image: imageInput?.value ?? "",
          soundEnabled: Boolean(soundEnabledInput?.checked),
          sound: soundInput?.value ?? "",
          tint: tintEnabledInput?.checked ? (tintInput?.value ?? "") : "",
          text: textEnabledInput?.checked ? (textInput?.value ?? "") : ""
        },
        label
      );
    }

    return normalized;
  }

  async _updateObject(_event, _formData) {
    await this._saveStyles({ closeAfterSave: this._closeAfterSave });
    this._closeAfterSave = false;
  }

  async _saveStyles({ closeAfterSave = false } = {}) {
    const normalized = this._collectStylesFromForm();
    await game.settings.set(MODULE_ID, "damageTypeStyles", JSON.stringify(normalized, null, 2));
    ui.notifications?.info("Damage type splat settings saved.");
    if (closeAfterSave) await this.close();
  }
}
