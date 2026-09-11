'use strict';
const { createServer } = require('node:http');
createServer((request, response) => {
  // Diagnostic endpoint only: report the path received through each gateway.
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    service: 'cismeHttpReadiness', version: '2026-09-09.3', runtime: process.version,
    architecture: process.arch, platform: process.platform,
    glibc: process.report.getReport().header.glibcVersionRuntime,
    requestPath: request.url.split('?')[0],
    businessDeployment: false
  }));
}).listen(9000, '0.0.0.0');
