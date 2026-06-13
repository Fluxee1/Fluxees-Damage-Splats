# Fluxee's Damage Splats

RuneScape-style damage splats for Foundry VTT with support for healing, temp HP, typed damage, custom images, custom sounds, tint colors, and text colors.

[Join the Discord!](https://discord.gg/KahMNDkRtK)

## Features

- Damage, healing, and temp HP splats
- Typed damage support through `Midi-QOL`
- Custom image and sound paths per damage type
- Per-type tint and text color styling
- Live preview tools in the `Damage Type Styles` manager
- Synchronized splats and sounds across clients with `socketlib`

## Installation

1. Install and enable `Fluxee's Damage Splats`
2. Install and enable `socketlib`
3. Optionally install and enable `Midi-QOL` for typed damage splats
4. Open the module settings and choose the images, sounds, and colors you want to use

## Customization

The module includes bundled defaults, but you can fully customize the look and sound of each splat type.

- Set a custom image per damage type
- Set a custom sound per damage type
- Use tint-base splats for stronger color styling
- Change text colors
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
- If no custom image is set for a type, the module falls back to the standard damage splat
- Multi-type hits only play one sound total

## Version

Current version: `1.1.0`
