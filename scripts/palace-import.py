#!/usr/bin/env python3
"""Imports another MemPalace into Stagehand's: every drawer it does not have yet (same id = same drawer, kept as it is),
with its stored embedding, and the knowledge graph's entities and triples (insert-or-ignore). The source is read from
a snapshot copy, so a palace in use by a running MCP server is never touched. Stagehand's palace is backed up first.

  palace-import.py --from <MEMPALACE_HOME> --to <MEMPALACE_HOME> [--dry-run]
"""
import argparse
import collections
import json
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path

import chromadb

COLLECTION = "mempalace_drawers"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True)
    ap.add_argument("--to", dest="dst", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    src, dst = Path(a.src), Path(a.dst)

    with tempfile.TemporaryDirectory() as tmp:
        snap = Path(tmp) / "palace"
        shutil.copytree(src / "palace", snap)
        scol = chromadb.PersistentClient(path=str(snap)).get_collection(COLLECTION)
        got = scol.get(include=["documents", "metadatas", "embeddings"])
        dcol = chromadb.PersistentClient(path=str(dst / "palace")).get_or_create_collection(COLLECTION)
        have = set(dcol.get(include=[])["ids"])
        new = [i for i, x in enumerate(got["ids"]) if x not in have]
        by_wing = collections.Counter(got["metadatas"][i].get("wing", "?") for i in new)
        report = {"source_drawers": len(got["ids"]), "already_present": len(got["ids"]) - len(new), "imported": len(new), "by_wing": dict(by_wing.most_common())}
        if not a.dry_run and new:
            backup = dst.parent / f"{dst.name}.backup-{time.strftime('%Y%m%d-%H%M%S')}"
            shutil.copytree(dst, backup)
            report["backup"] = str(backup)
            for s in range(0, len(new), 200):
                part = new[s : s + 200]
                dcol.add(
                    ids=[got["ids"][i] for i in part],
                    documents=[got["documents"][i] for i in part],
                    metadatas=[got["metadatas"][i] for i in part],
                    embeddings=[list(got["embeddings"][i]) for i in part],
                )

    skg, dkg = src / "knowledge_graph.sqlite3", dst / "knowledge_graph.sqlite3"
    if skg.exists():
        s = sqlite3.connect(f"file:{skg}?mode=ro", uri=True)
        d = sqlite3.connect(dkg)
        for table in ("entities", "triples"):
            cols = [r[1] for r in s.execute(f"PRAGMA table_info({table})")]
            rows = s.execute(f"SELECT {','.join(cols)} FROM {table}").fetchall()
            before = d.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] if d.execute("SELECT name FROM sqlite_master WHERE name=?", (table,)).fetchone() else 0
            if not a.dry_run:
                d.executemany(f"INSERT OR IGNORE INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", rows)
                d.commit()
            after = d.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] if not a.dry_run else before
            report[f"kg_{table}"] = {"source": len(rows), "added": after - before}
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
