import {toolPairingBalancedBefore, toolPairingBalancedAfter} from '@deepseek-ai/dsh-compaction';
import {createAssistantMessage} from '@deepseek-ai/dsh-llm';
import {deepFreeze} from '@deepseek-ai/dsh-util-values';

export const TAIL_RECORD = 'plugin:dsh-context-manager/verbatim-tail';
export const tailProjection = {type: TAIL_RECORD, project(event, context) {
  const {seq, text} = event.data;
  if (!context.nodes.includes(seq) || typeof text !== 'string') throw new Error('Invalid verbatim-tail projection');
  const originalEvent = context.events[seq - context.baseSeq];
  const message = context.messages.get(seq) ?? originalEvent?.data.message;
  if (originalEvent?.type !== 'assistant/message' || message?.content.length !== 1 || message.content[0].type !== 'text' || !message.content[0].text.endsWith(text)) throw new Error('Verbatim tail does not match original assistant text');
  const source = {...message.source}; delete source.replayState;
  return new Map([[seq, deepFreeze({...message, source, content: [{type: 'text', text}]})]]);
}};

// Retention is a minimum recent tail target. Never discard an oversized last
// response as a fallback, and never split tool-call/result units.
export function compactableRange(session, measurement, retainTokens) {
  const nodes = session.surface.nodes, priced = measurement.nodes;
  if (nodes.length !== priced.length || nodes.some((seq, i) => seq !== priced[i].seq)) throw new Error('Context measurement does not match session surface');
  const first = nodes.length && session.eventAt(nodes[0]).type === 'system/message' ? 1 : 0;
  let keep = nodes.length, tokens = 0;
  while (keep > first && tokens < retainTokens) tokens += priced[--keep].tokens;
  while (keep > first && (!toolPairingBalancedBefore(session, nodes[keep]) || !toolPairingBalancedAfter(session, nodes[keep - 1]))) --keep;
  return keep > first ? {start: nodes[first], end: nodes[keep - 1], retainedTokens: priced.slice(keep).reduce((sum, n) => sum + n.tokens, 0)} : null;
}

// A very long *text-only* response must not force retention of the whole node.
// Split its exact string into an old prefix and unchanged suffix. Opaque replay
// or reasoning blocks are not split: their provider-specific integrity matters.
export function splitTextTail(session, measurement, retainTokens, meter) {
  const nodes = session.surface.nodes, last = nodes.at(-1), event = last === undefined ? null : session.eventAt(last);
  if (event?.type !== 'assistant/message') return null;
  const message = session.deriveEventMessage(event);
  if (message.content.length !== 1 || message.content[0].type !== 'text' || measurement.nodes.at(-1).tokens <= retainTokens) return null;
  const text = message.content[0].text;
  const source = {...message.source}; delete source.replayState;
  const make = value => createAssistantMessage({source, content: [{type: 'text', text: value}]});
  let lo = 0, hi = text.length;
  // Largest start offset whose suffix still meets the retention minimum.
  while (lo < hi) {const mid = Math.ceil((lo + hi) / 2); if (meter.estimateMessage(make(text.slice(mid))) >= retainTokens) lo = mid; else hi = mid - 1;}
  let cut = lo;
  if (cut > 0 && /[\uDC00-\uDFFF]/.test(text[cut])) --cut;
  if (!cut) return null;
  const tail = make(text.slice(cut)), prefix = make(text.slice(0, cut));
  const first = session.eventAt(nodes[0]).type === 'system/message' ? 1 : 0;
  if (first >= nodes.length || !toolPairingBalancedBefore(session, nodes[first]) || !toolPairingBalancedAfter(session, last)) return null;
  return {start: nodes[first], end: last, tail, prefix, retainedTokens: meter.estimateMessage(tail)};
}
