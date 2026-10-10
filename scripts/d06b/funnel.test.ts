import { expect, test } from 'bun:test';
import { plan, type Cv } from './funnel.ts';
const cv: Cv = { id: 'cv01', fields: { name: 'IDENTITY_NAME', summary: 'Shipped pooling product', right_to_work: 'UK', notice_weeks: 12, years_experience: 5 } };
test('[unit] D06b ten questions are batched four/two/four on every CV', () => {
  const batches = plan([cv]);
  expect(batches.map(b => [b.stage, b.questions.length, b.questions[0]?.type])).toEqual([['S2', 4, 'noul'], ['S3', 2, 'choice'], ['S4', 4, 'score']]);
});
test('[unit] D06b nested identity is stripped and identity values cannot leak into requests', () => {
  const batches = plan([{ ...cv, fields: { ...cv.fields, projects: [{ name: 'IDENTITY_PROJECT', summary: 'Allowed', nested: { graduationYear: 1999 } }] } }]);
  expect(batches[0]?.state).not.toContain('IDENTITY_PROJECT');
  expect(batches[0]?.canonical).not.toContain('graduationYear');
  expect(() => plan([{ ...cv, fields: { ...cv.fields, summary: 'Built by IDENTITY_NAME' } }])).toThrow('identity value');
});
import { requests } from './funnel.ts';
test('[unit] D06b both typed adapters receive identical allowed text state', () => {
  const batch = plan([cv])[0]; if (!batch) throw new Error('fixture');
  const calls = requests(batch);
  expect(calls.length).toBe(2);
  expect(calls[0]?.body.state).toBe(batch.state);
  const messages = calls[1]?.body.messages;
  if (!Array.isArray(messages)) throw new Error("messages");
  const first: unknown = messages[0];
  if (typeof first !== "object" || first === null) throw new Error("message");
  const content: unknown = Reflect.get(first, "content");
  if (typeof content !== "string") throw new Error("content");
  expect(content.split("\n")[0]).toBe("Case: " + JSON.stringify(batch.state));
  expect(batch.state).not.toContain('right_to_work');
  expect(batch.canonical).toContain('right_to_work');
});
test('[unit] D06b request boundary rejects forged state and changed frozen questions', () => {
  const batch = plan([cv])[0]; if (!batch) throw new Error('fixture');
  expect(() => requests({ ...batch, state: '{"name":"forbidden"}' })).toThrow('batch differs');
  expect(() => requests({ ...batch, questions: [] })).toThrow('batch differs');
});
test('[unit] D06b identity values in keys, containers, short names and numbers are rejected', () => {
  for (const fields of [
    { name: 'Alice Smith', projects: { 'Alice Smith': 'built' } },
    { photo: { url: 'https://private.invalid/portrait' }, links: ['https://private.invalid/portrait'] },
    { name: 'Al', age: 40, graduation_year: 2008, summary: 'Al is aged 40, graduated 2008' },
    { age: 1234567, projects: [1234567] },
    { name: 'Alice Smith', location: { 'Alice Smith': 'London' }, salary_band: 'Alice Smith' },
  ]) expect(() => plan([{ id: 'privacy', fields }])).toThrow('identity');
});
test('[unit] D06b model state excludes eligibility keys at every depth', () => {
  const b = plan([{ id: 'nested', fields: { projects: [{ right_to_work: 'UK', notice_weeks: 1, summary: 'Relevant implementation' }] } }])[0];
  expect(b?.state).not.toContain('right_to_work'); expect(b?.state).not.toContain('notice_weeks'); expect(b?.state).toContain('Relevant implementation');
});
test('[unit] D06b stage allowlists: S2 excludes team_size_led, S3 and S4 include it', () => {
  const b = plan([{ id: 'allow', fields: { summary: 'Relevant implementation', team_size_led: 4 } }]);
  const state = (stage: string): string => b.find(x => x.stage === stage)?.state ?? '';
  expect(state('S2')).not.toContain('team_size_led');
  expect(state('S2')).toContain('Relevant implementation');
  expect(state('S3')).toContain('team_size_led');
  expect(state('S4')).toContain('team_size_led');
});
