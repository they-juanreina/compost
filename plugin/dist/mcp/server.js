#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runTool, TOOLS } from './tools.js';
export function createServer() {
    const server = new Server({ name: 'compost', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS.map((t) => ({
            name: t.name,
            description: `${t.description}${t.readOnly ? ' [read-only]' : ' [mutation]'}`,
            inputSchema: t.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await runTool(name, (args ?? {}));
        return {
            content: [{ type: 'text', text: result.content }],
            isError: !result.ok,
        };
    });
    return server;
}
async function main() {
    const server = createServer();
    await server.connect(new StdioServerTransport());
}
// Run when invoked directly (the plugin manifest points node at this file).
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        process.stderr.write(`compost-mcp: ${err?.message ?? String(err)}\n`);
        process.exit(1);
    });
}
