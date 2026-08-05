from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle","--use-angle=swiftshader",
        "--enable-unsafe-swapchain","--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width":1280,"height":720})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("https://anirudhatalmale6-alt.github.io/enchanted-banjo/forest.html", wait_until="networkidle")
    pg.wait_for_timeout(2500)
    pg.click("#enter")
    pg.keyboard.down("w"); pg.wait_for_timeout(2000); pg.keyboard.up("w")
    pg.wait_for_timeout(400)
    pg.screenshot(path="/var/lib/freelancer/projects/40625742/forest_send.png")
    ok = pg.evaluate("() => { const gl=document.getElementById('c').getContext('webgl2'); return !!gl; }")
    print("webgl:",ok,"errors:",errs[:5])
    b.close()
