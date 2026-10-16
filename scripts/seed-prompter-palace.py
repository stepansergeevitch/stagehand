#!/usr/bin/env python3
"""Seed Prompter's palace from another MemPalace.

Copies drawers (documents, metadata and stored embeddings, so nothing is re-embedded) of the given wings into the
destination palace, renaming wings on the way, plus every drawer of the diary wing whose text mentions the app.
Idempotent: drawers whose id already exists in the destination are skipped. The knowledge graph and hallways files
are copied when the destination has none yet.

Usage:
  seed-prompter-palace.py --src ~/code/northspyre/.mempalace --dst ~/.vortex/prompter \
      --wing task-orchestrator=vortex --wing vortex --diary wing_claude --mention vortex
Prints one JSON object with the counts.
"""
import argparse
import json
import os
import shutil
import sys

import chromadb

COLLECTION = "mempalace_drawers"
BATCH = 100


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--dst", required=True)
    ap.add_argument("--wing", action="append", default=[], help="wing to copy, optionally old=new")
    ap.add_argument("--diary", default=None, help="diary wing whose entries mentioning --mention are copied")
    ap.add_argument("--mention", default="vortex")
    a = ap.parse_args()

    src_home, dst_home = os.path.expanduser(a.src), os.path.expanduser(a.dst)
    os.makedirs(dst_home, exist_ok=True)
    src = chromadb.PersistentClient(path=os.path.join(src_home, "palace")).get_collection(COLLECTION)
    dst = chromadb.PersistentClient(path=os.path.join(dst_home, "palace")).get_or_create_collection(COLLECTION)

    renames = {}
    for w in a.wing:
        old, _, new = w.partition("=")
        renames[old] = new or old

    copied, skipped, per_wing = 0, 0, {}

    def copy(ids, docs, metas, embs):
        nonlocal copied, skipped
        for i in range(0, len(ids), BATCH):
            b_ids = ids[i : i + BATCH]
            have = set(dst.get(ids=b_ids)["ids"])
            keep = [k for k, id_ in enumerate(b_ids) if id_ not in have]
            skipped += len(b_ids) - len(keep)
            if not keep:
                continue
            dst.add(
                ids=[b_ids[k] for k in keep],
                documents=[docs[i + k] for k in keep],
                metadatas=[metas[i + k] for k in keep],
                embeddings=[embs[i + k] for k in keep],
            )
            copied += len(keep)

    for old, new in renames.items():
        got = src.get(where={"wing": old}, include=["documents", "metadatas", "embeddings"])
        metas = [{**m, "wing": new} for m in got["metadatas"]]
        copy(got["ids"], got["documents"], metas, list(got["embeddings"]))
        per_wing[f"{old}->{new}"] = len(got["ids"])

    if a.diary:
        got = src.get(where={"wing": a.diary}, include=["documents", "metadatas", "embeddings"])
        needle = a.mention.lower()
        pick = [k for k, d in enumerate(got["documents"]) if needle in (d or "").lower()]
        copy(
            [got["ids"][k] for k in pick],
            [got["documents"][k] for k in pick],
            [got["metadatas"][k] for k in pick],
            [got["embeddings"][k] for k in pick],
        )
        per_wing[a.diary] = len(pick)

    extras = []
    for name in ("knowledge_graph.sqlite3", "hallways.json"):
        s, d = os.path.join(src_home, name), os.path.join(dst_home, name)
        if os.path.exists(s) and not os.path.exists(d):
            shutil.copyfile(s, d)
            extras.append(name)

    print(json.dumps({"copied": copied, "skipped": skipped, "wings": per_wing, "total": dst.count(), "extras": extras}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
