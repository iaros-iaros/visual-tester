<img width="2140" height="510" alt="desktop_workflow" src="https://github.com/user-attachments/assets/0fdcd17f-bed6-4234-b66d-8975d6489b16" />

# Visual Tester

A visual regression testing tool powered by n8n, Browserless, Gemini AI, and Caddy.
It screenshots every page of a target site on a schedule, pixel-diffs each capture
against a saved baseline, and escalates real differences to a vision LLM — whose
claims are then machine-verified before anything is reported to Slack.

## Prerequisites

- Docker
- Docker Compose

## Setup

1.  **Clone the repository.**
2.  **Create a `.env` file** based on the provided example:

    ```bash
    cp .env.example .env
    ```

    Fill in the required values (e.g. `POSTGRES_PASSWORD`, `AI_API_KEY`, `SLACK_WEBHOOK`,
    `TARGET_WEBSITE_URL`, `WEBHOOK_URL`, `UPDATE_BASELINE_TOKEN`, the `N8N_BASIC_AUTH_*`
    and `CADDY_EVIDENCE_*` credentials, and `UID`/`GID`). `OPENROUTER_API_KEY` is optional
    but strongly recommended: without it the Qwen fallback comparer and the existence-probe
    verification layer self-disable.

3.  **Build and start the services** (the n8n image is custom-built — see Architecture):

    ```bash
    docker compose up -d --build
    ```

4.  **Import the workflows** into n8n: `desktop_live.json`, `mobile_live.json`
    (the two device pipelines) and `updater_live.json` (the baseline updater),
    then activate them.

## Workflows

### 1. Desktop & 2. Mobile

Two workflows with identical logic, differing only by device profile:

-   **Desktop** — 1920-wide viewport, dpr 1. Schedule: **daily 10:00** (Europe/Istanbul).
-   **Mobile** — 393-wide viewport, dpr 3 (iPhone-class, renders 1179px-wide captures).
    Schedule: **daily 09:00 / 15:00 / 20:00** (Europe/Istanbul).

Screenshots are captured **full-page**. Narrow mobile viewports make pages very tall — a
single capture can be 60,000+ pixels high — and the pipeline is tuned for this (large
browserless timeouts, filesystem binary mode, raised payload caps, memory-bounded image
handling in every code node).

Each run:

1.  **Fetch Sitemap** — retrieves URLs from `TARGET_WEBSITE_URL/sitemap.xml`.
2.  **Capture** — screenshots each URL via Browserless. Every guard here **fails closed**:
    a capture that cannot be trusted writes a structured error payload instead of a wrong
    PNG, because a silently truncated or mis-scaled capture reads downstream as a real
    page and produces a confident, wrong verdict. The emulated viewport is verified after
    navigation on three axes — layout width, device pixel ratio, and puppeteer's own
    cached viewport, which is what scales the screenshot — and on mismatch an escalating
    ladder re-navigates, then forces a raw CDP metrics override, then retries on a fresh
    page. (Browserless connects its function client without a `defaultViewport`, so
    puppeteer's 800x600 default can land *after* ours and stick; identical retries just
    reproduce it.) A page scroll-locked by an auto-opening modal is closed or refused, and
    cookie banners are dismissed with retries. Last of all, every `<video>` is parked on
    frame 0 — `play()` is neutralised first, because the feed restarts its videos from an
    intersection observer and a bare `pause()` is undone before the shot. Without it the
    site's dozen autoplay+loop heroes put a different frame in every capture: two
    back-to-back captures of the homepage differ by 0.28% (escalation starts at 0.1%),
    against 0.0007% once frozen. If no baseline exists for a page, the capture becomes its
    baseline (status *New*).
3.  **Pixel Diff Check** — decodes baseline + new with `sharp` and compares at full
    resolution with `pixelmatch`. Under 0.1% changed pixels → **Pass**; a capture error →
    a visible **Skip** with the reason; otherwise escalate to the AI.
4.  **AI Vision Check** — sends the pair to **Gemini** (pro-tier alias) grounded with
    machine evidence so it cannot freewheel: a numbered list of pixel-diff regions it must
    attribute any defect to, native-resolution crop pairs of the changed areas, dHash
    reshuffle evidence for rotated content grids, and row-alignment **insertion seams**
    (rows that exist only in the new capture — how an inserted element is pinpointed
    instead of the content it displaced). Any "missing/added" FAIL claim is then verified
    fail-closed: Qwen existence probes at the claimed location (Gemini cross-checked),
    a full-page sweep, one corrective retry — an unverifiable claim is discarded and the
    failure falls back to a generic pixel-diff description rather than a story. A discarded
    claim is recorded verbatim in the verification trail, never in the headline reason: it
    is the one sentence the system decided was false, and quoting it up front reads as the
    finding. Qwen (via OpenRouter) also serves as the full fallback comparer when Gemini is
    unavailable.
