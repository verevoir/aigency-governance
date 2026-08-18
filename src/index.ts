export {
  LensSetError,
  parseLensSet,
  SUPPORTED_VERSION,
  type Lens,
  type LensSet,
} from './review/lensSet.js';
export { loadLensSet, type LoadResult, type ReadResult, type SourceReader } from './review/load.js';
export {
  aggregate,
  PanelMismatchError,
  type Finding,
  type LensResult,
  type Outcome,
  type Verdict,
} from './review/verdict.js';
export {
  APPROVED_WORD,
  CANNOT_RUN_WORD,
  FINDING_MARKER,
  REASON_MARKER,
  REJECTED_WORD,
  REPLY_CONTRACT,
  VERDICT_MARKER,
} from './review/replyContract.js';
export {
  buildPrompt,
  NO_PRACTICES_NOTICE,
  renderPrompt,
  type Prompt,
  type Subject,
} from './review/prompt.js';
export { parseReply } from './review/parseReply.js';
export { runPanel, type PanelRun, type Reviewer } from './review/panel.js';
export { exitCodeFor, renderReport, type ReportContext } from './review/report.js';
export {
  fileReader,
  httpReader,
  keyFileReader,
  readerFor,
  type FetchLike,
} from './review/readers.js';
export {
  anthropicReviewer,
  redact,
  type AnthropicConfig,
  type HttpPost,
} from './review/anthropic.js';
export {
  DEFAULT_LENS_SOURCE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  renderMissing,
  resolveSettings,
  type KeyFileReader,
  type KeyFileResult,
  type MissingSetting,
  type ReviewSettings,
  type SettingsResult,
} from './review/settings.js';
export { runReview, type ReviewDeps, type ReviewOutcome } from './cli/run.js';

// retrying and observing (src/decorate/) are deliberately NOT re-exported
// here. A review found them added to this public barrel with no caller
// anywhere in this repository or any branch built on top of it - only their
// own dedicated test file uses either one. A public export is a promise, and
// this one was nobody's ask. The modules stay in the tree, tested and ready
// to be wired to a real caller; they get re-exported the day one exists,
// not before.
