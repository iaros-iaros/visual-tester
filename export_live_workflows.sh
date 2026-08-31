#!/bin/bash
#
# Export the live workflows out of the n8n container into the tracked *_live.json
# snapshots. Run after every deploy: those snapshots are what `assemble.py` builds
# from and what `assemble.py --check` compares against, so the repo only describes
# production if this has been run.

# Change to the script's directory to ensure relative paths work
cd "$(dirname "$0")"

TEMP_FILE="n8n_data/config/temp_all_workflows.json"
# The docker output path is relative to the container's mount.
DOCKER_OUTPUT_PATH="/home/node/.n8n/temp_all_workflows.json"

echo "Exporting 'Desktop', 'Mobile' and 'Visual Testing - Updater' from n8n..."

# Remove old temp file if it exists (just in case)
if [ -f "$TEMP_FILE" ]; then
    rm "$TEMP_FILE"
fi

docker exec n8n-visual-tester n8n export:workflow --all --output="$DOCKER_OUTPUT_PATH"

if [ ! -f "$TEMP_FILE" ]; then
    echo "Error: Export failed. file '$TEMP_FILE' not found."
    echo "Make sure the docker container 'n8n-visual-tester' is running and you have permissions."
    exit 1
fi

echo "Filtering for target workflows..."

# Python script to filter and save separate JSON files
python3 -c "
import json
import sys

input_file = '$TEMP_FILE'

# Workflow name in n8n -> the snapshot file it belongs in
workflow_map = {
    'Desktop': 'desktop_live.json',
    'Mobile': 'mobile_live.json',
    'Visual Testing - Updater': 'updater_live.json'
}

try:
    with open(input_file, 'r') as f:
        data = json.load(f)

    # Ensure data is a list
    if isinstance(data, dict):
        workflows = [data]
    else:
        workflows = data

    # n8n stamps every export with a 'shared' block naming the owning personal
    # project -- 'First Last <email@host>' plus its project id. That is instance
    # bookkeeping, not workflow definition: importing assigns ownership locally, so
    # dropping it changes nothing about a deploy or a rollback, and it keeps a
    # personal email address out of a repo that may not stay private.
    def scrub(wf):
        wf.pop('shared', None)
        return wf

    found = sorted({wf.get('name') for wf in workflows} & set(workflow_map))
    for wf in workflows:
        name = wf.get('name')
        if name in workflow_map:
            output_file = workflow_map[name]
            print(f'Saving workflow \"{name}\" to {output_file}...')
            with open(output_file, 'w') as out_f:
                json.dump(scrub(wf), out_f, indent=2)

    missing = sorted(set(workflow_map) - set(found))
    if missing:
        print(f'Error: workflow(s) not found in the export: {missing}')
        sys.exit(1)
    print(f'Successfully saved {len(found)} workflow(s).')

except Exception as e:
    print(f'Error processing JSON: {e}')
    sys.exit(1)
"
STATUS=$?

if [ $STATUS -ne 0 ]; then
    echo "Error: export incomplete — the snapshots were NOT fully refreshed."
    exit 1
fi

rm -f "$TEMP_FILE"
echo "Done. Run 'python3 build/assemble.py --check' to confirm the sources still match."
