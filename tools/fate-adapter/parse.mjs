/** Inventory make definitions without evaluating make or executing shell fragments. */
export function inventoryFate(source, file) {
  const cases = [];
  const logical = source.replace(/\\\r?\n/g, ' ');
  for (const [index, line] of logical.split('\n').entries()) {
    const match = /^(fate-[\w.+-]+):\s*CMD\s*[:?+]?=\s*(.+)$/.exec(line);
    if (!match) continue;
    const [, id, command] = match;
    cases.push({ id, file, logicalLine: index + 1, command,
      helper: command.split(/\s+/)[0],
      sampleDependent: command.includes('$(TARGET_SAMPLES)'),
      status: 'unported', reason: 'Requires helper semantics, variable resolution and an EdgeFFmpeg executor' });
  }
  return cases;
}
