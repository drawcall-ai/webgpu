import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node deps/package.js OUTPUT_DIR');
const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const build = JSON.parse(readFileSync(join(dir, 'build.json')));
const target = build.target;
if (!Object.hasOwn(root.optionalDependencies, `@drawcall/webgpu-${target}`)) {
  throw new Error(`Unsupported native package target: ${target}`);
}
const [system, arch] = target.split('-');
const platform = system === 'linuxmusl' ? 'linux' : system;
if (build.driver !== 'mesa') throw new Error('Native build must include Mesa');
const manifest = {
  name: `@drawcall/webgpu-${target}`,
  version: root.version,
  description: `Dawn with native GPU backends and Mesa lavapipe CPU fallback on ${target}`,
  license: platform === 'linux'
    ? 'BSD-3-Clause AND MIT AND Zlib AND Apache-2.0 WITH LLVM-exception AND GPL-3.0-or-later WITH GCC-exception-3.1'
    : 'BSD-3-Clause AND MIT AND Zlib AND Apache-2.0 WITH LLVM-exception',
  repository: root.repository,
  os: [platform],
  cpu: [arch],
  ...(platform === 'linux' ? { libc: [target.startsWith('linuxmusl-') ? 'musl' : 'glibc'] } : {}),
  files: ['dawn.node', '*.so*', '*.dylib', '*.dll', 'build.json', '*NOTICES', 'LICENSE'],
};
writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
  copyFileSync(new URL(`../${file}`, import.meta.url), join(dir, file));
}
