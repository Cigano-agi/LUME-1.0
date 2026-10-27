// Isolated hidden Electron host for synthetic 03A34 renderer QA only.
const {app,BrowserWindow,session}=require('electron');
const {resolve}=require('node:path');
const profile=process.env.LUME_03A34_PROFILE;
const target=process.env.LUME_03A34_URL;
if(!profile||!target||new URL(target).hostname!=='127.0.0.1')throw Error('03A34 fixture requires an isolated local profile and loopback URL');
app.setPath('userData',resolve(profile));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('web-contents-created',(_event,contents)=>{
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.on('will-navigate',(event,url)=>{if(!url.startsWith(new URL(target).origin+'/'))event.preventDefault();});
});
app.whenReady().then(async()=>{
  const origin=new URL(target).origin;
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith(origin+'/')}));
  const window=new BrowserWindow({show:false,useContentSize:true,width:820,height:900,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await window.loadURL(target);
});
