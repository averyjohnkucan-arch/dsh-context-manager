import NativeTokenMeter from '@deepseek-ai/dsh-token-meter';

// Native 0.2.2 pricing folds surface replacements but not plugin-owned text
// projections. Account for our lossless tail projection without changing host files.
export default class ContextTokenMeter extends NativeTokenMeter {
  measure(session, header) {
    const measured = super.measure(session, header);
    let removed = 0;
    const nodes = measured.nodes.map(node => {
      const event = session.eventAt(node.seq);
      if (event?.type !== 'assistant/message') return node;
      const original = event.data.message, projected = session.deriveEventMessage(event);
      if (original === projected || original.content.length !== 1 || original.content[0].type !== 'text' || projected?.content.length !== 1 || projected.content[0].type !== 'text') return node;
      const delta = Math.max(0, this.estimateMessage(original) - this.estimateMessage(projected));
      removed += delta;
      return Object.freeze({...node, tokens: Math.max(0, node.tokens - delta), heuristicTokens: Math.max(0, node.heuristicTokens - delta)});
    });
    return Object.freeze({...measured, nodes: Object.freeze(nodes), totalTokens: Math.max(0, measured.totalTokens - removed), surfaceTokens: Math.max(0, measured.surfaceTokens - removed), surfaceDeltaTokens: measured.surfaceDeltaTokens - removed});
  }
}
