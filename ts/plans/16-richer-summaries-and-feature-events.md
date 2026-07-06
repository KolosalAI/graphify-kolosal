# Plan 16 — Fuller node descriptions + a live per-feature progress event

> **Status: DONE.** `NODE_SYSTEM` now asks for a full plain-English description (4–5 sentences:
> steps, inputs, outputs, side-effects; never mentions "the code"/"this function"); `summary` cap
> raised 200→1000 chars. Added `SummarizerEvents.onFeatureDone` (`FeatureDoneEvent` with
> index/total/label/tier/op+node counts/llm+fallback counts), emitted from `readyIfDone` with a
> feature counter; main.js subscribes and prints `✓ [i/total] <label> (<tier>) — N nodes, M ops · X
> summarized, Y fallback` live per feature. Verified on `sample_source_planout`: summaries are
> multi-sentence (e.g. 4 sentences / 414 chars), all 35 features print progress in completion order,
> `--no-llm` still prints (fallback counts). Plan 14/15 behavior unchanged.

Two focused changes on top of Plan 15's node summarizer (`src/group/nodesummary.ts`).

## 1. Richer summaries — full logic description (4–5 sentences)

Today each node's `summary` is capped at one short sentence (prompt says `"one or two short
sentence"`, result sliced to 200 chars). Plan 16 makes it a **full plain-English description of the
logic**: what the code does, the main steps/branches, inputs and outputs, and any notable
side-effects — **up to 4–5 sentences**, still jargon-free for a product reader. The `title` stays
short (≤6 words).

Changes in `nodesummary.ts`:
- **Prompt (`NODE_SYSTEM`)** → ask for a *description*, not a one-liner:
  *"summary: a full plain-English description of what the code does and how — its steps, inputs,
  outputs, and side-effects — in 4–5 sentences, no code/DB/framework jargon."* Keep the title rule.
- **Length cap** → raise the `summary` slice from `200` to ~`1000` chars (a 5-sentence description
  is ~500–800 chars). Bump `chatJson` `max_tokens` if needed (currently 1200 — enough).
- **Heuristic fallback** stays short (first code line) — it's a placeholder when the LLM is off; note
  in output that a fuller description needs the LLM.
- Titles/`content`/dedup/cache/frontier behavior are unchanged.

## 2. Per-feature progress event (subscribed + printed by main.js)

Plan 15 already fires `onFeatureReady(graph)` (used to *write* the file) as each feature completes.
Plan 16 adds a distinct **progress event** carrying stats, so main.js can **print a live line per
feature** during the run — separating "write the file" from "tell the user".

- New event on `SummarizerEvents`:
  ```ts
  onFeatureDone?: (p: {
    index: number; total: number;       // 1-based position / feature count
    featureId: string; label: string; tier: "business" | "common";
    operationCount: number; nodeCount: number;
    llmNodes: number; fallbackNodes: number;
  }) => void;
  ```
- Emitted from the existing `readyIfDone(featureId)` path, **after** `finalizeMeta` (so counts are
  set) and alongside `onFeatureReady`. A monotonic counter gives `index`/`total` (`total` =
  `graphs.length`).
- **main.js subscribes and prints**, e.g.:
  ```
  ✓ [7/35] Cart (business) — 12 nodes, 3 ops · 9 summarized, 3 fallback
  ```
  This replaces the current silent per-feature write with visible progress, matching the streaming
  labeler style (Plan 09).

## Data / API touch points

- `nodesummary.ts`: `NODE_SYSTEM`, summary slice length, `SummarizerEvents.onFeatureDone`, emit site
  in `readyIfDone`, a feature counter.
- `main.js`: add the `onFeatureDone` handler (print), keep `onFeatureReady` (write).
- No schema change to `graph.json` beyond the already-longer `summary` string.

## Verification

1. With LLM on, a node's `summary` is a multi-sentence (≥3, ≤~5) plain-English description; the
   `title` is still ≤6 words.
2. During the run, main.js prints one `✓ [i/total] <feature> (<tier>) — …` line **per feature**, in
   completion order, with correct llm/fallback counts.
3. `--no-llm` still prints the per-feature lines (fallback counts), summaries remain the short
   heuristic placeholder, deterministic.
4. Existing Plan 14/15 behavior (folders always written, dedup, frontier heuristic, raw fields
   preserved) is unchanged.

## Phasing

1. Update `NODE_SYSTEM` + summary length cap in `nodesummary.ts`.
2. Add `onFeatureDone` to `SummarizerEvents`; emit it from `readyIfDone` with a feature counter.
3. Subscribe in main.js; print the per-feature progress line.
4. Run on the sample (LLM on/off); confirm fuller descriptions + live per-feature output.
