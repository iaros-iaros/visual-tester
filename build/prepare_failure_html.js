const fs = require('fs');
const sharp = require('sharp');
let pixelmatch = require('pixelmatch');
if (pixelmatch.default) pixelmatch = pixelmatch.default;

const inputData = $input.first().json;
const slug = $('Loop Over Items').item.json.slug;
const MAX_WIDTH = 1280;
const newPath = `/files/new_screenshots/new_${slug}.png`;
const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;
const reason = inputData.reason || "Unknown failure";

// Read the new screenshot ONCE from disk (keep this original buffer for the diff;
// the display buffer is downscaled separately so we never double-resample).
let origBuffer = null;
try { origBuffer = fs.readFileSync(newPath); } catch (e) { console.error(`PF: cannot read ${newPath}: ${e.message}`); }

// Build the DISPLAY copy: downscale by pixel-area budget (+ width cap) so the
// evidence JPEG stays small. Box overlay is %-based so placement is unaffected.
let displayBuffer = origBuffer;
let dispW = 0, dispH = 0;
if (origBuffer) {
  try {
    const meta = await sharp(origBuffer).metadata();
    const MAX_PIXELS = 3000000;
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (meta.width * meta.height)));
    const displayWidth = Math.min(MAX_WIDTH, Math.max(1, Math.round(meta.width * scale)));
    if (displayWidth < meta.width) {
      displayBuffer = await sharp(origBuffer).resize(displayWidth, null, { withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    }
    const dm = await sharp(displayBuffer).metadata();
    dispW = dm.width; dispH = dm.height;
  } catch (e) { console.error(`PF: display resize failed: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Derive the highlight BOX(ES) from the actual pixel diff. The old row/col
// projection unioned every changed area into one loose rectangle (measured ~42x
// too big on mobile, up to whole-page on desktop) and bailed to Gemini's
// unreliable 0-1000 box whenever baseline/new heights differed (16% of mobile
// pages). This derives tight per-cluster boxes via connected components and,
// for a height mismatch with an unchanged layout width, diffs the shared top
// overlap instead of giving up. Output: `boxes` = array of normalized 0-1000
// {top,left,width,height}. Gemini's box is kept ONLY as the final fallback.
// v3 (2026-07-28): clusterBoxesV2 additionally returns `allComps` — EVERY blob
// (any mass) normalized like the drawn boxes — so the emphasis step below can
// snap the model box onto the real blob it points at even when the mass gates
// dropped that blob from drawing (small-but-real defect, e.g. the header-logo
// soccer-ball incident: logo blob 6.1% < KEEP_SHARE while two rotating cards
// held 42% each).
// ---------------------------------------------------------------------------
const modelBox = inputData.box || { top: 0, left: 0, width: 0, height: 0 };
// v4 (2026-07-29): the AI's chosen pixel-diff REGION is the authoritative defect
// location. Raw model box coordinates proved unreliable (correct "logo missing"
// reason arrived with a box over mid-page blobs -> 3 irrelevant red boxes); the
// region number is the model picking from OUR enumerated diff clusters instead.
const rrIn = inputData.defectRegionRect;
const regionRect = (rrIn && typeof rrIn === 'object' && rrIn.width > 0 && rrIn.height > 0)
  ? { top: rrIn.top, left: rrIn.left, width: rrIn.width, height: rrIn.height } : null;
// 2026-08-01: region flagged as a row-alignment INSERTION SEAM — its rect IS
// the mechanically-located inserted rows; blob-intersection ranking would
// re-select the big displaced-content blobs around it (the incident class).
const regionInsert = regionRect !== null && inputData.defectRegionInsert === true;
let boxes = (modelBox.width > 0 && modelBox.height > 0) ? [modelBox] : [];
let boxSource = "model";
let allComps = []; // every diff blob (normalized 0-1000 + share), for model-box snapping
let natH = 0;      // native height of the NEW screenshot (tolerance basis below)

const DIFF_WIDTH = 600;
const CELL = 8;           // coarse grid cell (diff px) for clustering
const HOT_MIN = 2;        // red px in a cell for it to count as "hot"
const DILATE = 1;         // cell dilation to fuse intra-item anti-alias fragments
const DOM_SHARE = 0.40;   // top blob's share of total diff to count as one dominant change
const DOM_RATIO = 3.0;    // ...or top >= 3x the 2nd blob
const KEEP_SHARE = 0.10;  // additional blobs boxed tight if >= this share of diff
const KTIGHT = 4;         // never draw more than this many tight boxes
const SUBST_SHARE = 0.05; // a blob counts toward the enclosing box if >= this share
const BIG_H = 0.50;       // a box taller than this frac of page is relabeled "reshuffled"
const PAD = 0.012;        // box padding (frac of axis)

// Concentration-gated granular boxing. The old row/col projection unioned everything,
// and the later cumulative-mass + PERVASIVE-GUARD rewrite drew ONE box over the whole
// grid whenever the change was one card among scattered grid noise (nondeterministic
// poster loads / anti-alias never concentrate to 90% in <=5 clusters). Instead:
//   1. connected-component blobs of the red diff (mass + tight red-pixel bbox each);
//   2. if there is one DOMINANT blob (>=DOM_SHARE of the diff, or >=DOM_RATIO x the 2nd)
//      -> box it (and any other >=KEEP_SHARE blob) TIGHT, ignoring the scattered tail =>
//      the box pins to the one changed card;
//   3. otherwise (mass genuinely spread across many blobs = rotation/reflow) -> ONE honest
//      enclosing box over the SIGNIFICANT blobs only (tail dropped so page-edge noise can't
//      inflate it), labelled 'pixeldiff-rotation'.
// NEVER-MISS: any drawn box CONTAINS its change; a very tall dominant blob (large change, or
// a reflow cascade we can't tell apart pixel-only) is still boxed, just relabelled. The
// already-computed Gemini modelBox is a SUBORDINATE tiebreaker only (near-tie: prefer the
// blob overlapping the model region); it can never drop mass or reorder beyond that. Model-
// box ANCHORING (drawing the blob the model located when mass gates skipped it) happens in
// the emphasis step below, and only ever onto real diff blobs from allComps.
// normH = height to normalize VERTICAL coords against: the diff is over the top-overlap
// region (H rows) but the evidence image is the NEW screenshot, so rows are a fraction of
// the NEW image's diff height (normH), not the overlap height (no-op when normH === H).
function clusterBoxesV2(red, W, H, total, normH, modelBox) {
  if (!normH) normH = H;
  const empty = { boxes: [], source: 'none', dominantShare: 0, coverage: 0, compCount: 0, keptCount: 0, allComps: [] };
  if (total === 0) return empty;
  const GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
  const cellDiff = new Int32Array(GW * GH);
  for (let y = 0; y < H; y++) { const gy = (y / CELL) | 0; for (let x = 0; x < W; x++) if (red[y * W + x]) cellDiff[gy * GW + ((x / CELL) | 0)]++; }
  const hot = new Uint8Array(GW * GH);
  for (let i = 0; i < cellDiff.length; i++) hot[i] = cellDiff[i] >= HOT_MIN ? 1 : 0;
  // connectivity map: dilate hot cells by DILATE so intra-item fragments fuse
  let conn;
  if (DILATE > 0) {
    conn = new Uint8Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      if (!hot[gy * GW + gx]) continue;
      for (let dy = -DILATE; dy <= DILATE; dy++) for (let dx = -DILATE; dx <= DILATE; dx++) {
        const ny = gy + dy, nx = gx + dx;
        if (nx >= 0 && ny >= 0 && nx < GW && ny < GH) conn[ny * GW + nx] = 1;
      }
    }
  } else { conn = hot; }
  const label = new Int32Array(GW * GH);
  const comps = [], stack = [];
  let lab = 0;
  for (let c = 0; c < GW * GH; c++) {
    if (!conn[c] || label[c]) continue;
    lab++; label[c] = lab; stack.length = 0; stack.push(c);
    let dsum = 0, minx = GW, maxx = 0, miny = GH, maxy = 0;
    while (stack.length) {
      const cur = stack.pop(), cx = cur % GW, cy = (cur / GW) | 0;
      if (hot[cur]) { dsum += cellDiff[cur]; if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nc = ny * GW + nx; if (conn[nc] && !label[nc]) { label[nc] = lab; stack.push(nc); }
      }
    }
    if (dsum > 0) comps.push({ dsum, cminx: minx, cmaxx: maxx, cminy: miny, cmaxy: maxy });
  }
  if (!comps.length) return empty;
  // refine each blob to its tight RED-PIXEL extent within its cell bbox
  for (const c of comps) {
    const x0 = c.cminx * CELL, x1 = Math.min(W - 1, (c.cmaxx + 1) * CELL - 1), y0 = c.cminy * CELL, y1 = Math.min(H - 1, (c.cmaxy + 1) * CELL - 1);
    let rminx = W, rmaxx = 0, rminy = H, rmaxy = 0, found = false;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (red[y * W + x]) { found = true; if (x < rminx) rminx = x; if (x > rmaxx) rmaxx = x; if (y < rminy) rminy = y; if (y > rmaxy) rmaxy = y; }
    if (found) { c.top = rminy; c.bottom = rmaxy; c.left = rminx; c.right = rmaxx; } else { c.top = y0; c.bottom = y1; c.left = x0; c.right = x1; }
  }
  comps.sort((a, b) => b.dsum - a.dsum);
  // subordinate AI tiebreak: near-tie top two -> prefer the one overlapping the model region
  if (modelBox && modelBox.width > 0 && modelBox.height > 0 && comps.length >= 2) {
    if (comps[1].dsum >= 0.7 * comps[0].dsum) {
      const mTop = modelBox.top / 1000 * normH, mBot = (modelBox.top + modelBox.height) / 1000 * normH;
      const ov = c => Math.max(0, Math.min(c.bottom, mBot) - Math.max(c.top, mTop));
      if (ov(comps[1]) > ov(comps[0])) { const t = comps[0]; comps[0] = comps[1]; comps[1] = t; }
    }
  }
  const topc = comps[0];
  const topShare = topc.dsum / total;
  const second = comps[1] ? comps[1].dsum : 0;
  const dominant = (topShare >= DOM_SHARE) || (topc.dsum >= DOM_RATIO * second);
  let rects, source, kept;
  if (dominant) {
    kept = [topc];
    for (let i = 1; i < comps.length && kept.length < KTIGHT; i++) if (comps[i].dsum / total >= KEEP_SHARE) kept.push(comps[i]);
    rects = kept.map(c => ({ top: c.top, bottom: c.bottom, left: c.left, right: c.right }));
    source = 'pixeldiff';
  } else {
    let enc = comps.filter(c => c.dsum / total >= SUBST_SHARE);
    if (!enc.length) enc = comps.slice(0, Math.min(comps.length, 3));
    let t = H, b = 0, l = W, r = 0;
    for (const c of enc) { if (c.top < t) t = c.top; if (c.bottom > b) b = c.bottom; if (c.left < l) l = c.left; if (c.right > r) r = c.right; }
    rects = [{ top: t, bottom: b, left: l, right: r }];
    source = 'pixeldiff-rotation'; kept = enc;
  }
  const coverage = kept.reduce((s, c) => s + c.dsum, 0) / total;
  const pY = Math.round(H * PAD), pX = Math.round(W * PAD);
  const normRect = (b) => {
    const top = Math.max(0, b.top - pY), bottom = Math.min(H - 1, b.bottom + pY);
    const left = Math.max(0, b.left - pX), right = Math.min(W - 1, b.right + pX);
    return { top: (top / normH) * 1000, left: (left / W) * 1000, width: ((right - left + 1) / W) * 1000, height: ((bottom - top + 1) / normH) * 1000 };
  };
  const boxes = rects.map(normRect);
  const allComps = comps.map(c => ({ ...normRect(c), share: c.dsum / total }));
  // cosmetic relabel: a very tall box is honestly a "large area / reshuffled" case
  if (source === 'pixeldiff' && boxes.some(b => b.height / 1000 > BIG_H)) source = 'pixeldiff-rotation';
  return { boxes, source, dominantShare: topShare, coverage, compCount: comps.length, keptCount: rects.length, allComps };
}

try {
  if (origBuffer) {
    const rOpt = { withoutEnlargement: true };
    const [bMeta, nMeta] = await Promise.all([sharp(baselinePath).metadata(), sharp(origBuffer).metadata()]);
    natH = nMeta.height;
    const baseRaw = await sharp(baselinePath).resize(DIFF_WIDTH, null, rOpt).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const newRaw = await sharp(origBuffer).resize(DIFF_WIDTH, null, rOpt).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = baseRaw.info.width; // both == DIFF_WIDTH after resize
    let bData = baseRaw.data, nData = newRaw.data, H = baseRaw.info.height;

    // Height mismatch: trust a shared TOP-overlap crop ONLY when the native
    // layout width is unchanged (same page, just taller/shorter). A different
    // native width means a real re-layout -> overlap won't align -> keep model box.
    let usable = true;
    if (baseRaw.info.height !== newRaw.info.height) {
      if (bMeta.width === nMeta.width) {
        H = Math.min(baseRaw.info.height, newRaw.info.height);
        bData = baseRaw.data.subarray(0, W * H * 4);
        nData = newRaw.data.subarray(0, W * H * 4);
      } else {
        usable = false;
      }
    }

    if (usable) {
      const diff = Buffer.alloc(W * H * 4);
      pixelmatch(bData, nData, diff, W, H, { threshold: 0.1 });
      const red = new Uint8Array(W * H);
      let total = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (diff[i] > 150 && diff[i + 1] < 100 && diff[i + 2] < 100) { red[y * W + x] = 1; total++; }
      }
      const res = clusterBoxesV2(red, W, H, total, newRaw.info.height, modelBox);
      if (res.boxes.length) { boxes = res.boxes; boxSource = res.source; }
      allComps = res.allComps || [];
    }
  }
} catch (e) { console.error(`PF: diff-box failed for ${slug}; using model box: ${e.message}`); }
console.log(`Highlight box source for ${slug}: ${boxSource} (${boxes.length} box${boxes.length === 1 ? '' : 'es'})`);

// Composite the highlight box(es) onto the display image via sharp. Solid red =
// the reported defect, dashed amber = changed but judged noise. Non-throwing:
// on any error we still emit the plain display image so the loop stays safe.
// v4 contract (2026-07-29): red goes ONLY where pixel diff found changes AND the
// AI attributed the defect — i.e. the blob(s) inside the AI's chosen numbered
// region. Every other changed area is noise (dashed amber). Fallback chain when
// no region was chosen: model box snap (v3 behavior) -> all-red (vetoed verdict
// with no location at all — clusters ARE the finding, never-miss preserved).
let anchors = []; // the defect box(es), always drawn solid red
let outBuffer = displayBuffer;
try {
  if (regionRect && boxSource === 'model') boxes = []; // diff-less model box has no place in region mode
  if (displayBuffer && dispW > 0 && dispH > 0 && (boxes.length || regionRect)) {
    const TOLX = 30; // 0-1000 scale
    // Vertical tolerance capped at ~120px-equivalent, matching the AI Vision
    // Check geometry guard: a flat 30 was +-300 PIXELS on a 10,000px-tall page
    // — zero discriminating power for red-vs-amber assignment.
    const TOLY = natH > 0 ? Math.min(30, Math.max(6, (120 / natH) * 1000)) : 30;
    const mb = (modelBox && modelBox.width > 0 && modelBox.height > 0) ? modelBox : null;
    const overlapsModel = (b) => mb
      && b.top < mb.top + mb.height + TOLY && b.top + b.height > mb.top - TOLY
      && b.left < mb.left + mb.width + TOLX && b.left + b.width > mb.left - TOLX;
    let primary;
    if (regionRect) {
      if (regionInsert) {
        // Insertion seam: draw the seam rect itself, solid red, exactly once.
        anchors = [regionRect];
        boxSource += '+insert-band';
      } else {
      // Pin red to the diff blob(s) genuinely inside the chosen region: rank by
      // intersection area with the region rect (the rect comes from the same
      // cluster algorithm, so its twin blob overlaps ~fully; padded neighbors
      // only graze) and drop grazers below 20% of the best overlap.
      const interArea = (a, b) => Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))
        * Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
      const hits = allComps.map(c => ({ c, ia: interArea(c, regionRect) })).filter(x => x.ia > 0).sort((a, b) => b.ia - a.ia);
      anchors = hits.length ? hits.filter(x => x.ia >= hits[0].ia * 0.2).slice(0, 3).map(x => x.c) : [regionRect];
      boxSource += '+region-anchor';
      }
      // a mass box that IS one of the red blobs would double-draw — drop it
      const dup = (b) => anchors.some(a => Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2
        && Math.abs(a.top + a.height - b.top - b.height) < 2 && Math.abs(a.left + a.width - b.left - b.width) < 2);
      boxes = boxes.filter(b => !dup(b));
      primary = boxes.map(() => false); // every remaining changed area is noise
    } else if (!mb) {
      // no location signal at all (vetoed verdict / degenerate box): the
      // clusters ARE the reported finding — every box solid red (never-miss).
      primary = boxes.map(() => true);
    } else {
      primary = boxes.map(b => overlapsModel(b));
      if (!primary.some(Boolean)) {
        const hits = allComps.filter(c => overlapsModel(c)).sort((a, b) => b.share - a.share).slice(0, 3);
        if (hits.length) { anchors = hits; boxSource += '+model-anchor'; }
        else { anchors = [mb]; boxSource += '+model-box'; } // unguarded path: draw the claim itself
      }
    }
    console.log(`Highlight emphasis for ${slug}: ${primary.filter(Boolean).length + anchors.length} defect box(es) (${anchors.length} anchored, ${regionRect ? 'region' : 'box'} mode), ${primary.filter(p => !p).length} noise box(es)`);
    const toRect = (box, solid) => {
      const L = Math.max(0, Math.round((box.left / 1000) * dispW));
      const T = Math.max(0, Math.round((box.top / 1000) * dispH));
      const Wd = Math.max(1, Math.round((box.width / 1000) * dispW));
      const Hd = Math.max(1, Math.round((box.height / 1000) * dispH));
      return solid
        ? `<rect x="${L}" y="${T}" width="${Wd}" height="${Hd}" fill="rgba(240,65,65,0.3)" stroke="rgba(255,20,20,0.85)" stroke-width="3"/>`
        : `<rect x="${L}" y="${T}" width="${Wd}" height="${Hd}" fill="rgba(255,170,30,0.12)" stroke="rgba(255,170,30,0.9)" stroke-width="3" stroke-dasharray="14,10"/>`;
    };
    const rects = boxes.map((box, i) => toRect(box, primary[i])).join('') + anchors.map(a => toRect(a, true)).join('');
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}">${rects}</svg>`);
    outBuffer = await sharp(displayBuffer).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 90 }).toBuffer();
  } else if (displayBuffer) {
    outBuffer = await sharp(displayBuffer).jpeg({ quality: 90 }).toBuffer();
  }
} catch (e) {
  console.error(`PF: composite failed for ${slug}; emitting plain image: ${e.message}`);
  try { outBuffer = await sharp(displayBuffer).jpeg({ quality: 90 }).toBuffer(); } catch (e2) { outBuffer = displayBuffer; }
}

