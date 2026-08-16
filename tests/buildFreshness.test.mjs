// buildFreshness, driven directly rather than through check-cli.mjs, so the
// stale/current boundary can be tested against directories this test creates
// and controls — not this repository's own src/ or dist/, which run_gates
// itself depends on being current.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFreshness, newestMtimeMs } from '../scripts/buildFreshness.mjs';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aigency-build-freshness-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function touch(path, whenMs) {
  await writeFile(path, 'x', 'utf8');
  const seconds = whenMs / 1000;
  await utimes(path, seconds, seconds);
}

describe('newestMtimeMs', () => {
  it('is undefined for a directory that does not exist', async () => {
    expect(await newestMtimeMs(join(dir, 'nowhere'))).toBeUndefined();
  });

  it('is undefined for a directory that exists but holds no files', async () => {
    const empty = join(dir, 'empty');
    await mkdir(empty);
    expect(await newestMtimeMs(empty)).toBeUndefined();
  });

  it('finds the newest file, including a nested one', async () => {
    const root = join(dir, 'root');
    await mkdir(join(root, 'nested'), { recursive: true });
    await touch(join(root, 'old.txt'), 1_000_000);
    await touch(join(root, 'nested', 'new.txt'), 2_000_000);

    expect(await newestMtimeMs(root)).toBe(2_000_000);
  });
});

describe('buildFreshness', () => {
  // Two tests, not one: a single test pinning one reason cannot show that an
  // absent directory and an empty one are told apart from each other — only
  // two tests, each pinning its own reason and ruling out the other's
  // wording, can show that.
  it('is stale, naming absence specifically, when dist does not exist at all', async () => {
    const src = join(dir, 'src');
    const distDir = join(dir, 'dist');
    await mkdir(src);
    await touch(join(src, 'index.ts'), 1_000_000);

    const result = await buildFreshness(src, distDir);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe(`${distDir} does not exist`);
    expect(result.reason).not.toContain('holds no files');
  });

  it('is stale, naming emptiness specifically, when dist exists but holds no files', async () => {
    const src = join(dir, 'src');
    const distDir = join(dir, 'dist');
    await mkdir(src);
    await mkdir(distDir);
    await touch(join(src, 'index.ts'), 1_000_000);

    const result = await buildFreshness(src, distDir);

    expect(result.stale).toBe(true);
    expect(result.reason).toBe(`${distDir} exists but holds no files`);
    expect(result.reason).not.toContain('does not exist');
  });

  it('is stale when src was touched after the newest file in dist', async () => {
    const src = join(dir, 'src');
    const distDir = join(dir, 'dist');
    await mkdir(src);
    await mkdir(distDir);
    await touch(join(distDir, 'index.js'), 1_000_000);
    await touch(join(src, 'index.ts'), 2_000_000);

    const result = await buildFreshness(src, distDir);

    expect(result.stale).toBe(true);
    expect(result.reason).toContain(src);
  });

  it('is current when dist is newer than every file in src', async () => {
    const src = join(dir, 'src');
    const distDir = join(dir, 'dist');
    await mkdir(src);
    await mkdir(distDir);
    await touch(join(src, 'index.ts'), 1_000_000);
    await touch(join(distDir, 'index.js'), 2_000_000);

    const result = await buildFreshness(src, distDir);

    expect(result).toEqual({ stale: false });
  });

  it('is current when the two newest mtimes are exactly equal', async () => {
    const src = join(dir, 'src');
    const distDir = join(dir, 'dist');
    await mkdir(src);
    await mkdir(distDir);
    await touch(join(src, 'index.ts'), 1_000_000);
    await touch(join(distDir, 'index.js'), 1_000_000);

    const result = await buildFreshness(src, distDir);

    expect(result).toEqual({ stale: false });
  });
});
