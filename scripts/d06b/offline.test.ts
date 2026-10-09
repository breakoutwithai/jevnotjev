import { expect, test } from 'bun:test';
import { offline } from './offline.ts';
const fixture = new URL('../../examples/d06b-cv-funnel/cv.fixture.json', import.meta.url).pathname;
const empty = new URL('../../examples/d06b-cv-funnel/empty.fixture.json', import.meta.url).pathname;
function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
test('[smoke] D06b offline plan never dispatches and accounts for six requests and 24 slots', async () => {
  const result = await offline(['plan', fixture]);
  if (!object(result.body)) throw new Error('body');
  expect(result.code).toBe(0); expect(result.body.logicalRequests).toBe(6); expect(result.body.plannedSlots).toBe(24);
  expect(JSON.stringify(result.body)).not.toContain('IDENTITY_');
  expect(result.body.status).toBe('proposed-offline-only');
});
test('[integration] D06b report preserves ten cautious core question verdicts without labels or calls', async () => {
  const result = await offline(['report', fixture, empty, empty]);
  expect(result.code).toBe(4);
  if (!object(result.body) || !object(result.body.core) || !object(result.body.core.body)) throw new Error('core');
  const verdicts = result.body.core.body.verdicts;
  if (!Array.isArray(verdicts)) throw new Error('verdicts');
  expect(verdicts).toHaveLength(10);
  expect(result.body.ledger).toEqual([]);
  expect(result.body.arithmetic).toEqual({ stageFigures: 21, questionFigures: 72, mismatches: 0 });
});
test('[unit] D06b offline command rejects unknown commands and missing report files', async () => {
  await expect(offline(['run', fixture])).rejects.toThrow('Usage');
  await expect(offline(['report', fixture])).rejects.toThrow('Usage');
});
