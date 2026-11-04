import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean', default: false } },
});
const [command, version] = positionals;
assert.ok(['prepare', 'publish', 'trust'].includes(command), 'Usage: npm run release:prepare -- VERSION, or npm run release:publish/release:trust -- [--dry-run]');
assert.equal(positionals.length, command === 'prepare' ? 2 : 1);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Invoke through an npm run release:* script');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/release');
const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
const names = [...Object.keys(manifest.optionalDependencies), manifest.name];

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function run(args, capture = false) {
  return execFileSync(process.execPath, [npm, ...args], {
    cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

async function prepare() {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected a stable release version such as 0.1.0');
  assert.ok(!values['dry-run'], 'Preparation does not publish; --dry-run only applies to publish');
  const native = names.slice(0, -1).map(name => {
    const target = name.slice(`${manifest.name}-`.length);
    const directory = join(root, 'dist', target);
    const packageJson = JSON.parse(readFileSync(join(directory, 'package.json')));
    const build = JSON.parse(readFileSync(join(directory, 'build.json')));
    assert.equal(packageJson.name, name, `Wrong package in ${directory}`);
    assert.equal(build.target, target, `Wrong binary target in ${directory}`);
    assert.equal(build.driver, 'mesa');
    const required = ['native/build.py', 'deps/mesa.py', ...(target.startsWith('linux') ? ['deps/bundle.py'] : [])];
    for (const file of required) assert.ok(Object.hasOwn(build.sources, file), `${target}: missing source provenance for ${file}`);
    for (const [file, checksum] of Object.entries(build.sources)) {
      assert.equal(hash(join(root, file)), checksum, `Rebuild ${target}: ${file} changed`);
    }
    for (const [file, checksum] of Object.entries(build.libraries)) {
      assert.equal(hash(join(directory, file)), checksum, `${target}/${file} checksum mismatch`);
    }
    for (const file of ['LICENSE', 'DAWN_NOTICES', 'MESA_NOTICES', 'THIRD_PARTY_NOTICES']) {
      assert.ok(existsSync(join(directory, file)), `${target}/${file} missing`);
    }
    return { directory, packageJson };
  });

  // Validate every platform before replacing a previously prepared release.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'webgpu-release-'));
  const packages = [];
  try {
    const main = join(stage, 'main');
    mkdirSync(main);
    for (const file of [...manifest.files, 'README.md', 'LICENSE']) {
      await cp(join(root, file), join(main, file), { recursive: true });
    }
    manifest.optionalDependencies = Object.fromEntries(names.slice(0, -1).map(name => [name, version]));
    for (const { directory, packageJson } of [...native, { directory: main, packageJson: manifest }]) {
      // Native artifacts are disposable CI output; the source package.json stays untouched.
      writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
      const [packed] = JSON.parse(run(['pack', directory, '--ignore-scripts', '--json', '--pack-destination', output], true));
      packages.push({ name: packed.name, file: packed.filename, sha256: hash(join(output, packed.filename)) });
    }
    writeFileSync(join(output, 'release.json'), `${JSON.stringify({ version, packages }, null, 2)}\n`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`Prepared ${packages.length} packages in ${output}; nothing published.`);
}

function published(item, version) {
  const spec = `${item.name}@${version}`;
  const result = spawnSync(process.execPath, [npm, 'view', spec, 'dist.integrity', '--json'], {
    cwd: root, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Cannot check ${spec}: ${result.stderr || result.stdout}`, { cause: error });
  }
  if (result.status !== 0) {
    const error = response.error;
    assert.equal(error.code, 'E404', `Cannot check ${spec}: ${result.stderr || result.stdout}`);
    return false;
  }
  const integrity = `sha512-${createHash('sha512').update(readFileSync(join(output, item.file))).digest('base64')}`;
  assert.equal(response, integrity, `${spec} already exists with different contents`);
  console.log(`Already published: ${spec}`);
  return true;
}

async function publish() {
  const release = JSON.parse(readFileSync(join(output, 'release.json')));
  assert.deepEqual(release.packages.map(item => item.name), names, 'Prepared release does not match this package set');
  for (const item of release.packages) {
    assert.equal(basename(item.file), item.file, 'Tarballs must be inside dist/release');
    assert.equal(hash(join(output, item.file)), item.sha256, `${item.file} checksum mismatch`);
  }
  // Check every published version before changing the registry; partial releases resume safely.
  const pending = release.packages.filter(item => !published(item, release.version));
  const upload = async item => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [npm, 'publish', join(output, item.file),
      '--access', 'public', '--tag', 'latest',
      ...(process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : []),
      ...(values['dry-run'] ? ['--dry-run'] : [])], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  };
  // Native packages are independent and publish together; the main package goes last so a
  // published version never references a missing native package.
  const results = await Promise.allSettled(pending.filter(item => item.name !== manifest.name).map(upload));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Native packages failed to publish; the main package was not published');
  for (const item of pending.filter(item => item.name === manifest.name)) await upload(item);
}

// Run after initial publication with npm >=11.15 and an account with 2FA enabled.
async function trust() {
  const repository = manifest.repository.url.match(/^git\+https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/);
  assert.ok(repository, 'Trusted publishing requires a GitHub repository URL');
  for (const [index, name] of names.entries()) {
    const args = ['trust', 'github', name, '--repo', repository[1], '--file', 'publish-package.yml', '--allow-publish', '--yes'];
    console.log(`npm ${args.join(' ')}`);
    if (values['dry-run']) continue;
    // npm recommends spacing bulk trust requests to avoid registry rate limits.
    if (index > 0) await setTimeout(2000);
    run(args);
  }
}

if (command === 'prepare') await prepare();
else if (command === 'trust') await trust();
else await publish();
