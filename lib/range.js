import {toolPairingBalancedBefore, toolPairingBalancedAfter} from '@deepseek-ai/dsh-compaction';

// Adapted from DeepSeek's MIT-licensed compaction-basic 0.2.1-rc.2.
// The fallback can summarize a single very large completed assistant message:
// retaining that entire node would otherwise prevent recovery at the output limit.
export function compactableRange(session, measurement, retainTokens, includeLast = false) {
  const nodes = session.surface.nodes, priced = measurement.nodes;
  if (!nodes.length) return null;
  if (nodes.length !== priced.length || nodes.some((seq, i) => seq !== priced[i].seq)) throw new Error('Context measurement does not match session surface');
  const first = session.eventAt(nodes[0]).type === 'system/message' ? 1 : 0;
  let keep = nodes.length, total = 0;
  if (!includeLast) for (let i = nodes.length - 1; i >= 0; --i) {
    total += priced[i].tokens;
    keep = i;
    if (total >= retainTokens) break;
  }
  while (keep > first) {
    const before = keep === nodes.length || toolPairingBalancedBefore(session, nodes[keep]);
    if (before && toolPairingBalancedAfter(session, nodes[keep - 1])) break;
    --keep;
  }
  return keep > first ? {start: nodes[first], end: nodes[keep - 1]} : null;
}
