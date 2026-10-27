"""Cloud validation: modal run test/cloud.py [--native-dir /build/linux-x64]."""
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import time
import modal

ROOT = Path(__file__).resolve().parents[1]
volume = modal.Volume.from_name('drawcall-webgpu-build')
image = (modal.Image.from_registry('node:24-trixie-slim', add_python='3.12')
    .run_commands('apt-get update && apt-get install -y --no-install-recommends time && rm -rf /var/lib/apt/lists/*')
    .run_commands('mkdir -p /work /runtime && chmod 700 /runtime')
    .add_local_file(ROOT / 'package.json', '/work/package.json', copy=True)
    .add_local_file(ROOT / 'package-lock.json', '/work/package-lock.json', copy=True)
    .run_commands('cd /work && npm ci --ignore-scripts')
    .env({'XDG_RUNTIME_DIR': '/runtime'})
    .add_local_dir(ROOT / 'src', '/work/src')
    .add_local_dir(ROOT / 'skills', '/work/skills')
    .add_local_dir(ROOT / 'examples/compute-texture', '/work/examples/compute-texture', ignore=['node_modules', 'dist', 'test/out'])
    .add_local_file(ROOT / 'README.md', '/work/README.md')
    .add_local_file(ROOT / 'LICENSE', '/work/LICENSE')
    .add_local_dir(ROOT / 'test', '/work/test', ignore=['out', '__pycache__']))
app = modal.App('drawcall-webgpu-test')

@app.function(image=image, cpu=(2, 2), memory=(1024, 1024), timeout=900, volumes={'/build': volume})
def validate(native_dir: str, repetitions: int):
    env = dict(os.environ)
    env.pop('DRAWCALL_WEBGPU_NATIVE', None)
    def run(args, cwd='/consumer'):
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(f'{args}: exit {result.returncode}\n{result.stdout}\n{result.stderr}')
        return result
    packed = []
    for directory in ['/work', native_dir]:
        result = json.loads(run(['npm', 'pack', directory, '--json', '--pack-destination', '/tmp'], cwd='/work').stdout)
        packed.append('/tmp/' + result[0]['filename'])
    Path('/consumer').mkdir()
    Path('/consumer/package.json').write_text(json.dumps({'private': True, 'type': 'module'}))
    run(['npm', 'install', '--ignore-scripts', '--save-exact', *packed, 'three@0.186.1'])
    shutil.copytree('/work/test', '/consumer/test')
    shutil.copytree('/work/examples', '/consumer/examples')
    def fingerprint():
        return {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                for base in ['/consumer/node_modules/three', '/consumer/test/models']
                for path in sorted(Path(base).rglob('*')) if path.is_file()}
    provenance = json.loads(Path('/consumer/test/reference/manifest.json').read_text())
    for name, digest in provenance['models'].items():
        assert hashlib.sha256(Path('/consumer/test/models', name).read_bytes()).hexdigest() == digest, f'Original asset changed: {name}'
    for scene in ['pbr', 'soldier', 'tokyo']:
        assert hashlib.sha256(Path('/consumer/test/reference', scene + '.png').read_bytes()).hexdigest() == provenance[scene]['sha256'], f'Reference changed: {scene}'
    adapter = json.loads(run(['node', 'test/adapter.js']).stdout)
    before = fingerprint()
    unit = run(['node', '--test', '--test-concurrency=1', 'test/runtime.test.js', 'test/images.test.js', 'test/compute.test.js', 'test/platform.test.js'])
    example = run(['node', '--test', 'examples/compute-texture/test/node.test.js'])
    rows = []
    example_rows = []
    for repetition in range(repetitions):
        for scene in ['pbr', 'soldier', 'tokyo']:
            start = time.monotonic()
            rendered = run(['/usr/bin/time', '-f', '%e %M', '-o', '/tmp/usage', 'node', 'test/render.js', scene, '/tmp/render.png'])
            elapsed = time.monotonic() - start
            output = json.loads(rendered.stdout)
            seconds, rss = Path('/tmp/usage').read_text().split()
            verified = run(['node', 'test/verify.js', scene, '/tmp/render.png', output['hash']])
            row = {**output, 'repetition': repetition, 'wallSeconds': elapsed,
                   'timeSeconds': float(seconds), 'peakRssMiB': int(rss) / 1024,
                   'quality': json.loads(verified.stdout), 'stderr': rendered.stderr}
            rows.append(row)
            print(json.dumps(row), flush=True)
        start = time.monotonic()
        run(['/usr/bin/time', '-f', '%e %M', '-o', '/tmp/usage', 'node', 'examples/compute-texture/node.js', '/tmp/compute.png'])
        elapsed = time.monotonic() - start
        seconds, rss = Path('/tmp/usage').read_text().split()
        example_rows.append({'repetition': repetition, 'wallSeconds': elapsed, 'timeSeconds': float(seconds), 'peakRssMiB': int(rss) / 1024})
    assert before == fingerprint(), 'Three.js or original model bytes changed'
    for scene in ['pbr', 'soldier', 'tokyo']:
        assert len({row['hash'] for row in rows if row['scene'] == scene}) == 1, f'{scene} output changed between fresh processes'
    return {'adapter': adapter, 'rows': rows, 'exampleRows': example_rows, 'exampleTests': example.stdout, 'runtimeTests': unit.stdout, 'nativeDir': native_dir,
            'configuredResources': {'cpu': 2, 'memoryMiB': 1024},
            'cgroupLimits': {name: Path('/sys/fs/cgroup', name).read_text().strip()
                for name in ['cpu.max', 'memory.max', 'cpu/cpu.cfs_quota_us',
                             'cpu/cpu.cfs_period_us', 'memory/memory.limit_in_bytes']
                if Path('/sys/fs/cgroup', name).exists()},
            'sourcesUnchanged': True, 'installedPackages': run(['npm', 'ls', '--json']).stdout, 'nativeSha256': hashlib.sha256(Path(native_dir, 'dawn.node').read_bytes()).hexdigest()}

@app.local_entrypoint()
def main(native_dir: str = '/build/linux-x64', repetitions: int = 3):
    if repetitions < 1:
        raise ValueError('repetitions must be positive')
    result = validate.remote(native_dir, repetitions)
    output = ROOT / 'test/out'
    output.mkdir(exist_ok=True)
    path = output / f'validation-{time.strftime("%Y%m%d-%H%M%S")}.json'
    path.write_text(json.dumps(result, indent=2) + '\n')
    print(path)
