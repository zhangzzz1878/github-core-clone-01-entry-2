// graphql.ts — a small GraphQL parser + executor for the subset the
// conformance suite uses: queries/mutations, variables, aliases, inline
// fragments, input objects, enums, and __type introspection.

import {
  VIEWER_LOGIN,
  viewerUserJson,
  getRepo,
  getRepoById,
} from './store.ts';

// ------------------------------------------------------------------ tokenizer

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '.') {
      if (src.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      throw new Error('Unexpected "." in query');
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === '/') out += '/';
          else if (e === '\\') out += '\\';
          else if (e === '"') out += '"';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} in query`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --------------------------------------------------------------------- parser

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
  }

  peek() {
    return this.t[this.i];
  }

  next() {
    return this.t[this.i++];
  }

  expectPunct(value) {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`Expected "${value}" but got ${tok.kind} ${JSON.stringify(tok.value)}`);
    }
    return tok;
  }

  expectName() {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected name but got ${tok.kind}`);
    return tok.value;
  }

  skipDirectives() {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next(); // @
      this.expectName();
      if (this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument() {
    const operations = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('Empty document');
    return { operations };
  }

  parseOperation() {
    const tok = this.peek();
    let type = 'query';
    let name = null;
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      type = this.next().value;
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variables = [];
    if (this.peek().value === '(') {
      this.next(); // (
      while (this.peek().value !== ')') {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        let defaultValue;
        if (this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        variables.push({ name: varName, type: varType, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  parseType() {
    let type;
    if (this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().value === '!') {
      this.next();
      type = `${type}!`;
    }
    return type;
  }

  parseSelectionSet() {
    this.expectPunct('{');
    const selections = [];
    while (this.peek().value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().value === '...') {
      this.next();
      let typeCondition = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    let name = this.expectName();
    let alias = null;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args = {};
    if (this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections = null;
    if (this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments() {
    const args = {};
    this.expectPunct('(');
    while (this.peek().value !== ')') {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      // commas are insignificant whitespace in GraphQL
    }
    this.expectPunct(')');
    return args;
  }

  parseValue() {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields = {};
      while (this.peek().value !== '}') {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected token ${tok.kind} ${JSON.stringify(tok.value)} in value`);
  }
}

export function parseQuery(src) {
  return new Parser(tokenize(src)).parseDocument();
}

// Resolve a parsed value node against the request variables.
function resolveValue(node, variables) {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'list':
      return node.items.map((it) => resolveValue(it, variables));
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
    default:
      return node.value;
  }
}

function resolveArgs(argNodes, variables) {
  const out = {};
  for (const [k, v] of Object.entries(argNodes)) out[k] = resolveValue(v, variables);
  return out;
}

// ----------------------------------------------------------------- global ids

function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function b64urlDecode(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}

export function repoGlobalId(repo) {
  return `R_${b64urlEncode(repo.fullName)}`;
}
export function issueGlobalId(repo, issue) {
  return `I_${b64urlEncode(`${repo.fullName}#${issue.number}`)}`;
}
export function prGlobalId(repo, pr) {
  return `P_${b64urlEncode(`${repo.fullName}#${pr.number}`)}`;
}
export function commentGlobalId(repo, issue, comment) {
  return `C_${b64urlEncode(`${repo.fullName}#${issue.number}:${comment.id}`)}`;
}

// Decode a global id into { kind, repo, number, commentId } (or null).
export function decodeGlobalId(id) {
  if (typeof id !== 'string' || id.length < 3) return null;
  const kind = id[0];
  if (id[1] !== '_' || !'RIPC'.includes(kind)) return null;
  let decoded;
  try {
    decoded = b64urlDecode(id.slice(2));
  } catch {
    return null;
  }
  if (kind === 'R') {
    const [owner, name] = decoded.split('/');
    const repo = getRepo(owner, name);
    return repo ? { kind, repo } : null;
  }
  const hash = decoded.indexOf('#');
  if (hash === -1) return null;
  const fullName = decoded.slice(0, hash);
  const rest = decoded.slice(hash + 1);
  const [owner, name] = fullName.split('/');
  const repo = getRepo(owner, name);
  if (!repo) return null;
  if (kind === 'C') {
    const [numStr, commentStr] = rest.split(':');
    const number = parseInt(numStr, 10);
    const commentId = parseInt(commentStr, 10);
    const issue = repo.issues.get(number);
    if (!issue) return null;
    const comment = issue.comments.find((c) => c.id === commentId);
    if (!comment) return null;
    return { kind, repo, issue, comment };
  }
  const number = parseInt(rest, 10);
  if (kind === 'I') {
    const issue = repo.issues.get(number);
    return issue ? { kind, repo, issue } : null;
  }
  const pr = repo.pulls.get(number);
  return pr ? { kind, repo, pr } : null;
}

// --------------------------------------------------------------------- cursors

function encodeCursor(number) {
  return b64urlEncode(`cursor:${number}`);
}
function decodeCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = b64urlDecode(cursor);
    const m = decoded.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- introspection

const TYPE_TABLE = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
};

// ------------------------------------------------------------------ node shapes

function userNode() {
  return { __typename: 'User', login: VIEWER_LOGIN };
}

function repoNode(repo) {
  return { __typename: 'Repository', repo };
}

function issueNode(repo, issue) {
  return { __typename: 'Issue', repo, issue };
}

function prNode(repo, pr) {
  return { __typename: 'PullRequest', repo, pr };
}

function issueStateEnum(issue) {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function prStateEnum(pr) {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function prMergeable(repo, pr) {
  if (pr.state !== 'open') return 'UNKNOWN';
  const { conflict } = repo.analyzeMerge(pr);
  return conflict ? 'CONFLICTING' : 'MERGEABLE';
}

// Paginate an issue list per the connection args.
function issueConnection(repo, args) {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states);
    list = list.filter((i) => wanted.has(issueStateEnum(i)));
  }
  const orderBy = args.orderBy ?? {};
  const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  if (args.after !== null && args.after !== undefined) {
    const afterNum = decodeCursor(args.after);
    if (afterNum !== null) {
      list = list.filter((i) => (direction === 'asc' ? i.number > afterNum : i.number < afterNum));
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function prConnection(repo, args) {
  let list = [...repo.pulls.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states);
    list = list.filter((p) => wanted.has(prStateEnum(p)));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => prNode(repo, p)),
  };
}

// ----------------------------------------------------------------- field table
// Each field: { type, resolve(parent, args) }. `type` is the GraphQL return
// type name used by the validator (list wrappers are unwrapped there).

const F = (type, resolve) => ({ type, resolve });

const TYPES = {
  Query: {
    fields: {
      viewer: F('User', () => userNode()),
      repository: F('Repository', (_p, args) => {
        const repo = getRepo(args.owner, args.name);
        return repo ? repoNode(repo) : null;
      }),
      node: F('Node', (_p, args) => {
        const decoded = decodeGlobalId(args.id);
        if (!decoded) return null;
        if (decoded.kind === 'R') return repoNode(decoded.repo);
        if (decoded.kind === 'I') return issueNode(decoded.repo, decoded.issue);
        if (decoded.kind === 'P') return prNode(decoded.repo, decoded.pr);
        if (decoded.kind === 'C') {
          return {
            __typename: 'IssueComment',
            repo: decoded.repo,
            issue: decoded.issue,
            comment: decoded.comment,
          };
        }
        return null;
      }),
      __type: F('__Type', (_p, args) => {
        const info = TYPE_TABLE[args.name];
        if (!info) return null;
        return { __typename: '__Type', name: args.name, kind: info.kind, info };
      }),
    },
  },
  Node: {
    fields: {
      id: F('ID', (p) => {
        if (p.__typename === 'Repository') return repoGlobalId(p.repo);
        if (p.__typename === 'Issue') return issueGlobalId(p.repo, p.issue);
        if (p.__typename === 'PullRequest') return prGlobalId(p.repo, p.pr);
        if (p.__typename === 'IssueComment') return commentGlobalId(p.repo, p.issue, p.comment);
        return null;
      }),
    },
  },
  User: {
    fields: {
      login: F('String', (p) => p.login),
      id: F('ID', () => `U_${b64urlEncode(VIEWER_LOGIN)}`),
      name: F('String', () => viewerUserJson().name),
    },
  },
  Repository: {
    fields: {
      id: F('ID', (p) => repoGlobalId(p.repo)),
      databaseId: F('Int', (p) => p.repo.id),
      name: F('String', (p) => p.repo.name),
      nameWithOwner: F('String', (p) => p.repo.fullName),
      owner: F('User', () => userNode()),
      defaultBranchRef: F('Ref', (p) => {
        const tip = p.repo.branchTip(p.repo.defaultBranch);
        return tip ? { __typename: 'Ref', name: p.repo.defaultBranch } : null;
      }),
      viewerPermission: F('String', () => 'ADMIN'),
      hasIssuesEnabled: F('Boolean', () => true),
      issue: F('Issue', (p, args) => {
        const issue = p.repo.issues.get(args.number);
        return issue ? issueNode(p.repo, issue) : null;
      }),
      issues: F('IssueConnection', (p, args) => issueConnection(p.repo, args)),
      pullRequests: F('PullRequestConnection', (p, args) => prConnection(p.repo, args)),
      pullRequest: F('PullRequest', (p, args) => {
        const pr = p.repo.pulls.get(args.number);
        return pr ? prNode(p.repo, pr) : null;
      }),
    },
  },
  Ref: {
    fields: {
      name: F('String', (p) => p.name),
    },
  },
  Issue: {
    fields: {
      id: F('ID', (p) => issueGlobalId(p.repo, p.issue)),
      number: F('Int', (p) => p.issue.number),
      title: F('String', (p) => p.issue.title),
      state: F('String', (p) => issueStateEnum(p.issue)),
      body: F('String', (p) => p.issue.body),
    },
  },
  IssueConnection: {
    fields: {
      nodes: F('[Issue]', (p) => p.nodes),
      pageInfo: F('PageInfo', (p) => p.pageInfo),
    },
  },
  PageInfo: {
    fields: {
      hasNextPage: F('Boolean', (p) => p.hasNextPage),
      endCursor: F('String', (p) => p.endCursor),
    },
  },
  PullRequest: {
    fields: {
      id: F('ID', (p) => prGlobalId(p.repo, p.pr)),
      number: F('Int', (p) => p.pr.number),
      title: F('String', (p) => p.pr.title),
      body: F('String', (p) => p.pr.body),
      state: F('String', (p) => prStateEnum(p.pr)),
      merged: F('Boolean', (p) => p.pr.merged),
      headRefName: F('String', (p) => p.pr.headRef),
      baseRefName: F('String', (p) => p.pr.baseRef),
      mergeable: F('String', (p) => prMergeable(p.repo, p.pr)),
      files: F('PullRequestChangedFileConnection', (p, args) => {
        const files = p.repo.pullFiles(p.pr);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
        };
      }),
    },
  },
  PullRequestConnection: {
    fields: {
      nodes: F('[PullRequest]', (p) => p.nodes),
    },
  },
  PullRequestChangedFileConnection: {
    fields: {
      nodes: F('[PullRequestChangedFile]', (p) => p.nodes),
    },
  },
  PullRequestChangedFile: {
    fields: {
      path: F('String', (p) => p.path),
    },
  },
  __Type: {
    fields: {
      name: F('String', (p) => p.name),
      kind: F('String', (p) => p.kind),
      fields: F('[__Field]', (p) => (p.info.fields ?? []).map((n) => ({ __typename: '__Field', name: n }))),
      enumValues: F('[__EnumValue]', (p) => (p.info.enumValues ?? []).map((n) => ({ __typename: '__EnumValue', name: n }))),
    },
  },
  __Field: {
    fields: {
      name: F('String', (p) => p.name),
    },
  },
  __EnumValue: {
    fields: {
      name: F('String', (p) => p.name),
    },
  },
  Mutation: {
    fields: {
      createIssue: F('CreateIssuePayload', (_p, args) => {
        const input = args.input ?? {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'R') throw new Error('Repository not found');
        const issue = decoded.repo.createIssue({ title: input.title ?? '', body: input.body ?? '' });
        return { __typename: 'CreateIssuePayload', issue: issueNode(decoded.repo, issue) };
      }),
      closeIssue: F('CloseIssuePayload', (_p, args) => {
        const input = args.input ?? {};
        const decoded = decodeGlobalId(input.issueId);
        if (!decoded || decoded.kind !== 'I') throw new Error('Issue not found');
        decoded.repo.patchIssue(decoded.issue.number, { state: 'closed' });
        return { __typename: 'CloseIssuePayload', issue: issueNode(decoded.repo, decoded.issue) };
      }),
      createPullRequest: F('CreatePullRequestPayload', (_p, args) => {
        const input = args.input ?? {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'R') throw new Error('Repository not found');
        const repo = decoded.repo;
        const headRef = input.headRefName;
        const baseRef = input.baseRefName;
        if (!repo.branchTip(headRef)) throw new Error(`head branch '${headRef}' does not exist`);
        if (!repo.branchTip(baseRef)) throw new Error(`base branch '${baseRef}' does not exist`);
        const pr = repo.createPull({ title: input.title ?? '', body: input.body ?? '', headRef, baseRef });
        return { __typename: 'CreatePullRequestPayload', pullRequest: prNode(repo, pr) };
      }),
      mergePullRequest: F('MergePullRequestPayload', (_p, args) => {
        const input = args.input ?? {};
        const decoded = decodeGlobalId(input.pullRequestId);
        if (!decoded || decoded.kind !== 'P') throw new Error('Pull request not found');
        const result = decoded.repo.mergePull(decoded.pr);
        if (!result.ok) throw new Error('Merge conflict: this pull request cannot be merged');
        return { __typename: 'MergePullRequestPayload', pullRequest: prNode(decoded.repo, decoded.pr) };
      }),
      addComment: F('AddCommentPayload', (_p, args) => {
        const input = args.input ?? {};
        const decoded = decodeGlobalId(input.subjectId);
        if (!decoded || decoded.kind !== 'I') throw new Error('Issue not found');
        const comment = decoded.repo.addComment(decoded.issue.number, input.body ?? '');
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo: decoded.repo, issue: decoded.issue, comment },
          },
        };
      }),
    },
  },
  CreateIssuePayload: {
    fields: { issue: F('Issue', (p) => p.issue) },
  },
  CloseIssuePayload: {
    fields: { issue: F('Issue', (p) => p.issue) },
  },
  CreatePullRequestPayload: {
    fields: { pullRequest: F('PullRequest', (p) => p.pullRequest) },
  },
  MergePullRequestPayload: {
    fields: { pullRequest: F('PullRequest', (p) => p.pullRequest) },
  },
  AddCommentPayload: {
    fields: { commentEdge: F('IssueCommentEdge', (p) => p.commentEdge) },
  },
  IssueCommentEdge: {
    fields: { node: F('IssueComment', (p) => p.node) },
  },
  IssueComment: {
    fields: {
      id: F('ID', (p) => commentGlobalId(p.repo, p.issue, p.comment)),
      body: F('String', (p) => p.comment.body),
    },
  },
};

// ------------------------------------------------------------------ validation

function unwrapType(t) {
  return t.replace(/[\[\]!]/g, '');
}

function validateSelections(selections, typeName, errors) {
  const typeDef = TYPES[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const target = sel.typeCondition ?? typeName;
      if (!TYPES[target]) {
        errors.push({ message: `Unknown type "${target}".` });
        continue;
      }
      validateSelections(sel.selections, target, errors);
      continue;
    }
    if (sel.name === '__typename') continue;
    if (!typeDef || !typeDef.fields[sel.name]) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      continue;
    }
    if (sel.selections) {
      validateSelections(sel.selections, unwrapType(typeDef.fields[sel.name].type), errors);
    }
  }
}

// ------------------------------------------------------------------- execution

function executeSelections(selections, parent, variables, errors) {
  const out = {};
  const typeName = parent.__typename;
  const typeDef = TYPES[typeName];
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(sel.selections, parent, variables, errors));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldDef = typeDef?.fields[sel.name];
    if (!fieldDef) continue; // validation already reported it
    let value;
    try {
      value = fieldDef.resolve(parent, resolveArgs(sel.args, variables));
    } catch (e) {
      errors.push({ message: e && e.message ? e.message : 'Field resolution failed' });
      out[key] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (!sel.selections) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === 'object' && item.__typename
          ? executeSelections(sel.selections, item, variables, errors)
          : item);
      continue;
    }
    if (typeof value === 'object' && value.__typename) {
      out[key] = executeSelections(sel.selections, value, variables, errors);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(op, variables) {
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const errors = [];
  validateSelections(op.selections, rootType, errors);
  if (errors.length > 0) return { data: null, errors };
  const root = { __typename: rootType };
  const data = executeSelections(op.selections, root, variables, errors);
  if (errors.length > 0) return { data, errors };
  return { data };
}

// ----------------------------------------------------------------- HTTP handler

export function handleGraphQL(ctx) {
  if (ctx.method !== 'POST') {
    return { status: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }
  let payload;
  try {
    payload = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Malformed JSON body' }) };
  }
  const runOne = (single) => {
    if (!single || typeof single.query !== 'string') {
      return { data: null, errors: [{ message: 'Must provide a query string.' }] };
    }
    let doc;
    try {
      doc = parseQuery(single.query);
    } catch (e) {
      return { data: null, errors: [{ message: e.message }] };
    }
    const variables = single.variables && typeof single.variables === 'object' ? single.variables : {};
    let op = doc.operations[0];
    if (single.operationName) {
      op = doc.operations.find((o) => o.name === single.operationName) ?? op;
    }
    return executeOperation(op, variables);
  };
  const result = Array.isArray(payload) ? payload.map(runOne) : runOne(payload);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  };
}
