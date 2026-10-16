/** Local developer metadata runner: Bun. Native Node strip-only is unsupported because reused Jev validation uses transform syntax. No network or automatic discovery. */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, hostAdapter, jevAdapter, type Provider, type CollectionInput } from '../../src/tokenmax-collection/collector.ts';

export async function run(args:readonly string[],now=Date.now()):Promise<string> {
 const roots:{provider:Provider;path:string}[]=[];let out='';let activeSessionId:string|undefined;let mode='host';
 for(let i=0;i<args.length;i++){const flag=args[i];const value=args[++i];if(!value)throw Error('Each option needs a value');if(flag==='--claude'||flag==='--codex')roots.push({provider:flag==='--claude'?'claude':'codex',path:resolve(value)});else if(flag==='--out')out=resolve(value);else if(flag==='--active-session')activeSessionId=value;else if(flag==='--mode'&&(value==='host'||value==='jev'))mode=value;else throw Error('Supported options: --claude DIR --codex DIR --out NEW_DIR --active-session ID --mode host|jev');}
 if(!roots.length||!out)throw Error('Select at least one provider root and a new --out directory. No history roots are inferred.');
 try{await access(out);throw Error('Output directory already exists');}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
 const files:{provider:Provider;path:string;lines:string[]}[]=[];let totalBytes=0;
 async function walk(provider:Provider,dir:string):Promise<void>{for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(provider,path);else if(entry.isFile()&&entry.name.endsWith('.jsonl')){if(files.length>=2000)throw Error('Scope exceeds 2000 files; select a narrower provider directory');const lines:string[]=[];const reader=createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity});try{for await(const line of reader){totalBytes+=Buffer.byteLength(line);if(totalBytes>50_000_000)throw Error('Scope exceeds 50 MB; select a narrower provider directory');lines.push(line);}}finally{reader.close();}files.push({provider,path,lines});}}}
 for(const root of roots)await walk(root.provider,root.path);
 const adapter=mode==='jev'?jevAdapter({}):hostAdapter(async()=>{throw Error('Metadata runner has no host semantic transport');});
 const input:CollectionInput={files,now,adapter,...(activeSessionId?{activeSessionId}:{})};
 const result=await collect(input);
 await mkdir(out,{recursive:false});
 await writeFile(join(out,'share-draft.json'),JSON.stringify(result.share,null,2)+'\n',{flag:'wx'});
 await writeFile(join(out,'review.md'),`# DRAFT - NOT APPROVED FOR SHARING\n\nCollected only selected roots. No message bodies were sent to a model. No semantic candidates were inspected. This runner is metadata-only; optional Jev was ${mode==='jev'?'requested but unavailable (NOT RUN)':'not requested (zero calls)'}. For semantic analysis use the exported bounded adapter API after authorizing selected content.\n\nPeriod: rolling seven days. Sessions: ${result.share.map.sessions}. Unknown baseline segments: ${result.share.coverage.baseline_segments}. Opus share: ${result.share.map.opus_share_pct??'unknown'}. Window zones from observed allowance readings only: Claude ${result.privateWindows.claude.zone}; Codex latest ${result.privateWindows.codexLatest.zone}; Codex weekly ${result.privateWindows.codexWeekly.zone}. Missing/invalid readings remain UNKNOWN. Costs and semantic quality: unknown.\n\nRedaction-preservation and outcome comparisons adapt the Switch Check pattern credited to Lutfiya Miller: does B preserve the relevant facts and action of A?\n\nReview the aggregate before copying it. This program did not upload or publish.\n`,{flag:'wx'});
 return out;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])){try{console.log(await run(process.argv.slice(2)));}catch{console.error('Collection stopped. Check selected roots, runtime support, scope bounds and a new output directory. No logs or private exception text are printed.');process.exitCode=1;}}
