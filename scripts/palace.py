#!/usr/bin/env python3
"""Stagehand's access to its own MemPalace: fixed-id context drawers and search, JSON in and out.

The MCP tool add_drawer always files a new drawer; a living context text needs one drawer that is replaced in place,
so Stagehand upserts it here by a fixed id. Search goes through mempalace's own searcher.

  palace.py --palace <dir> get --id <drawer_id>
  palace.py --palace <dir> put --id <drawer_id> --wing <w> --room <r> [--source <s>]   (content on stdin)
  palace.py --palace <dir> search --query <q> [--wing <w>] [--room <r>] [--limit <n>]
  palace.py --palace <dir> status
"""
import argparse
import json
import sys
from datetime import datetime

import chromadb

COLLECTION = "mempalace_drawers"


def collection(palace, create=False):
    client = chromadb.PersistentClient(path=palace)
    return client.get_or_create_collection(COLLECTION) if create else client.get_collection(COLLECTION)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--palace", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("get")
    g.add_argument("--id", required=True)
    p = sub.add_parser("put")
    p.add_argument("--id", required=True)
    p.add_argument("--wing", required=True)
    p.add_argument("--room", required=True)
    p.add_argument("--source", default="stagehand")
    s = sub.add_parser("search")
    s.add_argument("--query", required=True)
    s.add_argument("--wing")
    s.add_argument("--room")
    s.add_argument("--limit", type=int, default=8)
    sub.add_parser("status")
    a = ap.parse_args()

    if a.cmd == "get":
        try:
            r = collection(a.palace).get(ids=[a.id], include=["documents", "metadatas"])
        except Exception:
            print(json.dumps({"found": False}))
            return
        if not r["ids"]:
            print(json.dumps({"found": False}))
            return
        print(json.dumps({"found": True, "content": r["documents"][0], "meta": r["metadatas"][0]}))
    elif a.cmd == "put":
        content = sys.stdin.read()
        col = collection(a.palace, create=True)
        col.upsert(
            ids=[a.id],
            documents=[content],
            metadatas=[{"wing": a.wing, "room": a.room, "source_file": a.source, "chunk_index": 0, "added_by": "stagehand", "filed_at": datetime.now().isoformat()}],
        )
        print(json.dumps({"ok": True, "id": a.id}))
    elif a.cmd == "search":
        from mempalace.searcher import search_memories

        print(json.dumps(search_memories(a.query, palace_path=a.palace, wing=a.wing, room=a.room, n_results=a.limit)))
    elif a.cmd == "status":
        try:
            col = collection(a.palace)
        except Exception:
            print(json.dumps({"total": 0, "wings": {}}))
            return
        metas = col.get(include=["metadatas"])["metadatas"]
        wings = {}
        for m in metas:
            w = m.get("wing", "?")
            r = m.get("room", "?")
            wings.setdefault(w, {}).setdefault(r, 0)
            wings[w][r] += 1
        print(json.dumps({"total": len(metas), "wings": wings}))


if __name__ == "__main__":
    main()
