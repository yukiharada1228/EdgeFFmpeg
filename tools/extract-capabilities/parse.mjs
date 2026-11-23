/** Parse the human-readable listings of the pinned FFmpeg version. Preserve flags. */
export function parseListing(kind, output) {
  const entries = [];
  let direction;
  for (const line of output.split('\n')) {
    if (kind === 'protocol') {
      if (/^(Input|Output):$/.test(line)) direction = line.slice(0, -1).toLowerCase();
      else if (direction && /^  [a-zA-Z0-9_+-]+\s*$/.test(line)) entries.push({ name: line.trim(), direction });
      continue;
    }
    if (kind === 'hardware') {
      if (/^[a-z0-9_]+$/.test(line)) entries.push({ name: line });
      continue;
    }
    if (kind === 'sampleFormat') {
      const match = /^([a-z][a-z0-9]+)\s+(\d+)\s*$/.exec(line);
      if (match) entries.push({ name: match[1], bits: Number(match[2]) });
      continue;
    }
    const match = /^\s*([A-Z. |]{1,8})\s+(\S+)\s+(.+)$/.exec(line);
    if (!match || match[2] === '=' || !/^[a-zA-Z0-9_,+-]+$/.test(match[2])) continue;
    const flags = match[1].trim();
    for (const name of match[2].split(',')) {
      if (kind === 'format') {
        if (flags.includes('D')) entries.push({ name, kind: 'demuxer', flags });
        if (flags.includes('E')) entries.push({ name, kind: 'muxer', flags });
      } else entries.push({ name, flags });
    }
  }
  return entries;
}