5.  **Report** — builds an HTML report whose rows carry buttons, not images: nothing is
    fetched until a reviewer clicks. **Compare Baseline ↔ New** opens the failure pair
    (frozen per run, so later re-baselines can't rewrite history) side by side in one
    scroll container, both halves at equal width and split by a red seam; **View Baseline**
    opens a passing page's baseline. **Solid red** marks the AI-attributed defect location;
    **dashed amber** marks areas that changed but were judged noise. Each failure carries
    the model version, its thought process, and the machine-verification trail.
6.  **Notify** — posts a summary to Slack with a link to the report.

### 3. Visual Testing - Updater

-   **Trigger:** Webhook (called from the HTML report).
-   **Function:** When a reviewer clicks **"Accept New Version"**, replaces that page's
    baseline with the current screenshot. Reports reflect acceptance state on reload.
-   **Security:** Protected by `UPDATE_BASELINE_TOKEN`.

### 4. Error Handler

-   Catches workflow errors and routes a notification.

## Architecture

-   **n8n** — the workflow engine. Runs a **custom image** (`Dockerfile`, based on the
    pinned `n8nio/n8n` tag) that globally installs pinned `sharp`, `pngjs`, and
    `pixelmatch` and exposes them via `NODE_PATH`, so the code nodes can pixel-diff and
    resize images. Data is stored in Postgres; binary data is kept on the filesystem.
-   **Browserless** — headless Chrome for rendering pages and taking screenshots.
    Pinned to the `chrome` image, not `chromium`: the open-source build has no
    proprietary codecs, so H.264 `<video>` fails to decode and the target site paints
    a playback-error overlay that no real visitor sees. The `chrome` image serves the
    function endpoint at **`/chrome/function`** (chromium served it at `/function`),
    so the image tag and the capture nodes' URL have to change together.
-   **Caddy** — reverse proxy and static file server for the evidence images and HTML reports.
-   **Postgres** — database for n8n.

Runtime files live under `local_files/` (mounted as `/files` in the n8n container):
`baseline_screenshots/`, `new_screenshots/`, `failed_screenshots/` (highlighted evidence +
frozen baseline copies), and `reports/`.

## Repository layout

Every tracked file is either infrastructure, a node source, or a snapshot of live state.
Filenames say what a file is for; nothing is named after the incident that produced it.

-   `desktop_live.json` / `mobile_live.json` / `updater_live.json` — snapshots of the
    workflows as they are actually running, refreshed with `./export_live_workflows.sh`.
    They are both the import artifacts and the base `assemble.py` builds from.
-   `build/` — the source of every non-trivial node, one file per node:
    `capture_page.js` (the browserless capture, shared by both screenshot nodes),
    `pixel_diff_check.js`, `ai_vision_check.js`, `prepare_failure_html.js`,
    `result_tested.js`, `generate_report.js`, `updater_copy.js`. `ai_vision_check.js`
    and `generate_report.js` are templates instantiated per device.
-   `build/assemble.py` — injects those sources into the workflow snapshots
    (see *Changing a code node*), and `--check` gates drift between them.
-   `build/validate_*.js` — offline harnesses that run the real node bodies against real
    screenshot pairs inside the container: `validate_ai_vision.js` (live or pre-AI),
    `validate_ai_vision_scripted.js` (scripted model/probe responses, no AI calls),
    `validate_failure_html.js`, `validate_report.js` (renders a synthetic run's HTML so
    report markup can be opened in a browser). `make_synthetics_insertions.js` and
    `make_synthetics_deletions.py` build truth-set pairs whose answer is known.
-   `export_live_workflows.sh` — pulls the live workflows out of the container into the
    `*_live.json` snapshots. `show_db_sizes.sh` prints the largest Postgres tables.

**Rolling back a deployment** — `*_live.json` is committed after every deploy, so git
history *is* the rollback chain: `git log -- desktop_live.json` lists one revision per
deployment, and `git show <commit>:desktop_live.json > rollback.json` gives you that
exact live state to import.

## Keeping the target site out of the repo

This repo is public and the site it tests is not named anywhere in it — not in code, not
in comments, not in commit messages. Refer to a page by its role ("one marketing page",
"a profile page"), never by its URL or slug, and never quote its UI text verbatim.

A `pre-commit` hook enforces it. Enable it once per clone:

```bash
git config core.hooksPath build/hooks
```

It blocks staged content that carries the site's identity or a real credential. The terms
live outside version control, because writing them into a tracked file would republish
exactly what they guard: the host comes from `TARGET_WEBSITE_URL` in `.env`, and
`build/hooks/terms.local` (gitignored, optional) holds any extra terms. `--no-verify`
bypasses it if you ever need to.

Note that the slug scheme derives the host from each sitemap URL rather than hardcoding
it, so the exported workflow snapshots stay clean through a re-export.

## Changing a code node

The workflow JSONs store node code as escaped one-line strings — never edit them by
hand. The loop is:

1.  Edit the relevant `build/*.js` source.
2.  `python3 build/assemble.py <name>` — writes `desktop_<name>.json` /
    `mobile_<name>.json` from the current `*_live.json` bases (add `--updater` if
    `updater_copy.js` changed). They land in `/tmp/visual-tester-deploy/`, outside the
    project, because they are throwaway — the sources plus a base rebuild them
    byte-for-byte. Pass `--out DIR` to put them somewhere else.
3.  Import them into n8n (replacing Desktop/Mobile). `n8n import:workflow` reads from
    inside the container, so copy them into `n8n_data/config/` (mounted at
    `/home/node/.n8n`) first and delete them after. The import **deactivates** the
    workflow and writes a *draft*, so then **publish** each one and **restart the n8n
    container** — publishing alone leaves the running process on its previously
    registered cron, i.e. on the old code. Confirm both workflows are active again.
4.  `./export_live_workflows.sh` to refresh the snapshots, then commit those.

`python3 build/assemble.py --check` reports drift between the sources and the live
exports (exit 1 if any managed node differs) — run it any time to confirm the repo
still reproduces production.

## Usage

1.  Access n8n at your configured domain (or `http://localhost:5678` locally).
2.  Reports are written to `local_files/reports/` and served via Caddy.
3.  Watch Slack for run notifications; open a report and **Accept New Version** to
    re-baseline any page whose change is intentional.

### Re-baselining

Baselines are created automatically whenever one is missing. Prefer per-page
**Accept New Version** from the report. To re-baseline everything for a device, archive
and clear the relevant `local_files/baseline_screenshots/baseline_*_<device>.png` files
and let the next scheduled run recreate them.
