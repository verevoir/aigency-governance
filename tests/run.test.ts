// The composition, driven end to end with fakes: no network, no filesystem,
// no environment read from the process. Everything `runReview` touches arrives
// as an argument, which is the property that makes this suite worth having —
// the real thing calls a paid API once per lens, and the tests below assert
// exactly when it must not.
//
// The recorder is split three ways on purpose. `factory` counts calls to the
// deps factory, which is where a real composition CONSTRUCTS a client; `read`
// and `reviewed` count the two things a client would then do. They are counted
// separately because they fail separately: a run that resolves settings, builds
// an Anthropic client and only then discovers there is no key has already done
// the work this ordering exists to avoid, and a suite that watched only
// `reviewed` would call that a pass.
import { describe, expect, it } from 'vitest';

import { runReview, type ReviewDeps } from '../src/cli/run.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';
import type { Reviewer } from '../src/review/panel.js';
import { NO_PRACTICES_NOTICE, type Subject } from '../src/review/prompt.js';
import {
  APPROVED_WORD,
  FINDING_MARKER,
  REJECTED_WORD,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';
import {
  DEFAULT_LENS_SOURCE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PRACTICES_MAX_CHARS,
  type ReviewSettings,
} from '../src/review/settings.js';

const SUBJECT: Subject = {
  title: 'S24a: the lens set',
  description: 'a definition, loaded once',
  diff: '+const x = 1;',
};

// A real definition, not a stub: the panel parses this with the production
// parser, so a test that passes here passes against the shape CI will fetch.
const TWO_LENSES = JSON.stringify({
  version: 1,
  lenses: [
    { id: 'correctness', title: 'Correctness', focus: 'does it do what it says' },
    { id: 'honesty', title: 'Honesty', focus: 'does it report what it observed' },
  ],
});

const APPROVE = `${VERDICT_MARKER} ${APPROVED_WORD}`;
const REJECT = `${VERDICT_MARKER} ${REJECTED_WORD}\n${FINDING_MARKER} a real finding`;

/**
 * A complete environment. Tests that care about one variable override that
 * one, so a test about the token count is not quietly also a test about a
 * missing key. Overriding with `undefined` removes a variable, which is what
 * an unset one looks like to `process.env`.
 */
function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    AIGENCY_REVIEW_LENSES_TOKEN: 'lens-token',
    ...overrides,
  };
}

interface Calls {
  /** Times the deps factory ran — where a real composition builds a client. */
  factory: number;
  /** The sources the reader was asked for. */
  read: string[];
  /** The lenses the reviewer was asked to judge. Money, one call each. */
  reviewed: string[];
  /**
   * The shared half of every prompt the reviewer was handed — the half the bar
   * travels in. Captured at the reviewer rather than read back off the panel,
   * because what matters is what a reviewer would actually have been sent.
   */
  shared: string[];
}

interface Harness {
  readonly deps: (settings: ReviewSettings) => ReviewDeps;
  readonly calls: Calls;
  /** What the factory was handed, so the wiring can be asserted on. */
  readonly settingsSeen: ReviewSettings[];
}

interface HarnessOptions {
  readonly found?: ReadResult;
  readonly reply?: Reviewer;
  /** The bar, when a test supplies one. Absent means the composition has none. */
  readonly practices?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: Calls = { factory: 0, read: [], reviewed: [], shared: [] };
  const settingsSeen: ReviewSettings[] = [];
  const found: ReadResult = options.found ?? { kind: 'text', text: TWO_LENSES };
  const reply: Reviewer = options.reply ?? (() => Promise.resolve(APPROVE));
  const practices = options.practices;

  const read: SourceReader = (source) => {
    calls.read.push(source);
    return Promise.resolve(found);
  };

  // Records the call BEFORE delegating, so a reviewer that throws still counts
  // as a call that was made — which is the number that costs money.
  const review: Reviewer = (lensId, prompt) => {
    calls.reviewed.push(lensId);
    calls.shared.push(prompt.shared);
    return reply(lensId, prompt);
  };

