import type { Settings } from '../settings.js';
import { additionalContextOf, postHook, serverConfigured } from './remote.js';
import { TRIAGE_SYSTEM_PROMPT } from '../compression/prompts.js';
import type { AgentProvider } from '../compression/provider.js';
import { log } from '../log.js';

/** One server answer split into its header line and its candidate lines ("- [...] ..."). */
interface Section {
  header: string[];
  items: string[];
}

function split(text: string): Section {
  const header: string[] = [];
  const items: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) items.push(line);
    else if (items.length === 0) header.push(line);
    else items[items.length - 1] += `\n${line}`; // continuation of a multi-line item
  }
  return { header, items };
}

const render = (s: Section) => (s.items.length ? [...s.header, ...s.items].join('\n') : '');

/** Parses the triage answer ("2,5" or "none") into 1-based indexes; null when unusable. */
export function parseTriage(answer: string, count: number): Set<number> | null {
  const text = answer.trim().toLowerCase();
  if (text === 'none') return new Set();
  const nums = text.match(/\d+/g)?.map(Number).filter((n) => n >= 1 && n <= count);
  return nums && nums.length ? new Set(nums) : null;
}

/**
 * UserPromptSubmit context: the same notes-check and knowledge-check the former hooks called, on
 * the same raw payload. When they return more than triageThreshold candidates in total, an agent
 * keeps only those relevant to this prompt; otherwise (or if triage fails) the text is passed as-is.
 */
export async function promptContext(
  settings: Settings,
  provider: AgentProvider | null,
  raw: Record<string, unknown>,
): Promise<string> {
  if (!serverConfigured(settings)) return '';
  const call = async (endpoint: 'notes-check' | 'knowledge-check') => {
    try {
      return additionalContextOf(await postHook(settings, endpoint, raw));
    } catch (err) {
      log('worker', `${endpoint} failed`, err);
      return '';
    }
  };
  const sections = (await Promise.all([call('notes-check'), call('knowledge-check')])).map(split);
  const all = sections.flatMap((s) => s.items);
  if (all.length === 0) return '';

  if (provider && all.length > settings.triageThreshold) {
    try {
      const numbered = all.map((item, i) => `${i + 1}. ${item.slice(2)}`).join('\n');
      const { text } = await provider.run({
        systemPrompt: TRIAGE_SYSTEM_PROMPT,
        prompt: `<request>\n${String(raw.prompt ?? '')}\n</request>\n<candidates>\n${numbered}\n</candidates>`,
        mcpTools: [],
        maxTurns: 1,
        timeoutMs: settings.triageTimeoutMs,
      });
      const keep = parseTriage(text, all.length);
      if (keep) {
        let index = 0;
        for (const s of sections) s.items = s.items.filter(() => keep.has(++index));
      }
    } catch (err) {
      log('worker', 'triage failed — injecting untriaged notes', err);
    }
  }
  return sections.map(render).filter(Boolean).join('\n\n');
}
