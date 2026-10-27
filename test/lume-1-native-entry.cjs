// QA entry only. Never used by the product package or a personal profile.
const {app,BrowserWindow,shell}=require('electron');
const {basename}=require('node:path');
if(process.env.LUME_NATIVE_QA!=='isolated'||!basename(process.env.ASSESSOR_DESKTOP_TEST_PROFILE||'').startsWith('lume-1-native-qa-'))throw Error('ISOLATED_QA_PROFILE_REQUIRED');
global.__lumeNativeQA={showReplaced:0,focusSuppressed:0,externalBlocked:[],showInactive:[]};
const showInactive=BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive=function(){global.__lumeNativeQA.showInactive.push({url:this.webContents.getURL(),focusedBefore:this.isFocused()});return showInactive.call(this);};
BrowserWindow.prototype.show=function(){global.__lumeNativeQA.showReplaced++;return this.showInactive();};
BrowserWindow.prototype.focus=function(){global.__lumeNativeQA.focusSuppressed++;};
shell.openExternal=async url=>{global.__lumeNativeQA.externalBlocked.push({kind:'openExternal',origin:new URL(url).origin});throw Error('EXTERNAL_OPEN_BLOCKED_IN_QA');};
app.on('web-contents-created',(_event,contents)=>{
  contents.session.webRequest.onBeforeRequest((details,callback)=>{
    const url=new URL(details.url);const blocked=['http:','https:','ws:','wss:'].includes(url.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if(blocked)global.__lumeNativeQA.externalBlocked.push({kind:'request',origin:url.origin});callback({cancel:blocked});
  });
});
require('../desktop/main.cjs');
