// The composition, driven end to end with fakes: no network, no filesystem,
// no environment read from the process. Everything `runReview` touches arrives
// as an argument, which is the property that makes this suite worth having —
// the real thing calls a paid API once per lens, and the tests below assert
// exactly when it must not.
//
// The recorder is split four ways on purpose. `factory` counts calls to the
// reviewer's deps factory, which is where a real composition constructs the
// paid client; `readerBuilt` counts calls to the SEPARATE lens-reader
// factory, which needs only the lens source and token and nothing else;
// `read` and `reviewed` count the two things a client would then do. They
// are counted separately because they fail separately: a run that resolves
// settings, builds an Anthropic client and only then discovers there is no
// key has already done the work this ordering exists to avoid, and a suite
// that watched only `reviewed` would call that a pass. The split between
// `factory` and `readerBuilt` is what lets a test prove the lens set was
// checked (`readerBuilt` and `read` both non-zero) in the same run where no
// paid client was ever built (`factory` zero) — the exact shape of the fix
// this file exists to verify.
import { describe, expect, it } from 'vitest';

import { runReview, type LensReaderFactory, type ReviewDeps } from '../src/cli/run.js';
import type { ReadResult, SourceReader } from '../src/review/load.js';
import type { Reviewer } from '../src/review/panel.js';
import { NO_PRACTICES_NOTICE, type Subject } from '../src/review/prompt.js';
import {
  APPROVED_WORD,
  EVIDENCE_MARKER,
  FINDING_MARKER,
  REJECTED_WORD,
  VERDICT_MARKER,
} from '../src/review/replyContract.js';
import {
  DEFAULT_LENS_SOURCE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
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
// Carries evidence genuinely present in SUBJECT.diff, so the rejection this
// builds is one verifyFindings.ts actually lets stand — the two tests that use
// this are about what happens to a SOUND rejection (it survives; it survives
// a sibling lens throwing), not about verification failing.
const REJECT = `${VERDICT_MARKER} ${REJECTED_WORD}\n${FINDING_MARKER} a real finding\n${EVIDENCE_MARKER} const x = 1;`;

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
  /** Times the reviewer's deps factory ran — where a real composition builds
   * the paid client. */
  factory: number;
  /** Times the SEPARATE lens-reader factory ran — needs only lens access,
   * never the key. */
  readerBuilt: number;
  /** The sources the reader was actually asked for. */
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
  readonly buildReader: LensReaderFactory;
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
  const calls: Calls = { factory: 0, readerBuilt: 0, read: [], reviewed: [], shared: [] };
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
      return { review, ...(practices === undefined ? {} : { practices }) };
    },
    // Takes only lens access — the same `read` function is returned every
    // time, regardless of what it is called with, which is deliberate: what
    // matters for these tests is whether the reader was reachable and reached,
    // not what it was built from.
    buildReader: () => {
      calls.readerBuilt += 1;
      return read;
    },
    calls,
    settingsSeen,
  };
}

describe('runReview, given a configuration it cannot use', () => {
  it('spends nothing when there is no API key, but still checks the lens set', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
    );

    // The assertion this file exists for. Not "no model call" — no CLIENT.
    // The factory is where a key is read and a connection is configured, and
    // a run that gets that far before checking has already done the work.
    // The lens set, by contrast, HAS been checked — `read` was called and
    // succeeded — because loadLensSet has no real dependency on the key.
    // One whole-value comparison rather than five separate assertions, so a
    // future change that drops one of these facts fails the same test that
    // catches the others, not a differently-worded one nobody ran.
    expect({
      exitCode: outcome.exitCode,
      namesKey: outcome.report.includes('ANTHROPIC_API_KEY'),
      namesNothingReviewed: outcome.report.includes('Nothing was reviewed'),
      factory: fakes.calls.factory,
      read: fakes.calls.read,
      reviewed: fakes.calls.reviewed,
      verdict: outcome.verdict,
    }).toEqual({
      exitCode: 1,
      namesKey: true,
      namesNothingReviewed: true,
      factory: 0,
      read: [DEFAULT_LENS_SOURCE],
      reviewed: [],
      verdict: undefined,
    });
  });

  it('spends nothing when the token count is present and wrong, but still checks the lens set', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_MAX_TOKENS: '4o96' }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
    );

    expect({
      exitCode: outcome.exitCode,
      namesSetting: outcome.report.includes('AIGENCY_REVIEW_MAX_TOKENS'),
      // The value they typed, echoed back. A complaint that does not quote the
      // offending value sends someone to re-read an environment they already
      // believe is correct.
      namesValue: outcome.report.includes('4o96'),
      namesNothingReviewed: outcome.report.includes('Nothing was reviewed'),
      factory: fakes.calls.factory,
      // Weaker than it reads, and recorded as such: the reviewer only exists on
      // the object the factory returns, so nought calls follows from `factory`
      // being nought rather than being independent evidence.
      reviewed: fakes.calls.reviewed,
    }).toEqual({
      exitCode: 1,
      namesSetting: true,
      namesValue: true,
      namesNothingReviewed: true,
      factory: 0,
      reviewed: [],
    });
  });

  // A red result, not a green one, and not an exception either. The caller
  // gets something to print.
  it('reports a configuration failure as red rather than throwing', async () => {
    const fakes = harness();

    const outcome = await runReview({}, SUBJECT, fakes.deps, fakes.buildReader);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('red result, not a passing one');
    // No panel ran, so there is no Verdict to report — not a fabricated
    // empty one, which would be indistinguishable from an approval.
    expect(outcome.verdict).toBeUndefined();
  });
});

