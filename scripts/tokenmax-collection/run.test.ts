import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from './run.ts';
import { ingestDraft } from '../../src/tokenmax-ingest/ingest.ts';
test('[integration] TC local selected-root metadata runner produces receiver-valid editable draft and refuses overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tm-collection-test-'));const root=join(dir,'history');const {mkdir}=await import('node:fs/promises');await mkdir(root);
 await writeFile(join(root,'synthetic.jsonl'),JSON.stringify({type:'assistant',timestamp:'2026-10-14T12:00:00Z',sessionId:'session',message:{id:'message',model:'claude-sonnet-5-5',usage:{input_tokens:12,output_tokens:3},content:'SECRET BODY NEVER IN OUTPUT'}}));
 const out=join(dir,'report');await run(['--claude',root,'--out',out],Date.parse('2026-10-16T00:00:00Z'));
 const draft=await readFile(join(out,'share-draft.json'),'utf8');expect(ingestDraft(draft).ok).toBe(true);expect(draft).not.toContain('SECRET');expect(draft).not.toContain(root);expect(draft).not.toContain('synthetic.jsonl');await expect(run(['--claude',root,'--out',out])).rejects.toThrow('already exists');
});
test('[unit] TC runner requires explicit source and destination and unknown runtime capability fails honestly',async()=>{await expect(run(['--out','/tmp/unused-tokenmax-test'])).rejects.toThrow('Select at least one provider');const result=spawnSync(process.execPath,[resolve('scripts/tokenmax-collection/run.ts'),'--bad','option'],{encoding:'utf8'});expect(result.status).toBe(1);expect(result.stderr).toContain('Collection stopped');expect(result.stderr).not.toContain('SECRET');});
test('[integration] TC standalone JavaScript runs in Node without Bun and emits receiver-valid aggregates without network',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tm-collection-node-'));const {mkdir}=await import('node:fs/promises');const root=join(dir,'history');await mkdir(root);
 const timestamp=new Date(Date.now()-86400000).toISOString();
 await writeFile(join(root,'fixture.jsonl'),JSON.stringify({type:'assistant',timestamp,sessionId:'session',message:{id:'message',model:'claude-sonnet-5-5',usage:{input_tokens:9,output_tokens:4},content:'PRIVATE CANARY'}}));
 const networkTrap='data:text/javascript,'+encodeURIComponent("globalThis.fetch=async()=>{console.error('NETWORK_ATTEMPT');throw Error('network prohibited in synthetic CLI test')};");
 for(const mode of ['host','jev']){
  const out=join(dir,mode);const result=spawnSync('node',['--import',networkTrap,resolve('scripts/tokenmax-collection/collect.mjs'),'--claude',root,'--out',out,'--mode',mode],{encoding:'utf8'});
  expect(result.status).toBe(0);expect(result.stderr).not.toContain('NETWORK_ATTEMPT');expect(result.stdout).toContain(out);
  const draft=await readFile(join(out,'share-draft.json'),'utf8');const ingested=ingestDraft(draft);expect(ingested.ok).toBe(true);expect(draft).not.toContain('PRIVATE CANARY');
  if(!ingested.ok)throw Error(ingested.error);expect(ingested.value.map.output_tokens.claude).toBe(4);expect(ingested.value.analysis.jev_calls).toBe(0);expect(ingested.value.analysis.status).toBe(mode==='jev'?'unavailable':'completed');
 }
});
test('[integration] TC empty selected history cannot become a report for an invented provider',async()=>{const root=await mkdtemp(join(tmpdir(),'tm-empty-history-'));const out=join(root,'report');await expect(run(['--codex',root,'--out',out])).rejects.toThrow('No selected source files');});
