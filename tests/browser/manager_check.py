"""Browser check for the Damage Type Styles window (ApplicationV2 port).

Serve a folder containing modules/rs-damage-splats (pointing at this module):
    python -m http.server 8766
then run: python tests/browser/manager_check.py
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

BASE = os.environ.get("HARNESS_URL", "http://localhost:8766/modules/rs-damage-splats/tests/browser/index.html")
CHROMIUM = os.environ.get("CHROMIUM_PATH")
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))

async def open_page(p, width=1040, height=900):
    browser = await p.chromium.launch(**({"executable_path": CHROMIUM} if CHROMIUM else {}))
    page = await browser.new_page(viewport={"width": width + 40, "height": height + 40})
    await page.goto(f"{BASE}?w={width}&h={height}")
    await page.wait_for_function("window.__ready === true || (window.__errors && window.__errors.length)", timeout=10000)
    return browser, page

async def main():
    async with async_playwright() as p:
        browser, page = await open_page(p)
        ev = page.evaluate
        row = lambda t: f'.rsds-row[data-type="{t}"]'

        check("window renders 16 rows", await ev("document.querySelectorAll('.rsds-row').length") == 16)
        check("root element is the form", await ev("document.querySelector('#rs-damage-splats-damage-type-styles').tagName") == "FORM")
        check("fire badge says Tint Base", await ev(f"document.querySelector('{row('fire')} [data-derived=image-mode]').textContent") == "Tint Base")
        types = await ev("[...document.querySelectorAll('[data-action=bundled-art]')].map(b => b.dataset.type)")
        check("bundled art button only on types that have art", len(types) == 12 and "slashing" not in types and "fire" in types, types)

        # Bundled art: sets image, turns tint off, badge updates.
        await page.click(f'{row("fire")} [data-action="bundled-art"]')
        state = await ev(f"(() => {{ const r = document.querySelector('{row('fire')}'); return {{ image: r.querySelector('[name=\"styles.fire.image\"]').value, tint: r.querySelector('[name=\"styles.fire.tintEnabled\"]').checked, tintInputDisabled: r.querySelector('[name=\"styles.fire.tint\"]').disabled, badge: r.querySelector('[data-derived=image-mode]').textContent }}; }})()")
        check("bundled art fills the image path", state["image"].endswith("firesplat.webp"), state)
        check("bundled art turns tint off", state["tint"] is False and state["tintInputDisabled"] is True, state)
        check("badge shows Bundled Art", state["badge"] == "Bundled Art", state)

        # Custom image + tint is kept and labelled.
        await page.fill('[name="styles.cold.image"]', "worlds/art/ice.webp")
        await page.dispatch_event('[name="styles.cold.image"]', "input")
        check("custom image with tint is labelled", await ev(f"document.querySelector('{row('cold')} [data-derived=image-mode]').textContent") == "Custom Image + Tint")
        check("missing custom image is flagged on the preview", await page.wait_for_function(f"document.querySelector('{row('cold')} [data-preview-box]').classList.contains('is-broken')", timeout=3000) is not None)

        # Disabled row.
        await page.uncheck('[name="styles.acid.enabled"]')
        check("disabled row is dimmed", await ev(f"document.querySelector('{row('acid')}').classList.contains('is-disabled')"))
        check("disabled badge", await ev(f"document.querySelector('{row('acid')} [data-derived=image-mode]').textContent") == "Disabled")
        await page.click(f'{row("acid")} [data-action="preview"]')
        notes = await ev("window.__notes || []")
        check("testing a disabled type warns instead of drawing", any("disabled" in n[1] for n in notes) and await ev("window.__previewSplats.length") == 0, notes)

        # Preview of temp HP uses the temp HP image, not the regular one.
        await page.click(f'{row("temp-hp")} [data-action="preview"]')
        splats = await ev("window.__previewSplats")
        check("temp HP test splat uses the temp HP image", splats and splats[-1]["image"].endswith("temphpsplat.webp"), splats)
        await page.click(f'{row("fire")} [data-action="preview"]')
        splats = await ev("window.__previewSplats")
        check("test splat uses unsaved form state (bundled fire art)", splats[-1]["image"].endswith("firesplat.webp"), splats[-1])

        # Reset row restores defaults.
        await page.click(f'{row("fire")} [data-action="reset"]')
        check("reset restores tint base", await ev(f"document.querySelector('{row('fire')} [data-derived=image-mode]').textContent") == "Tint Base")

        # Browse wires the file picker to the right input.
        await page.click(f'{row("poison")} [data-action="browse-image"]')
        await ev("window.__picker.callback('worlds/art/poison.webp')")
        check("file picker writes the chosen path", await ev("document.querySelector('[name=\"styles.poison.image\"]').value") == "worlds/art/poison.webp")

        # Apply saves without closing; Save saves and closes.
        await page.click('[data-action="apply"]')
        saved = json.loads(await ev("window.__settingsValues.get('rs-damage-splats.damageTypeStyles')"))
        check("apply saves", saved["acid"]["enabled"] is False and saved["cold"]["image"] == "worlds/art/ice.webp" and saved["cold"]["tint"] != "", saved.get("cold"))
        check("apply keeps the window open", await ev("!!document.querySelector('#rs-damage-splats-damage-type-styles')"))
        await page.click('button[type="submit"]')
        await page.wait_for_timeout(200)
        check("save closes the window", await ev("window.__closed === true"))
        errors = await ev("window.__errors || []")
        check("no page errors", not errors, errors)
        await browser.close()

        # Layout at different window sizes: nothing overflows sideways.
        for width in (1300, 1040, 860, 620):
            browser, page = await open_page(p, width, 760)
            problems = await page.evaluate("""() => {
              const app = document.querySelector('#rs-damage-splats-damage-type-styles');
              const box = app.getBoundingClientRect();
              const bad = [];
              for (const el of app.querySelectorAll('.rsds-row button, .rsds-row input, .rsds-manager-footer button, .rsds-manager-badge')) {
                const r = el.getBoundingClientRect();
                if (r.width && r.right > box.right + 1) bad.push(el.outerHTML.slice(0, 60));
              }
              const list = app.querySelector('.rsds-manager-list');
              if (list.scrollWidth > list.clientWidth + 1) bad.push('list scrolls sideways');
              if (list.scrollHeight <= list.clientHeight) bad.push('list does not scroll');
              const footer = app.querySelector('.rsds-manager-footer').getBoundingClientRect();
              if (footer.bottom > box.bottom + 1) bad.push('footer cut off');
              return bad;
            }""")
            check(f"layout at {width}px has no clipping", not problems, problems[:3])
            await page.screenshot(path=f"/tmp/rsds-{width}.png")
            await browser.close()

    print(f"{sum(results)} / {len(results)}")
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
