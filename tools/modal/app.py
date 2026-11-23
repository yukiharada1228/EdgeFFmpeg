"""Ephemeral, bounded Linux CPU validation; invoke through launch.mjs."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

import modal

if modal.is_local():
    STAGE = Path(os.environ['EDGE_MODAL_STAGE']).resolve()
    OUTPUT = Path(os.environ['EDGE_MODAL_OUTPUT']).resolve()
    MANIFEST = json.loads((STAGE / 'manifest.json').read_text())
    if MANIFEST.get('schemaVersion') != 1 or not 1 <= len(MANIFEST['shards']) <= 16:
        raise ValueError('Expected a prepared manifest with 1..16 shards')
    LOCK = json.loads((STAGE / 'compat/reference-container.lock.json').read_text())
    if LOCK['platform'] != 'linux/amd64' or not __import__('re').fullmatch(r'docker.io/library/node@sha256:[a-f0-9]{64}', LOCK['image']):
        raise ValueError('Expected pinned Linux Node image')
    image = (
        modal.Image.from_registry(LOCK['image'], add_python='3.12')
        .workdir('/workspace')
        .add_local_dir(STAGE.parent / 'dependencies', '/workspace', copy=True)
        .run_commands('npm ci --no-audit --no-fund')
        .add_local_dir(STAGE, '/workspace')
        .add_local_file(STAGE / 'tools/modal/app.py', '/root/app.py')
    )
else:
    image = None
app = modal.App('edge-ffmpeg-cpu-validation')


@app.function(image=image, cpu=(2.0, 2.0), memory=(4096, 4096),
              max_containers=16, timeout=900, retries=0, include_source=False,
              block_network=True)
def validate(shard_id):
    manifest = json.loads(Path('/workspace/manifest.json').read_text())
    started = time.time()
    with tempfile.TemporaryDirectory(prefix='edge-validation-') as tmp:
        report = Path(tmp) / 'result.json'
        process = subprocess.run(
            ['node', 'tools/modal/run-shard.mjs', '--manifest', 'manifest.json',
             '--shard', str(shard_id), '--output', str(report), '--root', '/workspace'],
            cwd='/workspace', capture_output=True, text=True, timeout=870,
        )
        if report.exists():
            result = json.loads(report.read_text())
        else:
            result = {'status': 'error', 'error': 'Shard produced no report'}
        return {'shardId': shard_id, 'sourceSha256': manifest['source']['sha256'],
                'hostname': socket.gethostname(), 'containerId': os.environ.get('MODAL_TASK_ID'), 'startedAtEpoch': started,
                'finishedAtEpoch': time.time(), 'exitCode': process.returncode,
                'stdoutTail': process.stdout[-8192:], 'stderrTail': process.stderr[-8192:],
                'result': result}


@app.local_entrypoint()
def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    results = []
    try:
        for result in validate.map([s['id'] for s in MANIFEST['shards']], order_outputs=False):
            results.append(result)
            (OUTPUT / f"shard-{result['shardId']}.json").write_text(json.dumps(result, indent=2) + '\n')
            print(f"Shard {result['shardId']}: exit {result['exitCode']}")
    finally:
        expected_ids = {str(s['id']) for s in MANIFEST['shards']}
        actual_ids = [str(r['shardId']) for r in results]
        failures = [r['shardId'] for r in results if r['exitCode'] != 0 or
                    r['result'].get('status') != 'passed' or
                    r['result'].get('sourceHash') != MANIFEST['source']['sha256'] or
                    r['result'].get('platform') != 'linux' or r['result'].get('arch') != 'x64']
        complete = len(actual_ids) == len(expected_ids) and set(actual_ids) == expected_ids
        events = sorted([(r['startedAtEpoch'], 1) for r in results] + [(r['finishedAtEpoch'], -1) for r in results])
        current = peak = 0
        for _, delta in events:
            current += delta
            peak = max(peak, current)
        totals = {key: sum((r['result'].get('tests') or {}).get(key, 0) for r in results) for key in ['total', 'passed', 'failed', 'pending', 'todo']}
        summary = {'schemaVersion': 1, 'suite': MANIFEST['suite'],
                   'sourceSha256': MANIFEST['source']['sha256'], 'platform': 'linux',
                   'expectedShards': len(MANIFEST['shards']), 'completedShards': len(results),
                   'failedShards': failures, 'tests': totals, 'peakConcurrentInputs': peak,
                   'containerCount': len({r['containerId'] for r in results}) if all(r.get('containerId') for r in results) else None, 'wallSeconds': time.time() - started,
                   'limits': {'maxContainers': 16, 'cpuPerContainer': 2,
                              'memoryMiBPerContainer': 4096, 'timeoutSeconds': 900, 'retries': 0},
                   'status': 'passed' if complete and not failures else 'failed',
                   'results': results}
        (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if summary['status'] != 'passed':
        raise RuntimeError('Distributed validation failed; inspect summary.json')