// The guard that stops this system failing silently. Every other red result
// here is something going wrong loudly; this is the one where everything
// works perfectly and reviews nothing.
// Not a `resolveSettings` test wearing a `runReview` hat: `resolveSettings`
// is always driven here with an INJECTED reader, real or fake, and that
// leaves the one thing only `runReview` itself can answer untested — what
// happens when a caller supplies no fifth argument at all. `noKeyFile` in
// run.ts claims to behave as "every path absent"; this is what actually
// drives that default rather than a stand-in for it.
describe('runReview, given no key-file reader at all', () => {
  it('treats ANTHROPIC_API_KEY_FILE as unreachable when no reader is supplied', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_API_KEY_FILE: '/keys/anthropic' }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
      // No fifth argument — this is the default parameter under test.
    );

    // If the default silently supplied a real filesystem, or resolved the
    // path some other way, this would either find nothing (same result,
    // wrong reason) or crash reading a path that does not exist on this
    // machine. Asserting the report names the key as unconfigured, rather
    // than erroring or reaching the panel, is what pins it to "every path
    // absent" specifically.
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('ANTHROPIC_API_KEY');
    expect(outcome.report).toContain('Nothing was reviewed');
    expect(fakes.calls.factory).toBe(0);
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
    it(`is red and constructs no reviewer when the diff is ${what}, though the lens set is still checked`, async () => {
      const fakes = harness();

      const outcome = await runReview(env(), { ...SUBJECT, diff }, fakes.deps, fakes.buildReader);

      // The environment here is complete and the lens set loads: without the
      // guard this run reaches the panel, every lens approves an empty diff
      // and the outcome is a green 0. The diff-emptiness check is what stops
      // that. It runs independently of the lens-set check below, which is
      // why `read` is non-empty here even though the diff is what is wrong —
      // that is the fix this file makes, not a leftover to explain away.
      expect({
        exitCode: outcome.exitCode,
        namesEmptyDiff: outcome.report.includes('The diff was empty'),
        // The wiring causes, named. A report that said only "empty diff"
        // sends someone to look at a change they can see is not empty.
        namesWrongBase: outcome.report.includes('wrong base'),
        namesShallowClone: outcome.report.includes('shallow clone'),
        namesFetchDepth: outcome.report.includes('fetch depth of 1'),
        namesNothingReviewed: outcome.report.includes('Nothing was reviewed'),
        factory: fakes.calls.factory,
        read: fakes.calls.read,
        reviewed: fakes.calls.reviewed,
        verdict: outcome.verdict,
      }).toEqual({
        exitCode: 1,
        namesEmptyDiff: true,
        namesWrongBase: true,
        namesShallowClone: true,
        namesFetchDepth: true,
        namesNothingReviewed: true,
        factory: 0,
        read: [DEFAULT_LENS_SOURCE],
        reviewed: [],
        verdict: undefined,
      });
    });
  }
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

      const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

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
      // No parsed lens set means no panel and no Verdict.
      expect(outcome.verdict).toBeUndefined();
    });
  }

  // The reason the three stay apart all the way to the report. A 404 is
  // someone's wrong URL, a 503 is an outage to wait out, and a parse error is
  // a bad commit to the definition. A single "could not load" tells none of
  // them which they are.
  it('gives three distinguishable reports, not one', async () => {
    const reports = await Promise.all(
      unavailable.map(async ({ found }) => {
        const fakes = harness({ found });
        return (await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader)).report;
      }),
    );

    expect(new Set(reports).size).toBe(3);
  });
});

