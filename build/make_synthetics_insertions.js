// Builds INSERTION truth-set pairs: rows spliced into a real PNG to create a
// known-truth shift, so a judging change can be tested against a defect whose
// answer is known. Writes results under /tmp/vt/synth/.
//
// Usage (inside container, NODE_PATH=/usr/local/lib/node_modules):
//   node make_synthetics_insertions.js <sourcePng>
// Emits:
//   synth_insert_new.png   — rows [A, A+h) duplicated (lookalike-row insertion at a footer link row)
//   synth_delete_new.png   — rows [A, A+h) removed
//   synth_grid_new.png     — 350 rows duplicated mid-grid (repeated-module stress)
// plus synth_manifest.json with the exact splice coordinates.
const fs = require('fs');
const sharp = require('sharp');

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node make_synthetics_insertions.js <sourcePng>'); process.exit(2); }
const OUT = '/tmp/vt/synth';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const meta = await sharp(SRC).metadata();
  const { width, height } = meta;
  const raw = await sharp(SRC).ensureAlpha().raw().toBuffer();
  const rowBytes = width * 4;

  const splice = async (insertAt, srcFrom, srcH, remove, outName) => {
    let parts;
    if (remove) {
      parts = [raw.subarray(0, srcFrom * rowBytes), raw.subarray((srcFrom + srcH) * rowBytes)];
    } else {
      parts = [raw.subarray(0, insertAt * rowBytes), raw.subarray(srcFrom * rowBytes, (srcFrom + srcH) * rowBytes), raw.subarray(insertAt * rowBytes)];
    }
    const buf = Buffer.concat(parts);
    const h = remove ? height - srcH : height + srcH;
    await sharp(buf, { raw: { width, height: h, channels: 4 } }).png({ compressionLevel: 6 }).toFile(`${OUT}/${outName}`);
    return { outName, width, height: h };
  };

  // Footer link-row coordinates for the reference source capture (1179x12894):
  // the brand-column footer link list spans ~y9500-10150; one link row ~42px.
  // Scale proportionally if a different source is supplied.
  const s = height / 12894;
  const LINK_ROW = Math.round(10060 * s), LINK_H = Math.round(46 * s);
  const GRID_ROW = Math.round(5000 * s), GRID_H = Math.round(350 * s);

  const manifest = { src: SRC, dims: { width, height }, cases: {} };
  manifest.cases.insert = Object.assign(
    { spliceAt: LINK_ROW + LINK_H, srcFrom: LINK_ROW, srcH: LINK_H,
      expect: `one INSERT band within y ${LINK_ROW - 60}-${LINK_ROW + 2 * LINK_H + 60} (lookalike row; either copy acceptable), h<=~${LINK_H + 10}` },
    await splice(LINK_ROW + LINK_H, LINK_ROW, LINK_H, false, 'synth_insert_new.png'));
  manifest.cases.delete = Object.assign(
    { srcFrom: LINK_ROW, srcH: LINK_H, expect: 'NO insert bands; >=1 delete gap' },
    await splice(0, LINK_ROW, LINK_H, true, 'synth_delete_new.png'));
  manifest.cases.grid = Object.assign(
    { spliceAt: GRID_ROW + GRID_H, srcFrom: GRID_ROW, srcH: GRID_H,
      expect: `either an INSERT band inside y ${GRID_ROW - 100}-${GRID_ROW + 2 * GRID_H + 100} or no band at all; NEVER a band outside that window` },
    await splice(GRID_ROW + GRID_H, GRID_ROW, GRID_H, false, 'synth_grid_new.png'));

  fs.writeFileSync(`${OUT}/synth_manifest.json`, JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify(manifest, null, 1));
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
