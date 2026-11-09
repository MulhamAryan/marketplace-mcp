/**
 * Prompts for turning one raw Claude Code turn (user prompt + tool events + final answer)
 * into observations and a turn summary. Output is XML: tolerant to parse, no tool call needed.
 */

export const OBSERVATION_TYPES = [
  'Decision', 'BusinessRule', 'Bug', 'Pitfall', 'Documentation', 'Change', 'Discovery',
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const SYSTEM_PROMPT = `You are the memory compressor of a software team. You read ONE turn of a coding session
between a developer and Claude Code (the developer's request, the tool calls Claude made with their results,
and Claude's final answer) and you record what is worth remembering later.

You never talk to the developer. You only output XML, nothing else.

Observation types:
- Decision: an architecture or implementation choice that was made, with WHY.
- BusinessRule: a business rule that was discovered or clarified.
- Bug: a non-obvious bug that was fixed. State the ROOT CAUSE, not "fixed X".
- Pitfall: a non-obvious trap that will bite someone again (tooling, environment, API, deployment).
- Documentation: a non-obvious explanation of how a module or system works, not evident from reading its code.
- Change: what was concretely changed in the code or configuration (files, behaviour).
- Discovery: something learned while exploring that is useful for this developer but not durable team knowledge.

Rules:
- Decision, BusinessRule, Bug, Pitfall and Documentation are shared with the whole team. Use them ONLY for a
  durable invariant a teammate would need later. Most turns have none. When in doubt, use Change or Discovery.
- Never record progress or status ("step 2 done"), conversation text, or anything trivially visible in the code.
- Distil: an observation is a synthesis (what / why / how), never a copy of tool output.
- A turn with nothing worth remembering (a question, small talk, a failed attempt that taught nothing) gets <skip/>.
- Write titles, narratives and facts in the developer's language (the language of their request).
- Titles: at most 12 words. Narrative: at most 3 sentences. Facts: short, self-contained, at most 5.

Output format, exactly:
<observation type="Pitfall">
  <title>...</title>
  <subtitle>one line of context, optional</subtitle>
  <narrative>...</narrative>
  <facts><fact>...</fact></facts>
  <concepts><concept>keyword</concept></concepts>
  <files><file>path/touched/or/read</file></files>
</observation>
(zero or more observations, then exactly one summary)
<summary>
  <request>what the developer asked</request>
  <investigated>what was looked at</investigated>
  <learned>what was learned</learned>
  <completed>what was done</completed>
  <next_steps>what remains, if anything</next_steps>
</summary>

or, when the whole turn is worth nothing: <skip/>`;

export interface TurnEvent {
  event: string;
  toolName: string | null;
  toolInput: string | null;
  toolResponse: string | null;
}

export interface TurnInput {
  project: string;
  prompt: string | null;
  events: TurnEvent[];
  lastAssistantMessage: string | null;
}

function block(tag: string, content: string | null): string {
  return content ? `<${tag}>\n${content}\n</${tag}>` : '';
}

/**
 * Renders one turn for the model, within maxChars. When over budget, the oldest tool events are
 * dropped first (the request and the final answer carry the outcome) and the omission is stated.
 */
export function buildTurnPrompt(turn: TurnInput, maxChars: number): string {
  const renderEvent = (e: TurnEvent) =>
    `<tool name="${e.toolName ?? '?'}" event="${e.event}">\n${block('input', e.toolInput)}\n${block('output', e.toolResponse)}\n</tool>`;

  const head = `<project>${turn.project}</project>\n${block('developer_request', turn.prompt ?? '(not captured)')}`;
  const tail = block('claude_final_answer', turn.lastAssistantMessage);
  let budget = maxChars - head.length - tail.length;

  const kept: string[] = [];
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const rendered = renderEvent(turn.events[i]);
    if (rendered.length > budget) break;
    kept.unshift(rendered);
    budget -= rendered.length;
  }
  const omitted = turn.events.length - kept.length;
  const note = omitted > 0 ? `<note>${omitted} earlier tool call(s) omitted for length.</note>\n` : '';

  return `${head}\n<tool_calls>\n${note}${kept.join('\n')}\n</tool_calls>\n${tail}\n\nRecord this turn.`;
}