describe('runReview, when the panel runs', () => {
  it('exits 0 and says so when every lens approves', async () => {
    const fakes = harness();

    const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toContain('## Review: Approved');
    expect(outcome.report).toContain('Every lens reviewed and none had a finding.');
    expect([...fakes.calls.reviewed].sort()).toEqual(['correctness', 'honesty']);
    // The returned Verdict is the panel's own, not re-derived from the
    // markdown: same outcome, same lenses.
    expect(outcome.verdict?.outcome).toBe('approved');
    expect(outcome.verdict?.results.map((result) => result.lens).sort()).toEqual([
      'correctness',
      'honesty',
    ]);
  });

  it('exits 1 and carries the finding when one lens rejects', async () => {
    const fakes = harness({
      reply: (lensId) => Promise.resolve(lensId === 'honesty' ? REJECT : APPROVE),
    });

    const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('## Review: Rejected');
    expect(outcome.report).toContain('a real finding');
    expect(outcome.report).toContain('honesty');
    expect(outcome.verdict?.outcome).toBe('rejected');
    expect(outcome.verdict?.findings).toHaveLength(1);
    expect(outcome.verdict?.findings[0]?.lens).toBe('honesty');
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

    const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.report).toContain('## Review: Could not run');
    expect(outcome.report).toContain('1 of 2 lenses did not review');
    expect(outcome.report).toContain('socket hang up');
    // The work that did happen is not discarded on the way to the report.
    expect(outcome.report).toContain('a real finding');
    // The fact the markdown alone could never give a caller back: which
    // lens could not run, and why — now in the returned Verdict itself,
    // not just in prose.
    expect(outcome.verdict?.outcome).toBe('could_not_run');
    expect(outcome.verdict?.unran).toEqual([
      { lens: 'honesty', reason: 'reviewer threw: socket hang up' },
    ]);
  });

  it('names the source the definition actually came from', async () => {
    const fakes = harness();

    const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

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
      fakes.buildReader,
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

    await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

    expect(fakes.calls.factory).toBe(1);
    expect(fakes.settingsSeen[0]).toEqual({
      apiKey: 'sk-ant-test',
      model: DEFAULT_MODEL,
      maxTokens: DEFAULT_MAX_TOKENS,
      lensSource: DEFAULT_LENS_SOURCE,
      lensToken: 'lens-token',
    });
  });

  // The bar reaching the reviewer. Without this, `runPanel(…, wired.practices)`
  // could lose its fourth argument and every lens would be prompted with
  // NO_PRACTICES_NOTICE while the suite stayed green — a panel judging against
  // nothing, reporting exactly as if it had judged against the bar.
  it('supplies the practices to every lens, not merely to the first', async () => {
    const fakes = harness({ practices: 'THE-BAR-MARKER: say what you observed' });

    const outcome = await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

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

    await runReview(env(), SUBJECT, fakes.deps, fakes.buildReader);

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
      fakes.buildReader,
    );

    expect(fakes.settingsSeen[0]?.model).toBe('claude-haiku-3');
    expect(fakes.settingsSeen[0]?.maxTokens).toBe(12000);
  });
});