  return {
    deps: (settings) => {
      calls.factory += 1;
      settingsSeen.push(settings);
      // Spread rather than an explicit `practices: options.practices`: under
      // exactOptionalPropertyTypes a field set to undefined is not the same as
      // a field that is absent, and absent is what "no bar" means here.
      return { read, review, ...(practices === undefined ? {} : { practices }) };
    },
    calls,
    settingsSeen,
  };
}

describe('runReview, given a configuration it cannot use', () => {
  it('spends nothing when the token count is present and wrong', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_MAX_TOKENS: '4o96' }),
      SUBJECT,
      fakes.deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('AIGENCY_REVIEW_MAX_TOKENS');
    // The value they typed, echoed back. A complaint that does not quote the
    // offending value sends someone to re-read an environment they already
    // believe is correct.
    expect(outcome.report).toContain('4o96');
    expect(outcome.report).toContain('Nothing was reviewed');
    expect(fakes.calls.factory).toBe(0);
    // Weaker than it reads, and recorded as such: the reviewer only exists on
    // the object the factory returns, so nought calls follows from the line
    // above rather than being independent evidence.
    expect(fakes.calls.reviewed).toEqual([]);
  });

  it('spends nothing when the lens token is missing and the lens source needs one', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined }),
      SUBJECT,
      fakes.deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('AIGENCY_REVIEW_LENSES_TOKEN');
    expect(outcome.report).toContain('Nothing was reviewed');
    expect(fakes.calls.factory).toBe(0);
    expect(fakes.calls.reviewed).toEqual([]);
  });

  // A red result, not a green one, and not an exception either. The caller
  // gets something to print.
  it('reports a configuration failure as red rather than throwing', async () => {
    const outcome = await runReview({}, SUBJECT, harness().deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('red result, not a passing one');
  });
});

