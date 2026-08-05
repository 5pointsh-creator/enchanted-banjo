from playwright.sync_api import sync_playwright
errs=[]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle","--use-angle=swiftshader",
        "--enable-unsafe-swapchain","--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width":900,"height":600})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8123/forest.html")
    pg.wait_for_timeout(2200)
    # confirm rename visible on start screen
    h1 = pg.text_content("#start h1")
    pg.click("#enter")
    pg.wait_for_timeout(300)
    pg.screenshot(path="/var/lib/freelancer/projects/40625742/cyc_a.png")
    hueA = pg.evaluate("() => window.__ph ?? null")
    pg.wait_for_timeout(9000)   # let colours drift
    pg.screenshot(path="/var/lib/freelancer/projects/40625742/cyc_b.png")
    print("start_h1:", repr(h1), "| errors:", errs[:5])
    b.close()
