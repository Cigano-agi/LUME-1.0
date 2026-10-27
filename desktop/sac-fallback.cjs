const { createHash } = require('node:crypto');
const { readFileSync, lstatSync } = require('node:fs');
const { join } = require('node:path');

const POLICY = '{0283ac0f-fff1-49ae-ada1-8a933130cad6}';
const fail = () => Object.assign(new Error('SAC_FALLBACK_INVALIDO'), { code: 'SAC_FALLBACK_INVALIDO' });

function regular(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw fail();
  return stat;
}

// This marker is placed only on a PC where CodeIntegrity 3077 was checked for
// this exact helper. It disables the optional MCP listener; it grants no access.
function brokerBlockedByLocalPolicy(resourcesPath, platform = process.platform) {
  if (platform !== 'win32') return false;
  const markerPath = join(resourcesPath, 'lume-sac-no-mcp.json');
  try {
    regular(markerPath, 512);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw fail();
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (!marker || Object.getPrototypeOf(marker) !== Object.prototype ||
      Object.keys(marker).sort().join(',') !== 'helperSha256,policyGuid,schema' ||
      marker.schema !== 1 || marker.policyGuid !== POLICY ||
      typeof marker.helperSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(marker.helperSha256)) throw fail();
    const helper = join(resourcesPath, 'app.asar.unpacked', 'native', 'win-acl', 'bin', 'lume-acl.exe');
    regular(helper, 4 * 1024 * 1024);
    if (createHash('sha256').update(readFileSync(helper)).digest('hex') !== marker.helperSha256) throw fail();
    return true;
  } catch { throw fail(); }
}

module.exports = { brokerBlockedByLocalPolicy };
