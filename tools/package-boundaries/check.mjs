import ts from 'typescript';
import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const portable = { has: name => name.startsWith('@edge-ffmpeg/') && !name.startsWith('@edge-ffmpeg/runtime-') && !['@edge-ffmpeg/storage-r2', '@edge-ffmpeg/distributed'].includes(name) };
export function importsOf(source, file = 'input.ts') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) imports.push('<dynamic-module>');
      else imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}
export function checkImport(owner, specifier, declared, knownNames, filename, packageRoot) {
  if (specifier === '<dynamic-module>') return 'Computed module loading cannot be statically checked';
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(filename), specifier);
    const path = relative(packageRoot, target);
    return path === '..' || path.startsWith('../') || isAbsolute(path) ? 'Relative import escapes package' : null;
  }
  if (specifier.startsWith('/') || specifier.startsWith('#')) return 'Absolute and package-import aliases are not permitted';
  if (portable.has(owner) && (builtins.has(specifier) || specifier.startsWith('node:') || specifier.startsWith('cloudflare:') || specifier.startsWith('@cloudflare/') || specifier.startsWith('@edge-ffmpeg/runtime-') || specifier === '@edge-ffmpeg/storage-r2' || specifier === '@edge-ffmpeg/distributed')) return 'Runtime dependency in portable package';
  if (specifier.startsWith('cloudflare:')) return owner === '@edge-ffmpeg/runtime-cloudflare' && specifier === 'cloudflare:workers' ? null : 'Cloudflare builtin outside Cloudflare adapter';
  if (builtins.has(specifier)) return owner === '@edge-ffmpeg/runtime-node' ? null : 'Node builtin outside Node adapter';
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  if (!declared.has(name)) return `Undeclared dependency: ${name}`;
  if (knownNames.has(name) && specifier !== name) return 'Workspace package must use its public entry point';
  return null;
}
export function findCycles(graph) {
  const errors = [], active = new Set(), visited = new Set();
  function visit(name, path) {
    if (active.has(name)) { errors.push([...path, name].join(' -> ')); return; }
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
    active.delete(name); visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  return errors;
}
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
export function checkPackages(root) {
  const directories = readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => resolve(root, 'packages', x.name));
  const packages = directories.map(directory => ({ directory, manifest: JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) }));
  const names = new Set(packages.map(p => p.manifest.name));
  const graph = new Map(), errors = [];
  for (const { directory, manifest } of packages) {
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    graph.set(manifest.name, [...declared].filter(name => names.has(name)));
    for (const file of walk(resolve(directory, 'src')).filter(file => /\.[cm]?[jt]s$/.test(file))) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'), file)) {
        const error = checkImport(manifest.name, specifier, declared, names, file, directory);
        if (error) errors.push(`${relative(root, file)}: ${error} (${specifier})`);
      }
    }
  }
  return [...errors, ...findCycles(graph).map(cycle => `Dependency cycle: ${cycle}`)];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkPackages(resolve(import.meta.dirname, '../..'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Package boundaries and dependency cycles checked');
}
