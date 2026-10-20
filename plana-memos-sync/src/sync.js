import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TAGS = ['#plana/tweet', '#plana/scys'];
const DEFAULT_OUTPUT_DIR = 'PlanA';

export async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const result = await syncMemos(options);
  printSummary(result, options);
}

export async function syncMemos(inputOptions) {
  const options = normalizeOptions(inputOptions);
  const state = await readState(options.stateFile);
  const listedMemos = await listMemos(options);
  const candidates = listedMemos.filter((memo) => options.tags.some((tag) => (memo.content || '').includes(tag)));

  const result = {
    scanned: listedMemos.length,
    matched: candidates.length,
    written: 0,
    skipped: 0,
    archived: 0,
    failed: 0,
    files: [],
    errors: [],
  };

  for (const memo of candidates) {
    const memoKey = memo.name || memo.uid || memo.id;
    if (!memoKey) {
      result.failed += 1;
      result.errors.push('Skipped memo without name/id');
      continue;
    }

    const known = state.memos[memoKey];
    if (!options.force && known?.updateTime === memo.updateTime) {
      result.skipped += 1;
      continue;
    }

    try {
      const writeResult = await writeMemoToVault(memo, options);
      result.written += 1;
      result.files.push(writeResult.notePath);
      if (writeResult.rawPath) result.files.push(writeResult.rawPath);

      if (options.archiveAfterSync && !options.dryRun) {
        await archiveMemo(memo, options);
        result.archived += 1;
      }

      state.memos[memoKey] = {
        updateTime: memo.updateTime || null,
        notePath: writeResult.notePath,
        rawPath: writeResult.rawPath || null,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${memoKey}: ${errorMessage(error)}`);
    }
  }

  state.lastRunAt = new Date().toISOString();
  if (!options.dryRun) {
    await writeState(options.stateFile, state);
  }

  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--archive-after-sync') {
      options.archiveAfterSync = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;
    options[toCamelCase(key)] = value;
  }
  return options;
}

function normalizeOptions(options) {
  const apiUrl = normalizeMemosApiUrl(options.apiUrl || process.env.MEMOS_API_URL);
  const token = options.token || process.env.MEMOS_ACCESS_TOKEN || process.env.MEMOS_TOKEN;
  const vault = options.vault || process.env.OBSIDIAN_VAULT;

  if (!apiUrl) {
    throw new Error('Missing Memos API URL. Use --api-url or MEMOS_API_URL.');
  }
  if (!token) {
    throw new Error('Missing Memos access token. Use --token or MEMOS_ACCESS_TOKEN.');
  }
  if (!vault) {
    throw new Error('Missing Obsidian vault path. Use --vault or OBSIDIAN_VAULT.');
  }

  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const stateFile = options.stateFile
    ? path.resolve(options.stateFile)
    : path.join(path.resolve(vault), '.plana-memos-sync', 'state.json');

  return {
    apiUrl,
    token,
    vault: path.resolve(vault),
    outputDir,
    stateFile,
    tags: parseTags(options.tag || options.tags),
    pageSize: parsePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE),
    maxPages: parseNonNegativeInteger(options.maxPages, DEFAULT_MAX_PAGES),
    state: options.state || 'NORMAL',
    archiveAfterSync: Boolean(options.archiveAfterSync),
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    verbose: Boolean(options.verbose),
  };
}

function normalizeMemosApiUrl(apiUrl) {
  if (!apiUrl) return '';
  const rawUrl = apiUrl.trim().replace(/\/+$/, '');
  const url = new URL(rawUrl);
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/api/v1';
  }
  return url.toString().replace(/\/+$/, '');
}

async function listMemos(options) {
  const memos = [];
  let pageToken = '';
  let pageCount = 0;

  do {
    pageCount += 1;
    const url = new URL(`${options.apiUrl}/memos`);
    url.searchParams.set('pageSize', String(options.pageSize));
    url.searchParams.set('state', options.state);
    url.searchParams.set('orderBy', 'create_time desc');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await requestJson(url, {
      method: 'GET',
      token: options.token,
    });

    if (!Array.isArray(payload.memos)) {
      throw new Error('Unexpected Memos API response: missing memos[]');
    }

    memos.push(...payload.memos);
    pageToken = payload.nextPageToken || '';
  } while (pageToken && (options.maxPages === 0 || pageCount < options.maxPages));

  return memos;
}

async function requestJson(url, { method, token, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload || {};
}

async function writeMemoToVault(memo, options) {
  const payload = parsePlanAPayload(memo.content || '');
  const identity = buildMemoIdentity(memo, payload);
  const date = dateSegment(payload?.captured_at || memo.createTime || new Date().toISOString());
  const noteRelPath = path.join(options.outputDir, date, `${identity.fileName}.md`);
  const rawRelPath = payload ? path.join(options.outputDir, 'raw', date, `${identity.fileName}.json`) : null;
  const notePath = path.join(options.vault, noteRelPath);
  const rawPath = rawRelPath ? path.join(options.vault, rawRelPath) : null;
  const syncedAt = new Date().toISOString();
  const note = buildObsidianNote({ memo, payload, identity, rawRelPath, syncedAt });

  if (!options.dryRun) {
    await mkdir(path.dirname(notePath), { recursive: true });
    await writeFile(notePath, note, 'utf8');
    if (payload && rawPath) {
      await mkdir(path.dirname(rawPath), { recursive: true });
      await writeFile(rawPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
  }

  return {
    notePath,
    rawPath,
  };
}

function parsePlanAPayload(content) {
  const blocks = extractFencedBlocks(content);
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block.body);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Ignore non-JSON code blocks.
    }
  }
  return null;
}

function extractFencedBlocks(content) {
  const blocks = [];
  const pattern = /(`{3,})([^\n]*)\n([\s\S]*?)\n\1/g;
  let match = pattern.exec(content);
  while (match) {
    blocks.push({
      fence: match[1],
      info: match[2].trim(),
      body: match[3],
    });
    match = pattern.exec(content);
  }
  return blocks;
}

function buildMemoIdentity(memo, payload) {
  const source = payload?.data_source || (payload?.tweet_id ? 'tweet' : 'memo');
  const itemId = payload?.id || payload?.tweet_id || payload?.scys_entity_id || extractTweetId(payload?.source_url || memo.content || '');
  const memoId = (memo.name || memo.uid || memo.id || 'memo').split('/').pop();
  const baseName = itemId || memoId;
  return {
    source,
    itemId: itemId || null,
    fileName: sanitizeFileName(`${source}-${baseName || 'memo'}`),
  };
}

function extractTweetId(text) {
  const match = String(text).match(/status\/(\d+)/);
  return match ? match[1] : null;
}

function buildObsidianNote({ memo, payload, identity, rawRelPath, syncedAt }) {
  const sourceUrl = payload?.source_url || '';
  const capturedAt = payload?.captured_at || memo.createTime || '';
  const rawLink = rawRelPath ? rawRelPath.split(path.sep).join('/') : '';
  const frontmatter = [
    '---',
    'source: memos',
    `memo: ${yamlString(memo.name || '')}`,
    `data_source: ${yamlString(identity.source)}`,
    identity.itemId ? `item_id: ${yamlString(identity.itemId)}` : null,
    payload?.tweet_id ? `tweet_id: ${yamlString(payload.tweet_id)}` : null,
    payload?.scys_entity_id ? `scys_entity_id: ${yamlString(payload.scys_entity_id)}` : null,
    sourceUrl ? `source_url: ${yamlString(sourceUrl)}` : null,
    capturedAt ? `captured_at: ${yamlString(capturedAt)}` : null,
    `synced_at: ${yamlString(syncedAt)}`,
    'tags:',
    `  - ${identity.source === 'scys_topic' ? 'plana/scys' : 'plana/tweet'}`,
    '---',
    '',
  ].filter((line) => line !== null);

  const body = [
    `# PlanA ${identity.source}${identity.itemId ? ` ${identity.itemId}` : ''}`,
    '',
    sourceUrl ? `[Open source](${sourceUrl})` : '',
    rawLink ? `Raw JSON: [${path.basename(rawLink)}](${encodeURI(rawLink)})` : '',
    '',
    '## Memos Content',
    '',
    memo.content || '',
    '',
  ].filter((line, index, array) => line || array[index - 1] !== '');

  return `${frontmatter.join('\n')}${body.join('\n')}`;
}

async function archiveMemo(memo, options) {
  const memoId = (memo.name || '').split('/').pop();
  if (!memoId) {
    throw new Error('Cannot archive memo without resource name');
  }

  const url = new URL(`${options.apiUrl}/memos/${encodeURIComponent(memoId)}`);
  url.searchParams.set('updateMask', 'state');
  await requestJson(url, {
    method: 'PATCH',
    token: options.token,
    body: {
      name: memo.name,
      state: 'ARCHIVED',
    },
  });
}

async function readState(stateFile) {
  try {
    const text = await readFile(stateFile, 'utf8');
    const parsed = JSON.parse(text);
    return {
      version: 1,
      memos: {},
      ...parsed,
      memos: parsed.memos || {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, memos: {}, lastRunAt: null };
    }
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function printSummary(result, options) {
  const lines = [
    `Scanned memos: ${result.scanned}`,
    `Matched ${options.tags.join(', ')}: ${result.matched}`,
    `Written: ${result.written}`,
    `Skipped: ${result.skipped}`,
    `Archived: ${result.archived}`,
    `Failed: ${result.failed}`,
  ];

  if (options.dryRun) lines.push('Dry run: no files or state were written.');
  if (options.verbose && result.files.length) {
    lines.push('', 'Files:');
    lines.push(...result.files.map((file) => `- ${file}`));
  }
  if (result.errors.length) {
    lines.push('', 'Errors:');
    lines.push(...result.errors.map((error) => `- ${error}`));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function helpText() {
  return `plana-memos-sync

Sync PlanA memos into an Obsidian vault.

Usage:
  plana-memos-sync --api-url <url> --token <token> --vault <path> [options]

Environment:
  MEMOS_API_URL        Memos API base URL, e.g. https://memos.example.com/api/v1
  MEMOS_ACCESS_TOKEN   Memos Personal Access Token
  OBSIDIAN_VAULT       Obsidian vault path

Options:
  --output-dir <dir>       Vault subdirectory (default: X-Tweets)
  --state-file <path>      State file path (default: <vault>/.plana-memos-sync/state.json)
  --tag <tag>              Memo tag to sync; repeat with comma-separated tags
                           (default: #plana/tweet,#plana/scys)
  --page-size <n>          Memos page size (default: 100)
  --max-pages <n>          Max pages to scan, 0 means unlimited (default: 10)
  --state <state>          Memos state to list (default: NORMAL)
  --archive-after-sync     Archive memo after local write succeeds
  --force                  Rewrite even when updateTime is unchanged
  --dry-run                Print summary without writing files/state or archiving
  --verbose                Print written file paths
  --help                   Show this help
`;
}

function dateSegment(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'memo';
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseTags(value) {
  if (!value) return DEFAULT_TAGS;
  const tags = String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : DEFAULT_TAGS;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
