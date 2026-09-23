const { app, BrowserWindow, shell, screen, Menu } = require('electron');
const { resolve } = require('node:path');
const iconPath = resolve(__dirname, '../../public/brand/interface-icon.png');
const url = `http://127.0.0.1:${process.env.WORKBENCH_PORT || 4317}`;
const targetOrigin = process.env.INTERFACE_TARGET === 'lab' ? `http://127.0.0.1:${process.env.TARGET_PORT || 4318}` : new URL(process.env.MIFOS_URL || 'http://127.0.0.1:4200').origin;
app.setName('Interface');
app.whenReady().then(() => {
  app.setAboutPanelOptions({applicationName:'Interface',applicationVersion:'0.5.0'});
  if(process.platform==='darwin')app.dock.setIcon(iconPath);
  if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Interface',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'},
  ]));
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1500, workArea.width - 40), height = Math.min(960, workArea.height - 40);
  const window = new BrowserWindow({width,height,x:Math.round(workArea.x+(workArea.width-width)/2),y:Math.round(workArea.y+(workArea.height-height)/2),minWidth:900,minHeight:600,title:'Interface — Local workbench',icon:iconPath,backgroundColor:'#f6f5f2',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}});
  window.webContents.setWindowOpenHandler(({url: destination})=>{
    try { if(new URL(destination).origin===targetOrigin)void shell.openExternal(destination); } catch {}
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',(event,target)=>{if(new URL(target).origin!==url)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window.loadURL(url);
});
app.on('window-all-closed',()=>app.quit());
