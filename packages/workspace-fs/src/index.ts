import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assert, fail, canonical, hash, now, relative, LIMITS, type Policy, type Manifest, type Capture } from '../../protocol/src/index.js';
function safeAncestors(p: string) {
  const absolute = path.resolve(p); let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); const stat = fs.lstatSync(current);
    assert(!stat.isSymbolicLink() && stat.isDirectory(), 'Symlink or non-directory ancestor: ' + current, 'MATERIALIZATION_CONFLICT');
  }
}
// Linux directory descriptors pin each ancestor while opening the next component.
// O_NOFOLLOW applies at every step, so replacing a parent with a symlink cannot
// redirect a content read outside the selected tree.
function openRegularNoFollow(full: string): number {
  assert(process.platform === 'linux', 'Secure capture currently requires Linux', 'UNSUPPORTED_FILE_TYPE');
  const parts = path.resolve(full).split('/').filter(Boolean);
  let dir = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const component of parts.slice(0,-1)) {
      const next = fs.openSync(`/proc/self/fd/${dir}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(dir); dir = next;
    }
    return fs.openSync(`/proc/self/fd/${dir}/${parts.at(-1)!}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } finally { fs.closeSync(dir); }
}
function inventory(root: string): { paths: string[]; coverage: Manifest['coverage'] } {
  let gitRoot: string | undefined;
  try { gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch { /* Folder without Git. */ }
  if (gitRoot) {
    assert(fs.realpathSync(gitRoot) === root, 'Git workspace must be the repository root');
    const bytes = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 32 * 1024 * 1024 });
    assert(Buffer.from(bytes.toString('utf8')).equals(bytes), 'Non UTF-8 filename is unsupported', 'UNSUPPORTED_FILE_TYPE');
    return { paths: [...new Set(bytes.toString('utf8').split('\0').filter(Boolean))].sort(), coverage: 'git-tracked-and-unignored' };
  }
  const paths: string[] = [];
  function walk(dir: string, prefix: string) {
    assert(prefix.split('/').length<=128,'Directory nesting limit exceeded','LIMIT_EXCEEDED');
    for (const name of fs.readdirSync(dir, { encoding: 'buffer' })) {
      assert(Buffer.from(name.toString('utf8')).equals(name), 'Non UTF-8 filename is unsupported', 'UNSUPPORTED_FILE_TYPE');
      const p = prefix + name.toString('utf8'); if (p === '.git' || p.startsWith('.git/')) continue;
      const stat = fs.lstatSync(path.join(root, p));
      if (stat.isDirectory()) walk(path.join(root, p), p + '/'); else paths.push(p);
      assert(paths.length <= LIMITS.entries, 'Too many paths', 'LIMIT_EXCEEDED');
    }
  }
  walk(root, ''); return { paths: paths.sort(), coverage: 'directory' };
}
export function scan(rootInput: string, policy: Policy, archive: string, mode: 'strict' | 'partial'): { manifest: Manifest; blobs: Map<string, Buffer> } {
  safeAncestors(rootInput); const root = fs.realpathSync(rootInput);
  const inv = inventory(root); assert(inv.paths.length<=LIMITS.entries,'Too many paths','LIMIT_EXCEEDED'); const entries: Manifest['entries'] = []; const exclusions: Manifest['exclusions'] = [];
  const blobs = new Map<string, Buffer>(); const normalized = new Set<string>(); let total = 0;
  const archiveRelative = path.relative(root, fs.realpathSync(archive)).split(path.sep).join('/');
  assert(archiveRelative !== '', 'Archive cannot be the workspace root');
  const excluded = [...policy.exclude, '.git', ...(archiveRelative && !archiveRelative.startsWith('../') ? [archiveRelative] : [])];
  for (const p of inv.paths) {
    relative(p); const norm = p.normalize('NFC'); assert(!normalized.has(norm), 'Unicode normalization collision', 'UNSUPPORTED_FILE_TYPE'); normalized.add(norm);
    if (excluded.some(x => p === x || p.startsWith(x + '/'))) { exclusions.push({ path: p, reason: 'policy' }); continue; }
    const full = path.join(root, p);
    const omit = (reason: string, code: 'UNSUPPORTED_FILE_TYPE' | 'LIMIT_EXCEEDED') => { if (mode === 'strict') fail(code, `${reason}: ${p}`); exclusions.push({ path: p, reason }); };
    try {
      safeAncestors(path.dirname(full));
      const stat = fs.lstatSync(full, { bigint: true });
      if (!stat.isFile()) { omit('unsupported-file-type', 'UNSUPPORTED_FILE_TYPE'); continue; }
      if (stat.size > BigInt(policy.max_file) || stat.size + BigInt(total) > BigInt(policy.max_total)) { omit('size-limit', 'LIMIT_EXCEEDED'); continue; }
      const fd = openRegularNoFollow(full);
      let bytes: Buffer;
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        assert(before.isFile() && before.ino === stat.ino && before.dev === stat.dev && before.size === stat.size, 'File replaced during capture', 'CAPTURE_UNSTABLE');
        // Bounded read: a concurrently growing source cannot allocate unbounded memory.
        bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); assert(n > 0, 'File shortened during capture', 'CAPTURE_UNSTABLE'); offset += n; }
        const after = fs.fstatSync(fd, { bigint: true });
        assert(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'File changed during capture', 'CAPTURE_UNSTABLE');
      } finally { fs.closeSync(fd); }
      safeAncestors(path.dirname(full));
      const last = fs.lstatSync(full, { bigint: true }); assert(last.ino === stat.ino && last.dev === stat.dev && last.ctimeNs === stat.ctimeNs, 'File replaced during capture', 'CAPTURE_UNSTABLE');
      const digest = hash(bytes); blobs.set(digest, bytes); total += bytes.length;
      entries.push({ path: p, type: 'file', mode: Number(stat.mode) & 0o111 ? 0o755 : 0o644, hash: digest, size: bytes.length });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // Tracked deletion; repeated inventories still establish stability.
      throw e;
    }
  }
  return { manifest: { version: 1, entries, exclusions, policy_hash: hash(canonical(policy)), coverage: inv.coverage }, blobs };
}
export function capture(root: string, policy: Policy, archive: string, mode: 'strict' | 'partial', quality: 'observed' | 'quiescent', cooperating: boolean): Capture {
  assert(quality !== 'quiescent' || cooperating, 'Quiescent capture requires explicit writer-cooperation acknowledgement');
  const started_at = now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const a = scan(root, policy, archive, mode); const b = scan(root, policy, archive, mode);
      if (canonical(a.manifest) !== canonical(b.manifest)) continue;
      return { ...b, started_at, finished_at: now(), quality, assumption: quality === 'quiescent' ? 'Caller stopped all known writers; repeated hashes stable. External writers remain outside our control.' : 'Files observed over a capture window; repeated hashes stable, no global filesystem snapshot.' };
    } catch (e) { if ((e as { code?: string }).code !== 'CAPTURE_UNSTABLE') throw e; }
  }
  fail('CAPTURE_UNSTABLE', 'Workspace did not stabilize after three capture attempts');
}
export function validateManifest(manifest: Manifest) {
  assert(manifest.version === 1 && Array.isArray(manifest.entries) && Array.isArray(manifest.exclusions), 'Invalid manifest', 'INTEGRITY_ERROR');
  assert(manifest.entries.length <= LIMITS.entries, 'Too many entries', 'LIMIT_EXCEEDED');
  const paths = new Set<string>(); const folded = new Set<string>(); let previous = ''; let total = 0;
  for (const entry of manifest.entries) {
    relative(entry.path); assert(entry.path > previous && !paths.has(entry.path.normalize('NFC')), 'Duplicate, unsorted or normalization-colliding paths', 'INTEGRITY_ERROR'); previous = entry.path;
    const key = entry.path.normalize('NFC'); paths.add(key);
    // Conservative portable subset; reject even on a case-sensitive host.
    const lower = key.toLowerCase(); assert(!folded.has(lower), 'Case collision', 'MATERIALIZATION_CONFLICT'); folded.add(lower);
    assert(entry.type === 'file' && [0o644,0o755].includes(entry.mode) && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= LIMITS.file, 'Invalid manifest entry', 'INTEGRITY_ERROR');
    total += entry.size;
  }
  for (const p of folded) { const parts = p.split('/'); parts.pop(); while (parts.length) { assert(!folded.has(parts.join('/')), 'File-directory collision', 'MATERIALIZATION_CONFLICT'); parts.pop(); } }
  assert(total <= LIMITS.capture, 'Materialization exceeds total limit', 'LIMIT_EXCEEDED');
}
export function materialize(manifest: Manifest, getBlob: (hash: string) => Buffer, targetInput: string) {
  validateManifest(manifest); const target = path.resolve(targetInput); safeAncestors(path.dirname(target));
  assert(!fs.existsSync(target), 'Target must be absent', 'MATERIALIZATION_CONFLICT');
  // Validate all content before creating any output.
  for (const entry of manifest.entries) { const b = getBlob(entry.hash); assert(hash(b) === entry.hash && b.length === entry.size, 'Blob integrity failure', 'INTEGRITY_ERROR'); }
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.hyperweave-staging-')); fs.chmodSync(staging, 0o700);
  let reserved = false;
  try {
    for (const entry of manifest.entries) {
      const file = path.join(staging, entry.path); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, 'wx', 0o600);
      try { const bytes = getBlob(entry.hash); fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, entry.mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      assert(hash(fs.readFileSync(file)) === entry.hash, 'Written file failed verification', 'INTEGRITY_ERROR');
    }
    safeAncestors(path.dirname(target));
    // Exclusive reservation prevents overwriting an existing directory, including an empty one.
    fs.mkdirSync(target, { mode: 0o700 }); reserved = true; fs.renameSync(staging, target); reserved = false;
    return { target, files: manifest.entries.length, exclusions: manifest.exclusions };
  } catch (e) { if (reserved) fs.rmdirSync(target); throw e; }
  finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
