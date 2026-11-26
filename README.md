# Fluxee's Damage Splats

RuneScape-style damage splats for Foundry VTT with support for healing, temp HP, typed damage, custom images, custom sounds, tint colors, and text colors.

[Join the Discord!](https://discord.gg/KahMNDkRtK) · [Support me on Patreon](https://www.patreon.com/Fluxee)

## Features

- Damage, healing, and temp HP splats
- Typed damage support through `Midi-QOL`
- Custom image and sound paths per damage type
- Per-type tint and text color styling
- Live preview tools in the `Damage Type Styles` manager
- Synchronized splats and sounds across clients with `socketlib`, including HP changes players make themselves

## Installation

Requires Foundry VTT v13 or v14.

1. Install and enable `Fluxee's Damage Splats`
2. Install and enable `socketlib`
3. Optionally install and enable `Midi-QOL` for typed damage splats
4. Open the module settings and choose the images, sounds, and colors you want to use

## Customization

The module includes bundled defaults, but you can fully customize the look and sound of each splat type.

- Every damage type uses the tint base with its own color by default
- Use **Bundled Art** on a row to switch to the module's pre-colored art for that type (acid, cold, fire, force, lightning, necrotic, poison, psychic, radiant, thunder, healing, temp HP)
- Set your own image per type; with Tint on, the tint colors your image
- Set a custom sound per damage type
- Change text colors
- Untick **Enabled** to hide a type's splats entirely
- Test splats and sounds directly inside the style manager before saving

For custom images or sounds, store them in Foundry's normal file storage, not inside this module's `assets` folder. Module updates can overwrite or delete files placed inside the module folder.

## Included defaults

Bundled default assets include:

- `assets/regularsplat.webp`
- `assets/healsplat.webp`
- `assets/temphpsplat.webp`
- `assets/splattint.webp`
- `assets/healtint.webp`
- `assets/rssplathit.ogg`
- `assets/runescape_uf.ttf`

## Notes

- `socketlib` is required for synchronized splats and sounds across clients
- `Midi-QOL` is optional, but enables typed damage splats
- If no image or tint is set for a type, the module falls back to the standard damage splat
- If an image can't be loaded, the default splat is shown instead and the manager flags the path
- Foundry's own floating number is hidden on a token only when a splat is shown for it
- Multi-type hits only play one sound total
- The active GM turns HP changes into splats, so at least one GM should be connected for typed Midi-QOL splats. Without a GM, splats still show but are untyped

## Development

- `node --test tests/*.test.mjs` runs the logic and end-to-end flow tests
- `tests/browser/manager_check.py` checks the style manager in Chromium. Serve a folder containing `modules/rs-damage-splats` with `python -m http.server 8766` first. Needs `pip install playwright`

## Version

Current version: `1.2.2`
