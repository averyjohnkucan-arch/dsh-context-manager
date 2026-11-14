# DSH Context Manager 0.2

Buffer-triggered compaction and verbatim retention for **DSH 0.2.2-rc.1**.

## Two settings

Open **Settings → Models → Context & output**.

| Setting | Default | Meaning |
|---|---:|---|
| Output buffer | 32,768 tokens | Compact at a generation boundary when less than this much context remains. Not a response-length cap. |
| Keep verbatim | 30% | Minimum recent tail, calculated from the model's total capacity. 30% of 1,000,000 keeps 300,000 tokens. |

The response allowance is estimated remaining context minus one token. No fixed summary reserve is subtracted from ordinary output. Cloud providers retain their declared output ceilings. A physical context window and provider output ceiling still apply; this plugin cannot make a single request unlimited. DSH's meter is an estimate, so “minus one” is a request-budget rule, not a promise of exact tokenizer agreement.

The buffer is checked after naturally finished responses, at output-limit stops, and before new requests (including tool cycles, new inputs and model switches). Natural completion remains complete; after compaction the chat waits for its next input. Interrupted output can continue within the same turn without a synthetic user or “Continue” message, subject to the engine limitations below. User cancellation or pending input prevents automatic continuation.

## Verbatim tail and separate summary

The plugin keeps the recent tail outside the auxiliary summarization request. It sends the older selected region plus system instructions, relevant tool declarations, and a summarization instruction separately. The active context becomes system instructions, an older-history checkpoint, and the unchanged recent tail. Tool boundaries can increase the retained amount beyond the requested minimum.

A single huge text-only response is handled by keeping its exact suffix. The original full response and stream remain in the archive, with no duplicate assistant message added to the transcript. An ignorable plugin record projects the suffix into model-visible history. Opaque reasoning blocks, tool calls and other structured blocks are not sliced. If there is no safe range that preserves the requested tail, the operation stops rather than silently discarding it.

Summary output must fit the separate request, be smaller than its source, and leave room for the retained tail, system overhead and output buffer in the final context. Truncated, empty or oversized summaries retry up to three times with a reduced allowance. A failed summary never replaces the original history. Native compaction records retain provenance. Original conversation events are not deleted.

## Continuation support — read before installing

The replacement can continue a trailing assistant **text** prefix on NInfer without adding a user message when its server was launched with `--assistant-prefill` and the request's thinking mode is Off. It checks the saved profile and selected effort before resuming. It does not change your engine profiles or thinking defaults. The real DSH agent loop is tested with a deterministic adapter. GPU inference is not exercised by the regression suite.

**Interrupted thinking is not universally supported.** The NInfer server's current assistant-prefill implementation explicitly rejects reasoning-bearing final assistant messages. On NInfer reasoning cutoffs, and on adapters without a verified prefix-continuation contract, the plugin preserves the partial response and pauses. It reports the reason in Context & output. It never inserts a hidden continuation prompt or claims the old hidden model state survived compaction.

Other adapters can implement `contextManagerCanContinue({model, content, reasoningEffort})` and return `true` once their message-free prefix behavior is implemented and verified. Unverified cloud, Strata and Dory routes are not silently treated as supported. Their ordinary compaction and retention work, but automatic cutoff continuation pauses.

## Runtime integration

The bundle disables native automatic compactors across existing and future agent presets. It supplies a plugin-owned agent loop with one narrowly scoped continuation extension and a token meter subclass that accounts for verbatim-tail projections. **No installed DSH or engine source files are edited.** The loop is vendored from DeepSeek's MIT-licensed 0.2.2-rc.1 release; its license and modification notes are in `vendor/`.

This version pins DSH 0.2.2-rc.1 because it relies on that release's lifecycle and persistence contracts. Do not widen the range without testing the next host version.

Install the npm tarball as a DSH bundle and restart DSH. Settings are stored in `$DSH_HOME/dsh-context-manager/settings.json` (normally `~/.dsh/dsh-context-manager/settings.json`). Old v1 settings are backed up to `settings-v1-backup.json` and replaced by the fresh two-setting defaults. Disable or remove the **whole bundle**, then restart, to restore native loop, meter and preset policies. Existing checkpoints remain. Tail projection records are ignorable without the plugin, so removing it restores the full original assistant message for that projected tail; that can increase context usage until the native compactor reduces it.

## Development

```sh
npm install --ignore-scripts
npm test
npm run check
npm pack
```

Tests cover the real current DSH loop, full-capacity retention arithmetic, separate summary calls, text-tail preservation, no-message continuation, repeated-output stopping, summary failure retries, cancellation, provider limits and preset coordination. No credentials are required.
