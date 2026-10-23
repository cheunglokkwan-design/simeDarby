"""Convert the Brush PLY into an antimatter15 .splat in the digital-twin frame.

Applies twin.json alignment.scanToTwin (uniform scale * rotation + offset) to
positions, scales and rotations; colour from the SH DC term; drops faint,
huge and out-of-bounds splats.

usage: ply_to_twin_splat.py in.ply twin.json out.splat [--max-splats N] [--radius M]

  --max-splats N  keep only the N most important splats (largest scale x opacity),
                  e.g. 300000 for a ~9.6 MB file (32 bytes per splat) that loads fast.
  --radius M      drop splats further than M metres (horizontally) from the centre
                  of the primary building in twin.json, e.g. 25.
"""
import argparse, json
import numpy as np

ap = argparse.ArgumentParser(description='Brush PLY -> antimatter15 .splat in the twin frame')
ap.add_argument('src'); ap.add_argument('twin'); ap.add_argument('out')
ap.add_argument('--max-splats', type=int, default=0, help='keep the N most important splats (0 = all)')
ap.add_argument('--radius', type=float, default=0, help='horizontal crop radius in metres around the primary building (0 = off)')
args = ap.parse_args()
src, twin_path, out = args.src, args.twin, args.out
raw = open(src, 'rb').read(20000)
end = raw.find(b'end_header\n') + len(b'end_header\n')
props = [l.split()[-1].decode() for l in raw[:end].split(b'\n') if l.startswith(b'property')]
data = np.fromfile(src, dtype='<f4', offset=end).reshape(-1, len(props))
col = {p: data[:, i] for i, p in enumerate(props)}

twin = json.load(open(twin_path))
M = np.array(twin['alignment']['scanToTwin'], dtype=np.float64)
A, t = M[:3, :3], M[:3, 3]
s = np.cbrt(abs(np.linalg.det(A)))
R = A / s
assert np.allclose(R @ R.T, np.eye(3), atol=1e-3), 'not a similarity'
assert np.linalg.det(R) > 0, 'reflection: cannot rotate quaternions'

pos = np.stack([col['x'], col['y'], col['z']], 1) @ A.T + t
scale = np.exp(np.stack([col['scale_0'], col['scale_1'], col['scale_2']], 1)) * s
alpha = 1 / (1 + np.exp(-col['opacity']))
C0 = 0.28209479177387814
rgb = np.clip(0.5 + C0 * np.stack([col['f_dc_0'], col['f_dc_1'], col['f_dc_2']], 1), 0, 1)

# rotate quaternions: q' = q_R * q  (w, x, y, z)
def mat_to_quat(m):
    w = np.sqrt(max(0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    return np.array([w, (m[2, 1] - m[1, 2]) / (4 * w), (m[0, 2] - m[2, 0]) / (4 * w), (m[1, 0] - m[0, 1]) / (4 * w)])
qr = mat_to_quat(R)
q = np.stack([col['rot_0'], col['rot_1'], col['rot_2'], col['rot_3']], 1)
q /= np.linalg.norm(q, axis=1, keepdims=True)
w1, x1, y1, z1 = qr
w2, x2, y2, z2 = q.T
q = np.stack([w1*w2 - x1*x2 - y1*y2 - z1*z2, w1*x2 + x1*w2 + y1*z2 - z1*y2,
              w1*y2 - x1*z2 + y1*w2 + z1*x2, w1*z2 + x1*y2 - y1*x2 + z1*w2], 1)

lo, hi = np.array(twin['bounds']['min']), np.array(twin['bounds']['max'])
keep = (alpha > 0.04) & (scale.max(1) < 3.0) & np.all((pos > lo) & (pos < hi), 1)
if args.radius > 0:
    prim = next((b for b in twin.get('buildings', []) if b.get('primary')), None)
    c = np.array(prim['centre'] if prim else [0.0, 0.0, 0.0])
    keep &= np.hypot(pos[:, 0] - c[0], pos[:, 2] - c[2]) < args.radius
    print(f'crop: {args.radius:g} m around ({c[0]:.2f}, {c[2]:.2f})')
print(f'scale {s:.4f} m/unit; keeping {keep.sum():,} of {len(keep):,}')
pos, scale, rgb, alpha, q = pos[keep], scale[keep], rgb[keep], alpha[keep], q[keep]
order = np.argsort(-(scale.prod(1) * alpha))  # big, opaque first (library convention)
if args.max_splats and len(order) > args.max_splats:
    order = order[:args.max_splats]  # importance = volume x opacity; the tail is tiny/faint detail
    print(f'max-splats: keeping the {args.max_splats:,} most important')
rec = np.zeros(len(order), dtype=[('p', '<f4', 3), ('s', '<f4', 3), ('c', 'u1', 4), ('r', 'u1', 4)])
rec['p'] = pos[order]; rec['s'] = scale[order]
rec['c'] = np.concatenate([rgb[order], alpha[order, None]], 1) * 255
rec['r'] = np.clip(q[order] * 128 + 128, 0, 255)
rec.tofile(out)
print(out, f'{rec.nbytes / 1e6:.1f} MB')
