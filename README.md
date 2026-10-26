# DSH Context Manager

Adaptive output limits, reserved summarization space, and automatic continuation for DeepSeek Harness **0.2.1-rc.2**. All behavior lives in this Cordis plugin; no harness or inference-engine files are patched.

Install this folder or its npm tarball as a DSH bundle. The bundle disables the host `compaction-basic` and supplies a replacement using its public engine API and durable compaction transactions. DSH Web also mounts isolated native compactors inside agent presets. Version 0.1.1 uses Cordis's `internal/config` hook and fiber lifecycle API to disable their automatic policies, including already-mounted revisions and future presets. Their explicit `/compact` command remains native. No preset files, DSH code, or engine methods are patched.

Removing the bundle restores the standard engine. Disable the entire bundle rather than only its host entry, so the bundle's override is removed too. Disabling also restores native preset policies and removes matching adaptive output allowances from live request headers before those policies resume. Existing chat summaries are not undone.

The owner status endpoint reports `integration.managedPresetCompactors` and `integration.conflictingAutomaticCompactors`; the latter must be zero. The original host-only integration left preset compactors running: they subtracted the adaptive output allowance again and compacted prematurely at roughly 50K tokens. Regression tests reproduce that bug and verify the corrected integration across all four shipped preset types.

## Settings

Open **Settings → Models → Context & output**. Settings are saved in `$DSH_HOME/dsh-context-manager/settings.json` (default `~/.dsh/dsh-context-manager/settings.json`) and apply on the next generation.

| Setting | Default |
|---|---:|
| Automatic compaction | On |
| Automatic continuation | On |
| Output cap | 0: use remaining space |
| Summary budget | 16,384 tokens |
| Safety buffer | 8,192 tokens |
| Minimum space before compaction | 4,096 tokens |
| Recent context retained verbatim | 32,768 tokens |

For NInfer, Strata and Dory, the requested output allowance is:

```
context window − estimated prompt − summary budget − safety buffer
```

A 262,144-token model therefore has 237,568 tokens available for the prompt and response together. This is a maximum allowance, not a target response length. Other providers retain their advertised default output cap. A nonzero output-cap setting can further limit any route. The inference server may enforce a lower limit.

Reserves scale down for small context windows: summary ≤ one eighth, safety and minimum-output room ≤ one sixteenth, retained context ≤ one eighth. The plugin reads each model's declared context capacity; it does not increase that capacity. Estimates use DSH's token meter with a safety buffer, not an exact tokenizer for every model. The final admitted prompt is checked again before inference; internal budget retries rebuild and record the correct request rather than altering a frozen request.

## Compaction and continuation

When the remaining space is low, the plugin summarizes older context and normally retains the recent tail. A single oversized finished response can also be summarized when necessary to free space. Tool-call/result boundaries remain balanced. Summarization uses a bounded output allowance and disables extended reasoning where the model exposes an off setting. A failed, empty, or truncated summary preserves the original history and stops safely.

If a textual generation reaches its output limit, the plugin compacts if necessary and submits a durable automatic follow-up. It uses a new DSH turn because this DSH release keeps a token-limit turn-end reason across steps, which can otherwise prematurely end a later tool cycle. The original notice changes to “continued automatically below” only after that follow-up is admitted. User cancellation, pending user input, empty/repeated output, and truncated tool calls prevent automatic continuation. There is no artificial overall response-length cap; ordinary model completion still stops the response.

Changing the selected model to one with a smaller context triggers compaction against the new capacity, using the previous model to summarize the larger history. If the summary cannot make the pending request fit, processing stops without discarding the original content. A new user input too large to fit cannot be fixed by summarizing older turns.

Compaction invalidates the replaced prefix of any inference KV cache; the next request may need prefill. This plugin does not implement KV snapshot persistence or change model scheduling.

## Development

```
npm install
npm test
npm run check
npm pack
```

The regression suite runs the real DSH agent loop with a deterministic in-memory adapter. Preset integration tests use DSH's actual registry, loader, and shipped compaction isolation groups. They verify no compaction through 200K tokens in a 262,144-token window, compaction near the configured threshold, future preset revisions, and restoring defaults on disable. Other tests cover dynamic budgets, late context injection, switching model sizes, safe summary failure, cancellation, tool use after continuation, truncated tool calls, repeated output, settings persistence, and the continuation notice. No GPU is needed. Long-answer capacity is tested with synthetic responses; this is not a benchmark of a live 200K-token generation.
