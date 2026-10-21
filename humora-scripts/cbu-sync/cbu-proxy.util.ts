import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Builds axios agent config for routing CBU API calls through a forward proxy.
 *
 * Reads CBU_PROXY_URL (e.g. http://213.148.30.102:3128). Only CBU calls use
 * this proxy — all other services (myorg, mib, chamber, etc.) connect directly.
 * This avoids the problem of HTTP_PROXY/HTTPS_PROXY routing ALL axios traffic
 * through the proxy and breaking unrelated external services.
 *
 * Usage:
 *   const agents = buildProxyAgents();
 *   await axios.post(url, data, { ...agents, ... });
 *
 * Returns empty object when CBU_PROXY_URL is not set (direct connection).
 */
export function buildProxyAgents(): {
  httpAgent?: InstanceType<typeof HttpProxyAgent>;
  httpsAgent?: InstanceType<typeof HttpsProxyAgent>;
  proxy?: false;
} {
  const proxyUrl = process.env.CBU_PROXY_URL;
  if (!proxyUrl) return {};

  return {
    httpAgent: new HttpProxyAgent(proxyUrl),
    httpsAgent: new HttpsProxyAgent(proxyUrl),
    proxy: false, // disable axios built-in proxy handling — use agents instead
  };
}
