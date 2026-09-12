// No network and no writes to disk (with one deliberate, cleaned-up
// exception: the symlink-escape test below creates a real symlink in a
// scratch temp directory, because that is the one thing a fake filesystem
// cannot prove). The HTTP reader is exercised through a fake `FetchLike`,
// and the file reader is pointed at paths this repository already has —
// `package.json`, its own root directory, and a name that is not there —
// so every case is real I/O against something the test did not create.
//
// Most of these assert the difference between `missing` and `unreachable`.
// That distinction is the only reason these readers exist rather than a
// one-line `fetch`: a 403 reported as `missing` sends someone to check a URL
// that was correct all along.
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  citationFileReader,
  fileReader,
  httpReader,
  keyFileReader,
  lensFetchHeaders,
  lensReaderFor,
  listTrackedFiles,
  readerFor,
  type ExecFileLike,
  type FetchLike,
  type RawFetch,
} from '../src/review/readers.js';

type FetchResponse = Awaited<ReturnType<FetchLike>>;

interface FakeFetch {
  readonly impl: FetchLike;
  /** Every URL the reader asked for, in order. */
  readonly calls: string[];
}

function fakeFetch(respond: (url: string) => Promise<FetchResponse>): FakeFetch {
  const calls: string[] = [];
  return {
    calls,
    impl: (url) => {
      calls.push(url);
      return respond(url);
    },
  };
}

function serving(status: number, body: string): FakeFetch {
  return fakeFetch(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

/** A response whose headers arrived and whose body did not. */
function servingBrokenBody(message: string): FakeFetch {
  return fakeFetch(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error(message)),
    }),
  );
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));
const NOT_THERE = fileURLToPath(new URL('../no-such-lens-set.json', import.meta.url));
const THROUGH_A_FILE = fileURLToPath(new URL('../package.json/lenses.json', import.meta.url));

