// The four test suites of compat:report and the files each one runs (shared by the planner, shards and the selection).
export const SUITES=Object.freeze(['unit','integration','differential','workers']);
const TEST_FILE=/\.(test|spec)\.[cm]?[jt]sx?$/;
/** The test files compat:report expects for a suite, from a source snapshot's file list. */
export function suiteFiles(files,suite){return files.filter(file=>file.startsWith(`tests/${suite}/`)&&TEST_FILE.test(file));}
