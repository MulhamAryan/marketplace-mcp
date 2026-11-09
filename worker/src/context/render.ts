import type { ObservationRow, SummaryRow } from '../storage/observations.js';
import { estimateTokens } from './tokens.js';

const day = (iso: string) => iso.slice(0, 10);
const parseList = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Full observation, as shown in the context and by `eonix-mem show`. */
export function renderObservation(o: ObservationRow): string {
  const shared = o.share_status === 'pushed' ? ' · partagée équipe' : o.share_status === 'pending' ? ' · à partager' : '';
  const lines = [`### #${o.id} [${o.type}] ${o.title} — ${day(o.created_at)}${shared}`];
  if (o.subtitle) lines.push(`_${o.subtitle}_`);
  if (o.narrative) lines.push(o.narrative);
  for (const f of parseList(o.facts)) lines.push(`- ${f}`);
  const files = parseList(o.files);
  if (files.length) lines.push(`Fichiers : ${files.join(', ')}`);
  return lines.join('\n');
}

/** One index line; the token count tells Claude what fetching the full observation costs. */
export function renderIndexLine(o: ObservationRow): string {
  return `- #${o.id} ${day(o.created_at)} [${o.type}] ${o.title} (~${estimateTokens(renderObservation(o))} tok)`;
}

export function renderSummary(s: SummaryRow): string {
  const parts = [`- ${day(s.created_at)} — ${s.request ?? '(demande non résumée)'}`];
  if (s.completed) parts.push(`→ ${s.completed}`);
  if (s.next_steps) parts.push(`Reste : ${s.next_steps}`);
  return parts.join(' ');
}
