import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runCodexCommand,installationErrorDetails} from '../lib/user-installation.mjs';
const fixture=fileURLToPath(new URL('fixtures/codex-installer.mjs',import.meta.url));
test('bounded CLI diagnostics preserve command kind and safe failure facts without child output',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-command-errors-'));
 try{
  const bin=path.join(root,'bin');await mkdir(bin);
  await writeFile(path.join(bin,'codex'),`#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,{mode:0o700});
  const file=path.join(root,'state.json');await writeFile(file,JSON.stringify({markets:[],installed:[]}));
  const secret='Authorization: Bearer synthetic-cookie?token=not-real';
  for(const [mode,code]of[['nonzero','command_failed'],['limit','command_output_limit'],['timeout','command_timeout']]){
   const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CREATION_FIXTURE_STATE:file,CREATION_FIXTURE_SECRET:secret,CREATION_FIXTURE_READ_ERROR:mode};
   await assert.rejects(runCodexCommand(['plugin','list','--marketplace','own','--json'],{env}),error=>{
    assert.equal(error.message,'installation.'+code);const facts=installationErrorDetails(error);
    assert.equal(facts.commandKind,'plugin_read');assert.equal(facts.phase,'local_check');assert.equal(facts.timeoutMs,5000);
    assert.equal(facts.localRegistrationState,'unknown');assert(!JSON.stringify({message:error.message,facts}).includes(secret));return true;
   });
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
