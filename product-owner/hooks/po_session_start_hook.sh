#!/bin/bash
# Product Owner session start: what the palace holds for this PO's wing, so the agent knows what to search.
[ -z "$VORTEX_PO_WING" ] && { echo "{}"; exit 0; }
STATUS=$(python3 "$VORTEX_PALACE_SCRIPT" --palace "$VORTEX_PALACE_PATH" status 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin); w = sys.argv[1]
rooms = d.get('wings', {}).get(w, {})
print(f'Palace: {d.get(\"total\", 0)} drawers. Your wing {w}: ' + (', '.join(f'{r} {n}' for r, n in rooms.items()) or 'empty'))
" "$VORTEX_PO_WING" 2>/dev/null)
[ -z "$STATUS" ] && { echo "{}"; exit 0; }
TEXT="MEMPALACE — search it (mcp__mempalace__mempalace_search) before you answer about the product, and before you open a source: rooms artifacts and issues hold every source and issue as chunks with a locator. $STATUS"
ESCAPED=$(printf '%s' "$TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$ESCAPED"
