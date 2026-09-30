#!/bin/bash
# Before the conversation is compacted: file everything durable, since details are about to be summarised away.
cat <<'HOOKJSON'
{"decision":"block","reason":"COMPACTION ahead. Before it: bring context.md up to date, file the product knowledge of this session in your wing's rooms (update, do not append), and write a diary entry. Then continue."}
HOOKJSON
