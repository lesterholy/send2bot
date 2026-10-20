# plana-memos-sync

Local CLI for syncing PlanA memos into an Obsidian vault.

It lists Memos notes, filters for `#plana/tweet` and `#plana/scys`, extracts the JSON payload created by the PlanA extension, writes Markdown notes plus raw JSON files into the vault, and records local sync state so repeated runs are idempotent.

## Setup

Requires Node.js 22 or newer.

```bash
cd plana-memos-sync
npm install
npm test
```

No runtime dependencies are installed; the CLI uses Node's built-in `fetch`.

## Usage

```bash
node bin/plana-memos-sync.js \
  --api-url https://memos.example.com/api/v1 \
  --token memos_pat_xxx \
  --vault /path/to/ObsidianVault
```

Or use environment variables:

```bash
export MEMOS_API_URL=https://memos.example.com/api/v1
export MEMOS_ACCESS_TOKEN=memos_pat_xxx
export OBSIDIAN_VAULT=/path/to/ObsidianVault

node bin/plana-memos-sync.js
```

Default output:

```text
ObsidianVault/
  PlanA/
    2026-06-18/
      tweet-1234567890.md
    raw/
      2026-06-18/
        tweet-1234567890.json
  .plana-memos-sync/
    state.json
```

## Ack Mode

By default, the CLI does not modify Memos. It skips already-synced memos using the local state file.

To treat Memos as an inbox queue, archive each memo after it is written locally:

```bash
node bin/plana-memos-sync.js --archive-after-sync
```

This calls `PATCH /api/v1/memos/{memo}?updateMask=state` with `state: "ARCHIVED"` after the local files are written.

## Options

```text
--output-dir <dir>       Vault subdirectory (default: PlanA)
--state-file <path>      State file path (default: <vault>/.plana-memos-sync/state.json)
--tag <tag>              Comma-separated tags to sync (default: #plana/tweet,#plana/scys)
--page-size <n>          Memos page size (default: 100)
--max-pages <n>          Max pages to scan, 0 means unlimited (default: 10)
--state <state>          Memos state to list (default: NORMAL)
--archive-after-sync     Archive memo after local write succeeds
--force                  Rewrite even when updateTime is unchanged
--dry-run                Print summary without writing files/state or archiving
--verbose                Print written file paths
```

## Scheduling

Example cron entry:

```cron
*/15 * * * * cd /path/to/planA/plana-memos-sync && /usr/local/bin/node bin/plana-memos-sync.js >> /tmp/plana-memos-sync.log 2>&1
```

For macOS, a `launchd` job is usually a better fit if you want environment variables loaded from a fixed shell script.
