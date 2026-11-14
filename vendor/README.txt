agent-loop.js is the bundled implementation of @deepseek-ai/dsh-agent-loop
0.2.2-rc.1, under the adjacent upstream MIT LICENSE.

Modification: one context-manager/continue waterfall at the generation boundary
allows another next-step request without adding an inbox/user message. It resets
the old max-tokens end reason. All ordinary DSH lifecycle, persistence, routing,
tool dispatch and cancellation handling is preserved.

Source repository: https://github.com/deepseek-ai/deepseek-harness
Package: packages/core/agent-loop
The exact installed package version is pinned in the plugin's peers and tests.
