import { LOCAL_TYPES, type LocalType } from './prompts.js';

export interface ParsedObservation {
  type: LocalType;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  files: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
}

export interface ParsedTurn {
  skip: boolean;
  observations: ParsedObservation[];
  summary: ParsedSummary | null;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  const value = m ? decode(m[1]) : '';
  return value || null;
}

function list(xml: string, container: string, item: string): string[] {
  const inner = tag(xml, container);
  if (!inner) return [];
  return [...inner.matchAll(new RegExp(`<${item}>([\\s\\S]*?)</${item}>`, 'g'))].map((m) => decode(m[1])).filter(Boolean);
}

/**
 * Tolerant parser of the local part of the distill agent's answer (summary + local observations).
 * Team notes never come from here: they only exist through a successful remember call. Any XML
 * observation type other than Change becomes Discovery, so nothing in the XML can masquerade as a note.
 * Throws only when the answer has neither <skip/>, an observation nor a summary — the turn is then retried.
 */
export function parseTurnOutput(text: string): ParsedTurn {
  const observations: ParsedObservation[] = [];
  for (const m of text.matchAll(/<observation(?:\s+type="([^"]*)")?\s*>([\s\S]*?)<\/observation>/g)) {
    const body = m[2];
    const title = tag(body, 'title');
    if (!title) continue;
    const rawType = (m[1] ?? '').trim();
    const type: LocalType = (LOCAL_TYPES as readonly string[]).includes(rawType) ? (rawType as LocalType) : 'Discovery';
    observations.push({
      type,
      title,
      subtitle: tag(body, 'subtitle'),
      narrative: tag(body, 'narrative'),
      facts: list(body, 'facts', 'fact'),
      concepts: list(body, 'concepts', 'concept'),
      files: list(body, 'files', 'file'),
    });
  }

  const s = text.match(/<summary>([\s\S]*?)<\/summary>/);
  const summary: ParsedSummary | null = s
    ? {
        request: tag(s[1], 'request'),
        investigated: tag(s[1], 'investigated'),
        learned: tag(s[1], 'learned'),
        completed: tag(s[1], 'completed'),
        nextSteps: tag(s[1], 'next_steps'),
      }
    : null;

  const skip = /<skip\s*\/>/.test(text) && observations.length === 0 && !summary;
  if (!skip && observations.length === 0 && !summary) {
    throw new Error('agent answer has no <observation>, <summary> or <skip/>');
  }
  return { skip, observations, summary };
}
