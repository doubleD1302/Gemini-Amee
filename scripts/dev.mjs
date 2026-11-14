import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const viteEntry = resolve(root,'node_modules','vite','bin','vite.js');
const electronExecutable = require('electron');
const vite = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1'], { cwd:root, stdio:'inherit' });
let electron;
let stopped=false;
const cleanup=()=>{
  if(stopped)return;
  stopped=true;
  vite.kill();
  electron?.kill();
};
process.on('SIGINT',cleanup);
process.on('SIGTERM',cleanup);
vite.on('exit',code=>{if(!stopped&&!electron)process.exit(code??1);});
async function ready(port){
  for(let n=0;n<150;n++){
    const up=await new Promise(resolveConnection=>{
      const socket=createConnection({host:'127.0.0.1',port});
      socket.once('connect',()=>{socket.destroy();resolveConnection(true);});
      socket.once('error',()=>resolveConnection(false));
    });
    if(up)return true;
    await delay(180);
  }
  return false;
}
if(!await ready(5173)){cleanup();throw new Error('Vite dev server did not start.');}
electron=spawn(electronExecutable,['.'],{cwd:root,stdio:'inherit',env:{...process.env,GPS_DEV_URL:'http://127.0.0.1:5173'}});
electron.on('exit',code=>{cleanup();process.exit(code??0);});
