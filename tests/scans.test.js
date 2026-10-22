import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSplat, MAX_SCAN_BYTES } from '../src/scans.js';

test('rejects raw video, empty files, invalid splats and oversized imports', async () => {
  await assert.rejects(validateSplat(new File(['video'], 'drone.mp4')), /Process drone video/);
  await assert.rejects(validateSplat(new File([], 'roof.splat')), /non-empty/);
  await assert.rejects(validateSplat(new File(['bad'], 'roof.splat')), /incomplete or invalid/);
  await assert.rejects(validateSplat({ name: 'roof.splat', size: MAX_SCAN_BYTES + 1 }), /200 MB/);
});

test('distinguishes Gaussian PLY from ordinary point clouds', async () => {
  const cloud = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n';
  await assert.rejects(validateSplat(new File([cloud], 'points.ply')), /not a supported Gaussian/);
  const gaussian = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\n' + ['x', 'y', 'z', 'opacity', 'scale_0', 'rot_0', 'f_dc_0'].map(p => `property float ${p}\n`).join('') + 'end_header\n';
  assert.equal(await validateSplat(new File([gaussian, new Uint8Array(32)], 'roof.PLY')), 'ply');
  assert.equal(await validateSplat(new File([new Uint8Array(64)], 'roof.splat')), 'splat');
});
