"""Authenticated, single-GPU Nerfstudio job worker. Run one Uvicorn process."""
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

ROOT = Path(os.environ.get('DRONE_JOB_DIR', './.drone-jobs')).resolve()
MAX_UPLOAD = int(os.environ.get('DRONE_MAX_UPLOAD_MB', '1024')) * 1024 * 1024
MAX_SCAN = 200 * 1024 * 1024
MAX_SECONDS = int(os.environ.get('DRONE_MAX_VIDEO_SECONDS', '600'))
POOL = ThreadPoolExecutor(max_workers=1)
LOCK = threading.Lock()
TERMINAL = {'complete', 'failed'}


def authorize(authorization: str = Header(default='')):
    token = os.environ.get('DRONE_WORKER_TOKEN', '')
    if not token:
        raise HTTPException(503, 'Worker administrator must configure DRONE_WORKER_TOKEN.')
    if not hmac.compare_digest(authorization, f'Bearer {token}'):
        raise HTTPException(401, 'Worker authentication failed.')


def job_dir(job_id):
    if not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise HTTPException(404, 'Job not found.')
    return ROOT / job_id


def read_job(job_id):
    try:
        return json.loads((job_dir(job_id) / 'job.json').read_text())
    except FileNotFoundError:
        raise HTTPException(404, 'Job not found.')


def update_job(job_id, **changes):
    with LOCK:
        record = read_job(job_id)
        record.update(changes)
        path = job_dir(job_id) / 'job.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(record))
        temporary.replace(path)
        return record


@lru_cache(maxsize=1)
def capabilities():
    required = ['ffmpeg', 'ffprobe', 'colmap', 'ns-process-data', 'ns-train', 'ns-export']
    missing = [name for name in required if not shutil.which(name)]
    try:
        import torch
        gpu = torch.cuda.is_available()
    except ImportError:
        gpu = False
    return {'ready': not missing and gpu, 'missing': missing, 'gpu': gpu,
            'message': 'GPU worker ready.' if not missing and gpu else 'Reconstruction dependencies or CUDA GPU are unavailable on this worker.'}


@asynccontextmanager
async def lifespan(app):
    ROOT.mkdir(parents=True, exist_ok=True)
    # A server restart must not leave jobs pretending to run indefinitely.
    for path in ROOT.glob('*/job.json'):
        record = json.loads(path.read_text())
        if record['stage'] not in TERMINAL:
            update_job(record['id'], stage='failed', message='Worker restarted. Upload the footage again to retry.')
    yield


app = FastAPI(title='Solar Drone Reconstruction Worker', lifespan=lifespan,
              dependencies=[Depends(authorize)], docs_url=None, redoc_url=None)


