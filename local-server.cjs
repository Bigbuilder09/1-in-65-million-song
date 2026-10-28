// Local preview only. Run with --no-open to leave browser navigation to the caller.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const root = __dirname;
const port = 8765;
const pages = new Set(['index.html','privacy.html','save-ui.css','cloud-save.js','game-save.js','firebase-config.js','ads.txt','og.png']);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.mp3':'audio/mpeg','.png':'image/png','.txt':'text/plain; charset=utf-8'};
const server = http.createServer((req,res) => {
  if (req.headers.host !== `localhost:${port}`) { res.writeHead(403); res.end('Use localhost'); return; }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{'Allow':'GET, HEAD'}); res.end(); return; }
  let name;
  try { name = decodeURIComponent(new URL(req.url,`http://localhost:${port}`).pathname).replace(/^\//,'') || 'index.html'; }
  catch (_) { res.writeHead(400); res.end(); return; }
  if (!pages.has(name) && !/^music\/[\w-]+\.mp3$/.test(name)) { res.writeHead(404); res.end('Not found'); return; }
  const file = path.join(root,name);
  fs.stat(file,(err,stat)=>{
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(req.method === 'HEAD') {res.end();return;}
    const stream = fs.createReadStream(file);
    stream.on('error',()=>res.destroy()); stream.pipe(res);
  });
});
server.on('error',err=>{
  console.error(err.code === 'EADDRINUSE' ? 'Port 8765 is already in use. Close the previous local server and try again.' : err.message);
  process.exitCode=1;
});
server.listen(port,'localhost',()=>{
  const url = `http://localhost:${port}/index.html`;
  console.log(`Game: ${url}\nKeep this window open while playing. Press Ctrl+C to stop.\nIf Google reports unauthorized-domain, add localhost in Firebase Authentication > Settings > Authorized domains.`);
  if(!process.argv.includes('--no-open')) execFile('explorer.exe',[url],{windowsHide:true},err=>{
    if(err) console.log(`Open the browser manually: ${url}`);
  });
});
