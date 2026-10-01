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

1. In Foundry's **Setup → Add-on Modules → Install Module** screen, paste this URL into **Manifest URL** and click **Install**:

   ```text
   https://github.com/Fluxee1/Fluxees-Damage-Splats/releases/latest/download/module.json
   ```

2. Install `socketlib` if Foundry prompts for the required dependency
3. Open your world and enable **Fluxee's Damage Splats** and **socketlib** in **Manage Modules**
4. Optionally enable `Midi-QOL` for typed damage splats
5. Open the module settings and choose the images, sounds, and colors you want to use

The module's existing compatibility declaration is Foundry VTT **11 or later**, verified for **13**. Version 1.1.1 fixes installation packaging; it does not change the splat behavior or add new compatibility claims.

If an older installation cannot check for updates, reinstall through the manifest URL above. The module ID remains `rs-damage-splats`, so existing world settings continue to use the same ID.

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

Current version: `1.1.1`