// The absence of a billed API key is no longer a configuration failure — see
// settings.ts's own file header. `runReview` proceeds exactly as it does on
// the billed route; it is `review.ts`, at the process boundary, that reads
// `settings.route` and constructs the keyless `claudeCliReviewer` instead of
// `anthropicReviewer`, so no billed client is ever built without a key. That
// half is not visible to `runReview`'s own fakes (the factory here is not a
// real reviewer construction) and is proven separately, end to end against
// the real compiled binary, by `scripts/check-cli.mjs`'s third scenario.
describe('runReview, given no API key configured at all', () => {
  it('proceeds to the panel on the keyless route, exactly as it would on the billed one', async () => {
    const fakes = harness();

    const outcome = await runReview(env({ ANTHROPIC_API_KEY: undefined }), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    expect(fakes.calls.factory).toBe(1);
    expect(fakes.settingsSeen[0]?.route).toBe('keyless');
    expect(fakes.calls.reviewed).toHaveLength(2);
  });
});

describe('runReview, given no key-file reader at all', () => {
  // `noKeyFile` in run.ts claims to behave as "every path absent" when no
  // fourth argument is supplied — this is what actually drives that default
  // rather than a stand-in for it. Its observable meaning changed with the
  // named-but-missing fix in settings.ts: a NAMED path
  // (ANTHROPIC_API_KEY_FILE) resolving to absent is now a configuration
  // error and blocks, rather than falling through to keyless — so the
  // default reader correctly BLOCKS this run, exactly as a real filesystem
  // would if that named path genuinely did not exist on the machine
  // running the suite.
  it('blocks, rather than resolving keyless, when ANTHROPIC_API_KEY_FILE is named and no reader is supplied', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      SUBJECT,
      fakes.deps,
      // No fourth argument — this is the default parameter under test.
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('/keys/anthropic');
    expect(outcome.report).toContain('Nothing was reviewed');
    expect(fakes.calls.factory).toBe(0);
  });

  // The genuinely-unnamed case, kept apart from the one above so the two
  // cannot be conflated: with no ANTHROPIC_API_KEY_FILE set at all, the
  // default reader is only ever asked for the CONVENTIONAL default path,
  // which is allowed to be absent — so this still resolves keyless, which
  // is the property this describe block originally existed to pin.
  it('resolves keyless when no reader is supplied and no key file was named at all', async () => {
    const fakes = harness();

    const outcome = await runReview(env({ ANTHROPIC_API_KEY: undefined }), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    expect(fakes.calls.factory).toBe(1);
    expect(fakes.settingsSeen[0]?.route).toBe('keyless');
    expect('apiKey' in (fakes.settingsSeen[0] ?? {})).toBe(false);
  });
});

describe('runReview, given a diff with nothing in it', () => {
  const nothing: readonly { readonly what: string; readonly diff: string }[] = [
    { what: 'empty', diff: '' },
    // Not the same test twice. A guard written as `diff === ''` passes the
    // case above and fails this one, and a workflow that produced a stray
    // newline instead of a diff is the same defect wearing a different hat.
    { what: 'whitespace only', diff: '\n  \t\n' },
  ];

  for (const { what, diff } of nothing) {
    it(`is red and constructs nothing when the diff is ${what}`, async () => {
      const fakes = harness();

      const outcome = await runReview(env(), { ...SUBJECT, diff }, fakes.deps);

      // The environment here is complete and the lens set loads: without the
      // guard this run reaches the panel, every lens approves an empty diff
      // and the outcome is a green 0. So the code below is what the guard
      // changed, and nothing else.
      expect(outcome.exitCode).toBe(1);
      expect(outcome.report).toContain('The diff was empty');
      // The wiring causes, named. A report that said only "empty diff" sends
      // someone to look at a change they can see is not empty.
      expect(outcome.report).toContain('wrong base');
      expect(outcome.report).toContain('shallow clone');
      expect(outcome.report).toContain('fetch depth of 1');
      expect(outcome.report).toContain('Nothing was reviewed');
      expect(fakes.calls.factory).toBe(0);
      expect(fakes.calls.read).toEqual([]);
      expect(fakes.calls.reviewed).toEqual([]);
    });
  }

  // Pins the ORDER, which the comment in run.ts asserts and nothing else
  // holds: a guard placed before resolveSettings would pass both tests above
  // and this one would go red. A configuration problem must be reported even
  // when the diff is empty, because it has to be fixed either way — and
  // "your diff is empty" sends someone to look at their workflow when what
  // they actually need is a secret. Uses the lens token now, not the API
  // key, as the genuine configuration failure — an absent key no longer is
  // one (see the describe block above).
  it('reports a missing setting rather than an empty diff when both are wrong', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_LENSES_TOKEN: undefined }),
      { ...SUBJECT, diff: '' },
      fakes.deps,
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('AIGENCY_REVIEW_LENSES_TOKEN');
    // The half that makes this a test of order rather than a second test of
    // the settings check: both faults are present, and only one of them may
    // be reported.
    expect(outcome.report).not.toContain('The diff was empty');
    expect(fakes.calls.factory).toBe(0);
  });
});