describe('httpReader', () => {
  it('returns a 200 body verbatim', async () => {
    const body = '{\n  "version": 1,\n  "lenses": []\n}  — trailing space and a dash \n';
    const result = await httpReader(serving(200, body).impl)('https://example.test/lenses.json');
    expect(result).toEqual({ kind: 'text', text: body });
  });

  // Empty and missing are two different answers, and a 200 serving nothing is
  // the empty one. Collapsing it into `missing` would blame the configuration
  // for a definition someone truncated.
  it('returns an empty 200 body as text, not as missing', async () => {
    const result = await httpReader(serving(200, '').impl)('https://example.test/lenses.json');
    expect(result).toEqual({ kind: 'text', text: '' });
  });

  it('asks for the source it was given, unchanged', async () => {
    const fetch = serving(200, 'body');
    await httpReader(fetch.impl)('https://example.test/a/b.json?v=1');
    expect(fetch.calls).toEqual(['https://example.test/a/b.json?v=1']);
  });

  it('reports a 404 as missing, naming the source', async () => {
    const result = await httpReader(serving(404, 'Not Found').impl)('https://example.test/l.json');
    expect(result.kind).toBe('missing');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('404');
    expect(result.reason).toContain('https://example.test/l.json');
  });

  // A 500 says the server broke, not that the definition is absent. Someone
  // told to check their URL will find it correct and lose the hour.
  it('reports a 500 as unreachable carrying the status, not as missing', async () => {
    const result = await httpReader(serving(500, 'Server Error').impl)('https://example.test/l');
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('500');
  });

  it('reports a 403 as unreachable, not as missing', async () => {
    const result = await httpReader(serving(403, 'Forbidden').impl)('https://example.test/l');
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('403');
  });

  it('reports a fetch that rejects as unreachable, carrying the message', async () => {
    const fetch = fakeFetch(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:443')));
    const result = await httpReader(fetch.impl)('https://example.test/l.json');
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('ECONNREFUSED 10.0.0.1:443');
  });

  it('reports a fetch that throws synchronously as unreachable', async () => {
    const impl: FetchLike = () => {
      throw new Error('Invalid URL');
    };
    const result = await httpReader(impl)('https://example.test/l.json');
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('Invalid URL');
  });

  // The response arrived and the body did not, which is an outage mid-transfer
  // and not an absent definition.
  it('reports a body that fails to read as unreachable, not as missing', async () => {
    const fetch = servingBrokenBody('aborted mid-body');
    const result = await httpReader(fetch.impl)('https://example.test/l.json');
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('aborted mid-body');
  });
});

describe('fileReader', () => {
  it('reads a file that is there', async () => {
    const result = await fileReader()(PACKAGE_JSON);
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('@verevoir/aigency-governance');
  });

  it('reports a path that does not exist as missing, naming the code and the path', async () => {
    const result = await fileReader()(NOT_THERE);
    expect(result.kind).toBe('missing');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('ENOENT');
    expect(result.reason).toContain(NOT_THERE);
  });

  // A path that runs through a file is a wrong path, which is the same class
  // of mistake as a name that is not there.
  it('reports a path that runs through a file as missing', async () => {
    const result = await fileReader()(THROUGH_A_FILE);
    expect(result.kind).toBe('missing');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('ENOTDIR');
  });

  // The directory exists. Reporting it as missing would say the opposite of
  // what is true, and send someone to look for a path that is right there.
  // The errno is asserted rather than merely the kind, because `unreachable`
  // is also what the `?? 'unknown'` fallback produces — reading the code back
  // is the only way to tell a classified error from an unclassified one. Node
  // opens a directory successfully and fails the read with EISDIR on both
  // macOS and Linux.
  it('reports a directory as unreachable, not as missing', async () => {
    const result = await fileReader()(REPO_ROOT);
    expect(result.kind).toBe('unreachable');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain('EISDIR');
  });
});

// The port `resolveSettings` is injected with. Different vocabulary from
// `fileReader` on purpose — `absent`/`unreadable`, not `missing`/`unreachable`
// — but the same real distinction underneath: a file nobody wrote is a
// different problem from one nobody can open.
describe('keyFileReader', () => {
  it('reads a file that is there, verbatim — untrimmed', async () => {
    const result = await keyFileReader()(PACKAGE_JSON);
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('@verevoir/aigency-governance');
  });

  it('reports a path that does not exist as absent, not as an error', async () => {
    const result = await keyFileReader()(NOT_THERE);
    expect(result).toEqual({ kind: 'absent' });
  });

  // A path that runs through a file is a wrong path, which is the same class
  // of mistake as a name that is not there.
  it('reports a path that runs through a file as absent', async () => {
    const result = await keyFileReader()(THROUGH_A_FILE);
    expect(result).toEqual({ kind: 'absent' });
  });

  // The directory exists. Reporting it as absent would say the opposite of
  // what is true, and send someone looking for a file that is right there —
  // and the reason names the failure, never any bytes, because a failed open
  // never read any.
  it("reports a directory as unreadable, naming the failure and not the path's contents", async () => {
    const result = await keyFileReader()(REPO_ROOT);
    expect(result.kind).toBe('unreadable');
    if (result.kind !== 'unreadable') throw new Error('unreachable');
    expect(result.reason).toContain('EISDIR');
  });
});

// citations.ts's real, filesystem-AND-git-touching implementation. `path`
// here is relative to `repoRoot`, matching what a citation actually carries
// — unlike `fileReader`/`keyFileReader` above, which this suite drives with
// absolute paths.
describe('citationFileReader', () => {
  it('reads a file that is tracked and there, verbatim', async () => {
    const result = await citationFileReader(REPO_ROOT, new Set(['package.json']))('package.json');
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('@verevoir/aigency-governance');
  });

  // The vulnerability this fix closes (PR #20's own review, blast-radius
  // lens, blocking): an untracked file — the shape a gitignored `.env`
  // takes — is refused before any read is attempted, even though the path
  // exists on disk and would otherwise read fine.
  it('refuses a path that is not in the tracked-files set, without reading it', async () => {
    const result = await citationFileReader(REPO_ROOT, new Set())('package.json');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toContain('not tracked');
  });

  it('reports a tracked path that does not actually exist on disk as missing, naming the code', async () => {
    const result = await citationFileReader(
      REPO_ROOT,
      new Set(['no-such-lens-set.json']),
    )('no-such-lens-set.json');
    expect(result.kind).toBe('missing');
    if (result.kind !== 'missing') throw new Error('unreachable');
    expect(result.reason).toContain('ENOENT');
  });

  it('reports a tracked path that runs through a file as missing', async () => {
    const result = await citationFileReader(
      REPO_ROOT,
      new Set(['package.json/lenses.json']),
    )('package.json/lenses.json');
    expect(result.kind).toBe('missing');
    if (result.kind !== 'missing') throw new Error('unreachable');
    expect(result.reason).toContain('ENOTDIR');
  });

  // Layer 3: a symlink that IS tracked can still point outside the
  // checkout. Built with a real symlink in scratch temp directories —
  // separate from REPO_ROOT — so `realpath` genuinely resolves outside the
  // fake checkout root passed in as `repoRoot`, the one thing a fake
  // filesystem cannot prove.
  it('refuses a path that resolves outside the checkout via a symlink, even though it is "tracked"', async () => {
    const outsideDir = await mkdtemp(joinPath(tmpdir(), 'citation-escape-'));
    const linkDir = await mkdtemp(joinPath(tmpdir(), 'citation-repo-'));
    try {
      const outsideFile = joinPath(outsideDir, 'secret.ts');
      await writeFile(outsideFile, 'export const SECRET = 1;\n', 'utf8');
      const linkPath = joinPath(linkDir, 'escape.ts');
      await symlink(outsideFile, linkPath);

      const result = await citationFileReader(linkDir, new Set(['escape.ts']))('escape.ts');
      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('unreachable');
      expect(result.reason).toContain('outside the repository');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await rm(linkDir, { recursive: true, force: true });
    }
  });
});

describe('listTrackedFiles', () => {
  it('returns the tracked paths git ls-files reports, split on newlines', async () => {
    const exec: ExecFileLike = () => Promise.resolve({ stdout: 'a.ts\nb.ts\n' });
    const result = await listTrackedFiles('/irrelevant', exec);
    expect(result).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('drops the trailing blank line rather than treating it as a tracked empty path', async () => {
    const exec: ExecFileLike = () => Promise.resolve({ stdout: 'a.ts\n' });
    const result = await listTrackedFiles('/irrelevant', exec);
    expect(result.has('')).toBe(false);
    expect(result.size).toBe(1);
  });

  // Fails CLOSED: every citation must be refused as untracked when git
  // itself cannot answer, never treated as unrestricted.
  it('returns an empty set, not a thrown error, when the exec itself fails', async () => {
    const exec: ExecFileLike = () => Promise.reject(new Error('git: command not found'));
    const result = await listTrackedFiles('/irrelevant', exec);
    expect(result).toEqual(new Set());
  });

  // The real, unmocked path (no injected exec) — proves the production
  // default actually finds this repository's own tracked files.
  it("finds this repository's own tracked files, using the real git binary", async () => {
    const result = await listTrackedFiles(REPO_ROOT);
    expect(result.has('package.json')).toBe(true);
  });
});

// Asserted by behaviour throughout: did the source reach the fake fetch, or
// did it reach the disk? Inspecting the returned function would test how the
// choice is implemented rather than which reader was chosen.
describe('readerFor', () => {
  it('sends an http:// source over fetch', async () => {
    const fetch = serving(200, 'over the network');
    const result = await readerFor(
      'http://example.test/l.json',
      fetch.impl,
    )('http://example.test/l.json');
    expect(fetch.calls).toEqual(['http://example.test/l.json']);
    expect(result).toEqual({ kind: 'text', text: 'over the network' });
  });

  it('sends an https:// source over fetch', async () => {
    const fetch = serving(200, 'over the network');
    const result = await readerFor(
      'https://example.test/l.json',
      fetch.impl,
    )('https://example.test/l.json');
    expect(fetch.calls).toEqual(['https://example.test/l.json']);
    expect(result).toEqual({ kind: 'text', text: 'over the network' });
  });

  // Each of these must reach the disk. The fake would answer with a 200 if it
  // were asked, so a reader picked wrongly here fails on the result as well as
  // on the call log.
  for (const source of ['no-such-lens-set.json', './no-such-lens-set.json']) {
    it(`reads ${source} from disk`, async () => {
      const fetch = serving(200, 'over the network');
      const result = await readerFor(source, fetch.impl)(source);
      expect(fetch.calls).toEqual([]);
      expect(result.kind).toBe('missing');
      if (result.kind === 'text') throw new Error('unreachable');
      expect(result.reason).toContain('ENOENT');
    });
  }

  // `file:` is a URL scheme and still not a fetch: there is no third case, and
  // treating it as a path gives `missing` with the path in it, which is a
  // better answer than a clever one.
  it('treats a file: URL as a path rather than something to fetch', async () => {
    const fetch = serving(200, 'over the network');
    const source = 'file:///no-such-lens-set.json';
    const result = await readerFor(source, fetch.impl)(source);
    expect(fetch.calls).toEqual([]);
    expect(result.kind).toBe('missing');
    if (result.kind === 'text') throw new Error('unreachable');
    expect(result.reason).toContain(source);
  });
});

// The security property the README documents: the lens-set bearer token
// never leaves the one host it exists for, no matter what
// AIGENCY_REVIEW_LENSES was set to. A caller who points that variable at a
// third party must get an anonymous fetch, not their token forwarded to a
// stranger.
describe('lensFetchHeaders', () => {
  const TOKEN = 'gh-token-for-the-private-lens-repo';

  it('attaches the token and the github accept header on the expected host', () => {
    const headers = lensFetchHeaders(
      'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json',
      TOKEN,
    );
    expect(headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github.raw',
    });
  });

  // The discriminating case: a source on any other host gets no
  // authorization header at all — asserted as absence, not as something else
  // being present, because a redacted or substituted value sent to the wrong
  // host is still a defect this must rule out.
  it('sends no authorization header at all to a different host', () => {
    const headers = lensFetchHeaders('https://evil.example/lenses.json', TOKEN);
    expect('authorization' in headers).toBe(false);
    expect(headers).toEqual({});
  });

  // A host that merely contains the expected one, rather than being it, must
  // not pass — a startsWith or includes check would be fooled by exactly this.
  it('sends no authorization header to a look-alike host', () => {
    const headers = lensFetchHeaders('https://raw.githubusercontent.com.evil.example/x', TOKEN);
    expect('authorization' in headers).toBe(false);
  });

  it('sends no authorization header when there is no token to send', () => {
    const headers = lensFetchHeaders(
      'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json',
      undefined,
    );
    expect(headers).toEqual({});
  });

  // A URL that cannot even be parsed is not one this can prove is safe to
  // send a credential to, so it is treated the same as a mismatched host
  // rather than throwing.
  it('sends no authorization header for a URL that does not parse', () => {
    const headers = lensFetchHeaders('not a url at all', TOKEN);
    expect(headers).toEqual({});
  });
});

// The wiring itself, not just the pure decision. A hand-written call site at
// the process boundary, naming a URL and a token together itself, would have
// nothing proving the arguments arrive in the right order — every test
// driving `lensFetchHeaders` directly passes regardless of whether that call
// site got it right. Driving `lensReaderFor` end to end, through a fake
// two-argument fetch, proves the actual outgoing call carries — or omits —
// the header, rather than only proving the header-computing function would be
// right if called correctly.
describe('lensReaderFor', () => {
  const TOKEN = 'gh-token-for-the-private-lens-repo';
  const EXPECTED_HOST_SOURCE =
    'https://raw.githubusercontent.com/verevoir/aigency-governance/main/review/lenses.json';

  interface RawCall {
    readonly url: string;
    readonly headers: Record<string, string>;
  }

  function fakeRawFetch(body: string): { readonly impl: RawFetch; readonly calls: RawCall[] } {
    const calls: RawCall[] = [];
    return {
      calls,
      impl: (url, init) => {
        calls.push({ url, headers: init.headers });
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
      },
    };
  }

  it('sends the token to the expected host, through the actual call the reader makes', async () => {
    const fetch = fakeRawFetch('lens set body');
    const result = await lensReaderFor(
      { lensSource: EXPECTED_HOST_SOURCE, lensToken: TOKEN },
      fetch.impl,
    )(EXPECTED_HOST_SOURCE);

    expect(result).toEqual({ kind: 'text', text: 'lens set body' });
    expect(fetch.calls).toEqual([
      {
        url: EXPECTED_HOST_SOURCE,
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github.raw' },
      },
    ]);
  });

  // The discriminating case, driven end to end: a source on any other host
  // reaches the actual outgoing fetch call with no authorization header at
  // all — asserted on the call the fake recorded, not on the pure function.
  it('sends no authorization header at all to a different host, through the actual call', async () => {
    const source = 'https://evil.example/lenses.json';
    const fetch = fakeRawFetch('whatever a stranger serves');

    await lensReaderFor({ lensSource: source, lensToken: TOKEN }, fetch.impl)(source);

    expect(fetch.calls).toHaveLength(1);
    expect('authorization' in (fetch.calls[0]?.headers ?? {})).toBe(false);
    expect(fetch.calls[0]?.headers).toEqual({});
  });

  it('reads from disk, never touching rawFetch at all, when the source is a path', async () => {
    const fetch = fakeRawFetch('should never be served');

    const result = await lensReaderFor(
      { lensSource: PACKAGE_JSON, lensToken: TOKEN },
      fetch.impl,
    )(PACKAGE_JSON);

    expect(fetch.calls).toEqual([]);
    expect(result.kind).toBe('text');
  });
});
