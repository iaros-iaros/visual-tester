#!/usr/bin/env python3
"""Assembler: inject the current build/*.js sources into the current workflow
exports.

n8n stores node code as an escaped one-line string inside workflow JSON, which
cannot be read or diffed. So build/*.js is the source, the workflow JSON is a
build artifact, and this is the compiler — the standing path from a source edit
to an importable workflow, whatever the current live state is:

  python3 build/assemble.py --check           drift report, no writes:
                                              exit 0 = every managed node in the
                                              exports matches the sources
  python3 build/assemble.py <name>            write desktop_<name>.json and
                                              mobile_<name>.json from the
                                              *_live.json bases, into a scratch
                                              directory OUTSIDE the repo
  python3 build/assemble.py <name> --updater  also write updater_<name>.json
                                              from updater_live.json
  python3 build/assemble.py <name> --out DIR  write them to DIR instead

Managed nodes — device workflows (base: {device}_live.json):
  AI Vision Check                  <- build/ai_vision_check.js       (templated)
  Pixel Diff Check                 <- build/pixel_diff_check.js
  Result: Tested                   <- build/result_tested.js
  Prepare Failure HTML             <- build/prepare_failure_html.js
  Generate Report                  <- build/generate_report.js       (templated)
  Take Screenshot                  <- build/capture_page.js          (embedded)
  New Page Screenshot              <- build/capture_page.js          (embedded)

The two screenshot nodes are HTTP Request nodes, not Code nodes: the browserless
capture function lives inside their jsonBody, so only the function body is
swapped and the {"code": .., "context": {..}} wrapper — which carries the
per-device "mobile" flag — is preserved. That source may not contain a backtick
or ${, since it sits inside a JS template literal inside an n8n expression.
Managed nodes — updater (base: updater_live.json):
  Copy New Screenshot To Baseline  <- build/updater_copy.js

Templating: __MAX_WIDTH__ / __MAX_PIXELS__ / __DEVICE__ are substituted per
device; a leftover __UPPERCASE__ placeholder after substitution aborts the
build. Every other code node (Device Config, Result: New, Check Token, ...) is
left untouched.

The deployables are throwaway: the sources plus a base rebuild them byte-for-byte
at any time, and what actually shipped is recorded by the refreshed *_live.json.
So they are written to a scratch directory outside the project (DEFAULT_OUT) and
never accumulate in the repo. The gitignore rules for desktop_*/mobile_*/
updater_*.json remain as a backstop for --out . and for older artifacts.

Deploy loop (n8n 2.x needs the publish + restart, not just the import):

  python3 build/assemble.py myfix                 # -> /tmp/visual-tester-deploy/
  cp /tmp/visual-tester-deploy/{desktop,mobile}_myfix.json n8n_data/config/
  docker exec n8n-visual-tester n8n import:workflow \\
      --input=/home/node/.n8n/mobile_myfix.json   # deactivates + writes a draft
  # ...same for desktop, then publish both (n8n UI or MCP publish_workflow) and
  # docker compose restart n8n, or the running process keeps the stale cron
  rm n8n_data/config/{desktop,mobile}_myfix.json
  ./export_live_workflows.sh && python3 build/assemble.py --check   # must be in sync
"""
import argparse
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Outside the repo on purpose: assembling must not leave artifacts behind in the
# project folder. Stable rather than mkdtemp, so the deploy commands above can name
# the files, and re-assembling the same name simply overwrites.
DEFAULT_OUT = Path(tempfile.gettempdir()) / 'visual-tester-deploy'