describe('runReview, given a lens set it cannot load', () => {
  // Every one of these is a run that reviewed NOTHING. The exit code is the
  // whole point: a definition that failed to load must not exit 0 on the
  // grounds that no lens complained.
  const unavailable: readonly { readonly why: string; readonly found: ReadResult }[] = [
    { why: 'missing', found: { kind: 'missing', reason: 'HTTP 404' } },
    { why: 'unreachable', found: { kind: 'unreachable', reason: 'HTTP 503' } },
    { why: 'malformed', found: { kind: 'text', text: '{ not json' } },
  ];

  for (const { why, found } of unavailable) {
    it(`is red, reviews nothing and says "${why}"`, async () => {
      const fakes = harness({ found });

      const outcome = await runReview(env(), SUBJECT, fakes.deps);

      expect(outcome.exitCode).toBe(1);
      expect(outcome.report).toContain(why);
      // Which definition failed, so a reader knows whose bar was unavailable
      // and where to go looking.
      expect(outcome.report).toContain(DEFAULT_LENS_SOURCE);
      expect(outcome.report).toContain('Nothing was reviewed');
      expect(fakes.calls.read).toEqual([DEFAULT_LENS_SOURCE]);
      // Also weaker than it reads: with no parsed set there is nothing to hand
      // the panel, so the types already forbid this. It is here because the
      // claim matters, not because it could plausibly fail alone.
      expect(fakes.calls.reviewed).toEqual([]);
    });
  }

  // The reason the three stay apart all the way to the report. A 404 is
  // someone's wrong URL, a 503 is an outage to wait out, and a parse error is
  // a bad commit to the definition — three different people, three different
  // actions. A single "could not load" tells none of them which they are.
  it('gives three distinguishable reports, not one', async () => {
    const reports = await Promise.all(
      unavailable.map(
        async ({ found }) => (await runReview(env(), SUBJECT, harness({ found }).deps)).report,
      ),
    );

    expect(new Set(reports).size).toBe(3);
  });
});

describe('runReview, when the panel runs', () => {
  it('exits 0 and says so when every lens approves', async () => {
    const fakes = harness();

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain('## Review: Approved');
    expect(outcome.report).toContain('Every lens reviewed and none had a finding.');
    expect([...fakes.calls.reviewed].sort()).toEqual(['correctness', 'honesty']);
  });

  it('exits 1 and carries the finding when one lens rejects', async () => {
    const fakes = harness({
      reply: (lensId) => Promise.resolve(lensId === 'honesty' ? REJECT : APPROVE),
    });

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('## Review: Rejected');
    expect(outcome.report).toContain('a real finding');
    expect(outcome.report).toContain('honesty');
  });

  // The half-run panel. Its findings are real and must survive, but they are
  // not the whole of what is there, so the result is could_not_run and red.
  it('is red when a reviewer throws, and still reports the lens that ran', async () => {
    const fakes = harness({
      reply: (lensId) =>
        lensId === 'honesty'
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(REJECT),
    });

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('## Review: Could not run');
    expect(outcome.report).toContain('1 of 2 lenses did not review');
    expect(outcome.report).toContain('socket hang up');
    // The work that did happen is not discarded on the way to the report.
    expect(outcome.report).toContain('a real finding');
  });

  it('names the source the definition actually came from', async () => {
    const fakes = harness();

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.report).toContain(DEFAULT_LENS_SOURCE);
  });

  // A report that named the default while a laptop run judged against a
  // checked-out copy would attribute a verdict to the wrong bar entirely.
  it('names the override, and not the default, when one is set', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_LENSES: './review/lenses.json' }),
      SUBJECT,
      fakes.deps,
    );

    expect(outcome.report).toContain('./review/lenses.json');
    expect(outcome.report).not.toContain(DEFAULT_LENS_SOURCE);
    expect(fakes.calls.read).toEqual(['./review/lenses.json']);
  });
});