// R1: the defect this file was rewritten for. `runReview` used to evaluate
// settings, the diff and the lens set in sequence and return at the first
// failure — so a run with two things wrong named one, and a person fixed
// what they were told and re-ran only to be told the next thing. The three
// facts below are independently knowable, and every test in this block
// drives a case where more than one of them is true at once, asserting
// through one whole-value `toEqual` per test rather than a sequence of
// separate checks — a sequential assertion proves only its first possible
// failure, and these are exactly the tests where a silently-dropped second
// problem must be caught.
describe('runReview, gathering what is independently knowable', () => {
  it('reports two problems together, leading with the one to fix first', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined }),
      { ...SUBJECT, diff: '' },
      fakes.deps,
      fakes.buildReader,
    );

    const keyAt = outcome.report.indexOf('ANTHROPIC_API_KEY');
    const diffAt = outcome.report.indexOf('The diff was empty');

    expect({
      exitCode: outcome.exitCode,
      namesKey: keyAt >= 0,
      namesEmptyDiff: diffAt >= 0,
      // The configuration problem must be fixed whatever the diff turns out
      // to be, so it leads — a caller reading only as far as the first
      // heading still learns the thing to fix next.
      keyBeforeDiff: keyAt >= 0 && diffAt >= 0 && keyAt < diffAt,
      // Both were checked, and the panel still did not run: gathering is not
      // continuing.
      factory: fakes.calls.factory,
      reviewed: fakes.calls.reviewed,
    }).toEqual({
      exitCode: 1,
      namesKey: true,
      namesEmptyDiff: true,
      keyBeforeDiff: true,
      factory: 0,
      reviewed: [],
    });
  });

  // The specific case the diagnosis names: loadLensSet needs a lens source
  // and a lens token, not the API key, so its reachability must be checked
  // even when the key is the thing that is missing. `read` is asserted
  // directly, not merely inferred from the report, so a fixture that
  // short-circuited before reaching the reader would fail this test rather
  // than pass it for the wrong reason.
  it('checks the lens set even when the API key is missing, and reports both', async () => {
    const fakes = harness({ found: { kind: 'missing', reason: 'HTTP 404' } });

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
    );

    const keyAt = outcome.report.indexOf('ANTHROPIC_API_KEY');
    const lensAt = outcome.report.indexOf(DEFAULT_LENS_SOURCE);

    expect({
      exitCode: outcome.exitCode,
      namesKey: keyAt >= 0,
      namesLensSetProblem: outcome.report.includes('missing') && lensAt >= 0,
      keyBeforeLensSet: keyAt >= 0 && lensAt >= 0 && keyAt < lensAt,
      readerReached: fakes.calls.read,
      factory: fakes.calls.factory,
      reviewed: fakes.calls.reviewed,
    }).toEqual({
      exitCode: 1,
      namesKey: true,
      namesLensSetProblem: true,
      keyBeforeLensSet: true,
      readerReached: [DEFAULT_LENS_SOURCE],
      factory: 0,
      reviewed: [],
    });
  });

  it('reports three problems together when three are present', async () => {
    const fakes = harness({ found: { kind: 'unreachable', reason: 'HTTP 503' } });

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined }),
      { ...SUBJECT, diff: '' },
      fakes.deps,
      fakes.buildReader,
    );

    const positions = [
      outcome.report.indexOf('ANTHROPIC_API_KEY'),
      outcome.report.indexOf('The diff was empty'),
      outcome.report.indexOf(DEFAULT_LENS_SOURCE),
    ];

    expect({
      exitCode: outcome.exitCode,
      allPresent: positions.every((position) => position >= 0),
      // Settled configuration, then the diff, then the lens set — the order
      // the file header explains, each strictly after the last.
      inOrder: positions.every((position, index) => {
        if (index === 0) return true;
        const previous = positions[index - 1];
        return previous !== undefined && previous < position;
      }),
      namesUnreachable: outcome.report.includes('unreachable'),
      factory: fakes.calls.factory,
      reviewed: fakes.calls.reviewed,
    }).toEqual({
      exitCode: 1,
      allPresent: true,
      inOrder: true,
      namesUnreachable: true,
      factory: 0,
      reviewed: [],
    });
  });

  // The present-and-wrong branch, not just the missing one: `invalid` and
  // `incomplete` are different `SettingsResult` kinds, and both must still
  // let the lens-set check through independently.
  it('reports both when the configuration is present-and-wrong and the lens set cannot be read', async () => {
    const fakes = harness({ found: { kind: 'missing', reason: 'HTTP 404' } });

    const outcome = await runReview(
      env({ AIGENCY_REVIEW_MAX_TOKENS: '4o96' }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
    );

    const maxTokensAt = outcome.report.indexOf('AIGENCY_REVIEW_MAX_TOKENS');
    const lensAt = outcome.report.indexOf(DEFAULT_LENS_SOURCE);

    expect({
      exitCode: outcome.exitCode,
      namesMaxTokens: maxTokensAt >= 0 && outcome.report.includes('4o96'),
      namesLensSet: lensAt >= 0,
      maxTokensBeforeLensSet: maxTokensAt >= 0 && lensAt >= 0 && maxTokensAt < lensAt,
      factory: fakes.calls.factory,
    }).toEqual({
      exitCode: 1,
      namesMaxTokens: true,
      namesLensSet: true,
      maxTokensBeforeLensSet: true,
      factory: 0,
    });
  });

  // The other half of "gather, don't invent": when only one thing is wrong,
  // the other two — checked, and found clean — must not appear as if they
  // were also problems. `readerReached` proves the lens set really was
  // checked (not skipped because the key was missing), and `isGathered`
  // proves the report was not wrapped in the multi-problem framing over a
  // single problem.
  it('reports one problem alone, with no invented companions, when only one is wrong', async () => {
    const fakes = harness();

    const outcome = await runReview(
      env({ ANTHROPIC_API_KEY: undefined }),
      SUBJECT,
      fakes.deps,
      fakes.buildReader,
    );

    expect({
      exitCode: outcome.exitCode,
      namesKey: outcome.report.includes('ANTHROPIC_API_KEY'),
      namesEmptyDiff: outcome.report.includes('The diff was empty'),
      namesLensSetProblem: outcome.report.includes('could not be read'),
      isGathered: outcome.report.includes('Problem 1 of'),
      readerReached: fakes.calls.read,
    }).toEqual({
      exitCode: 1,
      namesKey: true,
      namesEmptyDiff: false,
      namesLensSetProblem: false,
      isGathered: false,
      readerReached: [DEFAULT_LENS_SOURCE],
    });
  });
});
