'use strict';

// Deployment probe only: no member data, caller identifiers or credentials.
exports.main = async function (event = {}) {
  const result = {
    service: 'cismeReadiness',
    version: '2026-09-09.1',
    runtime: process.version,
    businessDeployment: false
  };
  if (event.probe === 'network') {
    const start = Date.now();
    try {
      const response = await fetch('https://cisme-app.onrender.com/health/ready', {
        signal: AbortSignal.timeout(1800)
      });
      result.backend = { reachable: response.ok, httpStatus: response.status, elapsedMs: Date.now() - start };
    } catch {
      result.backend = { reachable: false, elapsedMs: Date.now() - start, reason: 'NETWORK_OR_TIMEOUT' };
    }
  }
  return result;
};