// Guarantee a non-null buffer so this node ALWAYS emits binary.data — otherwise a
// missing new-screenshot would make prepareBinaryData throw and (since Save Failed
// needs the binary) wedge the sequential loop. Fall back to a neutral placeholder.
if (!outBuffer) {
  try {
    outBuffer = await sharp({ create: { width: 400, height: 120, channels: 3, background: { r: 34, g: 34, b: 34 } } }).jpeg().toBuffer();
  } catch (e) { outBuffer = Buffer.alloc(0); }
}

// ---------------------------------------------------------------------------
// Immutable failure evidence (2026-07-29). The report's Baseline image used to
// link the LIVE baseline file, which "Accept New Version" overwrites — an old
// report then displays a baseline the run never compared against (and browser
// caches serve stale copies: these PNGs ship no Cache-Control). Freeze the
// compared pair per run: write a downscaled copy of the baseline AS COMPARED
// next to the highlighted screenshot, and let Save Failed stamp the
// highlighted file with the same suffix. Both land in failed_screenshots/,
// which the existing 3-day wildcard cleanup cron already wipes.
// ---------------------------------------------------------------------------
const evidenceStamp = new Date().toISOString().replace(/[:.]/g, '-');
let baselineSnapFile = null;
try {
  const bMetaSnap = await sharp(baselinePath).metadata();
  const snapScale = Math.min(1, Math.sqrt(3000000 / (bMetaSnap.width * bMetaSnap.height)));
  const snapW = Math.min(MAX_WIDTH, Math.max(1, Math.round(bMetaSnap.width * snapScale)));
  const snapBuf = await sharp(baselinePath).resize(snapW, null, { withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  baselineSnapFile = `baseline-at-fail_${slug}_${evidenceStamp}.jpg`;
  fs.writeFileSync(`/files/failed_screenshots/${baselineSnapFile}`, snapBuf);
} catch (e) { console.warn(`PF: baseline snapshot failed for ${slug}: ${e.message}`); baselineSnapFile = null; }

const data = await this.helpers.prepareBinaryData(outBuffer, `highlighted_${slug}.jpg`, 'image/jpeg');
return [{
  json: { reason, url: inputData.url, slug: inputData.slug, status: inputData.status, device: inputData.device, boxSource, boxCount: boxes.length + anchors.length, anchorCount: anchors.length, defectRegion: inputData.defectRegion ?? null, defectRegionInsert: inputData.defectRegionInsert === true, modelVersion: inputData.modelVersion ?? null, aiProvider: inputData.aiProvider ?? null, reasonSource: inputData.reasonSource ?? null, thought_process: inputData.thought_process ?? null, verification_trail: inputData.verification_trail ?? null, evidenceStamp, baselineSnapFile },
  binary: { data }
}];
