# github-core-clone-01-entry-2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/zhangzzz1878/github-core-clone-01-entry-2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/zhangzzz1878/github-core-clone-01-entry-2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub core clone in dependency-free Node: git smart HTTP (v0 + v2 upload-pack, receive-pack), the REST v3 API, a GraphQL API with cursor pagination, and an MCP server — all backed by one in-memory store with deterministic ids and timestamps.

## Run it

```sh
node --experimental-strip-types main.ts
```

In the graded trial the entry binds an ephemeral port and registers with the trial environment via `MAKEFUN_ENV_URL`; without it, it listens on `$PORT` (default 3000) for local development. API calls require `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4mdg389a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
