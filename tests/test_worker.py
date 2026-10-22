"""API and pipeline-contract checks; these tests do not run reconstruction."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import worker.app as worker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = patch.object(worker, 'ROOT', Path(self.directory.name))
        self.root.start()
        self.env = patch.dict(os.environ, {'DRONE_WORKER_TOKEN': 'unit-test-token'})
        self.env.start()
        self.headers = {'Authorization': 'Bearer unit-test-token'}
        self.client = TestClient(worker.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env.stop()
        self.root.stop()
        self.directory.cleanup()

    def test_authentication_and_missing_processor(self):
        self.assertEqual(self.client.get('/api/drone/health').status_code, 401)
        with patch.object(worker, 'capabilities', return_value={'ready': False, 'message': 'Processor unavailable.'}):
            response = self.client.post('/api/drone/jobs', headers=self.headers,
                                        data={'site_id': 'way/1'}, files={'video': ('roof.mp4', b'video')})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(list(worker.ROOT.glob('*/job.json')), [])

    def test_job_contract_and_upload_validation(self):
        with patch.object(worker, 'capabilities', return_value={'ready': True}), patch.object(worker.POOL, 'submit') as submit:
            invalid = self.client.post('/api/drone/jobs', headers=self.headers,
                                       data={'site_id': 'way/1'}, files={'video': ('bad.exe', b'bad')})
            self.assertEqual(invalid.status_code, 415)
            with patch.object(worker, 'MAX_UPLOAD', 4):
                large = self.client.post('/api/drone/jobs', headers=self.headers,
                                         data={'site_id': 'way/1'}, files={'video': ('roof.mp4', b'12345')})
                self.assertEqual(large.status_code, 413)
            response = self.client.post('/api/drone/jobs', headers=self.headers,
                                        data={'site_id': 'way/1'}, files={'video': ('roof.mp4', b'video')})
            self.assertEqual(response.status_code, 202)
            submit.assert_called_once()
            job = response.json()
            status = self.client.get(f'/api/drone/jobs/{job["id"]}', headers=self.headers).json()
            self.assertEqual(status['siteId'], 'way/1')
            self.assertEqual(status['stage'], 'queued')
            self.assertEqual(self.client.get(f'/api/drone/jobs/{job["id"]}/scan', headers=self.headers).status_code, 409)
            self.assertEqual(self.client.get('/api/drone/jobs/not-a-job', headers=self.headers).status_code, 404)

    def test_pipeline_invokes_real_tools_in_order_and_publishes_only_an_export(self):
        job_id = 'a' * 32
        directory = worker.job_dir(job_id)
        directory.mkdir()
        (directory / 'job.json').write_text(json.dumps({'id': job_id, 'stage': 'queued'}))
        video = directory / 'input.mp4'
        video.write_bytes(b'test fixture, not video')
        commands = []

        def command(args, **kwargs):
            commands.append(args[0])
            if args[0] == 'ffprobe':
                class Probe:
                    stdout = '{"format":{"duration":"60"}}'
                return Probe()
            if args[0] == 'ns-process-data':
                path = directory / 'processed'
                path.mkdir()
                (path / 'transforms.json').write_text(json.dumps({'frames': [{}] * 20}))
            if args[0] == 'ns-train':
                path = directory / 'training'
                path.mkdir()
                (path / 'config.yml').write_text('mock training config')
            if args[0] == 'ns-export':
                path = directory / 'result'
                path.mkdir()
                (path / 'splat.ply').write_bytes(b'mock exported splat')

        with patch.object(worker.subprocess, 'run', side_effect=command):
            worker.reconstruct(job_id, video)
        self.assertEqual(commands, ['ffprobe', 'ns-process-data', 'ns-train', 'ns-export'])
        self.assertEqual(worker.read_job(job_id)['stage'], 'complete')
        self.assertTrue((directory / 'scan.ply').exists())


if __name__ == '__main__':
    unittest.main()
