
const fs = require('fs');
const sharp = require('sharp');

let pixelmatch = require('pixelmatch');
if (pixelmatch.default) {
    pixelmatch = pixelmatch.default;
}

const slug = $('Loop Over Items').item.json.slug;
const baselinePath = `/files/baseline_screenshots/baseline_${slug}.png`;
const newPath = `/files/new_screenshots/new_${slug}.png`;

// ---------------------------------------------------------------------------
// v2 (2026-07-29): validate PNG magic bytes BEFORE any sharp call. Two reasons:
//   1. A failed capture writes its JSON error payload ({"capture_error":true,
//      "reason":"viewport width ..."}) into new_<slug>.png — the width-guard
//      contract had no consumer, so the JSON reached sharp (12:31Z run,
//      the site root).
//   2. On n8n 2.30.6 a sharp NATIVE decode error is FATAL to the task runner:
//      the runner freezes Error.prototype and sharp's error wrapper
//      (is.js nativeError: `context.message = ...`) throws an uncatchable
//      TypeError inside the native callback — this try/catch never sees it and
//      the whole runner process dies. Never hand sharp a non-PNG.
// A captureError result routes the page to a visible SKIP with the real reason
// (AI Vision Check short-circuits on it) instead of a runner crash.
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sniffPng = (path) => {
    try {
        const fd = fs.openSync(path, 'r');
        const head = Buffer.alloc(200);
        const n = fs.readSync(fd, head, 0, 200, 0);
        fs.closeSync(fd);
        if (n >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return null;
        const text = head.subarray(0, n).toString('utf8');
        if (text.trimStart().startsWith('{')) {
            try {
                const j = JSON.parse(fs.readFileSync(path, 'utf8'));
                return j.reason || j.message || `capture error payload: ${text.slice(0, 120)}`;
            } catch (e) { /* partial JSON */ }
        }
        return `not a valid PNG (${n < 8 ? n + ' bytes' : 'bad signature'})`;
    } catch (e) {
        return `unreadable file: ${e.message}`;
    }
};

const newProblem = sniffPng(newPath);
if (newProblem) {
    console.error(`Pixel Diff Check: new screenshot invalid for ${slug}: ${newProblem}`);
    return { json: { pixelMatch: false, captureError: `new screenshot: ${newProblem}`, slug: slug } };
}
const baseProblem = sniffPng(baselinePath);
if (baseProblem) {
    console.error(`Pixel Diff Check: baseline invalid for ${slug}: ${baseProblem}`);
    return { json: { pixelMatch: false, captureError: `baseline screenshot: ${baseProblem}`, slug: slug } };
}

try {
    console.log(`Processing ${slug}...`);

    // Decode both PNGs to raw RGBA via sharp and compare at FULL resolution.
    // No size bail: sharp's decode is memory-efficient enough for these tall pages
    // (~720 MB peak on the largest ~80 MP page, well within the 4 GB heap), and
    // downscaling would blur away small changes. Reading via sharp is pixel-identical
    // to the old pngjs path. ensureAlpha() forces 4 channels so the buffers line up.
    const img1 = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const img2 = await sharp(newPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const width = img1.info.width;
    const height = img1.info.height;

    if (img1.info.width !== img2.info.width || img1.info.height !== img2.info.height) {
        return { json: { pixelMatch: false, reason: "Dimensions mismatch" } };
    }

    const numDiffPixels = pixelmatch(img1.data, img2.data, null, width, height, { threshold: 0.1 });
    const totalPixels = width * height;
    const diffPercentage = (numDiffPixels / totalPixels) * 100;
    const match = diffPercentage < 0.1;

    return {
         json: {
              pixelMatch: match,
              mismatchedPixels: numDiffPixels,
              diffPercentage: parseFloat(diffPercentage.toFixed(3)),
              slug: slug
         }
    };
} catch (error) {
    console.error(`Error in Pixel Diff Check for ${slug}:`, error.message);
    return { json: { pixelMatch: false, error: error.message } };
}
