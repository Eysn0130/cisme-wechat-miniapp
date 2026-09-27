// Local DevTools fault boundary. Start the disposable acceptance API on 18081,
// then point the existing local mini-program origin at this loopback proxy.
// No production runtime imports this file and no request content is logged.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const host = '127.0.0.1';
const listenPort = 18080;
const targetPort = 18081;
const faultDirectory = resolve('tmp/miniprogram-acceptance-r7-faults');
const faults = new Map([
  ['/v1/bootstrap/profile', resolve(faultDirectory, 'profile')],
  ['/v1/ugc/status', resolve(faultDirectory, 'ugc-status')],
]);

const server = http.createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://${host}:${listenPort}`).pathname;
  const fault = request.method === 'GET' ? faults.get(path) : undefined;
  if (fault && existsSync(fault)) {
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ code: 'SYNTHETIC_ACCEPTANCE_UNAVAILABLE', title: '本地合成接口暂时不可用' }));
    return;
  }
  const upstream = http.request({ host, port: targetPort, method: request.method, path: request.url, headers: request.headers }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ code: 'SYNTHETIC_UPSTREAM_UNAVAILABLE' }));
  });
  request.pipe(upstream);
});

server.listen(listenPort, host, () => {
  process.stdout.write(JSON.stringify({ scope: 'loopback-disposable-mini-program-acceptance', origin: `http://${host}:${listenPort}`, target: `http://${host}:${targetPort}` }) + '\n');
});
