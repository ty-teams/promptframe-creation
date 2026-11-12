export function claudeHostHooks({pluginName='promptframe-creation',serverName,configFile,nodeCommand='node',runtimeRoot='${CLAUDE_PLUGIN_ROOT}'}={}){
 const escaped=pluginName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const command={type:'command',command:nodeCommand,args:[runtimeRoot+'/bin/promptframe-creation.mjs',
  'claude-host-hook',...(configFile?['--config',configFile]:[])],timeout:5};
 return{
  SessionStart:[{matcher:'startup|resume|fork|clear|compact',hooks:[{...command}]}],
  PreToolUse:[{matcher:serverName?'^mcp__'+serverName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'__.*':'^mcp__plugin_'+escaped+'_.*',
    hooks:[{...command,onFailure:'block'}]}],
  SessionEnd:[{hooks:[{...command}]}],
 };
}
