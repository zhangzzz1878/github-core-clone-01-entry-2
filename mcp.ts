// mcp.ts — Model Context Protocol over Streamable HTTP (plain JSON
// responses, no SSE). Implements the modern 2026-07-28 era
// (server/discover) plus the legacy initialize handshake as a fallback.

import {
  VIEWER_LOGIN,
  getRepo,
  createRepo,
  repoJson,
  issueJson,
  prJson,
} from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The tool catalogue is a precomputed constant so two tools/list calls
// return byte-identical arrays.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_DEFS = new Map(TOOLS.map((t) => [t.name, t]));

function rpcResult(id, result) {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function rpcError(id, code, message, httpStatus = 200) {
  return {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  };
}

// A tool result carries both structuredContent and a text block with the
// same JSON, so clients that read either side see the data.
function toolResult(id, structured) {
  return rpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  });
}

function toolErrorResult(id, message) {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  });
}

function resolveRepo(args) {
  const owner = args.owner ?? VIEWER_LOGIN;
  const repo = getRepo(owner, args.repo);
  return repo;
}

function callTool(name, args) {
  // Returns { ok: true, value } or { ok: false, message }.
  switch (name) {
    case 'create_repo': {
      const repo = createRepo(args.name, { description: args.description, private: args.private });
      if (!repo) return { ok: false, message: `Repository '${args.name}' already exists` };
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const issue = repo.createIssue({ title: args.title, body: args.body ?? '' });
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.listIssues({ state, direction: 'desc' });
      return { ok: true, value: { issues: issues.map((i) => issueJson(repo, i)) } };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const headRef = typeof args.head === 'string' ? args.head : '';
      const baseRef = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (!repo.branchTip(headRef)) return { ok: false, message: `head branch '${headRef}' does not exist` };
      if (!repo.branchTip(baseRef)) return { ok: false, message: `base branch '${baseRef}' does not exist` };
      const pr = repo.createPull({ title: args.title, body: args.body ?? '', headRef, baseRef });
      return { ok: true, value: prJson(repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const num = Number(args.pull_number);
      const pr = repo.pulls.get(num);
      if (!pr) return { ok: false, message: 'Pull request not found' };
      const result = repo.mergePull(pr);
      if (!result.ok) return { ok: false, message: 'Merge conflict: this pull request cannot be merged' };
      return { ok: true, value: prJson(repo, pr) };
    }
    default:
      return { ok: false, message: `Unknown tool '${name}'` };
  }
}

export function handleMcp(ctx) {
  if (ctx.method === 'DELETE') {
    return { status: 200, headers: {}, body: '' };
  }
  if (ctx.method !== 'POST') {
    return {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }),
    };
  }
  let payload;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = payload.id === undefined ? null : payload.id;
  const method = payload.method;
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {};

  // Notifications carry no id: answer with an empty 202.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const version = requested && LEGACY_REVISIONS.includes(requested) ? requested : LEGACY_REVISIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const def = TOOL_DEFS.get(name);
      if (!def) return rpcError(id, -32601, `Unknown tool '${name}'`);
      for (const req of def.inputSchema.required ?? []) {
        const v = args[req];
        if (v === undefined || v === null || v === '') {
          return rpcError(id, -32602, `Missing required argument '${req}'`);
        }
      }
      const result = callTool(name, args);
      if (!result.ok) return toolErrorResult(id, result.message);
      // list_issues: the text block carries the plain array so a text
      // search finds titles and numbers; structuredContent keeps the
      // object wrapper.
      if (name === 'list_issues') {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result.value.issues) }],
          structuredContent: result.value,
        });
      }
      return toolResult(id, result.value);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
