"""Prepare a drone-scanned point cloud for the digital twin (offline, numpy + scipy).

Usage:
    python scripts/prepare_twin.py [--ply PATH] [--out public/twins/friend-house] [--renders DIR]

Steps (see docs/internal/twin-contract.md for the output frame and files):
  a. load the xyz-only PLY, drop floaters (robust crop + statistical outlier removal), voxel-downsample
  b. gravity: coarse "up" = least-variance PCA axis, sign from a roofs-cover-walls test (sloped
     planar patches sit above the adjacent vertical ones); refined so that wall normals are
     horizontal (iterative least-squares on near-vertical planar patches)
  c. heading: wall normals folded mod 90 deg -> rotate so the dominant wall direction is the x axis.
     No compass in a drone scan, so northBearing = 0 (-z = north is a convention, user rotates)
  d. scale: estimated from architecture (eave and ridge height above ground of the primary house,
     storey count inferred from ridge/eave ratio) - documented in twin.json
  e. roofs: DTM by morphological opening, height-above-ground, top-surface points, PCA normals,
     region growing into planes, merge, outlines (row-wise extents in roof-local u/v, simplified),
     edge typing (eave/ridge/hip-verge/valley-abutment), obstacles = points > max(0.15 m, 3 sigma)
     above the plane, clustered
  f. occupancy grid (0.25 m, +-30 m) for shadow raycasts with floater and roof-fuzz removal,
     decimated points.bin + normals.bin, twin.json (roofs, buildings, occluders, scale cross-checks)

Also: --render-plan PLAN.json renders a planArray result (top view + heatmap, oblique + sections).

Everything is deterministic (fixed RNG seeds).
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_PLY = 'C:/Users/User/splatwork/friend/export_30000.ply'
DEFAULT_OUT = os.path.join(ROOT, 'public', 'twins', 'friend-house')
DEFAULT_RENDERS = 'C:/Users/User/splatwork/friend'

T0 = time.time()
GRAVITY_EVIDENCE = {}
DEBUG_PLANES = False


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


# ----------------------------------------------------------------------------- helpers
def load_ply_xyz(path):
    raw = open(path, 'rb').read()
    end = raw.index(b'end_header\n') + len(b'end_header\n')
    header = raw[:end].decode('ascii', 'replace')
    nvert = int([l for l in header.splitlines() if l.startswith('element vertex')][0].split()[-1])
    props = []
    in_vertex = False
    for line in header.splitlines():
        if line.startswith('element'):
            in_vertex = line.startswith('element vertex')
        elif line.startswith('property') and in_vertex:
            props.append(line.split()[-1])
    if props[:3] != ['x', 'y', 'z'] or len(props) != 3:
        # Header may be misleading (ImageToStl); trust the byte count when it matches 12 B/vertex.
        if len(raw) - end != nvert * 12:
            raise ValueError(f'unexpected vertex layout {props}')
    pts = np.frombuffer(raw, dtype='<f4', count=nvert * 3, offset=end).reshape(-1, 3).astype(np.float64)
    return pts, header


def voxel_down(p, size, extra=None):
    key = np.floor(p / size).astype(np.int64)
    key -= key.min(0)
    mult = key.max(0) + 1
    lin = (key[:, 0] * mult[1] + key[:, 1]) * mult[2] + key[:, 2]
    _, first, inv, cnt = np.unique(lin, return_index=True, return_inverse=True, return_counts=True)
    # centroid per voxel
    out = np.zeros((len(first), 3))
    np.add.at(out, inv, p)
    out /= cnt[:, None]
    return out, cnt


def pca_normals(p, k):
    tree = cKDTree(p)
    _, idx = tree.query(p, k, workers=-1)
    nb = p[idx]
    nb = nb - nb.mean(1, keepdims=True)
    cov = np.einsum('nki,nkj->nij', nb, nb)
    w, v = np.linalg.eigh(cov)
    n = v[:, :, 0]
    curv = w[:, 0] / np.maximum(w.sum(1), 1e-12)
    return n, curv, idx


def rot_from_up(up):
    """Rotation matrix (rows = new axes) taking `up` to +z; proper rotation (det +1)."""
    z = up / np.linalg.norm(up)
    ref = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0])
    x = ref - z * (ref @ z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.vstack([x, y, z])
    assert np.linalg.det(R) > 0
    return R


def rot_z(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1.0]])  # rotates vectors by -theta


def douglas_peucker(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = np.linalg.norm(ab)
    if L < 1e-12:
        d = np.linalg.norm(pts - a, axis=1)
    else:
        w_ = pts - a
        d = np.abs(ab[0] * w_[:, 1] - ab[1] * w_[:, 0]) / L
    i = int(np.argmax(d))
    if d[i] > eps:
        left = douglas_peucker(pts[: i + 1], eps)
        right = douglas_peucker(pts[i:], eps)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def simplify_closed(poly, eps):
    # split at the two farthest-apart vertices so DP works on a closed ring
    i0 = 0
    d = np.linalg.norm(poly - poly[i0], axis=1)
    i1 = int(np.argmax(d))
    a = douglas_peucker(poly[i0: i1 + 1], eps)
    b = douglas_peucker(np.vstack([poly[i1:], poly[:1]]), eps)
    out = np.vstack([a[:-1], b[:-1]])
    return out


def regularize_ring(ring, snap_deg=15.0, min_len=0.3):
    """Clean a roof outline in roof-local (u = eave, v = up-slope) coordinates: drop sliver edges,
    snap near-axis edges to the eave/slope axes, merge collinear runs, re-intersect. Hip and
    valley diagonals keep their measured direction. Returns None if the result is not plausible."""
    pts = [np.array(p, float) for p in ring]
    a0 = abs(polygon_area(np.array(pts)))
    # 1. remove short edges by collapsing them to their midpoint
    for _ in range(200):
        n = len(pts)
        if n <= 4:
            break
        lens = [np.linalg.norm(pts[(i + 1) % n] - pts[i]) for i in range(n)]
        i = int(np.argmin(lens))
        if lens[i] >= min_len:
            break
        j = (i + 1) % n
        mid = (pts[i] + pts[j]) / 2
        pts[i] = mid
        pts.pop(j)
    n = len(pts)
    # 2. lines with snapped directions
    lines = []
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        d = b - a
        L = np.linalg.norm(d)
        ang = math.degrees(math.atan2(d[1], d[0]))
        snapped = None
        for t in (-180, -90, 0, 90, 180):
            if abs(ang - t) < snap_deg:
                snapped = math.radians(t)
        dirv = np.array([math.cos(snapped), math.sin(snapped)]) if snapped is not None else d / max(L, 1e-9)
        lines.append({'p': (a + b) / 2, 'd': dirv, 'L': L})
    # 3. merge consecutive (nearly) collinear lines
    merged = True
    while merged and len(lines) > 3:
        merged = False
        for i in range(len(lines)):
            j = (i + 1) % len(lines)
            A, B = lines[i], lines[j]
            if abs(A['d'][0] * B['d'][1] - A['d'][1] * B['d'][0]) < math.sin(math.radians(4)) and A['d'] @ B['d'] > 0:
                nrm = np.array([-A['d'][1], A['d'][0]])
                off = (A['L'] * (A['p'] @ nrm) + B['L'] * (B['p'] @ nrm)) / (A['L'] + B['L'])
                if abs(A['p'] @ nrm - B['p'] @ nrm) > 0.25:
                    continue  # a real step, keep both
                along = (A['L'] * (A['p'] @ A['d']) + B['L'] * (B['p'] @ A['d'])) / (A['L'] + B['L'])
                lines[i] = {'p': A['d'] * along + nrm * off, 'd': A['d'], 'L': A['L'] + B['L']}
                lines.pop(j)
                merged = True
                break
    # 4. vertices = intersections of consecutive lines (steps between parallel lines get a connector)
    out = []
    m = len(lines)
    for i in range(m):
        A, B = lines[i], lines[(i + 1) % m]
        den = A['d'][0] * B['d'][1] - A['d'][1] * B['d'][0]
        if abs(den) < math.sin(math.radians(10)):
            # parallel step: end of A, start of B (projections of the midpoint between them)
            q = (A['p'] + A['d'] * A['L'] / 2 + B['p'] - B['d'] * B['L'] / 2) / 2
            out.append(A['p'] + A['d'] * ((q - A['p']) @ A['d']))
            out.append(B['p'] + B['d'] * ((q - B['p']) @ B['d']))
            continue
        w = B['p'] - A['p']
        t = (w[0] * B['d'][1] - w[1] * B['d'][0]) / den
        out.append(A['p'] + A['d'] * t)
    out = np.array(out)
    if len(out) < 3:
        return None
    a1 = polygon_area(out)
    if a1 <= 0 or abs(a1 - a0) / a0 > 0.12 or np.linalg.norm(out - np.array(ring).mean(0), axis=1).max() > 1.5 * np.linalg.norm(np.array(ring) - np.array(ring).mean(0), axis=1).max():
        return None
    return out


def polygon_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def convex_hull_2d(p):
    p = np.unique(np.round(p, 6), axis=0)
    if len(p) < 3:
        return p
    p = p[np.lexsort((p[:, 1], p[:, 0]))]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in p[::-1]:
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return np.array(lower[:-1] + upper[:-1])


def min_area_rect(p):
    """Minimum-area rotated rectangle around 2D points (rotating calipers over hull edges)."""
    h = convex_hull_2d(p)
    if len(h) < 3:
        c = p.mean(0)
        return np.array([c + [-.05, -.05], c + [.05, -.05], c + [.05, .05], c + [-.05, .05]])
    best = None
    for i in range(len(h)):
        e = h[(i + 1) % len(h)] - h[i]
        e = e / (np.linalg.norm(e) + 1e-12)
        nrm = np.array([-e[1], e[0]])
        a, b = h @ e, h @ nrm
        area = (a.max() - a.min()) * (b.max() - b.min())
        if best is None or area < best[0]:
            best = (area, e, nrm, a.min(), a.max(), b.min(), b.max())
    _, e, nrm, a0, a1, b0, b1 = best
    return np.array([e * a0 + nrm * b0, e * a1 + nrm * b0, e * a1 + nrm * b1, e * a0 + nrm * b1])


# ----------------------------------------------------------------------------- stages
def clean(points):
    log('raw points', len(points))
    med = np.median(points, 0)
    q1, q3 = np.percentile(points, [25, 75], axis=0)
    iqr = q3 - q1
    box = np.all(np.abs(points - med) < 4.0 * iqr + 1e-9, axis=1)
    p = points[box]
    log('robust crop kept', box.sum(), f'({box.mean() * 100:.1f}%)')
    # SOR on all points (k=10 mean distance)
    tree = cKDTree(p)
    d, _ = tree.query(p, 11, workers=-1)
    md = d[:, 1:].mean(1)
    keep = md < md.mean() + 2.0 * md.std()
    p = p[keep]
    log('statistical outlier removal kept', keep.sum(), f'({keep.mean() * 100:.1f}%)')
    # main cluster: connected components on a coarse voxel grid; keep the biggest
    vs = np.median(md) * 8
    key = np.floor((p - p.min(0)) / vs).astype(np.int64)
    dims = key.max(0) + 1
    occ = np.zeros(dims, bool)
    occ[key[:, 0], key[:, 1], key[:, 2]] = True
    lab, nlab = ndimage.label(ndimage.binary_dilation(occ, iterations=1), structure=np.ones((3, 3, 3)))
    plab = lab[key[:, 0], key[:, 1], key[:, 2]]
    cnt = np.bincount(plab)
    cnt[0] = 0
    main = plab == np.argmax(cnt)
    p = p[main]
    log('main cluster kept', main.sum(), 'of', len(main), 'components', nlab)
    total_removed = 1 - len(p) / len(points)
    return p, total_removed


def estimate_gravity(p):
    c = p - np.median(p, 0)
    sub = c[np.random.default_rng(0).choice(len(c), min(200000, len(c)), replace=False)]
    w, v = np.linalg.eigh(np.cov(sub.T))
    axis = v[:, 0]
    h = sub @ axis
    skew = np.mean((h - h.mean()) ** 3) / (h.std() ** 3)
    # refine with walls on a moderately downsampled cloud near the centre
    ds, _ = voxel_down(c, 0.04 * np.sqrt(w[2]) / 4.0)
    rad = np.sqrt(w[2]) * 1.2
    central = ds[np.linalg.norm(ds - (ds @ axis)[:, None] * axis, axis=1) < rad]
    n, curv, _ = pca_normals(central, 40)
    # Sign of "up": roofs cover walls. Pair each near-vertical planar patch with the nearest sloped
    # planar patch in plan view; on a real building the sloped (roof) patch is ABOVE the wall.
    # (Height skew is printed for reference but is unreliable on sloping terrain.)
    cu = np.abs(n @ axis)
    h_ax = central @ axis
    planar = curv < 0.08
    Wm, Sm = planar & (cu < 0.25), planar & (cu > 0.6) & (cu < 0.92)
    Rt = rot_from_up(axis)
    xy = central @ Rt.T
    dd, ii = cKDTree(xy[Sm, :2]).query(xy[Wm, :2], 1, distance_upper_bound=0.3 * np.sqrt(w[2]) / 4.0)
    ok = np.isfinite(dd)
    frac_above = float(np.mean(h_ax[Sm][ii[ok]] > h_ax[Wm][ok])) if ok.any() else 0.5
    up = axis * (1 if frac_above > 0.5 else -1)
    log('PCA least-variance axis', np.round(axis, 4), 'skew', round(float(skew), 3),
        f'roof-above-wall fraction along +axis {frac_above:.2f} ({int(ok.sum())} pairs) -> up', np.round(up, 4))
    GRAVITY_EVIDENCE['roofAboveWallFraction'] = round(max(frac_above, 1 - frac_above), 3)
    GRAVITY_EVIDENCE['pairs'] = int(ok.sum())
    for it in range(8):
        cu = n @ up
        wall = (curv < 0.06) & (np.abs(cu) < 0.3)
        M = n[wall].T @ n[wall]
        ew, ev = np.linalg.eigh(M)
        new = ev[:, 0] * np.sign(ev[:, 0] @ up)
        delta = math.degrees(math.acos(min(1, abs(new @ up))))
        up = new
        if delta < 0.01:
            break
    log('wall-refined up', np.round(up, 4), 'wall patches', int(wall.sum()), 'iters', it + 1)
    wall_n = n[(curv < 0.06) & (np.abs(n @ up) < 0.15)]
    return up, wall_n, central, n, curv


def estimate_heading(wall_n, R):
    wn = wall_n @ R.T
    th = np.arctan2(wn[:, 1], wn[:, 0])
    m = np.angle(np.mean(np.exp(4j * th))) / 4  # dominant direction mod 90 deg
    return m


def cell_percentile(lin, z, q, ncells, min_count=1):
    """Per-cell q-quantile of z (cells given by linear index); NaN-free: inf where too few points."""
    order = np.lexsort((z, lin))
    ls = lin[order]
    starts = np.r_[0, np.flatnonzero(np.diff(ls)) + 1]
    ends = np.r_[starts[1:], len(ls)]
    cnt = ends - starts
    out = np.full(ncells, np.inf)
    pos = starts + ((cnt - 1) * q).astype(int)
    good = cnt >= min_count
    out[ls[starts[good]]] = z[order[pos[good]]]
    return out


def dtm(points_a, cell):
    """Digital terrain model from points in a z-up frame. Returns (grid, x0, y0, cell, fn)."""
    x0, y0 = points_a[:, 0].min(), points_a[:, 1].min()
    ix = ((points_a[:, 0] - x0) / cell).astype(int)
    iy = ((points_a[:, 1] - y0) / cell).astype(int)
    nx, ny = ix.max() + 1, iy.max() + 1
    # per-cell 10th percentile of height (robust to the below-ground splat noise a plain min picks up)
    lo = cell_percentile(ix * ny + iy, points_a[:, 2], 0.10, nx * ny, min_count=4).reshape(nx, ny)
    valid = np.isfinite(lo)
    fill = np.where(valid, lo, np.nanmax(np.where(valid, lo, -np.inf)))
    med = ndimage.median_filter(fill, 3)
    return lo, med, valid, x0, y0, nx, ny, ix, iy


def build_ground(points_a, cell, open_size_cells):
    lo, med, valid, x0, y0, nx, ny, ix, iy = dtm(points_a, cell)
    # morphological opening removes buildings/trees smaller than the window
    big = np.where(valid, med, np.inf)
    eroded = ndimage.minimum_filter(np.where(np.isfinite(big), big, 1e9), open_size_cells)
    opened = ndimage.maximum_filter(eroded, open_size_cells)
    opened = np.where(opened > 1e8, np.nan, opened)
    # fill gaps by nearest valid
    mask = ~np.isfinite(opened)
    if mask.any():
        idx = ndimage.distance_transform_edt(mask, return_distances=False, return_indices=True)
        opened = opened[tuple(idx)]
    ground = ndimage.gaussian_filter(opened, 1.5)

    def ground_at(x, y):
        gx = np.clip(((x - x0) / cell).astype(int), 0, nx - 1)
        gy = np.clip(((y - y0) / cell).astype(int), 0, ny - 1)
        return ground[gx, gy]
    return ground_at, (ground, x0, y0, cell)


def region_grow(p, n, curv, idx, max_angle_deg, max_dist, min_pts):
    N = len(p)
    labels = -np.ones(N, int)
    order = np.argsort(curv)
    cos_t = math.cos(math.radians(max_angle_deg))
    regions = []
    for seed in order:
        if labels[seed] != -1 or curv[seed] > 0.08:
            continue
        rid = len(regions)
        members = [seed]
        labels[seed] = rid
        pn = n[seed].copy()
        p0 = p[seed].copy()
        q = [seed]
        since = 0
        while q:
            i = q.pop()
            for j in idx[i, 1:]:
                if labels[j] != -1:
                    continue
                if abs(n[j] @ pn) < cos_t:
                    continue
                if abs((p[j] - p0) @ pn) > max_dist:
                    continue
                labels[j] = rid
                members.append(j)
                q.append(j)
                since += 1
            if since > 150 and len(members) > 30:
                pts = p[members]
                c = pts.mean(0)
                _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
                nn = vt[2] * np.sign(vt[2][2] + 1e-12)
                pn, p0 = nn, c
                since = 0
        if len(members) < min_pts:
            labels[np.array(members)] = -2  # visited, too small
            regions.append(None)
        else:
            regions.append(np.array(members))
    return labels, regions


def fit_plane(pts, iters=3, trim=2.5):
    m = np.ones(len(pts), bool)
    for _ in range(iters):
        c = pts[m].mean(0)
        _, _, vt = np.linalg.svd(pts[m] - c, full_matrices=False)
        nn = vt[2] * np.sign(vt[2][2] + 1e-12)
        d = (pts - c) @ nn
        s = 1.4826 * np.median(np.abs(d[m]))
        m = np.abs(d) < max(trim * s, 0.03)
    return nn, c, s, m


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ply', default=DEFAULT_PLY)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--renders', default=DEFAULT_RENDERS)
    ap.add_argument('--no-renders', action='store_true')
    ap.add_argument('--scale', type=float, default=None, help='override metres per scan unit')
    ap.add_argument('--render-plan', default=None, help='render a planArray result (JSON from node) over the twin and exit')
    ap.add_argument('--tag', default='default', help='suffix for plan renders')
    args = ap.parse_args()
    if args.render_plan:
        render_plan(args.out, args.render_plan, args.renders, args.tag)
        return
    os.makedirs(args.out, exist_ok=True)

    raw, _ = load_ply_xyz(args.ply)
    pts, removed_frac = clean(raw)

    # --- b. gravity
    up, wall_n, _, _, _ = estimate_gravity(pts)
    R1 = rot_from_up(up)
    # --- c. heading
    theta = estimate_heading(wall_n, R1)
    R2 = rot_z(theta) @ R1
    centre_scan = np.median(pts, 0)
    A = (pts - centre_scan) @ R2.T  # z up, scan units
    # choose between 0/90 deg so the long building direction is x: compare wall-patch spread
    wn = wall_n @ R2.T
    nx_walls = np.sum(np.abs(wn[:, 0]) > 0.9)  # walls facing +-x run along y
    ny_walls = np.sum(np.abs(wn[:, 1]) > 0.9)  # walls facing +-y run along x
    if nx_walls > ny_walls:
        R2 = rot_z(math.pi / 2) @ R2
        A = (pts - centre_scan) @ R2.T
    log('heading rotation', round(math.degrees(theta), 2), 'deg; walls along x', max(nx_walls, ny_walls), 'along y', min(nx_walls, ny_walls))

    # verticality check of walls after alignment
    wn = wall_n @ R2.T
    wall_tilt = np.degrees(np.arcsin(np.clip(np.abs(wn[:, 2]), 0, 1)))
    log('wall normal |elevation| median deg', round(float(np.median(wall_tilt)), 2))

    # --- d/e. iterate: provisional scale -> segmentation -> measured scale
    scale = args.scale or 5.0
    for attempt in range(3):
        res = segment(A, scale)
        if args.scale:
            break
        est = res['scale_est']
        log(f'scale attempt {attempt}: used {scale:.3f}, measured {est["metresPerUnit"]:.3f}')
        if abs(est['metresPerUnit'] - scale) / scale < 0.06:
            scale = est['metresPerUnit']
            res = segment(A, scale)
            break
        scale = est['metresPerUnit']
    else:
        res = segment(A, scale)
    write_outputs(args, A, R2, centre_scan, scale, res, removed_frac, wall_tilt)


def segment(A_units, scale):
    """Segmentation in metres (z up, x along dominant walls). Returns dict."""
    A = A_units * scale
    log(f'segment at {scale:.3f} m/unit; extent', np.round(A.min(0), 1), np.round(A.max(0), 1))
    ground_at, ginfo = build_ground(A, 0.5, int(round(24 / 0.5)))  # 24 m opening window
    hag = A[:, 2] - ground_at(A[:, 0], A[:, 1])

    # top-surface points above 2 m: within 0.35 m of the 0.25 m cell's top (95th pct)
    cell = 0.25
    x0, y0 = A[:, 0].min(), A[:, 1].min()
    ix = ((A[:, 0] - x0) / cell).astype(int)
    iy = ((A[:, 1] - y0) / cell).astype(int)
    nxc, nyc = ix.max() + 1, iy.max() + 1
    lin = ix * nyc + iy
    order = np.lexsort((A[:, 2], lin))
    lin_s = lin[order]
    starts = np.r_[0, np.flatnonzero(np.diff(lin_s)) + 1]
    ends = np.r_[starts[1:], len(lin_s)]
    top = np.full(nxc * nyc, -np.inf)
    pos = starts + ((ends - starts - 1) * 0.95).astype(int)
    top[lin_s[starts]] = A[order[pos], 2]
    is_top = (A[:, 2] > top[lin] - 0.35) & (hag > 1.8)
    T = A[is_top]
    T, _ = voxel_down(T, 0.08)
    log('top-surface points above 1.8 m', len(T))
    n, curv, idx = pca_normals(T, 24)
    n *= np.sign(n[:, 2] + 1e-12)[:, None]
    labels, regions = region_grow(T, n, curv, idx[:, :16], max_angle_deg=14, max_dist=0.15, min_pts=120)
    planes = []
    for rid, mem in enumerate(regions):
        if mem is None:
            continue
        pts = T[mem]
        nn, c, s, inl = fit_plane(pts)
        tilt = math.degrees(math.acos(min(1, nn[2])))
        if tilt > 60:
            continue
        planes.append({'n': nn, 'c': c, 'sigma': s, 'idx': mem[inl]})
    log('raw planes', len(planes))
    # merge coplanar, adjacent planes
    merged = True
    while merged:
        merged = False
        for i in range(len(planes)):
            for j in range(i + 1, len(planes)):
                a, b = planes[i], planes[j]
                if a['n'] @ b['n'] < math.cos(math.radians(7)):
                    continue
                if abs((b['c'] - a['c']) @ a['n']) > 0.2 or abs((a['c'] - b['c']) @ b['n']) > 0.2:
                    continue
                ta, tb = cKDTree(T[a['idx']]), T[b['idx']]
                d, _ = ta.query(tb, 1, distance_upper_bound=0.6)
                if np.isfinite(d).sum() < 5:
                    continue
                allidx = np.r_[a['idx'], b['idx']]
                nn, c, s, inl = fit_plane(T[allidx])
                planes[i] = {'n': nn, 'c': c, 'sigma': s, 'idx': allidx[inl]}
                planes.pop(j)
                merged = True
                break
            if merged:
                break
    # area filter + tree rejection (roofs are smooth: low sigma, decent area)
    good = []
    for pl in planes:
        pts = T[pl['idx']]
        area = len(pl['idx']) * 0.08 * 0.08 / max(pl['n'][2], 0.3)
        pl['area_est'] = area
        if area < 4.0 or pl['sigma'] > 0.09:
            if DEBUG_PLANES: print('DROP plane', np.round(pts.mean(0),1), 'area', round(area,1), 'sigma', round(pl['sigma'],3), 'tilt', round(math.degrees(math.acos(min(1,pl['n'][2]))),1))
            continue
        good.append(pl)
    log('planes after merge/filter', len(good), [round(p['area_est'], 1) for p in good])

    # buildings = connected footprints of planes
    occ = np.zeros((nxc, nyc), np.int32)
    for k, pl in enumerate(good):
        pts = T[pl['idx']]
        gx = ((pts[:, 0] - x0) / cell).astype(int)
        gy = ((pts[:, 1] - y0) / cell).astype(int)
        occ[gx, gy] = k + 1
    foot = ndimage.binary_dilation(occ > 0, iterations=3)
    blab, nb = ndimage.label(foot)
    for k, pl in enumerate(good):
        pts = T[pl['idx']]
        gx = ((pts[:, 0] - x0) / cell).astype(int)
        gy = ((pts[:, 1] - y0) / cell).astype(int)
        b = np.bincount(blab[gx, gy]).argmax()
        pl['building'] = int(b)
    buildings = {}
    for pl in good:
        buildings.setdefault(pl['building'], []).append(pl)
    # primary building: the one closest to the scan's point-density centre (drone orbit centre)
    dens_c = np.median(A[:, :2], 0)
    binfo = []
    for b, pls in buildings.items():
        allp = np.vstack([T[p['idx']] for p in pls])
        c2 = allp[:, :2].mean(0)
        binfo.append({'b': b, 'centre': c2, 'dist': float(np.linalg.norm(c2 - dens_c)),
                      'area': sum(p['area_est'] for p in pls), 'planes': pls,
                      'min': allp.min(0), 'max': allp.max(0)})
    binfo = [bi for bi in binfo if bi['area'] > 15]
    binfo.sort(key=lambda bi: bi['dist'])
    primary = binfo[0]
    log('buildings', [(round(bi['dist'], 1), round(bi['area'], 1), len(bi['planes'])) for bi in binfo])

    # scale measurement on the primary building (in current metres -> convert to units)
    pp = np.vstack([T[p['idx']] for p in primary['planes']])
    ph = pp[:, 2] - ground_at(pp[:, 0], pp[:, 1])
    ridge_m = float(np.percentile(ph, 98))
    eaves = []
    for p in primary['planes']:
        if p['n'][2] > math.cos(math.radians(8)):
            continue  # flat parts have no eave line
        q = T[p['idx']]
        eaves.append(float(np.percentile(q[:, 2] - ground_at(q[:, 0], q[:, 1]), 3)))
    eave_m = float(np.median(eaves)) if eaves else ridge_m * 0.45
    ratio = ridge_m / max(eave_m, 1e-6)
    storeys = 1 if ratio > 2.0 else 2
    eave_ref = 3.0 if storeys == 1 else 6.2   # MY single-storey eave ~2.7-3.3 m; double ~5.8-6.6 m
    ridge_ref = 7.0 if storeys == 1 else 9.5   # MY single-storey ridge ~6-8 m (steep hip); double ~8.5-10.5 m
    s_eave = eave_ref / (eave_m / scale)
    s_ridge = ridge_ref / (ridge_m / scale)
    s_est = math.sqrt(s_eave * s_ridge)
    spread = abs(math.log(s_eave / s_ridge))
    conf = 'medium' if spread < 0.15 else 'low'
    scale_est = {
        'metresPerUnit': s_est,
        'eaveUnits': eave_m / scale, 'ridgeUnits': ridge_m / scale, 'ridgeEaveRatio': ratio,
        'storeys': storeys, 'fromEave': s_eave, 'fromRidge': s_ridge, 'confidence': conf,
    }

    # trees / vegetation: high, rough points not explained by planes
    # occluders: tall things that are not roof planes (trees, poles, higher walls) on a 0.5 m grid
    oc = 0.5
    gx0, gy0 = A[:, 0].min(), A[:, 1].min()
    oix = ((A[:, 0] - gx0) / oc).astype(int)
    oiy = ((A[:, 1] - gy0) / oc).astype(int)
    onx, ony = oix.max() + 1, oiy.max() + 1
    hag95 = cell_percentile(oix * ony + oiy, hag, 0.95, onx * ony, min_count=3).reshape(onx, ony)
    roofc = np.zeros((onx, ony), bool)
    for pl in good:
        q = T[pl['idx']]
        roofc[((q[:, 0] - gx0) / oc).astype(int), ((q[:, 1] - gy0) / oc).astype(int)] = True
    roofc = ndimage.binary_dilation(roofc, iterations=2)
    tall = np.isfinite(hag95) & (hag95 > 3.0) & ~roofc
    tall = ndimage.binary_opening(tall, iterations=1)
    olab, on = ndimage.label(tall)
    occluders = []
    for k in range(1, on + 1):
        cells = np.argwhere(olab == k)
        if len(cells) < 12:  # < 3 m2
            continue
        hv = hag95[cells[:, 0], cells[:, 1]]
        cxy = cells.mean(0) * oc + [gx0 + oc / 2, gy0 + oc / 2]
        rad = float(np.sqrt(len(cells) * oc * oc / math.pi))
        rough_h = float(np.std(hv))
        gz = float(ground_at(np.array([cxy[0]]), np.array([cxy[1]]))[0])
        occluders.append({'centre_xy': cxy, 'ground': gz, 'top': float(np.percentile(hv, 95)) + gz, 'height': float(np.percentile(hv, 95)),
                          'radius': rad, 'areaM2': len(cells) * oc * oc,
                          'kind': 'tree / vegetation' if rough_h > 0.8 or rad > 2.0 and rough_h > 0.5 else 'structure (wall, pole or other building part)'})
    log('occluders', len(occluders), 'trees', sum(o['kind'].startswith('tree') for o in occluders))
    return {'A': A, 'T': T, 'Tn': n, 'planes': good, 'buildings': binfo, 'primary': primary, 'occluders': occluders,
            'ground_at': ground_at, 'ginfo': ginfo, 'hag': hag, 'scale_est': scale_est}


def roof_outline_and_obstacles(pl, T, A, hag, all_planes, ground_at):
    nn = pl['n']
    c = pl['c']
    upv = np.array([0, 0, 1.0])
    v = upv - nn * (upv @ nn)
    if np.linalg.norm(v) < 1e-6:  # flat: pick x as u
        u = np.array([1.0, 0, 0])
        v = np.cross(nn, u)
    else:
        v /= np.linalg.norm(v)
        u = np.cross(v, nn)
        u /= np.linalg.norm(u)
    pts = T[pl['idx']]
    uv = np.c_[(pts - c) @ u, (pts - c) @ v]
    r = 0.1
    mn = uv.min(0) - 0.5
    gi = ((uv - mn) / r).astype(int)
    shape = gi.max(0) + 3
    m = np.zeros(shape, bool)
    m[gi[:, 0], gi[:, 1]] = True
    m = ndimage.binary_closing(m, iterations=3)
    m = ndimage.binary_fill_holes(m)
    m = ndimage.binary_opening(m, iterations=2)
    lab, nl = ndimage.label(m)
    if nl == 0:
        return None
    big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
    m = lab == big
    # boundary of the mask (marching squares via contourpy), outer ring only, then simplified
    import contourpy
    pad = np.pad(m.astype(float), 1)
    gen = contourpy.contour_generator(z=pad.T, line_type=contourpy.LineType.Separate)
    lines = gen.lines(0.5)
    ring = max(lines, key=lambda L: abs(polygon_area(L[:-1])) if len(L) > 3 else 0)[:-1]
    ring = (ring - 1 + 0.5) * r + mn  # cell centres -> (u,v)
    if polygon_area(ring) < 0:
        ring = ring[::-1]
    ring_fine = simplify_closed(ring, 0.12)
    ring = simplify_closed(ring, 0.30)  # roof faces are simple polygons; staircase raster edges become straight
    if polygon_area(ring) < 0:
        ring = ring[::-1]
    if polygon_area(ring_fine) < 0:
        ring_fine = ring_fine[::-1]
    reg = regularize_ring(ring, min_len=0.5)
    if reg is None:
        ring = ring_fine
    if reg is not None:
        ring = reg
    area_plane = abs(polygon_area(ring))
    # 3D outline on the plane
    outline3 = c + ring[:, :1] * u + ring[:, 1:2] * v

    # edge typing in (u,v): horizontal edges at low v = eave, high v = ridge; sloped = hip/verge;
    # valley/abutment if the surface just outside the edge is higher than the plane extension
    vmin, vmax = ring[:, 1].min(), ring[:, 1].max()
    Ttree = cKDTree(A[:, :2])
    edges = []
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        d = b - a
        L = np.linalg.norm(d)
        mid = (a + b) / 2
        out_n = np.array([d[1], -d[0]]) / (L + 1e-12)  # outward for CCW ring
        horiz = abs(d[1]) < 0.25 * L
        if horiz:
            et = 'eave' if mid[1] < (vmin + vmax) / 2 else 'ridge'
        else:
            et = 'hip'
        # probe 0.6 m outside the edge: is there surface above the plane extension?
        probe = mid + out_n * 0.6
        P3 = c + probe[0] * u + probe[1] * v
        near = Ttree.query_ball_point(P3[:2], 0.3)
        if near:
            zz = A[near, 2]
            above = np.percentile(zz, 90) - P3[2]
            if et != 'eave' and above > 0.3:
                et = 'valley' if et == 'hip' else 'abutment'
        edges.append({'type': et, 'lengthM': round(float(L), 2)})

    # obstacles: points inside the outline, above the plane by > max(0.15, 3 sigma)
    thr = max(0.15, 3 * pl['sigma'])
    bb0, bb1 = outline3.min(0) - 0.2, outline3.max(0) + 4.0
    sel = np.all((A > bb0) & (A < bb1), axis=1)
    Q = A[sel]
    dq = (Q - c) @ nn
    quv = np.c_[(Q - c) @ u, (Q - c) @ v]
    inside = point_in_poly(quv, ring)
    up_pts = inside & (dq > thr) & (dq < 15)
    obstacles = []
    if up_pts.sum() > 0:
        g = ((quv[up_pts] - mn) / 0.2).astype(int)
        g = np.clip(g, 0, None)
        sh = g.max(0) + 2
        cnt = np.zeros(sh, int)
        np.add.at(cnt, (g[:, 0], g[:, 1]), 1)
        # density threshold relative to roof density (points per 0.2 m cell on the roof)
        roof_density = len(pts) / max(area_plane, 1e-6) * 0.04
        occm = cnt >= max(3, 0.35 * roof_density)
        occm = ndimage.binary_closing(occm, iterations=1)
        lab2, n2 = ndimage.label(occm)
        heights = dq[up_pts]
        for k in range(1, n2 + 1):
            cells = np.argwhere(lab2 == k)
            if len(cells) < 3:
                continue
            inc = lab2[np.clip(g[:, 0], 0, sh[0] - 1), np.clip(g[:, 1], 0, sh[1] - 1)] == k
            if inc.sum() < 8:
                continue
            h = float(np.percentile(heights[inc], 90))
            cuv = np.vstack([cells * 0.2 + mn, (cells + [1, 0]) * 0.2 + mn, (cells + [0, 1]) * 0.2 + mn,
                             (cells + 1) * 0.2 + mn])
            rect = min_area_rect(cuv)
            area_o = abs(polygon_area(rect))
            # kind from geometry
            on_edge = edge_distance(rect.mean(0), ring) < 0.5
            belongs_plane = False
            for op in all_planes:
                if op is pl:
                    continue
                q = Q[up_pts][inc]
                if np.median(np.abs((q - op['c']) @ op['n'])) < 0.15:
                    belongs_plane = True
                    break
            if h > 2.5:
                kind = 'tree canopy over roof'
            elif belongs_plane:
                kind = 'adjoining higher roof / dormer'
            elif on_edge and area_o > 1.0:
                kind = 'parapet / upstand'
            elif h > 0.6 and area_o > 0.8:
                kind = 'water tank or plant (unclassified protrusion)'
            else:
                kind = 'vent / pipe / small protrusion'
            o3 = c + rect[:, :1] * u + rect[:, 1:2] * v
            obstacles.append({'outline': o3, 'height': h, 'kind': kind, 'areaM2': area_o})
    return {'u': u, 'v': v, 'ring': ring, 'outline3': outline3, 'area': area_plane / 1.0,
            'edges': edges, 'obstacles': obstacles, 'thr': thr}


def point_in_poly(p, poly):
    x, y = p[:, 0], p[:, 1]
    inside = np.zeros(len(p), bool)
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cond = ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1)
        inside ^= cond
    return inside


def edge_distance(pt, poly):
    best = 1e9
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        ab = b - a
        t = np.clip((pt - a) @ ab / (ab @ ab + 1e-12), 0, 1)
        best = min(best, np.linalg.norm(pt - (a + t * ab)))
    return best


def cross_checks(roofs, buildings, res, origin, scale):
    """Sizes implied by the chosen scale, to compare with typical Malaysian houses."""
    prim = [b for b in buildings if b['primary']][0]
    pr = [r for r in roofs if r['building'] == prim['id']]
    allo = np.vstack([np.array(r['outline']) for r in pr])
    ext = allo.max(0) - allo.min(0)
    low_roofs = sorted(pr, key=lambda r: r['heightRangeM'][0])
    trees = [o for o in res['occluders'] if o['kind'].startswith('tree')]
    return {
        'primaryRoofPlanFootprintM': [round(float(ext[0]), 1), round(float(ext[2]), 1)],
        'primaryRoofAreaM2': prim['roofAreaM2'],
        'lowestRoofEdgeAboveGroundM': low_roofs[0]['heightRangeM'][0] if low_roofs else None,
        'highestRidgeAboveGroundM': max(r['heightRangeM'][1] for r in pr),
        'tallestNearbyTreeM': round(max([o['height'] for o in trees], default=0), 1),
        'typical': 'MY double-storey bungalow/semi-D: eave 5.8-6.6 m, ridge 8.5-10.5 m, car-porch roof edge 2.7-3.5 m, '
                   'footprint 10-20 m a side; mature rain trees 10-20 m.',
    }


def to_twin(p):
    """z-up aligned metres (x, y=north, z=up) -> twin (x east, y up, z south)."""
    p = np.asarray(p, dtype=np.float64)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], axis=-1)


def write_outputs(args, A_units, R2, centre_scan, scale, res, removed_frac, wall_tilt):
    A = res['A']
    T = res['T']
    ground_at = res['ground_at']
    hag = res['hag']
    primary = res['primary']
    # origin: ground under the primary building centre
    pc = primary['centre']
    g0 = float(ground_at(np.array([pc[0]]), np.array([pc[1]]))[0])
    origin = np.array([pc[0], pc[1], g0])
    A0 = A - origin
    T0_ = T - origin

    roofs = []
    buildings_out = []
    all_planes = [p for b in res['buildings'] for p in b['planes']]
    for bi_k, bi in enumerate(res['buildings']):
        bid = f'B{bi_k + 1}'
        roof_ids = []
        for pl in sorted(bi['planes'], key=lambda p: -p['area_est']):
            pl_local = dict(pl)
            pl_local['c'] = pl['c'] - origin
            info = roof_outline_and_obstacles(pl_local, T0_, A0, hag, [dict(p, c=p['c'] - origin) if p is not pl else pl_local for p in all_planes], ground_at)
            if info is None or info['area'] < 4.0:
                continue
            rid = f'R{len(roofs) + 1}'
            nn = pl['n']
            nt = to_twin(nn)
            tilt = math.degrees(math.acos(min(1, nn[2])))
            # azimuth of the downslope (facing) direction, from north clockwise; north = +y (aligned) = -z (twin)
            az = (math.degrees(math.atan2(nn[0], nn[1])) + 360) % 360 if tilt > 0.5 else 180.0
            hags = T0_[pl['idx'], 2]
            roofs.append({
                'id': rid, 'building': bid,
                'normal': [round(float(x), 5) for x in nt],
                'point': [round(float(x), 3) for x in to_twin(pl_local['c'])],
                'tilt': round(tilt, 2), 'azimuth': round(az, 2),
                'flat': tilt < 5,
                'outline': [[round(float(x), 3) for x in to_twin(q)] for q in info['outline3']],
                'edges': info['edges'],
                'eaveDir': [round(float(x), 5) for x in to_twin(info['u'])],
                'upSlopeDir': [round(float(x), 5) for x in to_twin(info['v'])],
                'area': round(float(info['area']), 2),
                'planeRmsM': round(float(pl['sigma']), 3),
                'heightRangeM': [round(float(np.percentile(hags, 2)), 2), round(float(np.percentile(hags, 98)), 2)],
                'obstacles': [{'outline': [[round(float(x), 3) for x in to_twin(q)] for q in o['outline']],
                               'height': round(o['height'], 2), 'kind': o['kind'],
                               'areaM2': round(o['areaM2'], 2)} for o in info['obstacles']],
            })
            roof_ids.append(rid)
        if roof_ids:
            buildings_out.append({'id': bid, 'primary': bi is primary, 'roofIds': roof_ids,
                                  'centre': [round(float(x), 2) for x in to_twin(np.r_[bi['centre'] - origin[:2], 0])],
                                  'roofAreaM2': round(sum(r['area'] for r in roofs if r['building'] == bid), 1)})
    log('roofs written', len(roofs), 'primary roofs', [r['id'] for r in roofs if r['building'] == buildings_out[0]['id']])

    # --- occupancy
    vox = 0.25
    keep = (np.abs(A0[:, 0]) < 30) & (np.abs(A0[:, 1]) < 30)
    O = to_twin(A0[keep])
    omin = np.floor(O.min(0) / vox) * vox
    omin[1] = max(omin[1], -3.0)
    O = O[O[:, 1] >= omin[1]]
    gi = np.floor((O - omin) / vox).astype(int)
    dims = gi.max(0) + 1
    occ = np.zeros(dims[::-1], np.uint8)  # [z][y][x] -> x fastest in C order
    np.add.at(occ, (gi[:, 2], gi[:, 1], gi[:, 0]), 1)
    solid = occ >= 1
    # Splat "fuzz": Gaussian centres scattered just above roof surfaces (worst along ridges seen against
    # the sky). A voxel whose centre is 0.1-1.2 m above a fitted roof plane, inside that plane's outline
    # (+0.6 m), is only kept if it holds >= 3 points; real roof furniture is dense, fuzz is not.
    zz, yy, xx = np.nonzero(solid)
    cen = np.c_[xx, yy, zz] * vox + omin + vox / 2
    fuzz = np.zeros(len(cen), bool)
    cnt = occ[zz, yy, xx]
    for r in roofs:
        nn, p0 = np.array(r['normal']), np.array(r['point'])
        o = np.array(r['outline'])
        lo, hi = o.min(0) - 0.8, o.max(0) + 1.4
        m = np.all((cen > lo) & (cen < hi), axis=1) & (cnt < 3)
        if not m.any():
            continue
        q = cen[m] - p0
        h = q @ nn
        u = np.array(r['eaveDir']); v = np.cross(nn, u)
        ring = np.c_[(o - p0) @ u, (o - p0) @ v]
        quv = np.c_[q @ u, q @ v]
        inside = point_in_poly(quv, ring)
        # dilate the outline test by 0.6 m: also accept points within 0.6 m of the ring edges
        if (~inside).any():
            near = np.array([edge_distance(pt, ring) < 0.6 for pt in quv[~inside]])
            inside[~inside] = near
        f = inside & (h > 0.1) & (h < 1.2)
        idx = np.flatnonzero(m)[f]
        fuzz[idx] = True
    solid[zz[fuzz], yy[fuzz], xx[fuzz]] = False
    log('occupancy: removed', int(fuzz.sum()), 'sparse fuzz voxels hovering above roof planes')
    # drop floaters: isolated voxels and small disconnected clusters (< 12 voxels, < 0.19 m3).
    # Real roof furniture is connected to the roof surface, so it survives.
    nbr = ndimage.convolve(solid.astype(np.uint8), np.ones((3, 3, 3), np.uint8), mode='constant') - solid
    solid &= nbr >= 1
    lab, nlab = ndimage.label(solid, structure=np.ones((3, 3, 3)))
    sizes = np.bincount(lab.ravel())
    small = sizes < 12
    small[0] = False
    removed = int(small[lab].sum())
    solid &= ~small[lab]
    log('occupancy: removed', removed, 'voxels in', int(small.sum()), 'small floater clusters')
    occ_bytes = solid.astype(np.uint8)
    occ_bytes.tofile(os.path.join(args.out, 'occupancy.bin'))
    log('occupancy dims', dims.tolist(), 'solid', int(solid.sum()), f'{occ_bytes.nbytes / 1e6:.2f} MB')

    # --- points + normals (decimated)
    near = (np.abs(A0[:, 0]) < 45) & (np.abs(A0[:, 1]) < 45)  # keep point density near the house
    P = to_twin(A0[near])
    rng = np.random.default_rng(1)
    maxpts = 480000
    sel = rng.choice(len(P), min(maxpts, len(P)), replace=False) if len(P) > maxpts else np.arange(len(P))
    sel.sort()
    Pd = P[sel].astype(np.float32)
    Pd.tofile(os.path.join(args.out, 'points.bin'))
    nrm, _, _ = pca_normals(P[sel].astype(np.float64), 16)
    # orient toward up / outward
    nrm *= np.sign(nrm[:, 1] + 1e-9)[:, None]
    (np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)).tofile(os.path.join(args.out, 'normals.bin'))
    log('points.bin', len(Pd), f'{Pd.nbytes / 1e6:.2f} MB')

    se = res['scale_est']
    # scan -> twin transform (4x4) so the viewer can align the original splat if wanted
    M = np.eye(4)
    Rfull = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]]) @ R2 * scale
    M[:3, :3] = Rfull
    M[:3, 3] = -Rfull @ centre_scan - np.array([origin[0], origin[2], -origin[1]])
    twin = {
        'id': 'friend-house',
        'title': "Friend's house (drone scan, Gaussian-splat centres)",
        'source': 'export_30000.ply (ImageToStl, xyz only, 1,126,007 vertices); prepared by scripts/prepare_twin.py',
        'pointCount': int(len(Pd)),
        'bounds': {'min': [round(float(x), 2) for x in Pd.min(0)], 'max': [round(float(x), 2) for x in Pd.max(0)]},
        'scale': {
            'metresPerUnit': round(scale, 4),
            'method': (f"Architectural prior on the primary house. Measured eave {se['eaveUnits']:.3f} u and ridge "
                       f"{se['ridgeUnits']:.3f} u above the terrain model (ratio {se['ridgeEaveRatio']:.2f} -> "
                       f"{se['storeys']}-storey). Eave ~{3.0 if se['storeys'] == 1 else 6.2} m gives {se['fromEave']:.2f} m/u, "
                       f"ridge ~{7.0 if se['storeys'] == 1 else 9.5} m gives {se['fromRidge']:.2f} m/u; geometric mean used. "
                       f"Segmentation is re-run at the estimated scale until it agrees within 6% (fixed point; used {scale:.3f} m/u). "
                       f"Independent cross-checks (porch roof edge, footprint, trees) in scale.crossChecks."),
            'confidence': se['confidence'],
            'crossChecks': cross_checks(roofs, buildings_out, res, origin, scale),
            'rangeMetresPerUnit': [round(min(se['fromEave'], se['fromRidge']) * 0.9, 2), round(max(se['fromEave'], se['fromRidge']) * 1.1, 2)],
        },
        'northBearing': 0,
        'location': {'lat': 3.11, 'lon': 101.58, 'name': 'Ara Damansara (assumed)', 'timezone': 8},
        'ground': {'y': 0},
        'alignment': {
            'scanToTwin': [[round(float(x), 6) for x in row] for row in M],
            'upSignEvidence': GRAVITY_EVIDENCE,
            'wallNormalElevationMedianDeg': round(float(np.median(wall_tilt)), 2),
            'floatersRemovedFraction': round(float(removed_frac), 4),
            'method': 'PCA least-variance axis, sign from the roofs-cover-walls test (sloped planar patches sit above the '
                      'adjacent vertical ones), refined so near-vertical planar patches are '
                      'exactly vertical; heading from wall normals folded mod 90 deg; -z = north is a convention only.',
        },
        'buildings': buildings_out,
        'roofs': roofs,
        'occupancy': {'origin': [round(float(x), 3) for x in omin], 'voxel': vox, 'dims': dims.tolist(),
                      'file': 'occupancy.bin', 'encoding': 'uint8, 1 = solid, x fastest then y then z'},
        'files': {'points': 'points.bin', 'normals': 'normals.bin'},
        'occluders': [{'id': f'T{i + 1}', 'kind': o['kind'],
                       'centre': [round(float(x), 2) for x in to_twin(np.r_[o['centre_xy'] - origin[:2], o['ground'] - origin[2]])],
                       'radius': round(o['radius'], 2), 'height': round(o['height'], 2), 'top': round(o['top'] - origin[2], 2), 'areaM2': round(o['areaM2'], 1)}
                      for i, o in enumerate(sorted(res['occluders'], key=lambda o: np.linalg.norm(o['centre_xy'] - origin[:2])))
                      if np.linalg.norm(o['centre_xy'] - origin[:2]) < 40],
    }
    with open(os.path.join(args.out, 'twin.json'), 'w') as f:
        json.dump(twin, f, indent=1)
    log('twin.json written', os.path.join(args.out, 'twin.json'))
    log('scale', se)

    if not args.no_renders:
        render(args.renders, P, roofs, buildings_out, res, origin)


def render(outdir, P, roofs, buildings, res, origin):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    rng = np.random.default_rng(2)
    s = P[rng.choice(len(P), min(300000, len(P)), replace=False)]
    m = (np.abs(s[:, 0]) < 35) & (np.abs(s[:, 2]) < 35)
    s = s[m]
    cols = plt.cm.tab10(np.arange(10))
    # top
    fig, ax = plt.subplots(figsize=(16, 16))
    ax.scatter(s[:, 0], s[:, 2], c=s[:, 1], s=0.2, cmap='gray', vmin=-1, vmax=12)
    for k, r in enumerate(roofs):
        o = np.array(r['outline'])
        ax.fill(o[:, 0], o[:, 2], color=cols[k % 10], alpha=0.35)
        ax.plot(np.r_[o[:, 0], o[0, 0]], np.r_[o[:, 2], o[0, 2]], color=cols[k % 10], lw=1.5)
        ax.text(*np.array(r['point'])[[0, 2]], f"{r['id']}\n{r['tilt']:.0f}°/{r['azimuth']:.0f}°", fontsize=8, ha='center')
        for ob in r['obstacles']:
            q = np.array(ob['outline'])
            ax.plot(np.r_[q[:, 0], q[0, 0]], np.r_[q[:, 2], q[0, 2]], 'r-', lw=1)
    ax.set_aspect('equal')
    ax.invert_yaxis()  # z south -> down, north up
    ax.set_title('aligned top view (x east right, north up; -z = north). Roof planes coloured')
    ax.grid(alpha=0.3)
    fig.savefig(os.path.join(outdir, 'aligned-top.png'), dpi=70, bbox_inches='tight')
    plt.close(fig)
    # elevations: front (x vs y) slab, side (z vs y) slab through primary building
    fig, axs = plt.subplots(2, 1, figsize=(18, 12))
    sl = np.abs(s[:, 2]) < 1.5
    axs[0].scatter(s[sl, 0], s[sl, 1], s=0.3, c='k')
    axs[0].set_title('elevation: x (east) vs y (up), slab |z|<1.5 m through primary building')
    sl = np.abs(s[:, 0]) < 1.5
    axs[1].scatter(-s[sl, 2], s[sl, 1], s=0.3, c='k')
    axs[1].set_title('elevation: north (-z) vs y (up), slab |x|<1.5 m')
    for a in axs:
        a.set_aspect('equal')
        a.grid(alpha=0.4)
        a.axhline(0, color='g', lw=0.8)
    fig.savefig(os.path.join(outdir, 'aligned-elev.png'), dpi=70, bbox_inches='tight')
    plt.close(fig)
    # zoom on the primary building with roof planes
    prim = [b for b in buildings if b['primary']][0]
    pr = [r for r in roofs if r['building'] == prim['id']]
    allo = np.vstack([np.array(r['outline']) for r in pr])
    lo, hi = allo.min(0) - 4, allo.max(0) + 4
    mm = (s[:, 0] > lo[0]) & (s[:, 0] < hi[0]) & (s[:, 2] > lo[2]) & (s[:, 2] < hi[2])
    fig, axs = plt.subplots(1, 2, figsize=(22, 11))
    axs[0].scatter(s[mm, 0], s[mm, 2], c=s[mm, 1], s=1.0, cmap='gray', vmin=-1, vmax=12)
    for k, r in enumerate(pr):
        o = np.array(r['outline'])
        axs[1].fill(o[:, 0], o[:, 2], color=cols[k % 10], alpha=0.5)
        axs[1].plot(np.r_[o[:, 0], o[0, 0]], np.r_[o[:, 2], o[0, 2]], color='k', lw=0.8)
        axs[1].text(*np.array(r['point'])[[0, 2]], f"{r['id']} {r['tilt']:.0f}°/{r['azimuth']:.0f}° " + f"{r['area']:.0f} m2", fontsize=8, ha='center')
        for ob in r['obstacles']:
            q = np.array(ob['outline'])
            axs[1].fill(q[:, 0], q[:, 2], color='r', alpha=0.6)
    for a in axs:
        a.set_aspect('equal'); a.invert_yaxis(); a.grid(alpha=0.3)
        a.set_xlim(lo[0], hi[0]); a.set_ylim(hi[2], lo[2])
    axs[0].set_title('primary building: points (brightness = height)')
    axs[1].set_title('primary building: roof planes (tilt/azimuth), obstacles red')
    fig.savefig(os.path.join(outdir, 'aligned-primary.png'), dpi=70, bbox_inches='tight')
    plt.close(fig)
    log('renders written to', outdir)


def render_plan(twin_dir, plan_path, outdir, tag):
    """Top-down + oblique render of a plan (panels, arrays, rejected areas, flux heatmap) over the scan points."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    twin = json.load(open(os.path.join(twin_dir, 'twin.json')))
    P = np.fromfile(os.path.join(twin_dir, 'points.bin'), dtype=np.float32).reshape(-1, 3)
    d = json.load(open(plan_path, encoding='utf-8'))
    plan = d['plan']
    prim = [b for b in twin['buildings'] if b['primary']][0]
    roofs = [r for r in twin['roofs'] if r['building'] == prim['id']]
    allo = np.vstack([np.array(r['outline']) for r in roofs])
    lo, hi = allo.min(0) - 3, allo.max(0) + 3
    m = (P[:, 0] > lo[0]) & (P[:, 0] < hi[0]) & (P[:, 2] > lo[2]) & (P[:, 2] < hi[2])
    S = P[m]
    fig, axs = plt.subplots(1, 2, figsize=(26, 13))
    for k, ax in enumerate(axs):
        ax.scatter(S[:, 0], S[:, 2], c=S[:, 1], s=0.6, cmap='gray', vmin=-2, vmax=11, zorder=1)
        for r in roofs:
            o = np.array(r['outline'])
            ax.add_patch(Polygon(o[:, [0, 2]], closed=True, fill=False, ec='orange', lw=1.2, zorder=3))
            ax.text(r['point'][0], r['point'][2], r['id'], color='orange', fontsize=9, zorder=6)
        if k == 1 and d.get('heat'):
            for h in d['heat']:
                c = np.array([x[0] for x in h['cells']]); v = np.array([x[1] for x in h['cells']])
                if len(c):
                    sc = ax.scatter(c[:, 0], c[:, 2], c=v, s=28, marker='s', cmap='plasma', vmin=900, vmax=1750, zorder=2, alpha=0.9)
            fig.colorbar(sc, ax=ax, fraction=0.03, label='annual POA kWh/m2 (shaded)')
        for rj in plan['rejected']:
            if rj['kind'] in ('setback',) and k == 1:
                continue
            q = np.array(rj['outline'])
            col = {'shade': 'red', 'obstacle': 'magenta', 'clutter': 'purple', 'setback': 'red', 'size-cap': 'cyan'}.get(rj['kind'], 'red')
            ax.add_patch(Polygon(q[:, [0, 2]], closed=True, fc=col, alpha=0.18 if rj['kind'] != 'size-cap' else 0.1, ec=col, lw=0.6, hatch='//' if rj['kind'] in ('shade', 'obstacle', 'clutter') else None, zorder=4))
        for p in plan['panels']:
            q = np.array(p['corners'])
            ax.add_patch(Polygon(q[:, [0, 2]], closed=True, fc='#1f3fbf', ec='white', lw=0.8, alpha=0.95, zorder=5))
        for a in plan['arrays']:
            q = np.array(a['outline'])
            ax.add_patch(Polygon(q[:, [0, 2]], closed=True, fill=False, ec='cyan', lw=1.5, zorder=6))
            c = q.mean(0)
            ax.text(c[0], c[2], f"{a['id']} {a['rows']}x{a['cols']}", color='yellow', fontsize=10, ha='center', zorder=7)
        ax.set_xlim(lo[0], hi[0]); ax.set_ylim(hi[2], lo[2]); ax.set_aspect('equal'); ax.grid(alpha=0.25)
    s = plan['summary']
    axs[0].set_title(f"plan '{tag}': {s['panels']} x {s['watt']} W = {s['kWp']} kWp, {s['annualKwh']} kWh/yr, {s['specificYield']} kWh/kWp (north up, x east)")
    axs[1].set_title('annual flux heatmap + rejected (red hatch = shade, magenta = obstacle, purple = clutter, cyan = not needed)')
    fig.savefig(os.path.join(outdir, f'plan-top-{tag}.png'), dpi=60, bbox_inches='tight')
    plt.close(fig)
    # oblique 3D (panels drawn last, on top) + a section through every array
    arrays = plan['arrays']
    ncols = max(1, len(arrays))
    fig = plt.figure(figsize=(24, 12 + 4 * ((ncols + 2) // 3)))
    gs = fig.add_gridspec(1 + (ncols + 2) // 3, 3, height_ratios=[3] + [1] * ((ncols + 2) // 3))
    for k, (el, az) in enumerate([(35, -65), (35, 115)]):
        ax = fig.add_subplot(gs[0, k if k == 0 else 1:3] if False else gs[0, k * 2 if k == 0 else 1], projection='3d', computed_zorder=False) if False else fig.add_subplot(gs[0, k], projection='3d', computed_zorder=False)
        sub = S[np.random.default_rng(0).choice(len(S), min(90000, len(S)), replace=False)]
        ax.scatter(sub[:, 0], -sub[:, 2], sub[:, 1], c=sub[:, 1], s=0.25, cmap='gray', vmin=-4, vmax=12, depthshade=False, zorder=1)
        polys = [[(c[0], -c[2], c[1]) for c in p['corners']] for p in plan['panels']]
        ax.add_collection3d(Poly3DCollection(polys, fc='#1f3fbf', ec='white', lw=0.5, alpha=1.0, zorder=5))
        ax.view_init(el, az)
        ax.set_xlim(lo[0], hi[0]); ax.set_ylim(-hi[2], -lo[2]); ax.set_zlim(-1, 13)
        ax.set_box_aspect((hi[0] - lo[0], hi[2] - lo[2], 14))
        ax.set_xlabel('x east'); ax.set_ylabel('north'); ax.set_zlabel('up')
        ax.set_title('oblique: modules drawn on top of the scan points')
    axs3 = fig.add_subplot(gs[0, 2])
    axs3.axis('off')
    sm = plan['summary']
    axs3.text(0, 1, chr(10).join([f"{sm['panels']} modules, {sm['kWp']} kWp, {sm['annualKwh']} kWh/yr", f"specific yield {sm['specificYield']} kWh/kWp, PR {sm['performanceRatio']}",
                                 f"mean shade loss {sm['avgShadeLoss'] * 100:.1f}%, thermal loss {sm['thermalLoss'] * 100:.1f}%"] +
                                [f"{a['id']} {a['roofId']} {a['rows']}x{a['cols']} {a['orientation']} tilt {a['tiltDeg']} az {a['azimuthDeg']} {a['kWp']} kWp {a['loadKgM2']} kg/m2" for a in arrays]),
              va='top', family='monospace', fontsize=11)
    # sections: slab through each array centre, across the eave (i.e. along the slope)
    for i, a in enumerate(arrays):
        ax = fig.add_subplot(gs[1 + i // 3, i % 3])
        U, V, N = np.array(a['axisU']), np.array(a['axisV']), np.array(a['normal'])
        o = np.array(a['outline']).mean(0)
        q = S - o
        su, sv, sn = q @ U, q @ V, q @ N
        hv = np.array([V[0], V[2]]); hv /= np.linalg.norm(hv) + 1e-12
        horiz = q[:, 0] * hv[0] + q[:, 2] * hv[1]
        sl = (np.abs(su) < 0.3) & (np.abs(sv) < a['lengthM'] / 2 + 3)
        ax.scatter(horiz[sl], S[sl, 1], s=1.5, c='0.4', label='scan points (|u|<0.3 m)')
        for p in plan['panels']:
            if p['arrayId'] != a['id']:
                continue
            c = np.array(p['corners']) - o
            if abs(((c @ U).min() + (c @ U).max()) / 2) > a['colPitchM'] / 2 + 0.01:
                continue
            hh = c[:, 0] * hv[0] + c[:, 2] * hv[1]
            ax.plot([hh.min(), hh.max()], [np.array(p['corners'])[np.argmin(hh), 1], np.array(p['corners'])[np.argmax(hh), 1]], color='#1f3fbf', lw=4)
        ax.set_aspect('equal'); ax.grid(alpha=0.3)
        ax.set_title(f"section through {a['id']} on {a['roofId']} (module top {a.get('standoffM')} m above plane)")
    fig.savefig(os.path.join(outdir, f'plan-oblique-{tag}.png'), dpi=55, bbox_inches='tight')
    plt.close(fig)
    print('plan renders written', os.path.join(outdir, f'plan-top-{tag}.png'))


if __name__ == '__main__':
    main()
