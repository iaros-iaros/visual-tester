const isPixelsMatched = $('Pixel Diff Check').item.json.pixelMatch;

// Set safe defaults
let finalStatus = "SKIP";
let aiReason = "AI Check Skipped";
let aiBox = { top: 0, left: 0, width: 0, height: 0 };
let modelVersion = null;
let aiProvider = null;
let reasonSource = null;
let thoughtProcess = null;
let defectRegionRect = null;
let defectRegion = 0;
let defectRegionInsert = false;
let verificationTrail = null;

if (!isPixelsMatched) {
  const inputData = $input.first().json;

  if (inputData.error) {
    finalStatus = "SKIP";
    // Capture/decode failures ride the same error channel as model failures, so label
    // by kind (2026-08-11): prefixing every skip "AI API Error" advertised a dead
    // close-button selector as a Gemini problem for three runs of one
    // page. AI Vision Check tags the capture ones.
    const errLabel = inputData.error.kind === 'capture' ? "Capture Error" : "AI API Error";
    aiReason = `${errLabel}: ${inputData.error.message || "503 Overloaded"}`;
  } else if (inputData.ai) {
    // v2 shape: AI Vision Check returns the parsed verdict directly (plus
    // provenance fields) instead of the raw Gemini response envelope.
    const aiData = inputData.ai;
    modelVersion = inputData.modelVersion || null;
    aiProvider = inputData.aiProvider || null;
    reasonSource = inputData.reasonSource || null;
    thoughtProcess = aiData.thought_process ? String(aiData.thought_process).slice(0, 1500) : null;
    // 2400 (was 1200, 2026-08-05): the trail gained early mechanical-evidence
    // lines (tail identity, insertion bands) pushed BEFORE the verdict lines —
    // a head-anchored 1200 slice was dropping the diagnostic tail (probe/sweep
    // verdicts) exactly on busy pages. The report renders this collapsed.
    verificationTrail = inputData.verification_trail ? String(inputData.verification_trail).slice(0, 2400) : null;
    // v3: the model's chosen pixel-diff region (authoritative defect location
    // for the highlighter — model box coordinates are fallback-only).
    const rr = inputData.defectRegionRect;
    if (rr && typeof rr === 'object' && rr.width > 0 && rr.height > 0) {
      defectRegionRect = { top: rr.top, left: rr.left, width: rr.width, height: rr.height };
      defectRegion = inputData.defectRegion || 0;
      // v4 (2026-08-01): marks the region as a row-alignment INSERTION SEAM —
      // the highlighter draws the seam rect itself instead of blob-ranking.
      defectRegionInsert = inputData.defectRegionInsert === true;
    }

    // Robustly handle both Array [ymin, xmin, ymax, xmax] and Object formats
    let rawBox = aiData.box;
    let ymin, xmin, ymax, xmax;
    if (Array.isArray(rawBox) && rawBox.length === 4) {
      [ymin, xmin, ymax, xmax] = rawBox;
    } else if (rawBox && typeof rawBox === 'object') {
      ymin = rawBox.ymin;
      xmin = rawBox.xmin;
      ymax = rawBox.ymax;
      xmax = rawBox.xmax;
    }
    if (ymin !== undefined && xmin !== undefined) {
      aiBox = {
        top: ymin,
        left: xmin,
        width: Math.max(0, xmax - xmin),
        height: Math.max(0, ymax - ymin)
      };
    }

    aiReason = aiData.reason || "None";

    if (aiData.status === "FAIL" && !aiData.reason && !aiData.box) {
      finalStatus = "SKIP";
    } else if (aiData.status === "PASS" || aiData.status === "FAIL") {
      finalStatus = aiData.status;
    } else {
      finalStatus = "SKIP";
      aiReason = `Unrecognized AI status: ${String(aiData.status).slice(0, 40)}`;
    }
  } else {
    finalStatus = "SKIP";
    aiReason = "AI response missing (no ai/error field)";
  }
} else {
  finalStatus = "PASS";
  aiReason = "Exact Pixel Match";
}

// Output the Clean Result
return {
  json: {
    url: $('Loop Over Items').item.json.url,
    slug: $('Loop Over Items').item.json.slug,
    device: $('Loop Over Items').item.json.device,
    status: finalStatus,
    reason: aiReason,
    box: aiBox,
    defectRegion,
    defectRegionRect,
    defectRegionInsert,
    modelVersion,
    aiProvider,
    reasonSource,
    thought_process: thoughtProcess,
    verification_trail: verificationTrail
  }
};