DEVICE_PARAMS = {
    'desktop': {'MAX_WIDTH': '1280', 'MAX_PIXELS': '6000000', 'DEVICE': 'desktop'},
    'mobile':  {'MAX_WIDTH': '1000', 'MAX_PIXELS': '4000000', 'DEVICE': 'mobile'},
}
DEVICE_NODES = {
    'AI Vision Check': 'ai_vision_check.js',
    'Pixel Diff Check': 'pixel_diff_check.js',
    'Result: Tested': 'result_tested.js',
    'Prepare Failure HTML': 'prepare_failure_html.js',
    'Generate Report': 'generate_report.js',
}
UPDATER_NODES = {
    'Copy New Screenshot To Baseline': 'updater_copy.js',
}
# The browserless capture function. It is not a Code node -- it is embedded in the
# HTTP Request nodes' jsonBody, inside a JS template literal inside an n8n
# expression, so only the function body is swapped and the surrounding
# {"code": `...`, "context": {...}} wrapper (which carries the per-device
# "mobile" flag and the Loop Over Items expressions) is preserved verbatim.
CAPTURE_NODES = ('Take Screenshot', 'New Page Screenshot')
CAPTURE_SOURCE = 'capture_page.js'
CAPTURE_OPEN = '"code": `'
CAPTURE_CLOSE = '`,\n    "context"'
WORKFLOW_NAMES = {'desktop': 'Desktop', 'mobile': 'Mobile'}
UPDATER_BASE = 'updater_live.json'
PLACEHOLDER = re.compile(r'__[A-Z][A-Z0-9_]*__')


def md5_12(s):
    return hashlib.md5(s.encode()).hexdigest()[:12]


def load_sources(node_map):
    sources = {}
    for node_name, filename in node_map.items():
        path = ROOT / 'build' / filename
        code = path.read_text()
        assert code.strip(), f'{filename} is empty'
        sources[node_name] = code
    return sources


def instantiate(code, params):
    for key, value in params.items():
        code = code.replace(f'__{key}__', value)
    leftover = PLACEHOLDER.search(code)
    assert not leftover, f'unsubstituted placeholder {leftover.group()}'
    return code


def load_workflow(path):
    wf = json.loads(path.read_text())
    if isinstance(wf, list):  # `n8n export:workflow --all` wraps in a list
        assert len(wf) == 1, f'{path.name}: expected a single workflow, got {len(wf)}'
        wf = wf[0]
    return wf


def swap_capture_code(json_body, code, where):
    """Replace the capture function inside an HTTP Request node's jsonBody,
    keeping the surrounding n8n expression byte-for-byte."""
    assert json_body.count(CAPTURE_OPEN) == 1 and json_body.count(CAPTURE_CLOSE) == 1, (
        f'{where}: expected exactly one embedded capture function')
    start = json_body.index(CAPTURE_OPEN) + len(CAPTURE_OPEN)
    end = json_body.index(CAPTURE_CLOSE)
    return json_body[:start] + code + json_body[end:], json_body[start:end]


def process(base_path, expected_wf_name, sources, params, dst_path, check_only,
            capture_code=None):
    """Sync one workflow's managed nodes. Returns True if all already matched."""
    wf = load_workflow(base_path)
    if expected_wf_name is not None:
        assert wf.get('name') == expected_wf_name, (
            f'{base_path.name}: workflow is named {wf.get("name")!r}, expected '
            f'{expected_wf_name!r} — wrong base file?')

    by_name = {}
    for node in wf['nodes']:
        by_name.setdefault(node['name'], []).append(node)
    missing = [n for n in sources if n not in by_name]
    dupes = [n for n in sources if len(by_name.get(n, [])) > 1]
    assert not missing, f'{base_path.name}: managed nodes not found: {missing}'
    assert not dupes, f'{base_path.name}: duplicate node names: {dupes}'

    clean = True
    print(f'{base_path.name}:')
    for node_name in sources:
        node = by_name[node_name][0]
        old = node['parameters']['jsCode']
        new = instantiate(sources[node_name], params)
        if old == new:
            print(f'  {node_name:<32} {md5_12(old)}  in sync')
        else:
            clean = False
            verb = 'DRIFT' if check_only else 'update'
            print(f'  {node_name:<32} {md5_12(old)} -> {md5_12(new)}  {verb}')
            node['parameters']['jsCode'] = new

    for node_name in (CAPTURE_NODES if capture_code else ()):
        assert node_name in by_name, f'{base_path.name}: capture node not found: {node_name}'
        assert len(by_name[node_name]) == 1, f'{base_path.name}: duplicate node: {node_name}'
        node = by_name[node_name][0]
        new_body, old = swap_capture_code(
            node['parameters']['jsonBody'], capture_code, f'{base_path.name}/{node_name}')
        if old == capture_code:
            print(f'  {node_name:<32} {md5_12(old)}  in sync')
        else:
            clean = False
            verb = 'DRIFT' if check_only else 'update'
            print(f'  {node_name:<32} {md5_12(old)} -> {md5_12(capture_code)}  {verb}')
            node['parameters']['jsonBody'] = new_body

    unmanaged = sorted(n['name'] for n in wf['nodes']
                       if (n.get('parameters') or {}).get('jsCode')
                       and n['name'] not in sources)
    if unmanaged:
        print(f'  (unmanaged code nodes, untouched: {", ".join(unmanaged)})')

    if not check_only:
        dst_path.write_text(json.dumps(wf, indent=2))
        print(f'  -> wrote {dst_path}')
    return clean