describe('runReview, wiring the dependencies', () => {
  // The factory is handed the RESOLVED settings, defaults included. Handing it
  // the raw environment would mean the composition parsing the token count a
  // second time, in a second place, which is where the two would disagree
  // about what the run was configured to do.
  it('hands the factory the resolved settings, defaults and all', async () => {
    const fakes = harness();

    await runReview(env(), SUBJECT, fakes.deps);

    expect(fakes.calls.factory).toBe(1);
    expect(fakes.settingsSeen[0]).toEqual({
      route: 'billed',
      apiKey: 'sk-ant-test',
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      lensSource: DEFAULT_LENS_SOURCE,
      lensToken: 'lens-token',
      practicesMaxChars: DEFAULT_PRACTICES_MAX_CHARS,
    });
  });

  // The keyless counterpart to the test above — the exact shape a laptop
  // with no ANTHROPIC_API_KEY configured resolves to.
  it('hands the factory keyless settings, with no apiKey field, when no key is configured', async () => {
    const fakes = harness();

    await runReview(env({ ANTHROPIC_API_KEY: undefined }), SUBJECT, fakes.deps);

    expect(fakes.calls.factory).toBe(1);
    expect(fakes.settingsSeen[0]).toEqual({
      route: 'keyless',
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      lensSource: DEFAULT_LENS_SOURCE,
      lensToken: 'lens-token',
      practicesMaxChars: DEFAULT_PRACTICES_MAX_CHARS,
    });
  });

  // The bar reaching the reviewer. Without this, `runPanel(…, wired.practices)`
  // could lose its fourth argument and every lens would be prompted with
  // NO_PRACTICES_NOTICE while the suite stayed green — a panel judging against
  // nothing, reporting exactly as if it had judged against the bar.
  it('supplies the practices to every lens, not merely to the first', async () => {
    const fakes = harness({ practices: 'THE-BAR-MARKER: say what you observed' });

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    expect(fakes.calls.reviewed).toHaveLength(2);
    expect(fakes.calls.shared).toHaveLength(2);
    for (const shared of fakes.calls.shared) {
      expect(shared).toContain('THE-BAR-MARKER');
    }
  });

  // The other direction, and it is not decoration: without it the positive
  // test above passes for any implementation where the marker happens to
  // reach the prompt by some other route. Together they pin that the
  // composition supplies the bar when it has one and announces the absence
  // when it does not.
  it('announces the absence when the composition has no practices', async () => {
    const fakes = harness();

    await runReview(env(), SUBJECT, fakes.deps);

    expect(fakes.calls.shared).toHaveLength(2);
    for (const shared of fakes.calls.shared) {
      expect(shared).toContain(NO_PRACTICES_NOTICE);
    }
  });

  it('hands the factory the overrides the environment implied', async () => {
    const fakes = harness();

    await runReview(
      env({ AIGENCY_REVIEW_MODEL: 'claude-haiku-3', AIGENCY_REVIEW_MAX_TOKENS: '12000' }),
      SUBJECT,
      fakes.deps,
    );

    expect(fakes.settingsSeen[0]?.model).toBe('claude-haiku-3');
    expect(fakes.settingsSeen[0]?.maxTokens).toBe(12000);
  });

  // The non-blocking finding from the panel's review of ca48a7d: nothing
  // pinned that runReview actually threads settings.model into the report
  // context (ReportContext.model) — a silent regression there would stay
  // green. Asserted under an AIGENCY_REVIEW_MODEL override, not the
  // default, so this test would fail if run.ts passed DEFAULT_MODEL
  // instead of settings.model — proved by mutation (temporarily
  // hardcoding run.ts's `model` field and confirming this test turned
  // red) before this change was committed.
  it('passes the requested model into the report context, so the report names which model id the run was configured to use', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_MODEL: 'claude-haiku-3' }),
      SUBJECT,
      fakes.deps,
    );

    expect(outcome.report).toContain('model `claude-haiku-3`');
    expect(outcome.report).not.toContain(`model \`${DEFAULT_MODEL}\``);
  });
});

