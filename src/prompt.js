// Builds the system prompt. Files are re-read on every call, so edits to
// guideline.md / shop-info.md / barbers.json apply on the next call without
// restarting the server.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function loadBarbers() {
  return JSON.parse(readFileSync(path.join(DATA_DIR, 'barbers.json'), 'utf8'));
}

export function buildSystemPrompt() {
  const guideline = readFileSync(path.join(DATA_DIR, 'guideline.md'), 'utf8');
  const shopInfo = readFileSync(path.join(DATA_DIR, 'shop-info.md'), 'utf8');
  const { barbers } = loadBarbers();

  const barberLines = barbers
    .map((b) => {
      const extras = [];
      if (b.aliases?.length) extras.push(`also called ${b.aliases.join(', ')}`);
      if (b.tier) extras.push(`tier: ${b.tier}`);
      return `- ${b.name}${extras.length ? ` (${extras.join('; ')})` : ''}`;
    })
    .join('\n');

  const now = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return `${guideline}

# SHOP INFO
${shopInfo}

# BARBERS
These are all the barbers. Speech-to-text may misspell names, so match what the caller says to the closest name.
${barberLines}

# RIGHT NOW
It's currently ${now} (Toronto time). Use this to tell callers if the shop is open right now.`;
}
