"""
app.py  —  Floor Plan Processing Server
Port: 5001

Endpoints:
  POST /upload-floorplan   multipart image → JSON graph
  GET  /health

Node naming convention (consistent across ALL floor plans):
  M1..M4   → 4 largest rooms (assembly/meeting points)
  1, 2, 3… → remaining rooms in reading order (top→bottom, left→right)
  CJ_1…    → corridor junction nodes (as many as detected)

The DB and frontend always use these names — they never change.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename
import cv2
import numpy as np
from skimage.morphology import skeletonize
from collections import deque
import os
import math
import base64
import sys

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'bmp', 'webp'}


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS  (tune here if detection is off for a specific floor plan style)
# ─────────────────────────────────────────────────────────────────────────────

TARGET_W          = 900    # all images are resized to this canvas
TARGET_H          = 700
WALKABLE_MIN_GRAY = 150    # pixels brighter than this = floor / corridor
ROOM_DIST_RATIO   = 0.20   # dist-transform threshold: room_pixel > max*this
MIN_ROOM_PX       = 300    # ignore blobs smaller than this (px²)
NUM_MEETING       = 4      # largest N rooms become M1..M4
MIN_CJ_DIST       = 22     # px: merge skeleton junctions closer than this
MAX_BFS_STEPS     = 800    # BFS depth cap for junction connectivity


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1  Load & normalise
# ─────────────────────────────────────────────────────────────────────────────

def load_image(path):
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Cannot read: {path}")
    return cv2.resize(img, (TARGET_W, TARGET_H), interpolation=cv2.INTER_AREA)


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2  Walkable mask  (255 = floor/corridor, 0 = wall)
# ─────────────────────────────────────────────────────────────────────────────

def walkable_mask(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = (gray > WALKABLE_MIN_GRAY).astype(np.uint8) * 255
    # Close only tiny 1-2 px scan gaps — do NOT merge walls
    k2 = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k2, iterations=1)
    return mask


# ─────────────────────────────────────────────────────────────────────────────
# STEP 3  Room detection via distance transform
# ─────────────────────────────────────────────────────────────────────────────

def detect_rooms(mask):
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    threshold = dist.max() * ROOM_DIST_RATIO

    sure_fg = (dist > threshold).astype(np.uint8) * 255
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(sure_fg, 8)

    rooms = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw   = int(stats[i, cv2.CC_STAT_WIDTH])
        bh   = int(stats[i, cv2.CC_STAT_HEIGHT])

        if area < MIN_ROOM_PX:
            continue                       # noise / tiny artifact
        if bw > TARGET_W * 0.9 or bh > TARGET_H * 0.9:
            continue                       # whole-image background component

        rooms.append({
            "cx_px": float(centroids[i][0]),
            "cy_px": float(centroids[i][1]),
            "area": area, "bw": bw, "bh": bh,
        })

    return rooms, dist


# ─────────────────────────────────────────────────────────────────────────────
# STEP 4  Corridor skeleton & junction detection
# ─────────────────────────────────────────────────────────────────────────────

def corridor_skeleton(mask, dist_map, room_threshold):
    corridor_mask = ((dist_map <= room_threshold) & (mask > 0)).astype(np.uint8) * 255
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    corridor_mask = cv2.dilate(corridor_mask, k, iterations=2)
    corridor_mask = cv2.bitwise_and(corridor_mask, mask)
    bin01 = (corridor_mask > 0).astype(np.uint8)
    return skeletonize(bin01).astype(np.uint8) * 255


def skeleton_junctions(sk):
    h, w = sk.shape
    pts = []
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            if sk[y, x] == 0:
                continue
            nb = (int(sk[y-1,x-1]>0) + int(sk[y-1,x]>0) + int(sk[y-1,x+1]>0) +
                  int(sk[y,  x-1]>0) +                     int(sk[y,  x+1]>0) +
                  int(sk[y+1,x-1]>0) + int(sk[y+1,x]>0) + int(sk[y+1,x+1]>0))
            if nb >= 3:
                pts.append((x, y))
    return pts


def cluster_points(pts, radius):
    if not pts:
        return []
    used, merged = [False] * len(pts), []
    for i, p in enumerate(pts):
        if used[i]:
            continue
        cluster = [p]
        used[i] = True
        for j in range(i + 1, len(pts)):
            if not used[j] and math.hypot(p[0]-pts[j][0], p[1]-pts[j][1]) < radius:
                cluster.append(pts[j])
                used[j] = True
        merged.append((int(sum(c[0] for c in cluster) / len(cluster)),
                       int(sum(c[1] for c in cluster) / len(cluster))))
    return merged


# ─────────────────────────────────────────────────────────────────────────────
# STEP 5  Adjacency graph
# ─────────────────────────────────────────────────────────────────────────────

def bfs_connected(sk, start, goal, max_steps=MAX_BFS_STEPS, gap=6):
    if math.hypot(start[0]-goal[0], start[1]-goal[1]) > 300:
        return False
    h, w = sk.shape
    visited = {start}
    queue   = deque([start])
    steps   = 0
    while queue and steps < max_steps:
        cx, cy = queue.popleft()
        steps += 1
        if abs(cx-goal[0]) <= gap and abs(cy-goal[1]) <= gap:
            return True
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited and sk[ny, nx] > 0:
                    visited.add((nx, ny))
                    queue.append((nx, ny))
    return False


def build_adjacency(node_positions, room_names, cj_pixel_coords, sk):
    adj = {n: [] for n in node_positions}

    # Room → nearest junction
    for r_name in room_names:
        if not cj_pixel_coords:
            continue
        d  = node_positions[r_name]
        rx = d["x"] / 100 * TARGET_W
        ry = d["y"] / 100 * TARGET_H

        best_name, best_dist = None, float('inf')
        for cj_name, (px, py) in cj_pixel_coords.items():
            dist = math.hypot(rx - px, ry - py)
            if dist < best_dist:
                best_dist, best_name = dist, cj_name

        if best_name:
            if best_name not in adj[r_name]:
                adj[r_name].append(best_name)
            if r_name not in adj[best_name]:
                adj[best_name].append(r_name)

    # Junction ↔ junction via skeleton BFS
    cj_list = list(cj_pixel_coords.items())
    for i in range(len(cj_list)):
        for j in range(i + 1, len(cj_list)):
            n1, p1 = cj_list[i]
            n2, p2 = cj_list[j]
            if bfs_connected(sk, p1, p2):
                if n2 not in adj[n1]:
                    adj[n1].append(n2)
                if n1 not in adj[n2]:
                    adj[n1].append(n2)

    return {k: v for k, v in adj.items() if v}


# ─────────────────────────────────────────────────────────────────────────────
# MAIN PIPELINE
# ─────────────────────────────────────────────────────────────────────────────

def pct(px, py):
    return round(px / TARGET_W * 100, 1), round(py / TARGET_H * 100, 1)


def process_floor_plan(image_path: str) -> dict:
    img  = load_image(image_path)
    mask = walkable_mask(img)
    rooms, dist_map = detect_rooms(mask)

    if not rooms:
        raise ValueError(
            "No rooms detected. Make sure your floor plan has light-colored "
            "floors and dark walls. JPG/PNG both work."
        )

    room_threshold = dist_map.max() * ROOM_DIST_RATIO

    # ── Name rooms ──────────────────────────────────────────────────────────
    rooms.sort(key=lambda r: r["area"], reverse=True)

    meeting_rooms = rooms[:NUM_MEETING]
    regular_rooms = rooms[NUM_MEETING:]

    # Sort regular rooms: top→bottom, then left→right (reading order)
    regular_rooms.sort(
        key=lambda r: (int(r["cy_px"] // 80), int(r["cx_px"] // 80))
    )

    node_positions = {}
    room_names     = []
    meeting_points = []

    for i, r in enumerate(meeting_rooms, 1):
        name = f"M{i}"
        meeting_points.append(name)
        room_names.append(name)
        x, y = pct(r["cx_px"], r["cy_px"])
        node_positions[name] = {"x": x, "y": y}

    for i, r in enumerate(regular_rooms, 1):
        name = str(i)
        room_names.append(name)
        x, y = pct(r["cx_px"], r["cy_px"])
        node_positions[name] = {"x": x, "y": y}

    # ── Corridor junctions ───────────────────────────────────────────────────
    sk           = corridor_skeleton(mask, dist_map, room_threshold)
    raw_junctions = skeleton_junctions(sk)
    clustered    = cluster_points(raw_junctions, MIN_CJ_DIST)

    # Discard junctions that landed inside a room centroid
    def in_any_room(px, py):
        return any(math.hypot(px - r["cx_px"], py - r["cy_px"]) < 50
                   for r in rooms)

    cj_pts = [(px, py) for (px, py) in clustered if not in_any_room(px, py)]
    cj_pts.sort(key=lambda p: (int(p[1] // 60), int(p[0] // 60)))

    cj_pixel_coords = {}
    for i, (px, py) in enumerate(cj_pts, 1):
        name = f"CJ_{i}"
        cj_pixel_coords[name] = (px, py)
        x, y = pct(px, py)
        node_positions[name] = {"x": x, "y": y}

    # ── Build adjacency ──────────────────────────────────────────────────────
    adjacency = build_adjacency(node_positions, room_names, cj_pixel_coords, sk)

    return {
        "NODE_POSITIONS": node_positions,
        "NODE_ADJACENCY": adjacency,
        "MEETING_POINTS": meeting_points,
        "metadata": {
            "rooms_total":        len(rooms),
            "meeting_rooms":      len(meeting_points),
            "regular_rooms":      len(regular_rooms),
            "corridor_junctions": len(cj_pts),
            "total_nodes":        len(node_positions),
            "total_edges":        sum(len(v) for v in adjacency.values()) // 2,
        }
    }


def draw_result(img, result):
    """Draws only node names on the image for visualization."""
    pos = result["NODE_POSITIONS"]

    for name, d in pos.items():
        # Only label Rooms and Meeting Points (skip hidden/internal nodes if any)
        if name.startswith("P_") or name.startswith("CH_") or name.startswith("CV_"):
            continue

        px = int(d["x"]/100*TARGET_W)
        py = int(d["y"]/100*TARGET_H)
        
        # Premium Label styling
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 0.45
        thickness = 1
        (label_w, label_h), baseline = cv2.getTextSize(name, font, scale, thickness)
        
        # Center the label on the coordinate
        lx, ly = px - (label_w // 2), py + (label_h // 2)
        
        # Draw small background for text readability (subtle grey/white box)
        cv2.rectangle(img, (lx-2, ly-label_h-2), (lx+label_w+2, ly+2), (255,255,255), -1)
        cv2.putText(img, name, (lx, ly), font, scale, (20,20,20), thickness)

    return img


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/upload-floorplan', methods=['POST'])
def upload_floorplan():
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image file provided'}), 400

        file = request.files['image']
        if not file.filename or not allowed_file(file.filename):
            return jsonify({'error': 'Invalid or missing file'}), 400

        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        try:
            result = process_floor_plan(filepath)
            
            # ── Draw labels on the map ──────────────────────────────────────
            img_to_draw = load_image(filepath)
            labeled_img = draw_result(img_to_draw, result)
            
            # Convert to base64
            _, buffer = cv2.imencode('.png', labeled_img)
            img_base64 = base64.b64encode(buffer).decode('utf-8')
            
        finally:
            if os.path.exists(filepath):
                os.remove(filepath)

        m = result["metadata"]
        return jsonify({
            'success': True,
            'graph':   result,
            'labeled_image': f"data:image/png;base64,{img_base64}",
            'message': (
                f"Detected {m['rooms_total']} rooms "
                f"({m['meeting_rooms']} meeting + {m['regular_rooms']} regular) "
                f"and {m['corridor_junctions']} corridor junctions. "
                f"Total {m['total_nodes']} nodes, {m['total_edges']} edges."
            )
        })

    except ValueError as e:
        return jsonify({'error': str(e), 'success': False}), 422
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e), 'success': False}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'node_naming': {
            'meeting_rooms':      'M1, M2, M3, M4  (4 largest rooms)',
            'regular_rooms':      '1, 2, 3 …        (reading order)',
            'corridor_junctions': 'CJ_1, CJ_2 …    (as many as detected)',
        }
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=False, port=port, host='0.0.0.0')