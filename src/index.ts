import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Foundation entry point. Later items wire providers, tools, and context.
const server = new Server(
  { name: 'mcp-tracker', version: '1.0.0' },
  { capabilities: {} }
);

const transport = new StdioServerTransport();
await server.connect(transport);
