export default async ({ page, context }) => {
  const dpr = context.mobile ? 3 : 1;
  const expectW = context.width;

  // Reject structurally-invalid input up front. A width of 0/undefined makes Chromium
  // silently keep its 800px default viewport (while still applying dpr), producing a
  // wrong-width capture that becomes a false pixel-diff FAIL.
  if (typeof expectW !== 'number' || !(expectW > 0)) {
    return { capture_error: true, reason: 'invalid viewport width: ' + expectW };
  }

  // The page we capture from. Rung 3 of the establish ladder below replaces it
  // with a fresh one, so nothing may hold on to the original page handle.
  let pg = page;

  const applyViewport = () => pg.setViewport(context.mobile
    ? { width: expectW, height: context.height, isMobile: true, hasTouch: true, deviceScaleFactor: dpr }
    : { width: expectW, height: context.height });

  // A capture is only trustworthy when the emulation landed in BOTH places:
  // the page itself (layout width + device pixel ratio) and puppeteer's own
  // cached viewport, which is what pg.screenshot() scales the image by. They can
  // disagree: browserless connects its function client without a defaultViewport,
  // so puppeteer applies its DEFAULT_VIEWPORT (800x600 @1x) to every page it
  // materialises, and that application can land after ours. Repairing only the
  // live metrics yields a page that lays out at 393 but screenshots at 1x -- a
  // wrong-scale capture the old width-only guard passed (validated 2026-08-11
  // against browserless 2.38.2 / puppeteer's CdpPage._create).
  const measure = async () => {
    const live = await pg.evaluate(() => ({
      cw: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio,
    })).catch(() => null);
    const cached = pg.viewport() || {};
    return { cw: live ? live.cw : null, dpr: live ? live.dpr : null, cachedW: cached.width };
  };
  const loaded = (m) => m.cw === expectW && m.dpr === dpr && m.cachedW === expectW;
  const describe = (m) => m.cw + '@' + m.dpr + 'x/cache' + m.cachedW;

  // Raw CDP metrics override. A second CDP client outranks whatever puppeteer's
  // own session left behind, so this repairs the live layout when setViewport
  // alone does not stick. The session is deliberately never detached: Chromium
  // drops a session's emulation overrides when it goes away.
  let cdp = null;
  let cdpPage = null;
  const cdpViewport = async () => {
    if (cdpPage !== pg) {
      cdp = await pg.target().createCDPSession().catch(() => null);
      cdpPage = pg;
    }
    if (!cdp) return;
    const metrics = {
      width: expectW, height: context.height, deviceScaleFactor: dpr,
      mobile: !!context.mobile, screenWidth: expectW, screenHeight: context.height,
    };
    if (context.mobile) metrics.screenOrientation = { angle: 0, type: 'portraitPrimary' };
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics).catch(() => {});
  };

  // Escalated apply, used only after the plain path has already failed: raw CDP
  // override first, puppeteer's own setViewport LAST -- it owns the screenshot
  // scale and touch emulation, so it has to be the final writer. Repeated a few
  // times because the competing application is a race, not a steady state.
  const forceViewport = async () => {
    for (let i = 0; i < 3; i++) {
      await cdpViewport();
      await applyViewport();
      const m = await measure();
      if (m.cachedW === expectW && m.dpr === dpr) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  };

  // Dismiss an overlay, retrying the click until it actually disappears. The old code
  // clicked once and swallowed a 1s wait; under load the SPA drops that click, leaving
  // the banner in the shot. Retrying lands it. One click when healthy => pixel-neutral.
  const dismiss = async (selector, appearTimeout) => {
    await pg.waitForSelector(selector, { timeout: appearTimeout }).catch(() => {});
    for (let i = 0; i < 6; i++) {
      const el = await pg.$(selector).catch(() => null);
      if (!el) return;
      await el.click().catch(() => {});
      const gone = await pg.waitForSelector(selector, { hidden: true, timeout: 800 }).then(() => true).catch(() => false);
      if (gone) return;
    }
  };

  try {
    // Load the page and verify the emulation actually took effect. Under browserless load,
    // setViewport intermittently does not stick and the page lays out at Chromium's 800px
    // default (=> the 2400px-wide mobile capture / "squashed left" look). Re-applying
    // setViewport in place does NOT relayout a mobile page cleanly (validated 2026-07-15:
    // it lands on an intermediate overflow width); a fresh navigation does. So every rung
    // below re-navigates rather than resizing the loaded page.
    //
    // This is a LADDER, not a plain retry: the wrong-viewport state is sticky per page, so
    // three identical retries reproduce it three times and the capture is dropped -- which
    // is exactly what skipped the site root on mobile in two consecutive runs on
    // 2026-08-11 (all three loads at 800). Each rung therefore changes something:
    //   0. setViewport + fresh navigation  -- healthy path, byte-identical to before
    //   1-2. + raw CDP override, verified  -- outranks puppeteer's stale session
    //   3. + a brand-new page              -- drops the poisoned target entirely
    const seen = [];
    let established = false;
    for (let rung = 0; rung < 4 && !established; rung++) {
      if (rung === 3) {
        const fresh = await pg.browser().newPage().catch(() => null);
        if (!fresh) break;
        pg = fresh;   // the old page is left open on purpose: browserless closes it itself
      }
      if (rung === 0) await applyViewport();
      else await forceViewport();
      await pg.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 2000));
      const m = await measure();
      seen.push((rung >= 3 ? 'newpage:' : rung >= 1 ? 'forced:' : '') + describe(m));
      if (loaded(m)) established = true;
    }
    if (!established) {
      return { capture_error: true, reason: 'viewport ' + expectW + '@' + dpr + 'x never established (tried: ' + seen.join(', ') + ')' };
    }

    await dismiss('.spacer-medium ~ button', 2500);   // age gate
    await dismiss('button ::-p-text(Accept)', 2500);   // cookie consent

    await pg.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});

    const gate = await pg.evaluate(() => ({
      lazyImgs: document.querySelectorAll('img[loading="lazy"]').length,
      tall: document.documentElement.scrollHeight > window.innerHeight * 2,
    }));
    if (gate.lazyImgs >= 15 && gate.tall) {
      const st = Date.now();
      const initH = await pg.evaluate(() => document.documentElement.scrollHeight);
      let iter = 0;
      while (true) {
        if (++iter > 60) break;
        if (Date.now() - st > 25000) break;
        const h = await pg.evaluate(() => document.documentElement.scrollHeight);
        if (h > initH * 1.4) break;
        const atBottom = await pg.evaluate(() => (window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 4);
        if (atBottom && iter > 1) break;
        await pg.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85)));
        await new Promise(r => setTimeout(r, 350));
      }
      await pg.evaluate(() => window.scrollTo(0, 0));
      await pg.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});
    }

    await Promise.race([
      pg.evaluate(async () => {
        document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
        await Promise.all(Array.from(document.images).map(img => (img.complete && img.naturalHeight !== 0) ? null :
          new Promise(res => { const d = () => res(); img.addEventListener('load', d, { once: true }); img.addEventListener('error', d, { once: true }); setTimeout(d, 3000); })));
      }),
      new Promise(r => setTimeout(r, 6000)),
    ]).catch(() => {});
    await new Promise(r => setTimeout(r, 200));


    // Scroll-lock guard (2026-08-07): an auto-opened modal (e.g. the signup bottom-
    // sheet on one marketing page) locks the page behind it -- html overflow:hidden
    // + body position:fixed -- which collapses documentElement.scrollHeight to one
    // viewport, so fullPage would silently emit a viewport-tall capture. Detect the
    // lock, close the sheet via its own close button (Escape as a fallback), and if
    // the page stays locked FAIL CLOSED with capture_error: a truncated capture must
    // never reach the judging pipeline. Geometry alone is not a lock (app-layout pages
    // legitimately scroll in an inner container, e.g. this page's own desktop variant),
    // so also require the body-fixed / both-overflow-hidden scroll-lock signature.
    // Runs BEFORE the navbar-pin block: the pin must never re-anchor a modal sheet
    // using a collapsed docH.
    const lockState = () => pg.evaluate(() => {
      const de = document.documentElement, b = document.body;
      const deCs = getComputedStyle(de), bCs = getComputedStyle(b);
      return {
        deH: de.scrollHeight, bodyH: b.scrollHeight, vh: window.innerHeight,
        bodyFixed: bCs.position === 'fixed',
        bothHidden: deCs.overflowY === 'hidden' && bCs.overflowY === 'hidden',
      };
    }).catch(() => null);
    const isLocked = (m) => !!m && m.deH <= m.vh * 1.05 && m.bodyH > m.vh * 1.5 && (m.bodyFixed || m.bothHidden);

    // Match the close control on its CSS-module ELEMENT suffix, never on the build's
    // hash prefix (2026-08-11): the sheet's button was button.D__close when this guard
    // shipped and button.bg__close three days later -- the site's module prefixes
    // rotate with every frontend build, so a pinned prefix quietly matches nothing and
    // the guard fails closed on a page it used to recover (that page skipped
    // all three mobile runs of 2026-08-11). Rank candidates by the z-index of
    // their nearest fixed ancestor: a page carrying several close controls then picks
    // the top-most overlay's own button, and later attempts fall through to the next.
    const rankedClosers = async () => {
      const found = await pg.$$('button[class*="__close"], button[aria-label*="close" i], button[class*="close" i]').catch(() => []);
      const ranked = [];
      for (const el of found) {
        const z = await el.evaluate((e) => {
          const r = e.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0) || getComputedStyle(e).visibility === 'hidden') return null;
          let top = -1;
          for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.position !== 'fixed') continue;
            const nz = parseInt(cs.zIndex, 10);
            top = Math.max(top, Number.isFinite(nz) ? nz : 0);
          }
          return top;
        }).catch(() => null);
        if (z !== null) ranked.push({ el, z });
      }
      ranked.sort((a, b) => b.z - a.z);
      return ranked;
    };

    let lock = await lockState();
    if (isLocked(lock)) {
      const pathBefore = await pg.evaluate(() => location.pathname).catch(() => null);
      for (let i = 0; i < 3 && isLocked(lock); i++) {
        const ranked = await rankedClosers();
        if (ranked.length) await ranked[Math.min(i, ranked.length - 1)].el.click().catch(() => {});
        else await pg.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
        lock = await lockState();
      }
      if (isLocked(lock)) {
        return { capture_error: true, reason: 'page scroll-locked by an overlay (document ' + lock.deH + 'px vs content ' + lock.bodyH + 'px) -- fullPage would be viewport-only' };
      }
      // A suffix match also admits controls that are not the sheet's closer, and a click
      // that navigated would hand the pipeline a different page to diff against this
      // slug's baseline. Treat a pathname change as a failed dismissal, not a recovery.
      const pathAfter = await pg.evaluate(() => location.pathname).catch(() => null);
      if (pathBefore && pathAfter && pathAfter !== pathBefore) {
        return { capture_error: true, reason: 'overlay dismissal navigated away: ' + pathBefore + ' -> ' + pathAfter };
      }
      await pg.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {});
    }

    // MOBILE ONLY: the app-style bottom tab bar is position:fixed; bottom:0, so a fullPage
    // capture paints it once at the FIRST-viewport bottom, floating over content. Re-anchor
    // any bottom-pinned fixed bar to the TRUE document bottom: append a spacer strip the
    // bar's height, then position the bar absolutely inside that strip (below the footer, so
    // nothing is covered). Only fixed + in-viewport + lower-half elements are touched; the
    // top header and position:sticky content headings are left alone.
    if (context.mobile) {
      await pg.evaluate(() => {
        const vh = window.innerHeight;
        const bars = [];
        document.querySelectorAll('*').forEach(el => {
          const cs = getComputedStyle(el);
          if (cs.position !== 'fixed') return;
          const r = el.getBoundingClientRect();
          if (r.height < 20 || r.width < 40) return;
          if (r.top >= vh || r.bottom <= 0) return;
          if (r.top < vh * 0.45) return;
          bars.push({ el, h: r.height });
        });
        if (!bars.length) return;
        const docH = document.documentElement.scrollHeight;
        const maxH = Math.ceil(Math.max.apply(null, bars.map(b => b.h)));
        const spacer = document.createElement('div');
        spacer.setAttribute('data-vt-spacer', '1');
        spacer.style.cssText = 'width:100%;height:' + maxH + 'px;background:#000;';
        document.body.appendChild(spacer);
        bars.forEach(b => {
          document.body.appendChild(b.el);
          b.el.style.setProperty('position', 'absolute', 'important');
          b.el.style.setProperty('top', docH + 'px', 'important');
          b.el.style.setProperty('bottom', 'auto', 'important');
          b.el.style.setProperty('left', '0', 'important');
          b.el.style.setProperty('right', '0', 'important');
          b.el.style.setProperty('width', '100%', 'important');
          b.el.style.setProperty('margin', '0', 'important');
        });
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 150));
    }

    // Codec guard (2026-08-30). A browser that cannot decode the site's H.264 leaves
    // every <video> on MEDIA_ERR_SRC_NOT_SUPPORTED, and the site paints its own "couldn't
    // play the video" card over each one -- a page-shaped defect that no visitor can
    // reproduce, which the pipeline then reports with full confidence. That is the
    // silent-wrong-verdict shape every other guard here exists to prevent, so refuse the
    // capture instead: a Skip naming the cause beats a FAIL naming the wrong culprit.
    // Fires only on pages that actually carry video, and only on a codec-free build --
    // the browserless chromium image is one, which is why compose pins the chrome image.
    const codec = await pg.evaluate(() => ({
      h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),
      videos: document.querySelectorAll('video').length,
    })).catch(() => null);
    if (codec && codec.videos > 0 && !codec.h264) {
      return { capture_error: true, reason: 'browser cannot decode H.264 but the page has '
        + codec.videos + ' video element(s), so every one of them renders a playback-error '
        + 'state -- capture the site with the browserless chrome image, not chromium' };
    }

    // Park every video on frame 0 (2026-08-30). The marketing pages carry a dozen
    // autoplay+loop heroes each, so a browser that can actually decode them hands the
    // pixel diff a different frame every run -- site-wide noise that reads as change.
    // Order matters: neutralise play() BEFORE pausing, because the feed re-plays its
    // videos from an intersection observer and a bare pause() is undone before the
    // screenshot. Runs last, after the scroll pass has brought every lazy video into
    // view and started it. A video that cannot decode (media error, or a codec this
    // build lacks) never fires 'seeked', so every wait is bounded and the capture
    // proceeds regardless -- which is what makes this pixel-neutral on a codec-free
    // Chromium, where nothing was ever playing to begin with.
    await Promise.race([
      pg.evaluate(async () => {
        const noop = () => Promise.resolve();
        try { HTMLMediaElement.prototype.play = noop; } catch (e) {}
        await Promise.all(Array.from(document.querySelectorAll('video')).map(v => new Promise(res => {
          const timer = setTimeout(res, 2500);
          const settle = () => { clearTimeout(timer); res(); };
          try {
            v.play = noop;
            v.autoplay = false;
            v.loop = false;
            v.pause();
            // Already parked with a decoded frame to show: seeking again would only
            // risk a 'seeked' that never comes.
            if (v.currentTime === 0 && v.readyState >= 2) return settle();
            v.addEventListener('seeked', settle, { once: true });
            v.addEventListener('error', settle, { once: true });
            if (v.readyState < 2) {
              v.addEventListener('loadeddata', () => { try { v.currentTime = 0; } catch (e) {} }, { once: true });
            }
            v.currentTime = 0;
          } catch (e) { settle(); }
        })));
      }),
      new Promise(r => setTimeout(r, 6000)),
    ]).catch(() => {});
    await new Promise(r => setTimeout(r, 250));

    // Final backstop: never emit a wrong-width OR wrong-scale capture. (Emulation is
    // stable after the verified load, so this only fires on a genuine anomaly.)
    const finalM = await measure();
    if (!loaded(finalM)) {
      return { capture_error: true, reason: 'viewport drifted before screenshot: ' + describe(finalM) + ' != ' + expectW + '@' + dpr + 'x' };
    }

    return await pg.screenshot({ fullPage: true, type: 'png' });
  } catch (error) {
    // Fail CLOSED (2026-08-07): the old fallback shipped a viewport-only screenshot
    // here, which reads downstream as a real (truncated) page -- the same silent-
    // truncation shape as the scroll-lock class. An errored capture is not judged.
    return { capture_error: true, reason: 'capture failed: ' + (error && error.message ? error.message : String(error)) };
  }
};