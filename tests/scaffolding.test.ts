// Named `scaffolding` for a file that no longer holds any. The placeholder it
// was built around went when the first real exports landed (S24a); the belt
// has no verb that removes a file, so this name is a scar rather than a
// description, and it is fixed the day that verb exists (H22).
//
// What it holds now is real, and narrower than the name suggests. Two halves:
//
//   Runtime — the VALUES the barrel publishes, compared exactly, so a removed
//   export and a leaked one both go red.
//   Compile-time — the TYPES beside them, which are erased before any runtime
//   check can see them. Drop `type Verdict` from the barrel and the runtime
//   half stays green while every consumer loses it.
//
// What neither half catches, stated because the alternative is a comment
// claiming a property the code does not have: a NEW module that is never
// re-exported at all. The expectation below is hand-written and lives in the
// same edit as the barrel, so forgetting both at once is invisible here. This
// catches drift BETWEEN the list and the barrel. It is not a completeness
// check and must not be read as one.
import { describe, expect, it } from 'vitest';

import type {
  AnthropicConfig,
  Clock,
  FetchLike,
  Finding,
  HttpPost,
  KeyFileReader,
  KeyFileResult,
  Lens,
  LensAccess,
  LensReaderFactory,
  LensResult,
  LensSet,
  LoadResult,
  MissingSetting,
  Observation,
  Outcome,
  PanelRun,
  Prompt,
  ReadResult,
  Recorder,
  ReportContext,
  RetryPolicy,
  ReviewDeps,
  Reviewer,
  ReviewOutcome,
  ReviewSettings,
  SettingsResult,
  Sleep,
  SourceReader,
  Subject,
  Verdict,
} from '../src/index.js';
import * as surface from '../src/index.js';

// Erased at runtime, checked by `tsc --noEmit` in the same `verify` chain.
// Naming each type in a position that must resolve is what makes dropping one
// from the barrel a typecheck failure rather than a silent narrowing.
export type PublishedTypes = [
  Lens,
  LensSet,
  ReadResult,
  SourceReader,
  LoadResult,
  Finding,
  LensResult,
  Outcome,
  Verdict,
  Subject,
  Prompt,
  Reviewer,
  PanelRun,
  ReportContext,
  FetchLike,
  AnthropicConfig,
  HttpPost,
  KeyFileReader,
  KeyFileResult,
  MissingSetting,
  ReviewSettings,
  SettingsResult,
  ReviewDeps,
  LensAccess,
  LensReaderFactory,
  ReviewOutcome,
  RetryPolicy,
  Sleep,
  Clock,
  Observation,
  Recorder,
];

// Type-only exports vanish at runtime, so this list is the VALUES the barrel
// publishes and deliberately not the types beside them.
const PUBLISHED = [
  'APPROVED_WORD',
  'CANNOT_RUN_WORD',
  'DEFAULT_LENS_SOURCE',
  'DEFAULT_MAX_TOKENS',
  'DEFAULT_MODEL',
  'FINDING_MARKER',
  'LensSetError',
  'NO_PRACTICES_NOTICE',
  'PanelMismatchError',
  'REASON_MARKER',
  'REJECTED_WORD',
  'REPLY_CONTRACT',
  'RetryPolicyError',
  'SUPPORTED_VERSION',
  'VERDICT_MARKER',
  'aggregate',
  'anthropicReviewer',
  'buildPrompt',
  'exitCodeFor',
  'fileReader',
  'httpReader',
  'keyFileReader',
  'loadLensSet',
  'observing',
  'parseLensSet',
  'parseReply',
  'readerFor',
  'redact',
  'renderMissing',
  'renderPrompt',
  'renderReport',
  'resolveSettings',
  'retrying',
  'runPanel',
  'runReview',
];

describe('the published surface', () => {
  it('exports every value a runner needs to load and judge a definition', () => {
    expect(Object.keys(surface).sort()).toEqual(PUBLISHED);
  });

  it('publishes them as the kinds a caller can use', () => {
    expect(typeof surface.parseLensSet).toBe('function');
    expect(typeof surface.loadLensSet).toBe('function');
    expect(typeof surface.aggregate).toBe('function');
    expect(surface.SUPPORTED_VERSION).toBe(1);
    expect(new surface.LensSetError('x')).toBeInstanceOf(Error);
    expect(new surface.PanelMismatchError('x')).toBeInstanceOf(Error);
  });
});
