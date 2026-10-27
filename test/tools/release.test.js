import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const digest = text => createHash('sha256').update(text).digest('hex');

test('release preparation rejects stale binaries, packs all targets, and detects tarball tampering before publishing', () => {
  assert.ok(process.env.npm_execpath, 'Run through npm run test:release');
  const root = mkdtempSync(join(tmpdir(), 'webgpu release ü 渲染 '));
  const write = (path, text) => writeFileSync(join(root, path), text);
  const json = (path, value) => write(path, JSON.stringify(value));
  const names = Object.keys(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).optionalDependencies);
  try {
    for (const directory of ['deps', 'src', 'skills/webgpu', 'native']) mkdirSync(join(root, directory), { recursive: true });
    copyFileSync(new URL('../../deps/release.js', import.meta.url), join(root, 'deps/release.js'));
    write('native/driver.cpp', 'current source');
    write('native/build.py', 'native build');
    write('deps/mesa.py', 'mesa build');
    write('deps/bundle.py', 'bundle build');
    write('src/index.js', 'export const fixture = true;');
    write('skills/webgpu/SKILL.md', 'Fixture skill');
    write('README.md', 'Fixture');
    write('LICENSE', 'Fixture license');
    json('package.json', {
      name: '@drawcall/webgpu', version: '0.1.0', type: 'module', files: ['src', 'skills'],
      optionalDependencies: Object.fromEntries(names.map(name => [name, '0.1.0'])),
    });
    for (const name of names) {
      const target = name.slice('@drawcall/webgpu-'.length);
      const directory = `dist/${target}`;
      mkdirSync(join(root, directory), { recursive: true });
      json(`${directory}/package.json`, { name, version: '0.1.0', files: ['dawn.node', 'build.json', '*NOTICES', 'LICENSE'] });
      write(`${directory}/dawn.node`, 'fixture binary');
      for (const file of ['LICENSE', 'DAWN_NOTICES', 'MESA_NOTICES', 'THIRD_PARTY_NOTICES']) write(`${directory}/${file}`, 'Fixture notice');
      json(`${directory}/build.json`, {
        target, driver: 'mesa', sources: {
          'native/driver.cpp': digest('current source'), 'native/build.py': digest('native build'),
          'deps/mesa.py': digest('mesa build'), 'deps/bundle.py': digest('bundle build'),
        },
        libraries: { 'dawn.node': digest('fixture binary') },
      });
    }
    const run = (...args) => spawnSync(process.execPath, ['deps/release.js', ...args], { cwd: root, encoding: 'utf8' });
    const original = readFileSync(join(root, 'package.json'), 'utf8');
    write('native/driver.cpp', 'changed source');
    assert.match(run('prepare', '0.2.0').stderr, /Rebuild .*driver.cpp changed/);
    write('native/driver.cpp', 'current source');
    write('deps/mesa.py', 'fixed Mesa build');
    assert.match(run('prepare', '0.2.0').stderr, /Rebuild .*deps\/mesa.py changed/);
    write('deps/mesa.py', 'mesa build');
    const firstBuild = join(root, 'dist', names[0].slice('@drawcall/webgpu-'.length), 'build.json');
    const build = JSON.parse(readFileSync(firstBuild));
    const missing = structuredClone(build);
    delete missing.sources['deps/mesa.py'];
    writeFileSync(firstBuild, JSON.stringify(missing));
    assert.match(run('prepare', '0.2.0').stderr, /missing source provenance for deps\/mesa.py/);
    writeFileSync(firstBuild, JSON.stringify(build));
    const prepared = run('prepare', '0.2.0');
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), original);
    const release = JSON.parse(readFileSync(join(root, 'dist/release/release.json')));
    assert.equal(release.version, '0.2.0');
    assert.deepEqual(release.packages.map(item => item.name), [...names, '@drawcall/webgpu']);
    const main = release.packages.at(-1);
    const unpack = spawnSync('tar', ['-xOf', join(root, 'dist/release', main.file), 'package/package.json'], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const packed = JSON.parse(unpack.stdout);
    assert.equal(packed.version, '0.2.0');
    assert.deepEqual(Object.values(packed.optionalDependencies), names.map(() => '0.2.0'));
    write(`dist/release/${main.file}`, 'tampered');
    const rejected = run('publish', '--dry-run');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /checksum mismatch/);
    assert.equal(rejected.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishing resumes matching packages and rejects conflicts or registry errors before publishing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'webgpu-publish-test-')));
  const write = (path, value) => writeFileSync(join(root, path), value);
  const json = (path, value) => write(path, JSON.stringify(value));
  try {
    mkdirSync(join(root, 'deps'));
    mkdirSync(join(root, 'dist/release'), { recursive: true });
    copyFileSync(new URL('../../deps/release.js', import.meta.url), join(root, 'deps/release.js'));
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
    json('package.json', manifest);
    const names = [...Object.keys(manifest.optionalDependencies), manifest.name];
    const packages = names.map((name, index) => {
      const file = `${index}.tgz`;
      write(`dist/release/${file}`, name);
      return { name, file, sha256: digest(name) };
    });
    json('dist/release/release.json', { version: '0.1.0', packages });
    write('npm.js', `
      import { appendFileSync, readFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
      if (args[0] === 'view') {
        const registry = JSON.parse(readFileSync('registry.json'));
        const value = registry[args[1]] ?? { error: { code: 'E404' } };
        console.log(JSON.stringify(value));
        process.exit(value.error ? 1 : 0);
      }
      if (args[0] !== 'publish') throw new Error('Unexpected npm operation');
    `);
    const registry = Object.fromEntries(names.slice(0, 5).map(name => [
      `${name}@0.1.0`, `sha512-${createHash('sha512').update(name).digest('base64')}`,
    ]));
    const run = () => {
      write('calls.jsonl', '');
      return spawnSync(process.execPath, ['deps/release.js', 'publish', '--dry-run'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: join(root, 'npm.js') },
      });
    };
    const calls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    json('registry.json', registry);
    const resumed = run();
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(calls().slice(0, names.length).map(args => args[0]), names.map(() => 'view'));
    assert.deepEqual(calls().slice(names.length).map(args => args[1]), packages.slice(5).map(item => join(root, 'dist/release', item.file)));
    assert.ok(calls().slice(names.length).every(args => args.includes('--dry-run')));
    for (const [value, message] of [
      ['sha512-conflicting', /already exists with different contents/],
      [{ error: { code: 'E401' } }, /Cannot check/],
      [{ error: { code: 'ENETUNREACH' } }, /Cannot check/],
    ]) {
      json('registry.json', { ...registry, [`${names.at(-1)}@0.1.0`]: value });
      const rejected = run();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, message);
      assert.ok(calls().every(args => args[0] === 'view'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trust configures precisely these nine packages and dry-run invokes no external command', () => {
  const root = mkdtempSync(join(tmpdir(), 'webgpu-trust-test-'));
  try {
    mkdirSync(join(root, 'deps'));
    copyFileSync(new URL('../../deps/release.js', import.meta.url), join(root, 'deps/release.js'));
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, 'npm.js'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
    `);
    const log = join(root, 'calls.jsonl');
    writeFileSync(log, '');
    const run = (...args) => spawnSync(process.execPath, ['deps/release.js', 'trust', ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, npm_execpath: join(root, 'npm.js') },
    });
    const expected = [...Object.keys(manifest.optionalDependencies), manifest.name].map(name => [
      'trust', 'github', name, '--repo', 'drawcall-ai/webgpu', '--file', 'publish-package.yml', '--allow-publish', '--yes',
    ]);
    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(readFileSync(log, 'utf8'), '');
    assert.deepEqual(dry.stdout.trim().split('\n'), expected.map(args => `npm ${args.join(' ')}`));
    const configured = run();
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
