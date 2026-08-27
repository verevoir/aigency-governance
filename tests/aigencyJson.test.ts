// Drift guard between two independently-declared names for the same
// credential. aigency.json's `review` release step declares the env names
// its child process is permitted to receive; src/review/claudeCli.ts's
// CLAUDE_CLI_CREDENTIAL_ENV_VAR names the one credential allowedEnv() lets
// through to the `claude` grandchild. They agree today because both were
// written to name CLAUDE_CODE_OAUTH_TOKEN — not because either is derived
// from the other. CLAUDE_CLI_CREDENTIAL_ENV_VAR's own doc comment records
// why deriving one from the other was considered and rejected: the
// direct-shell entry point scripts/review-head.mjs exists to serve never
// reads aigency.json at all, and the declaration carries no marker saying
// which of its names is "the credential" even where it is read. The
// duplication is structural.
//
// What is not structural is how loudly drift shows up. Before this test,
// an edit to either name without the other surfaced three hops downstream,
// at review time, as an opaque "Not logged in · Please run /login" —
// nothing about that message points at a renamed constant or a stale
// declaration. This test reads aigency.json directly (real disk I/O, no
// fake — the file this repository actually ships) and fails at
// `npm run verify`, naming both sides, the moment they disagree.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLAUDE_CLI_CREDENTIAL_ENV_VAR } from '../src/review/claudeCli.js';

const AIGENCY_JSON = fileURLToPath(new URL('../aigency.json', import.meta.url));

interface AigencyCommand {
  readonly name: string;
  readonly env?: readonly string[];
}

interface AigencyConfig {
  readonly commands: readonly AigencyCommand[];
}

function loadAigencyJson(): AigencyConfig {
  return JSON.parse(readFileSync(AIGENCY_JSON, 'utf8')) as AigencyConfig;
}

describe("aigency.json's review step vs. claudeCli.ts's CLAUDE_CLI_CREDENTIAL_ENV_VAR", () => {
  it('name the same credential — a mismatch here is exactly the drift this test exists to catch loudly', () => {
    const config = loadAigencyJson();
    const review = config.commands.find((command) => command.name === 'review');

    if (review === undefined) {
      throw new Error(
        'aigency.json declares no "review" command at all — expected one whose ' +
          `env names ${JSON.stringify(CLAUDE_CLI_CREDENTIAL_ENV_VAR)}, the credential ` +
          "src/review/claudeCli.ts's CLAUDE_CLI_CREDENTIAL_ENV_VAR carries. Either the " +
          'step was renamed, or removed, or this test is now looking in the wrong place.',
      );
    }

    const declared = review.env ?? [];
    const agree = declared.includes(CLAUDE_CLI_CREDENTIAL_ENV_VAR);

    expect(
      agree,
      "aigency.json's \"review\" step declares env " +
        `${JSON.stringify(declared)}, but src/review/claudeCli.ts's ` +
        `CLAUDE_CLI_CREDENTIAL_ENV_VAR is ${JSON.stringify(CLAUDE_CLI_CREDENTIAL_ENV_VAR)}. ` +
        'The two must name the exact same credential: allowedEnv() only ever lets ' +
        'through what CLAUDE_CLI_CREDENTIAL_ENV_VAR names, so if aigency.json declares ' +
        "a different (or no) name, the review step's own env grant never reaches the " +
        "child at all — claude -p then fails authentication with \"Not logged in\", " +
        'which points nowhere near this mismatch. Fix whichever side changed without ' +
        'the other.',
    ).toBe(true);
  });
});
