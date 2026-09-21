import { State } from './state.js';
import { brief } from './brief.js';
import { verify, printVerifyReport } from './verify.js';
import { doctor } from './doctor.js';
import { listInbox } from './inbox.js';
import { planProposals } from './observe.js';

// MCP (Model Context Protocol) server exposing the manual to coding agents.
// Stdin/stdout JSON-RPC 2.0. Tools:
//   manual_brief  — verified session briefing for files (the headline tool)
//   manual_verify — run checks, return stamps
//   manual_doctor — manual health
//   manual_inbox  — list pending candidates

const VERSION = '0.1.0';

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL_DEFS = [
  {
    name: 'manual_brief',
    description:
      'Get a token-budgeted briefing of verified claims about a repository relevant to the given files: how to run tests, traps that look right but are wrong, policies, and who owns what. Call this before editing files in a repo with a .manual/ directory.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Repository root (default: session root)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files the agent is about to touch' },
        budget: { type: 'number', description: 'Max tokens for the briefing (default from manual.yaml)' },
      },
    },
  },
  {
    name: 'manual_verify',
    description:
      'Execute the repository manual: run each claim\'s check and return fresh/broken/blocked stamps. Use --diff semantics optionally by passing base ref.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        force: { type: 'boolean', description: 'Re-run even if evidence digests are unchanged' },
        diff: { type: 'string', description: 'Base ref: only claims relevant to changed files (plus policies)' },
      },
    },
  },
  {
    name: 'manual_doctor',
    description: 'Health report for the manual itself: stale evidence, expired TTLs, never-verified claims.',
    inputSchema: { type: 'object', properties: { root: { type: 'string' } } },
  },
  {
    name: 'manual_inbox',
    description: 'List candidate claims proposed by sessions (the flywheel inbox).',
    inputSchema: { type: 'object', properties: { root: { type: 'string' } } },
  },
];

function handleTool(root, name, args) {
  const state = new State(root);
  switch (name) {
    case 'manual_brief': {
      const out = brief(root, args.files || [], {
        state,
        budget: args.budget,
        quiet: true,
      });
      state.save();
      return {
        content: [
          {
            type: 'text',
            text: out.lines.join('\n') || '(no relevant claims — scope everything you touch)',
          },
        ],
      };
    }
    case 'manual_verify': {
      // Await is handled by the caller (handleToolAsync).
      return null;
    }
    case 'manual_doctor': {
      const res = doctor(root, state);
      state.save();
      return {
        content: [
          {
            type: 'text',
            text: res.rows
              .map((r) => `${r.issues.length ? '▲' : '✔'} ${r.id}: ${r.issues.join('; ') || r.state}`)
              .join('\n') || 'manual is empty',
          },
        ],
      };
    }
    case 'manual_inbox': {
      const files = listInbox(root);
      return { content: [{ type: 'text', text: files.join('\n') || 'inbox empty' }] };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handleToolAsync(root, name, args) {
  if (name === 'manual_verify') {
    const state = new State(root);
    const res = await verify(root, { state, force: Boolean(args.force), diff: args.diff || undefined });
    state.save();
    const text =
      res.results
        .map((r) => `${r.claim.fm.id}: ${r.stamp.state}${r.stamp.note ? ` (${r.stamp.note})` : ''}`)
        .join('\n') || 'no claims selected';
    return {
      content: [{ type: 'text', text }],
      isError: res.results.some((r) => r.stamp.state === 'broken'),
    };
  }
  return handleTool(root, name, args);
}

export async function serveMcp(root, { input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  const send = (obj) => output.write(obj + '\n');

  const onLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return send(jsonRpcError(null, -32700, 'parse error'));
    }
    const { id, method, params } = msg;

    try {
      if (method === 'initialize') {
        return send(jsonRpc(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'manual-cli', version: VERSION },
        }));
      }
      if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) {
        return; // notifications get no response
      }
      if (method === 'tools/list') {
        return send(jsonRpc(id, { tools: TOOL_DEFS }));
      }
      if (method === 'tools/call') {
        const name = params?.name;
        const args = params?.arguments || {};
        const result = await handleToolAsync(root, name, args);
        if (!result) return send(jsonRpcError(id, -32602, `unknown tool: ${name}`));
        return send(jsonRpc(id, result));
      }
      if (method === 'ping') return send(jsonRpc(id, {}));
      if (method === 'resources/list') return send(jsonRpc(id, { resources: [] }));
      if (method === 'prompts/list') return send(jsonRpc(id, { prompts: [] }));
      return send(jsonRpcError(id, -32601, `method not found: ${method}`));
    } catch (e) {
      return send(jsonRpcError(id, -32000, e.message));
    }
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      void onLine(line);
    }
  });

  return new Promise((resolve) => input.once('end', resolve));
}
