import { describe, expect, it } from 'vitest';

import { packageName } from '../src/index.js';

// This asserts almost nothing about `governance` and everything about the GATE:
// that vitest resolves TypeScript under NodeNext, that the `.js`-extension
// import convention holds in tests as well as source, and that `npm test`
// executes something rather than reporting a green run over zero files.
//
// A suite that passes because it found nothing to run is the "empty
// deliverable reported as success" defect (constraints.md B3) at the smallest
// possible scale, and it is the one failure this file exists to make
// impossible.
describe('scaffolding', () => {
  it('resolves a TypeScript module through the configured resolution', () => {
    expect(packageName).toBe('@verevoir/aigency-governance');
  });
});