def main():
    parser = argparse.ArgumentParser(
        description='Inject current build/*.js sources into the current workflow exports.')
    parser.add_argument('name', nargs='?',
                        help='suffix for the deployables, e.g. "myfix" -> desktop_myfix.json')
    parser.add_argument('--check', action='store_true',
                        help='report drift between sources and live exports; write nothing')
    parser.add_argument('--updater', action='store_true',
                        help='also assemble updater_<name>.json')
    parser.add_argument('--out', metavar='DIR', type=Path,
                        help=f'where to write the deployables (default: {DEFAULT_OUT}, '
                             f'outside the repo so nothing accumulates in it)')
    args = parser.parse_args()

    if args.check == bool(args.name):
        parser.error('pass a deployable name, or --check — exactly one of the two')
    if args.check and args.out:
        parser.error('--out has no meaning with --check, which writes nothing')
    out_dir = None
    if args.name:
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', args.name):
            parser.error(f'name {args.name!r}: use lowercase letters, digits, _ or -')
        if args.name == 'live':
            parser.error('name "live" would shadow the tracked live snapshots')
        out_dir = (args.out or DEFAULT_OUT).expanduser()
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            parser.error(f'--out {out_dir}: {e.strerror}')
        if not out_dir.is_dir():
            parser.error(f'--out {out_dir}: not a directory')

    device_sources = load_sources(DEVICE_NODES)
    updater_sources = load_sources(UPDATER_NODES)
    capture_code = (ROOT / 'build' / CAPTURE_SOURCE).read_text()
    assert '`' not in capture_code and '${' not in capture_code, (
        f'{CAPTURE_SOURCE}: a backtick or ${{ would break the n8n expression it is '
        f'embedded in — use single quotes and string concatenation')
    # A backslash is consumed by that same template literal before Chrome ever sees the
    # code, so an escape that is correct in the source file arrives mangled. `site\'s`
    # shipped on 2026-08-30 and reached the browser as site's inside a single-quoted
    # string: SyntaxError, every capture 400'd, and a whole mobile run came back as 68x
    # "Screenshot crashed (Timeout or Memory)". node --check on the source cannot see
    # this — the source is valid; only the embedded form is not. (And if you go looking
    # with node --check, give the file an .mjs extension: on a .js path it exits 0 on
    # exactly this error.) Backtick, ${ and backslash are the only three characters a
    # template literal treats specially, so these two asserts close the class.
    assert '\\' not in capture_code, (
        f'{CAPTURE_SOURCE}: a backslash is eaten by the n8n template literal this is '
        f'embedded in, so the escape never reaches the browser — reword to avoid it')

    clean = True
    for device in ('desktop', 'mobile'):
        clean &= process(
            base_path=ROOT / f'{device}_live.json',
            expected_wf_name=WORKFLOW_NAMES[device],
            sources=device_sources,
            params=DEVICE_PARAMS[device],
            dst_path=out_dir / f'{device}_{args.name}.json' if args.name else None,
            check_only=args.check,
            capture_code=capture_code,
        )
    if args.check or args.updater:
        clean &= process(
            base_path=ROOT / UPDATER_BASE,
            expected_wf_name='Visual Testing - Updater',
            sources=updater_sources,
            params={},
            dst_path=out_dir / f'updater_{args.name}.json' if args.name else None,
            check_only=args.check,
        )

    if args.check:
        print('check: ' + ('all managed nodes in sync' if clean else 'DRIFT detected'))
        sys.exit(0 if clean else 1)
    if clean:
        print('note: sources match the bases exactly — the deployables are identical '
              'to the current live state')
    print(f'deployables in {out_dir} — outside the repo; delete them once imported')


if __name__ == '__main__':
    main()