// THE JOIN. Both halves already existed and were already tested separately:
// `provision` (src/practices/provision.ts) reading a corpus, and `runPanel`
// threading a `practices` string to every lens (the describe block above).
// Nothing before this called the first from the second — `review.ts`'s deps
// factory omitted `practicesConsult` unconditionally, so every real run judged
// against NO_PRACTICES_NOTICE regardless of what any corpus held. These
// tests drive `practicesConsult`, the field that closes that gap, with no
// network and no real corpus — removing `resolvePractices`'s call in run.ts
// (or reverting `practicesConsult` to being ignored) turns every one of
// these red, which is the property that makes them worth having rather than
// a restatement of what `provision.test.ts` already proves in isolation.
describe('runReview, consulting a practices corpus', () => {
  const ONE_PRACTICE = JSON.stringify({
    version: 1,
    practices: [
      {
        id: 'p1',
        title: 'PRACTICES-BAR-MARKER',
        body: 'say what you observed, always',
      },
    ],
  });

  function corpusReaderReturning(found: ReadResult): SourceReader {
    return () => Promise.resolve(found);
  }

  it('reaches every lens with a real practice, via practicesConsult rather than a direct string', async () => {
    const fakes = harness();
    const asked: string[] = [];
    const practicesConsult = {
      source: 'https://corpus.test/practices.json',
      read: ((source: string) => {
        asked.push(source);
        return Promise.resolve({ kind: 'text', text: ONE_PRACTICE } as ReadResult);
      }) as SourceReader,
    };

    const outcome = await runReview(env(), SUBJECT, (settings) => ({
      ...fakes.deps(settings),
      practicesConsult,
    }));

    expect(outcome.exitCode).toBe(0);
    expect(fakes.calls.shared).toHaveLength(2);
    for (const shared of fakes.calls.shared) {
      expect(shared).toContain('PRACTICES-BAR-MARKER');
    }
    // The corpus source consulted is the one named in settings — not a
    // hardcoded stand-in — proving the source string actually threads through
    // rather than a fixed value happening to work.
    expect(asked).toEqual(['https://corpus.test/practices.json']);
  });

  it('fails the whole review, spending nothing on any lens, when the configured corpus cannot be read', async () => {
    const fakes = harness();
    const practicesConsult = {
      source: 'https://corpus.test/practices.json',
      read: corpusReaderReturning({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
    };

    const outcome = await runReview(env(), SUBJECT, (settings) => ({
      ...fakes.deps(settings),
      practicesConsult,
    }));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('practices corpus');
    expect(outcome.report).toContain('ECONNREFUSED');
    expect(outcome.report).toContain('Nothing was reviewed');
    // The fail-closed half: a corpus that is configured and broken must never
    // be quietly treated as "no corpus configured" — that would make the two
    // read identically, which is the exact collapse this join exists to
    // prevent. No lens is asked, so nothing is billed against a bar that was
    // never actually seen.
    expect(fakes.calls.reviewed).toEqual([]);
  });

  it('is red for a malformed corpus too, distinguishably from an unreachable one', async () => {
    const fakes = harness();
    const practicesConsult = {
      source: 's',
      read: corpusReaderReturning({ kind: 'text', text: '{ not json' }),
    };

    const outcome = await runReview(env(), SUBJECT, (settings) => ({
      ...fakes.deps(settings),
      practicesConsult,
    }));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('malformed');
    expect(fakes.calls.reviewed).toEqual([]);
  });

  it('marks the bar as partial, distinctly from a complete one, when the bound elides part of the corpus', async () => {
    const fakes = harness();
    const twoPractices = JSON.stringify({
      version: 1,
      practices: [
        { id: 'p1', title: 'T1', body: 'x'.repeat(40) },
        { id: 'p2', title: 'T2', body: 'y'.repeat(40) },
      ],
    });
    const practicesConsult = {
      source: 's',
      read: corpusReaderReturning({ kind: 'text', text: twoPractices }),
    };

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_PRACTICES_MAX_CHARS: '50' }),
      SUBJECT,
      (settings) => ({ ...fakes.deps(settings), practicesConsult }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(fakes.calls.shared.length).toBeGreaterThan(0);
    for (const shared of fakes.calls.shared) {
      expect(shared).toContain('T1');
      expect(shared).not.toContain('T2');
      expect(shared).toContain('NOTE:');
      expect(shared).toContain('This bar is partial');
    }
  });

  it('runs exactly as before — NO_PRACTICES_NOTICE, every lens — when no corpus is configured at all', async () => {
    const fakes = harness();

    const outcome = await runReview(env(), SUBJECT, fakes.deps);

    expect(outcome.exitCode).toBe(0);
    for (const shared of fakes.calls.shared) {
      expect(shared).toContain(NO_PRACTICES_NOTICE);
    }
  });
});
