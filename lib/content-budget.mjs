import {CreationClientError} from './credentials.mjs';

export const MCP_BLOCK_BYTES=400_000;
export const MCP_RESPONSE_BYTES=2_000_000;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');

/** Inspect the serialized response, including base64 and metadata. Refusing
 * an oversized result never retries the accepted business operation. */
export function assertMcpResponseBudget(result){
  if(bytes(result)>MCP_RESPONSE_BYTES)throw new CreationClientError('creation.response_budget_exceeded');
  const blocks=[...(result.content??[]),...(result.contents??[])];
  for(const message of result.messages??[])if(message.content)blocks.push(message.content);
  if(blocks.some(block=>bytes(block)>MCP_BLOCK_BYTES))throw new CreationClientError('creation.content_budget_exceeded');
  return result;
}
