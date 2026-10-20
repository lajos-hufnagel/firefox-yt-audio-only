'use strict';
// Process ownership shared by the optional browser benches. Never match a whole app name.
const { spawnSync } = require('child_process');
function profileFromLog(log) {
  const match = /Running Firefox with profile at ([^\r\n]+)/.exec(log);
  return match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
}
function profilePattern(profile) {
  if (!profile) return null;
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '(^|[[:space:]])-{1,2}profile[[:space:]]+' + escaped + '([[:space:]]|$)';
}
function running(profile) {
  const pattern = profilePattern(profile);
  if (!pattern) return '';
  return (spawnSync('pgrep', ['-fl', pattern], { encoding: 'utf8' }).stdout || '').trim();
}
function signal(child, profile, name) {
  if (child && child.pid) {
    try { process.kill(-child.pid, name); } catch (e) { /* own group already gone */ }
  }
  const pattern = profilePattern(profile);
  if (pattern) spawnSync('pkill', [name === 'SIGKILL' ? '-9' : '-15', '-f', pattern], { encoding: 'utf8' });
}
async function stop(child, profile) {
  signal(child, profile, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  signal(child, profile, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
}
module.exports = { profileFromLog, profilePattern, running, stop };
