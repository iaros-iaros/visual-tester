const allResults = $('Loop Over Items').all(); // Make sure this matches your input node

const escapeHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const reportGroups = ['__DEVICE__'];
const outputReports = [];


const publicBaseUrl = $env.WEBHOOK_URL;
const webhookUrl = `${$env.WEBHOOK_URL}/webhook/update-baseline`;

for (const deviceType of reportGroups){

  const groupResults = allResults.filter(item => item.json.device === deviceType);
  
  if (groupResults.length === 0) continue;
  
  let passUrls = [];
  let failUrls = [];
  let skippedUrls = [];
  let newUrls = [];
  const date = new Date();
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  const reportEpoch = date.getTime(); // for the updater's staleness guard
  const reportFilename = `report-${deviceType}-${timestamp}.html`;
  const reportFilePath = `/files/reports/${reportFilename}`;
  const reportPublicUrl = `${publicBaseUrl}/reports/${reportFilename}`;
  
  const scriptBlock = `
  <script>
    async function acceptBaseline(slug, btnElement) {
      // 1. Visual Feedback: Show spinner or dim the button
      const originalText = btnElement.innerText;
      btnElement.innerText = "⏳ Updating...";
      btnElement.style.opacity = "0.7";
      btnElement.style.pointerEvents = "none"; // Prevent double clicks
  
      try {
        // 2. Send Request to n8n (Background)
        // We add a random timestamp to prevent browser caching
        const url = "${webhookUrl}?slug=" + slug + "&token=${$env.UPDATE_BASELINE_TOKEN}&reportTs=${reportEpoch}";

        const response = await fetch(url);
        let body = null;
        try { body = await response.json(); } catch (e) {}

        if (response.ok && (!body || body.status !== 'error')) {
          // 3. Success: Replace button with Checkmark
          const container = btnElement.parentElement;
          container.innerHTML = '<span style="color: #2e7d32; font-weight: bold; font-size: 14px;">✅ Baseline Updated</span>';
        } else {
          throw new Error(body && body.message ? body.message : "Server returned " + response.status);
        }
      } catch (error) {
        // 4. Error: Reset button and alert user
        console.error(error);
        alert("❌ Baseline NOT updated: " + error.message);
        btnElement.innerText = originalText;
        btnElement.style.opacity = "1";
        btnElement.style.pointerEvents = "auto";
      }
    }

    // Persist the accepted state across reopens (2026-07-29): the baseline
    // file's Last-Modified IS the acceptance record — if it postdates this
    // report's generation, the row has already been dealt with. One HEAD
    // request per FAIL row, cache-busted; works for every viewer/browser.
    document.addEventListener('DOMContentLoaded', () => {
      const REPORT_TS = ${reportEpoch};
      document.querySelectorAll('button[data-accept-slug]').forEach(async (btn) => {
        try {
          const slug = btn.dataset.acceptSlug;
          const r = await fetch("${publicBaseUrl}/baseline_screenshots/baseline_" + slug + ".png?v=" + Date.now(), { method: 'HEAD', cache: 'no-store' });
          if (!r.ok) return;
          const lm = Date.parse(r.headers.get('Last-Modified') || '');
          if (lm && lm > REPORT_TS) {
            btn.parentElement.innerHTML = '<span style="color: #2e7d32; font-weight: bold; font-size: 14px;">✅ Baseline updated ' + new Date(lm).toLocaleString() + '</span><div style="font-size: 11px; color: #999; margin-top: 4px;">(after this report was generated)</div>';
          }
        } catch (e) { /* keep the button on any error */ }
      });
    });
  </script>
  `;

  // On-demand screenshot viewer (2026-08-18). Rows used to inline their capture
  // as a <=300px thumbnail, which was the worst of both worlds: the browser
  // downloaded the FULL native PNG for every one of ~56 PASS rows (~900MB per
  // mobile report, avg 16MB a file) and then drew nothing usable, because a
  // full-page capture is ~1:20 and object-fit:contain in a 300x300 box renders
  // it as a ~15px-wide sliver. Now a row carries only a button; images load on
  // click into a full-viewport overlay. A FAIL pair is stitched side by side
  // inside ONE scroll container with a red seam between the halves, both at
  // equal rendered width — they come from the same native page width, so equal
  // width IS equal scale, and a single scroll moves both halves together.
  const viewerBlock = `
  <script>
    (function () {
      var ov, stack, row, labels, pane, pct, links, title, msg;
      var zoom = 1, base = 0;
      var SEAM = 3;      // px, the divider between the two halves
      var MAXFIT = 2;    // never auto-upscale past 2x on open

      function build() {
        ov = document.createElement('div');
        ov.className = 'vt-ov';
        ov.innerHTML =
          '<div class="vt-bar">' +
            '<span class="vt-title"></span>' +
            '<span class="vt-grp">' +
              '<button type="button" class="vt-b" data-z="out" title="Zoom out">&minus;</button>' +
              '<span class="vt-pct"></span>' +
              '<button type="button" class="vt-b" data-z="in" title="Zoom in">+</button>' +
            '</span>' +
            '<button type="button" class="vt-b" data-z="fit" title="Fit to width">Fit</button>' +
            '<span class="vt-sp"></span>' +
            '<span class="vt-links"></span>' +
            '<button type="button" class="vt-b" data-vt-close="1">&times; Close</button>' +
          '</div>' +
          '<div class="vt-pane"><div class="vt-stack">' +
            '<div class="vt-labels"></div><div class="vt-row"></div><div class="vt-msg"></div>' +
          '</div></div>';
        document.body.appendChild(ov);
        stack = ov.querySelector('.vt-stack'); row = ov.querySelector('.vt-row');
        labels = ov.querySelector('.vt-labels'); pane = ov.querySelector('.vt-pane');
        pct = ov.querySelector('.vt-pct'); links = ov.querySelector('.vt-links');
        title = ov.querySelector('.vt-title'); msg = ov.querySelector('.vt-msg');
        ov.addEventListener('click', function (e) {
          var t = e.target;
          if (!t || !t.closest) return;
          var z = t.closest('[data-z]');
          if (z) { setZoom(z.getAttribute('data-z')); return; }
          if (t.closest('[data-vt-close]') || t === ov || t === pane || t === stack) close();
        });
        window.addEventListener('resize', apply);
      }

      // Read the pane's padding rather than hardcoding it: the phone breakpoint
      // narrows it, and fit-to-width has to agree with whatever the CSS says.
      function paneW() {
        var cs = getComputedStyle(pane);
        return pane.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      }

      function fitZoom() { return Math.max(0.02, paneW() / base); }

      function apply() {
        if (!base) return;
        var w = Math.max(40, Math.round(base * zoom));
        stack.style.width = w + 'px';
        stack.style.margin = w <= paneW() ? '0 auto' : '0';
        pct.textContent = Math.round(zoom * 100) + '%';
      }

      function setZoom(kind) {
        if (!base) return;
        if (kind === 'in') zoom = Math.min(8, zoom * 1.25);
        else if (kind === 'out') zoom = Math.max(0.02, zoom / 1.25);
        else zoom = fitZoom();
        apply();
      }

      function isOpen() { return ov && ov.style.display === 'flex'; }

      function close() {
        if (!ov) return;
        ov.style.display = 'none';
        row.innerHTML = ''; labels.innerHTML = ''; links.innerHTML = '';
        base = 0;
        document.body.style.overflow = '';
      }

      function open(btn) {
        if (!ov) build();
        var srcs = [], names = [];
        if (btn.dataset.vtA) { srcs.push(btn.dataset.vtA); names.push(btn.dataset.vtLa || 'Baseline'); }
        if (btn.dataset.vtB) { srcs.push(btn.dataset.vtB); names.push(btn.dataset.vtLb || 'New'); }
        if (!srcs.length) return;

        title.textContent = btn.dataset.vtTitle || '';
        labels.innerHTML = '';
        links.innerHTML = '';
        row.innerHTML = '';
        stack.style.width = '';
        base = 0; zoom = 1;
        pct.textContent = '';
        msg.style.display = '';
        msg.textContent = 'Loading' + (srcs.length > 1 ? ' both captures' : '') + '\u2026';

        names.forEach(function (n) {
          var el = document.createElement('span');
          el.textContent = n;
          labels.appendChild(el);
        });
        srcs.forEach(function (src, i) {
          var a = document.createElement('a');
          a.href = src; a.target = '_blank'; a.rel = 'noopener';
          var lx = document.createElement('span');
          lx.className = 'vt-lx';
          lx.textContent = 'original: ';
          a.appendChild(lx);
          a.appendChild(document.createTextNode(names[i].split(' ')[0].toLowerCase() + ' \u2197'));
          links.appendChild(a);
        });

        var left = srcs.length;
        srcs.forEach(function (src) {
          var img = document.createElement('img');
          img.alt = '';
          img.onload = function () {
            if (--left) return;
            var n = row.children.length, nat = 1;
            for (var i = 0; i < n; i++) nat = Math.max(nat, row.children[i].naturalWidth || 1);
            base = nat * n + SEAM * (n - 1);   // equal width per half, so equal scale
            zoom = Math.min(MAXFIT, fitZoom());
            msg.style.display = 'none';
            apply();
          };
          img.onerror = function () { msg.textContent = 'Could not load ' + src; };
          img.src = src;
          row.appendChild(img);
        });

        ov.style.display = 'flex';
        document.body.style.overflow = 'hidden';
      }

      document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button[data-vt-a]') : null;
        if (b) { e.preventDefault(); open(b); }
      });
      document.addEventListener('keydown', function (e) {
        if (!isOpen()) return;
        if (e.key === 'Escape') close();
        else if (e.key === '+' || e.key === '=') setZoom('in');
        else if (e.key === '-') setZoom('out');
        else if (e.key === '0') setZoom('fit');
      });
    })();
  </script>
  `;

  // 2. Build the Content
  for (const item of groupResults) {
    const data = item.json;
    const link = `<div style="margin-bottom: 8px;"><strong>URL:</strong> <a href="${data.url}" target="_blank">${data.url}</a></div>`;
    
    if (data.status === 'PASS') {
      const imageUrl = `${publicBaseUrl}/baseline_screenshots/baseline_${data.slug}.png?v=${timestamp}`
      passUrls.push(`
      ${link}
      <button type="button" class="vt-open" data-vt-a="${escapeHtml(imageUrl)}" data-vt-la="Baseline" data-vt-title="${escapeHtml(data.url)}">&#128444;&#65039; View Baseline</button>
      `);
    } 
    else if (data.status === 'FAIL') {
      const filename = data.fileName ? data.fileName.split('/').pop() : 'unknown';
      const newImageUrl = `${publicBaseUrl}/failed_screenshots/${filename}?v=${data.evidenceStamp || timestamp}`;
      // Immutable evidence (2026-07-29): link the per-run frozen copy of the
      // baseline AS COMPARED, not the live file that Accept overwrites. The
      // ?v= buster defeats stale browser caches on the live-file fallback.
      const baselineImageUrl = data.baselineSnapFile
        ? `${publicBaseUrl}/failed_screenshots/${data.baselineSnapFile}`
        : `${publicBaseUrl}/baseline_screenshots/baseline_${data.slug}.png?v=${timestamp}`;
      // One button, no inline <img> (2026-08-18): the pair opens in the viewer
      // overlay, stitched side by side inside one scroll container. Thumbnails
      // here were worse than useless — a full-page capture is ~1:20, so
      // object-fit:contain in a 300x300 box drew a ~15px-wide sliver, and the
      // browser downloaded the whole JPEG anyway to draw it.
      const failedScreenshotBlock = !data.reason.startsWith("Screenshot crashed") ? `
        <div style="margin-top:8px;">
          <button type="button" class="vt-open vt-open-fail" data-vt-a="${escapeHtml(baselineImageUrl)}" data-vt-b="${escapeHtml(newImageUrl)}" data-vt-la="Baseline" data-vt-lb="New (highlighted)" data-vt-title="${escapeHtml(data.url)}">&#128269; Compare Baseline &harr; New</button>
        </div>
        <div style="font-size: 11px; color: #999; margin-top: 6px;">(Opens both captures side by side &middot; <span style="color:#cb2431;">solid red</span> = reported defect &middot; <span style="color:#b8860b;">dashed amber</span> = changed, judged noise)</div>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eee;">
          <button
              data-accept-slug="${data.slug}" onclick="acceptBaseline('${data.slug}', this)"
              style="
                background-color: #2e7d32;
                color: white;
                border: none;
                padding: 8px 12px;
                border-radius: 4px;
                font-family: sans-serif;
                font-size: 14px;
                font-weight: bold;
                cursor: pointer;
                transition: background 0.2s;">
              Accept New Version
          </button>
          <div style="font-size: 11px; color: #999; margin-top: 4px;">(Overwrites baseline)</div>
        </div>
      ` : ``;

      const aiMetaBlock = data.modelVersion || data.reasonSource ? `
        <div style="font-size:11px; color:#666; font-family:monospace; margin-bottom:8px;">AI model: ${data.modelVersion || 'n/a'}${data.aiProvider && data.aiProvider !== 'gemini' ? ' via ' + data.aiProvider : ''}${data.reasonSource && data.reasonSource !== 'model' ? ' &middot; reason source: ' + data.reasonSource : ''}</div>` : '';
      const thoughtBlock = data.thought_process ? `
        <details style="margin-bottom:10px;"><summary style="cursor:pointer; font-size:12px; color:#555;">AI thought process</summary><div style="font-size:12px; color:#444; white-space:pre-wrap; background:#fafbfc; border:1px solid #eee; border-radius:4px; padding:8px; margin-top:6px;">${escapeHtml(data.thought_process)}</div></details>` : '';
      // v2 (2026-07-29): machine verification trail (probe/sweep evidence) so a
      // questionable verdict is diagnosable from the report alone.
      const verifBlock = data.verification_trail ? `
        <details style="margin-bottom:10px;"><summary style="cursor:pointer; font-size:12px; color:#555;">Verification trail</summary><div style="font-size:11px; color:#555; font-family:monospace; white-space:pre-wrap; background:#fafbfc; border:1px solid #eee; border-radius:4px; padding:8px; margin-top:6px;">${escapeHtml(data.verification_trail)}</div></details>` : '';
      failUrls.push(`
        ${link}
        <div style="margin-bottom:12px;"><strong>Reason:</strong> <span style="color:red;">${data.reason}</span></div>
        ${aiMetaBlock}
        ${thoughtBlock}
        ${verifBlock}
        ${failedScreenshotBlock}
      `);
    }
    else if (data.status === 'SKIP') {
      skippedUrls.push(`
        ${link}
        <div style="margin-bottom:12px; font-size: 13px;">
          <strong>Reason:</strong> <span style="color:#b08800;">${data.reason || "Skipped"}</span>
        </div>
      `);
    }
    else if (data.status === 'NEW') {
      newUrls.push(link);
    }
  }
  
  // 3. Generate HTML
  let html = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${deviceType.toUpperCase()} Report</title>
      ${scriptBlock}
      ${viewerBlock}
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; padding: 20px; margin: 0; }
        .wrapper { display: flex; align-items: stretch; background: #fff;
                   border: 1px solid #d1d5da; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
        .col + .col { border-left: 1px solid #e1e4e8; }
        .colhead { margin: 0; padding: 12px; background: #f6f8fa; font-size: 16px; border-bottom: 2px solid; }
        .cell { padding: 15px; border-bottom: 1px solid #e1e4e8; }
        .cell:last-child { border-bottom: 0; }
        .col-fail .cell { background: #fff5f5; }
        h2 { margin-top: 0; color: #24292e; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .cell a { overflow-wrap: anywhere; }
        button[data-accept-slug]:hover { background-color: #1b5e20 !important; }

        /* on-demand screenshot viewer */
        .vt-open { background:#0366d6; color:#fff; border:none; border-radius:4px; padding:8px 14px; font-family:inherit; font-size:14px; font-weight:bold; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.18); transition:background 0.2s; }
        .vt-open:hover { background:#024ea2; }
        .vt-open:active { box-shadow:none; transform:translateY(1px); }
        .vt-open-fail { background:#cb2431; }
        .vt-open-fail:hover { background:#a11b26; }
        .vt-ov { display:none; position:fixed; top:0; right:0; bottom:0; left:0; z-index:9999; background:rgba(15,17,20,0.93); flex-direction:column; }
        .vt-bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:10px 14px; background:#1c2026; color:#e6e6e6;
                  font-size:13px; flex:0 0 auto; border-bottom:1px solid #333d4a; }
        .vt-bar .vt-title { font-weight:600; max-width:34%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .vt-bar .vt-sp { flex:1 1 auto; }
        .vt-bar .vt-links a { color:#8cc2ff; margin-left:14px; }
        /* The controls used to be #2b323b on a #1c2026 bar -- a 1.3:1 surface
           contrast that read as "disabled" rather than "button". Raised to a
           surface that is plainly lighter than the bar, with a border and label
           to match, and the zoom trio bound into one segmented control. */
        .vt-b { background:#3b4552; color:#f4f7fa; border:1px solid #5a6675; border-radius:6px; padding:6px 13px;
                font:inherit; font-size:13px; font-weight:600; line-height:1.4; cursor:pointer; }
        .vt-b:hover { background:#4c596a; border-color:#748294; }
        .vt-b:active { transform:translateY(1px); }
        .vt-b:focus-visible { outline:2px solid #8cc2ff; outline-offset:2px; }
        .vt-b[data-vt-close]:hover { background:#cb2431; border-color:#e0505c; color:#fff; }
        .vt-grp { display:flex; align-items:stretch; background:#3b4552; border:1px solid #5a6675; border-radius:6px; overflow:hidden; }
        .vt-grp .vt-b { background:none; border:0; border-radius:0; }
        .vt-grp .vt-b:hover { background:#4c596a; }
        .vt-grp .vt-b[data-z="out"], .vt-grp .vt-b[data-z="in"] { font-size:17px; padding:2px 14px; }
        .vt-pct { display:flex; align-items:center; justify-content:center; min-width:52px; padding:0 4px;
                  border-left:1px solid #5a6675; border-right:1px solid #5a6675;
                  color:#e6ebf1; font-weight:600; font-variant-numeric:tabular-nums; }
        .vt-pane { flex:1 1 auto; overflow:auto; -webkit-overflow-scrolling:touch; padding:0 12px 12px; }
        .vt-labels { display:flex; position:sticky; top:0; z-index:1; }
        .vt-labels span { flex:1 1 0; min-width:0; padding:5px 8px; background:#2b323b; color:#e6e6e6; font-size:12px; font-weight:600; text-align:center; }
        .vt-labels span + span { border-left:3px solid #cb2431; }
        .vt-row { display:flex; align-items:flex-start; }
        .vt-row img { flex:1 1 0; min-width:0; height:auto; display:block; background:#fff; }
        .vt-row img + img { border-left:3px solid #cb2431; }
        .vt-msg { padding:24px; color:#bbb; font-size:13px; text-align:center; }

        /* Narrow windows and tablets. The bar fits on one line down to ~840px
           (font-dependent); below that it has to wrap, and the tidy break is the
           links onto a line of their own -- otherwise the spacer fills line 1 and
           Close is orphaned at the left of line 2. Only .vt-links needs an explicit
           order: everything else defaults to 0, so ordering it 1 alone moves it
           past Close. Breakpoint set conservatively above the measured threshold,
           which shifts with the platform's font metrics. */
        @media (max-width: 880px) {
          .vt-bar .vt-links { order:1; flex:1 0 100%; }
          .vt-bar .vt-links a { margin-left:0; margin-right:18px; }
        }

        /* Phones (2026-09-01). The report shipped without a viewport meta, so a
           phone laid the whole page out at 980px and scaled it to ~0.40 -- the
           viewer bar's 60x26 Close button reached the screen as 24x10 physical px,
           too small to see, let alone hit. The meta tag above fixes the scale;
           these rules give the bar somewhere to go at a real phone width. It wraps
           into three lines -- page title, the zoom cluster with Close pushed right,
           then the original-image links -- and the controls grow to a tappable
           size. */
        @media (max-width: 760px) {
          body { padding: 12px; }
          h2 { font-size: 20px; }
          .wrapper { flex-direction: column; }
          .col + .col { border-left: 0; }
          .col-fail { order: -1; }
          .col-skip { order: 1; }
          .col-pass, .col-skip { border-top: 1px solid #d1d5da; }
          .colhead { padding: 10px 12px; }
          .cell { padding: 12px; }
          .vt-bar { gap:6px 8px; padding:8px 10px; }
          .vt-bar .vt-title { flex:1 0 100%; max-width:100%; white-space:normal; overflow-wrap:anywhere;
                              display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
          .vt-bar .vt-links a { display:inline-block; padding:3px 0; font-size:13px; }
          .vt-bar .vt-links .vt-lx { display:none; }   /* "original: baseline" -> "baseline" */
          .vt-b { min-height:42px; padding:8px 16px; font-size:14px; }
          .vt-grp .vt-b[data-z="out"], .vt-grp .vt-b[data-z="in"] { font-size:19px; padding:2px 18px; }
          .vt-pct { min-width:58px; font-size:14px; }
          .vt-pane { padding:0 8px 8px; }
          .vt-labels span, .vt-msg { font-size:13px; }
        }
      </style>
    </head>
    <body>
      <h2>📸 Visual Testing Report: ${deviceType.toUpperCase()}</h2>
      <p><strong>Date:</strong> ${date.toLocaleString()}</p>
      
      <div class="wrapper">
  `;

  // 4. Add the three status columns
  //
  // These used to be the three cells of one table row, padded out to maxRows with
  // empty <td>s. That paired unrelated pages purely by index, and on a phone it
  // left each column a third of the screen: with the viewport meta in place the
  // FAIL reason wrapped at ~16 characters and the mobile report ran 19,000px.
  // Independent columns give the phone the full width, and FAIL is ordered first
  // there since that is the only column you act on.
  const column = (cls, label, colour, entries) => `
        <section class="col col-${cls}">
          <h3 class="colhead" style="color:${colour}; border-bottom-color:${colour};">${label} (${entries.length})</h3>
          ${entries.map(e => `<div class="cell">${e}</div>`).join('')}
        </section>`;

  html += column('pass', '✅ PASS', '#28a745', passUrls)
        + column('fail', '❌ FAIL', '#cb2431', failUrls)
        + column('skip', '⌛ SKIP', '#6a737d', skippedUrls);

  // 5. Close Tags
  html += `
      </div>
  `;
  
  if (newUrls.length > 0) {
      html += `<h3>🆕 New Baselines Created</h3><ul>` + newUrls.map(u => `<li>${u}</li>`).join('') + `</ul>`;
  }
  
  html += `</body></html>`;
  
  const base64Data = Buffer.from(html);
  
  // 6. Return Data for Next Nodes
  outputReports.push({
    json: {
      fileName: reportFilename,
      filePath: reportFilePath,
      fileContent: html,
      publicUrl: reportPublicUrl,
      // Stats for Slack
      passedCount: passUrls.length,
      failedCount: failUrls.length,
      skippedCount: skippedUrls.length,
      total: groupResults.length,
      device: deviceType // Useful for Slack Message Title
    },
    binary: {
      data: {
        data: base64Data,
        mimeType: 'text/html',
        fileName: reportFilename,
        fileExtension: 'html'
      }
    }
  });
}

return outputReports;