@app.get('/api/drone/health')
def health():
    return {**capabilities(), 'maxUploadMB': MAX_UPLOAD // (1024 * 1024), 'maxVideoSeconds': MAX_SECONDS}


def run_command(job_id, command, stage, message, timeout):
    update_job(job_id, stage=stage, message=message)
    with (job_dir(job_id) / 'processing.log').open('ab') as log:
        subprocess.run(command, cwd=job_dir(job_id), stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=timeout, env={**os.environ, 'QT_QPA_PLATFORM': 'offscreen'})


def reconstruct(job_id, video):
    directory = job_dir(job_id)
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'json', str(video)], check=True, capture_output=True, text=True, timeout=30)
        duration = float(json.loads(probe.stdout)['format']['duration'])
        if duration <= 0 or duration > MAX_SECONDS:
            raise ValueError(f'Choose a video between 1 and {MAX_SECONDS} seconds long.')
        processed = directory / 'processed'
        training = directory / 'training'
        exported = directory / 'result'
        run_command(job_id, ['ns-process-data', 'video', '--data', str(video), '--output-dir', str(processed),
                             '--num-frames-target', '200'], 'camera_alignment',
                    'Extracting frames and reconstructing camera positions.', 60 * 60)
        transforms = json.loads((processed / 'transforms.json').read_text())
        if len(transforms.get('frames', [])) < 20:
            raise ValueError('Too few camera views could be aligned. Retry with sharp, overlapping orbit footage.')
        run_command(job_id, ['ns-train', 'splatfacto', '--data', str(processed), '--output-dir', str(training),
                             '--max-num-iterations', os.environ.get('DRONE_TRAIN_STEPS', '10000'), '--vis', 'tensorboard'],
                    'training', 'Training the Gaussian splat on the GPU.', 2 * 60 * 60)
        configs = sorted(training.rglob('config.yml'), key=lambda path: path.stat().st_mtime)
        if not configs:
            raise ValueError('Training did not produce a saved configuration. Retry the job.')
        run_command(job_id, ['ns-export', 'gaussian-splat', '--load-config', str(configs[-1]), '--output-dir', str(exported)],
                    'exporting', 'Exporting the reconstructed Gaussian splat.', 15 * 60)
        results = list(exported.glob('*.ply'))
        if not results or results[0].stat().st_size == 0:
            raise ValueError('Reconstruction produced no splat file. Retry with a clearer capture.')
        if results[0].stat().st_size > MAX_SCAN:
            raise ValueError('The exported scan exceeds 200 MB. Crop the capture or reduce reconstruction size on the worker.')
        results[0].replace(directory / 'scan.ply')
        update_job(job_id, stage='complete', message='3D reconstruction ready. Review the draft panel layout against the scan.',
                   format='ply', cameraUp=[0, 0, 1], bytes=(directory / 'scan.ply').stat().st_size)
    except ValueError as error:
        update_job(job_id, stage='failed', message=str(error))
    except subprocess.TimeoutExpired:
        update_job(job_id, stage='failed', message='Processing exceeded the worker time limit. Retry with a shorter capture.')
    except Exception:
        update_job(job_id, stage='failed', message='Reconstruction failed. Check the worker processing log, or retry with clearer overlapping footage.')


@app.post('/api/drone/jobs', status_code=202)
async def create_job(site_id: str = Form(...), video: UploadFile = File(...)):
    if not capabilities()['ready']:
        raise HTTPException(503, capabilities()['message'])
    if not re.fullmatch(r'(way|relation|node)/\d+', site_id):
        raise HTTPException(422, 'Select a mapped building before uploading.')
    suffix = Path(video.filename or '').suffix.lower()
    if suffix not in {'.mp4', '.mov', '.m4v', '.webm'}:
        raise HTTPException(415, 'Choose an MP4, MOV, M4V or WebM video.')
    job_id = uuid.uuid4().hex
    directory = job_dir(job_id)
    with LOCK:
        active = sum(json.loads(path.read_text())['stage'] not in TERMINAL for path in ROOT.glob('*/job.json'))
        if active >= 4:
            raise HTTPException(429, 'The GPU queue is full. Wait for a running job to finish and retry.')
        directory.mkdir(parents=True)
        record = {'id': job_id, 'siteId': site_id, 'stage': 'uploading', 'message': 'Receiving footage.'}
        (directory / 'job.json').write_text(json.dumps(record))
    path = directory / f'input{suffix}'
    size = 0
    try:
        with path.open('wb') as output:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, f'Choose footage under {MAX_UPLOAD // (1024 * 1024)} MB.')
                output.write(chunk)
        if not size:
            raise HTTPException(422, 'The video is empty. Choose another file.')
    except BaseException:
        path.unlink(missing_ok=True)
        update_job(job_id, stage='failed', message='Video upload did not finish. Upload again to retry.')
        raise
    finally:
        await video.close()
    record = update_job(job_id, stage='queued', message='Waiting for the GPU worker.')
    POOL.submit(reconstruct, job_id, path)
    return record


@app.get('/api/drone/jobs/{job_id}')
def job_status(job_id: str):
    return read_job(job_id)


@app.get('/api/drone/jobs/{job_id}/scan')
def job_scan(job_id: str):
    record = read_job(job_id)
    if record['stage'] != 'complete':
        raise HTTPException(409, 'The 3D scan is not ready yet.')
    return FileResponse(job_dir(job_id) / 'scan.ply', filename=f'{job_id}.ply', media_type='application/octet-stream')
