import test from 'node:test';
import assert from 'node:assert/strict';
import {assertMcpResponseBudget,MCP_BLOCK_BYTES,MCP_RESPONSE_BYTES} from '../lib/content-budget.mjs';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {credentials,descriptor,threadA} from './fixtures/discovery.mjs';

const content=[
 {type:'text',text:'原任务仍按原身份观察。'},
 {type:'image',mimeType:'image/png',data:'iVBORw0KGgo='},
 {type:'audio',mimeType:'audio/wav',data:'UklGRg=='},
 {type:'resource_link',uri:'promptframe://resources/opaque-001',name:'Registered output',mimeType:'image/png'},
 {type:'resource',resource:{uri:'promptframe://resources/opaque-002',mimeType:'text/plain',text:'已授权资源摘要'}},
];

test('standard content and structured identity cross the generic bridge unchanged with one business call',async()=>{
 const expected={content,structuredContent:{taskId:'original-task',deadlineAt:'2030-01-01T00:00:00Z'},isError:false,_meta:{originalReceipt:'same'}};
 let calls=0;
 const bridge=createHostCallBridge({listTools:async()=>({tools:[descriptor('read_new_format','independent-read')]}),
  callTool:async()=>{calls++;return expected;}},{credentials});
 assert.equal(await bridge.call({name:'read_new_format',arguments:{},_meta:{threadId:threadA}}),expected);
 assert.equal(calls,1);
 assert.equal(assertMcpResponseBudget(expected),expected);
});

test('block budget counts JSON UTF8 bytes, annotations and base64 rather than decoded bytes',()=>{
 const overhead=Buffer.byteLength(JSON.stringify({type:'text',text:''}));
 const exact={type:'text',text:'a'.repeat(MCP_BLOCK_BYTES-overhead)};
 assert.doesNotThrow(()=>assertMcpResponseBudget({content:[exact]}));
 assert.throws(()=>assertMcpResponseBudget({content:[{...exact,text:exact.text+'a'}]}),/creation.content_budget_exceeded/);
 assert.throws(()=>assertMcpResponseBudget({content:[{type:'text',text:'汉'.repeat(140000)}]}),/creation.content_budget_exceeded/);
 assert.throws(()=>assertMcpResponseBudget({content:[{type:'image',mimeType:'image/png',data:Buffer.alloc(300000).toString('base64')}]}),/creation.content_budget_exceeded/);
});

test('aggregate and resource/prompt reads use the same bound without truncating or regenerating',async()=>{
 const block={type:'text',text:'a'.repeat(399900)};
 assert.throws(()=>assertMcpResponseBudget({content:Array(6).fill(block)}),/creation.response_budget_exceeded/);
 assert.throws(()=>assertMcpResponseBudget({content:[],structuredContent:{text:'a'.repeat(MCP_RESPONSE_BYTES)}}),/creation.response_budget_exceeded/);
 assert.throws(()=>assertMcpResponseBudget({contents:[{uri:'promptframe://resources/opaque',text:'a'.repeat(MCP_BLOCK_BYTES)}]}),/creation.content_budget_exceeded/);
 assert.throws(()=>assertMcpResponseBudget({messages:[{role:'user',content:{type:'text',text:'a'.repeat(MCP_BLOCK_BYTES)}}]}),/creation.content_budget_exceeded/);
 let calls=0;const bridge=createHostCallBridge({listTools:async()=>({tools:[descriptor('read_large','independent-read')]}),callTool:async()=>{calls++;return {content:[{type:'text',text:'a'.repeat(MCP_BLOCK_BYTES)}]};}},{credentials});
 await assert.rejects(bridge.call({name:'read_large',arguments:{}}),/creation.content_budget_exceeded/);
 assert.equal(calls,1);
});
