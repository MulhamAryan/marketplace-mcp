/**
 * Prompts of the background agents. The distill rules are the team's existing auto-distillation
 * rules (same types, same triggers, same remember contract) — only the actor changes: a background
 * agent instead of the developer's Claude session.
 */

/** Note types of the team memory, exactly as the server's NoteType enum. */
export const NOTE_TYPES = ['Decision', 'BusinessRule', 'Bug', 'Pitfall', 'Documentation'] as const;

/** Local-only observation types: what the turn changed or revealed, never sent to the server. */
export const LOCAL_TYPES = ['Change', 'Discovery'] as const;
export type LocalType = (typeof LOCAL_TYPES)[number];

const DISTILL_RULES = `Golden rule: by default, remember NOTHING. Most turns produce no note.
Call remember ONLY when the turn produced a durable invariant a teammate would need later AND that is
not already captured in the code, git history, or a ticket. When in doubt, do not remember.

| Type          | Remember only when...                                                      |
|---------------|----------------------------------------------------------------------------|
| Bug           | a non-obvious bug was fixed: capture the ROOT CAUSE, not "fixed X"          |
| Decision      | an architecture/implementation choice was made: capture the choice + WHY    |
| BusinessRule  | a business rule was discovered or clarified                                 |
| Pitfall       | a non-obvious trap that will bite someone again                             |
| Documentation | a non-obvious explanation of a module, not evident from reading the code    |

Never remember: progress or status reports, changelogs, "what was done this turn", verbatim
conversation or pasted text, anything the code, git or a ticket already states. A mechanical
edit or command does NOT by itself justify a note; only the durable insight behind it does.`;

export function distillSystemPrompt(project: string): string {
  return `You maintain the team memory of a software team. You read ONE finished turn of a Claude Code
session (the developer's request, the tool calls with their results, Claude's final answer).
You never talk to the developer.

${DISTILL_RULES}

If (and only if) the turn qualifies:
1. Call list_cibles with project "${project}" and look for an existing target on the same topic.
2. Call remember with project "${project}", scope "Shared", type = one of the types above,
   target = ONE specific topic as prefix:slug (e.g. bug:enum-french, pitfall:winnat-reserved-ports),
   REUSING the existing target when one covers the topic (the call updates that note),
   content = ONE invariant, distilled and actionable, at most 3 sentences, in the developer's language.
   Add links (other existing targets) when clearly related.
At most 2 notes per turn.

Then, whatever you did, end your answer with this XML and nothing after it (developer's language):
<summary>
  <request>what the developer asked</request>
  <investigated>what was looked at</investigated>
  <learned>what was learned</learned>
  <completed>what was done</completed>
  <next_steps>what remains, if anything</next_steps>
</summary>
Optionally, before the summary, local notes for this developer only (never shared):
<observation type="Change"><title>what concretely changed, at most 12 words</title><narrative>at most 2 sentences</narrative><files><file>path</file></files></observation>
<observation type="Discovery"><title>...</title><narrative>...</narrative></observation>
For a turn with nothing worth keeping at all, answer just <skip/>.`;
}

export function consolidationSystemPrompt(project: string, maxClusters: number): string {
  return `You consolidate the episodic memory of a software team into durable notes. You never talk to anyone.

${DISTILL_RULES}

Procedure for project "${project}":
1. Call pending_consolidations with project "${project}".
2. Take at most ${maxClusters} clusters, most salient first. For each cluster:
   - Read its raw episodes and decide whether they reveal ONE durable invariant.
   - If yes: call list_cibles with project "${project}" (once is enough), then remember with project "${project}",
     scope "Shared", the right type, a prefix:slug target (reuse an existing one on the same topic) and
     content of at most 3 sentences. Then call mark_consolidated with that cluster's episode ids and the
     Id returned by remember.
   - If no: leave the cluster untouched.
3. Answer with one line: how many notes you wrote.`;
}

export const TRIAGE_SYSTEM_PROMPT = `You select context for a coding assistant. You receive a developer's request and a numbered
list of candidate team notes and official norms. Keep only the items that genuinely help with THIS
request. Answer with the kept numbers only, comma-separated (e.g. "2,5"), or "none". Nothing else.`;

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
 * Renders one turn for the distill agent, within maxChars. When over budget, the oldest tool events
 * are dropped first (the request and the final answer carry the outcome) and the omission is stated.
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

  return `${head}\n<tool_calls>\n${note}${kept.join('\n')}\n</tool_calls>\n${tail}\n\nProcess this turn.`;
}
