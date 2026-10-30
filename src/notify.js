'use strict';
// Telegram alerts: "Backup OK" / "Backup failed".

async function telegram({ token, chatId }, text) {
  if (!token || !chatId) return { sent: false, reason: 'not set up' };
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.description || `Telegram answered ${res.status}`);
  return { sent: true };
}

function backupMessage(server, manifest, fmt) {
  const icon = { ok: '✅', partial: '⚠️', failed: '❌' }[manifest.status] || 'ℹ️';
  const word = { ok: 'Backup OK', partial: 'Backup finished with problems', failed: 'Backup FAILED' }[manifest.status] || 'Backup';
  const lines = [`${icon} ${word} — ${server.name} (${server.host})`];
  if (manifest.totalBytes) lines.push(`Size: ${fmt(manifest.totalBytes)}`);
  for (const i of manifest.items.filter((x) => x.status === 'failed').slice(0, 5)) lines.push(`• ${i.label}: ${i.error}`);
  return lines.join('\n');
}

module.exports = { telegram, backupMessage };
