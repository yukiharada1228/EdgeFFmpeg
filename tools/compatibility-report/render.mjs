/** Markdown summary of a report object; every platform it prints comes from the report itself. */
export function renderMarkdown(report) {
  const lines = [
    '# EdgeFFmpeg development compatibility evidence', '',
    `Generated: ${report.finishedAt}`, `Run: ${report.runId}`, '',
    `Development validation on ${report.platform?.host ?? 'an unknown platform'}: **${report.developmentValidation}**`,
    '**Full FFmpeg compatibility is not certified.**', '',
    `Platform: ${report.platform?.host ?? 'unknown'} (reference build: ${report.platform?.reference ?? 'unknown'}; platform gating: ${report.platform?.policy ?? 'disabled'}). Every result below was produced on this platform.`,
    `Platform gating: ${report.platform?.reason ?? 'not evaluated'}.`, '',
    `Source snapshot stable: ${report.sourceStable ?? false}`, `Reference artifacts stable: ${report.referenceStable ?? false}`, '',
    '| Suite | Platform | Result | Passed | Failed | Not applicable | Unexpected skips | Total |', '|---|---|---|---:|---:|---:|---:|---:|'
  ];
  for (const [name, suite] of Object.entries(report.suites ?? {})) lines.push(`| ${name} | ${suite.platform ?? report.platform?.host ?? 'unknown'} | ${suite.status} | ${suite.passed ?? 0} | ${suite.failed ?? 0} | ${suite.notApplicable ?? 0} | ${suite.unexpectedSkips ?? 0} | ${suite.total ?? 0} |`);
  lines.push('', 'Not-applicable tests are skips of tests whose contracts list only other platforms. They are neither passed nor failed, and are never counted as passed. Any other skip fails its file and suite.');
  const unexpected = Object.values(report.suites ?? {}).flatMap(suite => (suite.assertions ?? []).filter(test => test.outcome === 'unexpected-skip'));
  if (unexpected.length) {
    lines.push('', '## Unexpected skips', '');
    for (const test of unexpected) lines.push(`- ${test.file}: ${test.name} (${test.status})`);
  }
  if (report.capabilities) lines.push('', `Capability entries: ${report.capabilities.total}`, `Implementation states: ${JSON.stringify(report.capabilities.states)}`, `Unverified full conformance: ${report.capabilities.unverifiedConformance}`, '', 'Capability entries include codec families as well as separate encoder/decoder entries; they are not independent end-user features.');
  if (report.capabilities?.knownDifferences.length) {
    lines.push('', '## Known differences', '');
    for (const difference of report.capabilities.knownDifferences) lines.push(`- ${difference.features.join(', ')}: ${difference.notes}`);
  }
  lines.push('', '## Scoped native comparisons', '', '| Contract | Result | Platform | Required platforms | Modes | Scope |', '|---|---|---|---|---|---|');
  for (const contract of report.contracts ?? []) lines.push(`| ${contract.id} | ${contract.status} | ${contract.platform ?? 'unknown'} | ${contract.platforms?.join(', ') ?? 'all'} | ${contract.modes.join(', ')} | ${contract.scope.replaceAll('|', '\\|')} |`);
  if (report.notApplicable?.contracts) lines.push('', `Not applicable on ${report.platform?.host ?? 'this platform'}: ${report.notApplicable.contracts} ${report.notApplicable.contracts === 1 ? 'contract' : 'contracts'}, not counted as passed. They resolve only on a run on ${report.notApplicable.requiredPlatforms.join(', ')}.`);
  lines.push('', 'Bit-exact PCM comparisons cover only their named payload fixtures. They do not establish WAV file byte identity or full codec compatibility.', '', '## Required gates', '');
  for (const gate of report.gates ?? []) lines.push(`- ${gate.name}: ${gate.status} (exit ${gate.exitCode})`);
  if (report.reference) lines.push('', `Canonical target platform: ${report.reference.targetPlatformMatches}`, `Reproducible toolchain pinned: ${report.reference.reproducibleToolchainPinned}`, '', 'Native tests use the recorded local oracle. Local workerd tests are not production Cloudflare verification.');
  if (report.fate) lines.push('', `FATE explicit command definitions: ${report.fate.explicitCommandDefinitions}; executed with reviewed adaptations: ${report.fate.executedDefinitions}; unexecuted: ${report.fate.unexecutedDefinitions}. Generated Make targets are not included.`);
  if (report.failure) lines.push('', `Report failure: ${report.failure}`);
  lines.push('', 'See current.json and the run evidence directory for source/artifact hashes, test assertions and known differences.');
  return lines.join('\n') + '\n';
}
