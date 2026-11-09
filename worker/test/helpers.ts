import type { AgentProvider, AgentRequest, AgentResult } from '../src/compression/provider.js';

/** Records every agent request and answers with a fixed result (or throws a fixed error). */
export class FakeProvider implements AgentProvider {
  requests: AgentRequest[] = [];
  constructor(private readonly reply: AgentResult | Error) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    this.requests.push(req);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}
