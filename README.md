# Fluxee's Damage Splats

This Foundry VTT module shows RuneScape-style splats when actors lose or regain HP.

It supports:

- regular damage splats
- heal splats
- temp HP splats
- per-type splat sounds
- typed damage splats through Midi-QOL
- one splat per damage type when multiple types are applied
- a per-type settings form with live preview buttons
- synchronized splats and sounds across clients via socketlib

## Installation

Install the module in Foundry, then enable it for your world.

`socketlib` is a required dependency and is declared in the module manifest, so Foundry should prompt for it during install if it is missing.

Recommended setup:

1. Install and enable `Fluxee's Damage Splats`
2. Install and enable `socketlib`
3. Optionally install and enable `Midi-QOL` if you want typed damage splats
4. Open the module settings and review your splat images, sounds, and style defaults

## What it does

- Watches actor HP changes.
- Shows a damage splat when HP goes down.
- Shows a heal splat when HP goes up.
- Shows a temp HP splat when temporary HP changes.
- Uses Midi-QOL typed damage data when available.
- Falls back to actor HP loss when typed damage data is not available.
- Suppresses Foundry's native floating numbers if that setting is enabled.

## Required assets

Put your splat art and font in the module `assets` folder.

Expected defaults:

- `assets/RegularSplat.webp`
- `assets/HealSplat.webp`
- `assets/TempHPSplat.webp`
- `assets/rssplathit.ogg`
- `assets/runescape_bold.ttf`

Typed splats can point at any image path you enter in the settings form.

## Dependencies

- Required: `socketlib`
  - Used so the GM can broadcast splats and sounds to all connected clients.
- Optional: `Midi-QOL`
  - Used for typed damage splats and better per-type damage breakdowns.

## Main settings

- `HP data paths`
  - Comma-separated actor data paths to monitor for HP changes.
- `Use Midi-QOL typed damage`
  - Uses Midi-QOL typed damage breakdowns when available.
- `Regular splat image`
  - The default fallback damage splat.
- `Temp HP data paths`
  - Comma-separated actor data paths to monitor for temp HP changes.
- `Heal splat image`
  - Used when HP increases.
- `Temp HP splat image`
  - Used when temporary HP changes.
- `Splat scale`
  - Overall size multiplier for splats and numbers.
- `Splat duration (ms)`
  - Total on-screen time.
- `Multi-splat spread`
  - Controls how far apart multi-type splats step from center.
- `Multi-splat gap`
  - Adds or removes extra fixed space between multi-type splats.
- `Multi-splat arc lift`
  - How much outer splats rise upward.
- `Damage Type Styles`
  - Opens the per-type configuration form.
- `Default splat sound path`
  - World setting.
  - Used when a type has sound enabled but no custom sound path.
- `Enable splat sounds`
  - Client setting.
  - Players can turn splat sounds on or off for themselves.
- `Hide native damage/healing numbers`
  - Hides Foundry's floating numbers when possible.

## Damage type styles

Open `Damage Type Styles` to configure each type.

Each row has:

- enable toggle
- image path
- sound toggle
- sound path
- text color
- tint
- `Test Splat`
- `Reset`

Rules:

- If `Tint` is enabled, the module uses the tint-base splat for that row.
- If a type has an `image` and tint is off, that image is used first.
- If a type has sound enabled, it uses its own sound path or the default splat sound path.
- A multi-splat hit only plays one sound total.
- If no type image is set, the module falls back to the regular damage splat.
- Tint-driven rows use `SplatTint.webp`, while `heal` and `temp-hp` tint mode uses `HealTint.webp`.
- Crit splats are no longer used.

## Multi-type behavior

If more than one damage type is applied:

- each splat is reduced to 75% size
- splats are spread apart horizontally
- outer splats can lift upward slightly
- each splat shows its own per-type amount

You can tune this with:

- `Multi-splat spread`
- `Multi-splat gap`
- `Multi-splat arc lift`

## Midi-QOL and AoE

When Midi-QOL provides typed damage data, the module uses it directly.

If Midi-QOL does not provide a full typed breakdown for a target, the module also tries to infer the type from the item's damage parts. This helps spells like `Fireball` still choose the correct splat type.

## Heal behavior

When HP increases:

- one heal splat is shown
- the healed amount is displayed
- the configured heal splat image is used

## Temp HP behavior

When temporary HP changes:

- one temp HP splat is shown
- the changed amount is displayed
- the configured temp HP splat image is used

## Release notes

Version `1.0.0` includes:

- synchronized client splats through `socketlib`
- typed damage support for player and GM workflows
- temp HP support
- per-type sounds, tint, and text styling
- a responsive per-type style editor with preview and reset tools
