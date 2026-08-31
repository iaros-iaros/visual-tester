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
      var PAD = 24;      // .vt-pane horizontal padding
      var MAXFIT = 2;    // never auto-upscale past 2x on open

      function build() {
        ov = document.createElement('div');
        ov.className = 'vt-ov';
        ov.innerHTML =
          '<div class="vt-bar">' +
            '<span class="vt-title"></span>' +
            '<button type="button" class="vt-b" data-z="out" title="Zoom out">&minus;</button>' +
            '<span class="vt-pct"></span>' +
            '<button type="button" class="vt-b" data-z="in" title="Zoom in">+</button>' +
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

      function fitZoom() { return Math.max(0.02, (pane.clientWidth - PAD) / base); }

      function apply() {
        if (!base) return;
        var w = Math.max(40, Math.round(base * zoom));
        stack.style.width = w + 'px';
        stack.style.margin = w <= pane.clientWidth - PAD ? '0 auto' : '0';
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
          a.textContent = 'original: ' + names[i].split(' ')[0].toLowerCase() + ' \u2197';
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
  const maxRows = Math.max(passUrls.length, failUrls.length, newUrls.length, skippedUrls.length);
  
  let html = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8"><title>${deviceType.toUpperCase()} Report</title>
      ${scriptBlock}
      ${viewerBlock}
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; padding: 20px; margin: 0; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; background: white; }
        th { border: 1px solid #e1e4e8; padding: 12px; background: #f6f8fa; text-align: left; }
        td { border: 1px solid #e1e4e8; padding: 15px; background: #fff; vertical-align: top; }
        .wrapper { border: 1px solid #d1d5da; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        h2 { margin-top: 0; color: #24292e; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        button[data-accept-slug]:hover { background-color: #1b5e20 !important; }

        /* on-demand screenshot viewer */
        .vt-open { background:#0366d6; color:#fff; border:none; border-radius:4px; padding:8px 14px; font-family:inherit; font-size:14px; font-weight:bold; cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,0.18); transition:background 0.2s; }
        .vt-open:hover { background:#024ea2; }
        .vt-open:active { box-shadow:none; transform:translateY(1px); }
        .vt-open-fail { background:#cb2431; }
        .vt-open-fail:hover { background:#a11b26; }
        .vt-ov { display:none; position:fixed; top:0; right:0; bottom:0; left:0; z-index:9999; background:rgba(15,17,20,0.93); flex-direction:column; }
        .vt-bar { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#1c2026; color:#e6e6e6; font-size:12px; flex:0 0 auto; }
        .vt-bar .vt-title { font-weight:600; max-width:34%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .vt-bar .vt-sp { flex:1 1 auto; }
        .vt-bar .vt-links a { color:#79b8ff; margin-left:12px; }
        .vt-b { background:#2b323b; color:#e6e6e6; border:1px solid #3d454f; border-radius:4px; padding:4px 9px; font:inherit; font-size:12px; cursor:pointer; }
        .vt-b:hover { background:#39424d; }
        .vt-pct { min-width:46px; text-align:center; color:#9aa4b0; }
        .vt-pane { flex:1 1 auto; overflow:auto; padding:0 12px 12px; }
        .vt-labels { display:flex; position:sticky; top:0; z-index:1; }
        .vt-labels span { flex:1 1 0; min-width:0; padding:5px 8px; background:#2b323b; color:#e6e6e6; font-size:12px; font-weight:600; text-align:center; }
        .vt-labels span + span { border-left:3px solid #cb2431; }
        .vt-row { display:flex; align-items:flex-start; }
        .vt-row img { flex:1 1 0; min-width:0; height:auto; display:block; background:#fff; }
        .vt-row img + img { border-left:3px solid #cb2431; }
        .vt-msg { padding:24px; color:#bbb; font-size:13px; text-align:center; }
      </style>
    </head>
    <body>
      <h2>📸 Visual Testing Report: ${deviceType.toUpperCase()}</h2>
      <p><strong>Date:</strong> ${date.toLocaleString()}</p>
      
      <div class="wrapper">
        <table cellpadding="0" cellspacing="0">
          <thead>
              <tr>
              <th style="width: 33%; color: #28a745; border-bottom: 2px solid #28a745;">✅ PASS (${passUrls.length})</th>
              <th style="width: 33%; color: #cb2431; border-bottom: 2px solid #cb2431;">❌ FAIL (${failUrls.length})</th>
              <th style="width: 33%; color: #6a737d; border-bottom: 2px solid #6a737d;">⌛ SKIP (${skippedUrls.length})</th>
              </tr>
          </thead>
          <tbody>
  `;
  
  // 4. Add Rows
  for (let i = 0; i < maxRows; i++) {
    const passCell = passUrls[i] || "";
    const failCell = failUrls[i] || "";
    const skipCell = skippedUrls[i] || "";
    
    html += `
      <tr>
          <td>${passCell}</td>
          <td style="background-color: ${failCell ? '#fff5f5' : '#fff'};">${failCell}</td>
          <td>${skipCell}</td>
      </tr>`;
  }
  
  // 5. Close Tags
  html += `
          </tbody>
        </table>
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