#!/usr/bin/env python3
"""Vortex's LLMLingua-2 sidecar: compresses markdown into a digest the agent reads in place of a long source.

Runs in its own venv (~/.vortex/lingua/.venv). Reads JSON lines on stdin, writes JSON lines on stdout:

  in:  {"id": "…", "text": "…markdown…", "rate": 0.5}
  out: {"id": "…", "text": "…digest…", "origin_tokens": 1234, "tokens": 456, "fallbacks": 2}

The first line it writes is {"ready": true}, after the model loads. Lossy by design, so structure stays verbatim:
headings, code fences, tables, short blocks and bold lead-ins are kept as written; only prose is compressed. A block
whose identifiers or numbers do not all survive is compressed again more gently, then kept verbatim.
"""
import json
import os
import re
import sys

MODEL = os.environ.get("VORTEX_LINGUA_MODEL") or os.environ.get("STAGEHAND_LINGUA_MODEL") or "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
# Words whose loss flips or narrows the meaning; punctuation keeps sentences apart.
FORCE = ["\n", ".", "?", "!", ",", ":", ";", "not", "no", "never", "only", "without", "must", "except", "unless"]
SHORT = 300  # characters: a block this short stays verbatim — the saving is too small to risk
REQUIRED = re.compile(r"\b[A-Z]{1,8}-\d+\b|§\s?\d+|\bD\d+\b|\d+(?:[.,]\d+)?")


def load():
    from llmlingua import PromptCompressor
    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    return PromptCompressor(model_name=MODEL, use_llmlingua2=True, device_map=device)


def blocks(md):
    """Paragraph blocks; a code fence is one block however many blank lines it holds."""
    out, cur, fence = [], [], False
    for line in md.split("\n"):
        if line.strip().startswith("```"):
            fence = not fence
        if not fence and not line.strip() and cur:
            out.append("\n".join(cur))
            cur = []
            continue
        cur.append(line)
    if cur:
        out.append("\n".join(cur))
    return out


def verbatim(block):
    s = block.strip()
    return (
        len(s) < SHORT
        or s.startswith("#")
        or s.startswith("```")
        or s.startswith("|")
        or s.startswith(">") and len(s) < 2 * SHORT
        or re.fullmatch(r"(https?://\S+\s*)+", s) is not None
    )


# Spans that must reach the digest exactly: code, links, identifiers (INV-154, D16, §14), numbers with their unit.
PROTECT = re.compile(r"`[^`\n]+`|\[[^\]\n]*\]\([^)\n]+\)|https?://\S+|\b[A-Z]{1,8}-\d+\b|§\s?\d+(?:\.\d+)*|\b\d+(?:[.,]\d+)*(?:\s?(?:%|[A-Za-z]{1,3}\d?)\b)?|\*\*[^*\n]{1,60}\*\*")
MAX_SPANS = 80  # each span is one forced placeholder token; LLMLingua-2 has 100 slots, FORCE takes the rest


def compress_block(comp, block, rate):
    """Protected spans become placeholder words the model is forced to keep, so they come back verbatim."""
    spans = []

    def hide(m):
        spans.append(m.group(0))
        return f" zqp{len(spans) - 1}q "

    masked = PROTECT.sub(hide, block)
    if len(spans) > MAX_SPANS:
        return block, True
    marks = [f"zqp{i}q" for i in range(len(spans))]
    for r in (rate, min(rate + 0.25, 0.9)):
        out = comp.compress_prompt(masked, rate=r, force_tokens=FORCE + marks, drop_consecutive=True)["compressed_prompt"]
        if all(m in out for m in marks):
            out = re.sub(r"\s*zqp(\d+)q\s*", lambda m: f" {spans[int(m.group(1))]} ", out)
            return re.sub(r"[ \t]{2,}", " ", re.sub(r" +([,.;:?!])", r"\1", out)).strip(), False
    return block, True


LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+\.)\s")


def compress_piece(comp, piece, rate):
    """One paragraph, or one list item with its marker kept."""
    if len(piece.strip()) < SHORT // 2:
        return piece, False
    m = re.match(r"^(\s*(?:[-*+]|\d+\.)\s+)", piece)
    marker = m.group(1) if m else ""
    text, fell = compress_block(comp, piece[len(marker):], rate)
    return marker + text, fell


def digest(comp, md, rate):
    out, fallbacks = [], 0
    for b in blocks(md):
        if verbatim(b):
            out.append(b)
            continue
        lines = b.split("\n")
        if any(LIST_ITEM.match(l) for l in lines):
            # A list: each item (with its continuation lines) on its own, so items stay apart and keep their markers.
            items, cur = [], []
            for l in lines:
                if LIST_ITEM.match(l) and cur:
                    items.append("\n".join(cur))
                    cur = []
                cur.append(l)
            items.append("\n".join(cur))
        else:
            items = [b]
        done = []
        for it in items:
            text, fell = compress_piece(comp, it, rate)
            fallbacks += fell
            done.append(text)
        out.append("\n".join(done))
    return "\n\n".join(out), fallbacks


def main():
    comp = load()
    count = lambda t: len(comp.tokenizer(t, add_special_tokens=False)["input_ids"])
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            text, fallbacks = digest(comp, req["text"], float(req.get("rate", 0.5)))
            print(json.dumps({"id": req["id"], "text": text, "origin_tokens": count(req["text"]), "tokens": count(text), "fallbacks": fallbacks}), flush=True)
        except Exception as e:  # one bad input must not stop the sidecar
            print(json.dumps({"id": req.get("id"), "error": str(e)[:300]}), flush=True)


if __name__ == "__main__":
    main()
