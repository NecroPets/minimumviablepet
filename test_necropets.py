#!/usr/bin/env python3
"""End-to-end test harness for NecroPets. Drives every interactive flow in a real
headless browser, captures console/page errors, and watches the live Ollama call.
Outputs a JSON report (last stdout line) + screenshots in ./shots/."""
import json, os, re, sys, time, pathlib
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8090/"
SHOTS = pathlib.Path(__file__).parent / "shots"; SHOTS.mkdir(exist_ok=True)
R = {}  # results: name -> {pass, detail}
def rec(name, ok, detail=""): R[name] = {"pass": bool(ok), "detail": str(detail)[:400]}

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width":1366,"height":900})
        page = ctx.new_page()
        console_errors, page_errors, ollama_calls = [], [], []
        page.on("console", lambda m: console_errors.append(m.text) if m.type=="error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        def on_resp(resp):
            if "11434" in resp.url:
                ollama_calls.append({"url":resp.url,"status":resp.status})
        page.on("response", on_resp)

        # --- load ---
        try:
            page.goto(URL, wait_until="networkidle", timeout=30000)
            rec("page_loads", True, f"title={page.title()!r}")
        except Exception as e:
            rec("page_loads", False, e); print(json.dumps({"results":R}, indent=2)); return
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOTS/"01_hero.png"))

        # --- sections present ---
        for sid in ["hero","how","resurrect","companion","privacy","close"]:
            rec(f"section_{sid}", page.locator(f"#{sid}").count()>0)

        # --- nav anchors resolve ---
        dead = page.evaluate("""() => {
            const out=[]; document.querySelectorAll('a[href^=\"#\"]').forEach(a=>{
              const id=a.getAttribute('href').slice(1);
              if(id && !document.getElementById(id)) out.push(a.getAttribute('href'));
            }); return [...new Set(out)];
        }""")
        rec("nav_anchors_resolve", len(dead)==0, f"dead={dead}")

        # --- WIZARD: file input + step nav + resurrect -> awake ---
        try:
            wiz = page.locator("#resurrect")
            # file upload to first file input
            tmp = SHOTS/"_sample.txt"; tmp.write_text("memory")
            fi = wiz.locator("input[type=file]")
            file_ok=False
            if fi.count()>0:
                before = wiz.inner_text()
                fi.first.set_input_files(str(tmp))
                page.wait_for_timeout(600)
                file_ok = wiz.inner_text()!=before
            rec("wizard_file_upload", file_ok, f"file_inputs={fi.count()}")
            # advance steps: click any button matching next/continue up to 6x
            clicks=0
            for _ in range(6):
                nb = wiz.get_by_role("button", name=re.compile(r"next|continue|forward", re.I))
                if nb.count() and nb.first.is_visible():
                    nb.first.click(); clicks+=1; page.wait_for_timeout(350)
                else: break
            rec("wizard_step_nav", clicks>=1, f"advanced {clicks} steps")
            # trigger resurrection
            act = wiz.get_by_role("button", name=re.compile(r"resurrect|awaken|reanimate|bring.*back|begin|summon|wake", re.I))
            awake=False; detail="no resurrect button found"
            if act.count():
                act.first.click()
                # wait for build sequence + awake reveal (up to 12s)
                try:
                    page.wait_for_function(
                        """() => /awake|alive|is here|meet |say hello|hello,|waiting for you/i.test(document.querySelector('#resurrect')?.innerText||'')""",
                        timeout=12000)
                    awake=True; detail="awake state reached"
                except Exception as e:
                    detail=f"no awake state within 12s ({e})"
                page.screenshot(path=str(SHOTS/"02_wizard.png"))
            rec("wizard_resurrect_to_awake", awake, detail)
        except Exception as e:
            rec("wizard_resurrect_to_awake", False, e)

        # --- CHAT: real selectors, real submit, assert NEW bot bubble + live Ollama 200 ---
        try:
            page.locator("#companion").scroll_into_view_if_needed(); page.wait_for_timeout(500)
            field = page.locator("#np-chat-field")
            sendbtn = page.locator("#np-chat-form .np-chat__send, #np-chat-form button[type=submit], #np-chat-form button")
            tag = field.evaluate("el => el.tagName.toLowerCase()") if field.count() else "MISSING"
            rec("chat_field_present", field.count()>0, f"field tag={tag}")
            bots_before = page.locator("#np-chat-log .np-msg--bot").count()
            sent=False
            if field.count():
                field.click(); field.fill("Hi Luna, do you remember our evening walks together?")
                if sendbtn.count() and sendbtn.first.is_enabled():
                    sendbtn.first.click(); sent=True
                else:
                    page.eval_on_selector("#np-chat-form", "f => f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))"); sent=True
            rec("chat_submit_fires", sent, f"send_btns={sendbtn.count()}, bots_before={bots_before}")
            # NEW bot bubble with substantive text (Ollama may be slow w/ a pull running) up to 70s
            reply=False; rdetail="no new bot bubble"
            if sent:
                try:
                    page.wait_for_function(
                        """(n) => { const b=document.querySelectorAll('#np-chat-log .np-msg--bot');
                           return b.length>n && (b[b.length-1].innerText||'').trim().length>12; }""",
                        arg=bots_before, timeout=70000)
                    reply=True
                    rdetail=page.locator("#np-chat-log .np-msg--bot").last.inner_text().strip()[:160]
                except Exception as e:
                    rdetail=f"no reply within 70s ({e})"
                page.screenshot(path=str(SHOTS/"03_chat.png"))
            rec("chat_gets_reply", reply, rdetail)
            ok_calls=[c for c in ollama_calls if c["status"]==200]
            mode = page.locator("#np-chat-status").get_attribute("data-mode") if page.locator("#np-chat-status").count() else "?"
            # MUST be a real local reply: a 200 from Ollama AND the site reporting mode=local (not the 'memory' fallback)
            rec("chat_real_local_ai", len(ok_calls)>0 and mode=="local",
                f"ollama_200={len(ok_calls)} status_mode={mode} (must be 'local', not fallback) reply={str(rdetail)[:90]}")
        except Exception as e:
            rec("chat_gets_reply", False, e)

        # --- responsive: no horizontal overflow at 375px ---
        try:
            page.set_viewport_size({"width":375,"height":800}); page.wait_for_timeout(600)
            ow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            rec("responsive_no_overflow", ow<=2, f"overflow_px={ow}")
            page.screenshot(path=str(SHOTS/"04_mobile.png"), full_page=False)
        except Exception as e:
            rec("responsive_no_overflow", False, e)

        # --- console / page errors ---
        rec("no_console_errors", len(console_errors)==0, f"{console_errors[:5]}")
        rec("no_page_errors", len(page_errors)==0, f"{page_errors[:5]}")
        browser.close()

    passed = sum(1 for v in R.values() if v["pass"]); total=len(R)
    print("\n=== NECROPETS E2E ===")
    for k,v in R.items(): print(f"  [{'PASS' if v['pass'] else 'FAIL'}] {k}: {v['detail'][:120]}")
    print(f"SCORE {passed}/{total}")
    print("JSON:"+json.dumps({"passed":passed,"total":total,"results":R}))

if __name__=="__main__": main()
