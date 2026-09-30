#!/bin/bash
# Product Owner auto-save (after northspyre's mempal_save_hook): every 15 human exchanges the agent files what it learned.
SAVE_INTERVAL=15
STATE_DIR="${MEMPALACE_HOME:-$HOME/.mempalace}/hook_state"
mkdir -p "$STATE_DIR"
INPUT=$(cat)
field() { echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
SESSION_ID=$(field session_id | tr -cd 'a-zA-Z0-9_-'); [ -z "$SESSION_ID" ] && SESSION_ID=unknown
ACTIVE=$(field stop_hook_active)
TRANSCRIPT=$(field transcript_path); TRANSCRIPT="${TRANSCRIPT/#\~/$HOME}"
if [ "$ACTIVE" = "True" ] || [ "$ACTIVE" = "true" ]; then echo "{}"; exit 0; fi
COUNT=0
if [ -f "$TRANSCRIPT" ]; then
    COUNT=$(python3 - "$TRANSCRIPT" <<'PYEOF'
import json, sys
n = 0
for line in open(sys.argv[1]):
    try:
        m = json.loads(line).get('message', {})
        if isinstance(m, dict) and m.get('role') == 'user' and isinstance(m.get('content'), str):
            n += 1
    except Exception:
        pass
print(n)
PYEOF
)
fi
LAST_FILE="$STATE_DIR/po_${SESSION_ID}_last_save"
LAST=$(cat "$LAST_FILE" 2>/dev/null || echo 0)
if [ $((COUNT - LAST)) -ge "$SAVE_INTERVAL" ] && [ "$COUNT" -gt 0 ]; then
    echo "$COUNT" > "$LAST_FILE"
    cat <<'HOOKJSON'
{"decision":"block","reason":"AUTO-SAVE checkpoint. File the product knowledge from this session in the palace: update the drawers in your wing's features / users / decisions / glossary rooms (update, do not append), add knowledge-graph facts for product entities, write a short diary entry, and bring context.md up to date. Then continue."}
HOOKJSON
else
    echo "{}"
fi
