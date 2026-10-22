import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const paths = ['dist', 'plugins', '.agents', '.claude-plugin', 'package.json'];
const hash = (data) => createHash('sha256').update(data).digest('hex');

export function fingerprintPackage(root) {
  const files = {};
  const visit = (name) => {
    const entry = join(root, name);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`Staged package code must not contain symlinks: ${name}`);
    if (stat.isDirectory()) for (const child of readdirSync(entry).sort()) visit(`${name}/${child}`);
    else if (stat.isFile()) files[name] = hash(readFileSync(entry));
    else throw new Error(`Staged package code is not a regular file: ${name}`);
  };
  for (const name of paths) visit(name);
  return { files, sha256: hash(JSON.stringify(files)) };
}

export function stagePackage(source, target, expectedHash) {
  const staging = mkdtempSync(join(dirname(target), 'package-stage-'));
  const archive = join(dirname(target), 'installation-history', randomBytes(6).toString('hex'));
  mkdirSync(archive, { mode: 0o700, recursive: true });
  for (const name of paths) cpSync(join(source, name), join(staging, name), { recursive: true, dereference: false });
  if (fingerprintPackage(staging).sha256 !== expectedHash) throw new Error('Staged package fingerprint does not match the expected source');
  if (existsSync(join(source, 'node_modules'))) symlinkSync(realpathSync(join(source, 'node_modules')), join(staging, 'node_modules'), 'dir');
  const previous = join(archive, 'installed');
  renameSync(target, previous);
  try {
    renameSync(staging, target);
    if (fingerprintPackage(target).sha256 !== expectedHash) throw new Error('Actual installed package fingerprint does not match the intended candidate');
  } catch (error) {
    if (existsSync(target)) renameSync(target, join(archive, 'failed-candidate'));
    renameSync(previous, target);
    throw error;
  }
  return { code_sha256: expectedHash, dependency_root: existsSync(join(target, 'node_modules')) ? realpathSync(join(target, 'node_modules')) : null, previous_package: previous };
}
