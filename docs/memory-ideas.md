# Memory: ideas parked for later

Vortex's palace (`~/.vortex/mempalace`) files every Product Owner source and issue as verbatim chunks of about
700 characters, each opening with a locator line (`server/src/palace-index.ts`). The agent searches first and opens a
file only when search is not enough. The ideas below came up while designing that, and are not built.

## Multilingual embeddings

- **Problem** — the palace embeds with Chroma's default, `all-MiniLM-L6-v2`. It is English-only. A pasted conversation in
  Ukrainian or Russian embeds poorly, and an English query does not find it.
- **Idea** — embed with a multilingual model, for example `intfloat/multilingual-e5-small` (384 dimensions, like
  MiniLM, about 120 MB) or `paraphrase-multilingual-MiniLM-L12-v2`.
- **Cost** — every drawer must be embedded again (one collection holds one embedding space). The mempalace MCP server
  and `mempalace.searcher` must use the same embedding function as `scripts/palace.py`, or search breaks. That means a
  patch or a config option in mempalace itself, and the same change in every config dir that shares the palace.
- **When** — when a good share of the sources are not in English.

## LLMLingua-2 digests

- **Idea** — compress a long source with LLMLingua-2 into a digest the agent reads in place of the original.
- **Built and measured** — `scripts/lingua.py` (a JSON-lines sidecar; venv in `~/.vortex/lingua`, model
  `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`, MPS). It keeps headings, code, tables and short
  blocks verbatim, protects identifiers, numbers, code spans and bold lead-ins as forced placeholder tokens, and
  compresses each list item on its own.
- **Result on the UoM sources (2026-10-01)** — the session export (10.7k tokens): rate 0.45 gave −32 % but broke
  meaning ("costing engine, ledger not."); rate 0.6 gave −15 % and still garbled lines. These sources are terse STE
  markdown with little filler. Not wired in.
- **When to try again** — long, wordy sources: meeting transcripts and chat exports (what the model was trained on).
  Gate it: digest only when it saves 25 % or more, and never return a digest as a search hit.

## Compressed drawer text, original embeddings

- **Idea** — Chroma can store one text and embed another. File the compressed chunk as the drawer text and embed the
  original, so search quality stays and results cost fewer tokens.
- **Why not now** — results are about 1k tokens per search; the saving is small, and a lossy hit gets quoted as fact.
