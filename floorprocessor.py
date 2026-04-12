"""
floorprocessor.py  —  Standalone floor plan processor (matches app.py exactly).

Usage:
    python3 floorprocessor.py your_floor_plan.png
    python3 floorprocessor.py  (runs on 4 built-in test images)

Outputs:
    <name>_result.png  — visual debug overlay
    <name>_graph.json  — graph JSON ready to paste into dashboard or DB seed

Node naming (same for every floor plan):
    M1, M2, M3, M4   — 4 largest rooms  (meeting / assembly points)
    1, 2, 3 …         — regular rooms    (reading order: top→bottom, left→right)
    CJ_1, CJ_2 …      — corridor junctions (as many as detected)
"""

import cv2
import numpy as np
from skimage.morphology import skeletonize
from collections import deque
import json
import sys
import os
import math

# ── Constants (must match app.py exactly) ────────────────────────────────────
TARGET_W          = 900
TARGET_H          = 700
WALKABLE_MIN_GRAY = 150
ROOM_DIST_RATIO   = 0.20
MIN_ROOM_PX       = 300
NUM_MEETING       = 4
MIN_CJ_DIST       = 22
MAX_BFS_STEPS     = 800


def load_image(path):
    img = cv2.imread(path)
    if img is None:
        raise FileNotFoundError(f"Cannot read: {path}")
    return cv2.resize(img, (TARGET_W, TARGET_H), interpolation=cv2.INTER_AREA)


def walkable_mask(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = (gray > WALKABLE_MIN_GRAY).astype(np.uint8) * 255
    k2 = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k2, iterations=1)
    return mask


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
            continue
        if bw > TARGET_W * 0.9 or bh > TARGET_H * 0.9:
            continue
        rooms.append({
            "cx_px": float(centroids[i][0]),
            "cy_px": float(centroids[i][1]),
            "area": area, "bw": bw, "bh": bh,
        })
    return rooms, dist


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
            nb = (int(sk[y-1,x-1]>0)+int(sk[y-1,x]>0)+int(sk[y-1,x+1]>0)+
                  int(sk[y,  x-1]>0)+                   int(sk[y,  x+1]>0)+
                  int(sk[y+1,x-1]>0)+int(sk[y+1,x]>0)+int(sk[y+1,x+1]>0))
            if nb >= 3:
                pts.append((x, y))
    return pts


def cluster_points(pts, radius):
    if not pts:
        return []
    used, merged = [False]*len(pts), []
    for i, p in enumerate(pts):
        if used[i]:
            continue
        cluster = [p]; used[i] = True
        for j in range(i+1, len(pts)):
            if not used[j] and math.hypot(p[0]-pts[j][0], p[1]-pts[j][1]) < radius:
                cluster.append(pts[j]); used[j] = True
        merged.append((int(sum(c[0] for c in cluster)/len(cluster)),
                       int(sum(c[1] for c in cluster)/len(cluster))))
    return merged


def bfs_connected(sk, start, goal, max_steps=MAX_BFS_STEPS, gap=6):
    if math.hypot(start[0]-goal[0], start[1]-goal[1]) > 300:
        return False
    h, w = sk.shape
    visited = {start}
    queue = deque([start])
    steps = 0
    while queue and steps < max_steps:
        cx, cy = queue.popleft(); steps += 1
        if abs(cx-goal[0]) <= gap and abs(cy-goal[1]) <= gap:
            return True
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                nx, ny = cx+dx, cy+dy
                if 0<=nx<w and 0<=ny<h and (nx,ny) not in visited and sk[ny,nx]>0:
                    visited.add((nx,ny)); queue.append((nx,ny))
    return False


def build_adjacency(node_positions, room_names, cj_pixel_coords, sk):
    adj = {n: [] for n in node_positions}
    for r_name in room_names:
        if not cj_pixel_coords:
            continue
        d  = node_positions[r_name]
        rx = d["x"] / 100 * TARGET_W
        ry = d["y"] / 100 * TARGET_H
        best_name, best_dist = None, float('inf')
        for cj_name, (px, py) in cj_pixel_coords.items():
            dist = math.hypot(rx-px, ry-py)
            if dist < best_dist:
                best_dist, best_name = dist, cj_name
        if best_name:
            if best_name not in adj[r_name]: adj[r_name].append(best_name)
            if r_name not in adj[best_name]: adj[best_name].append(r_name)

    cj_list = list(cj_pixel_coords.items())
    for i in range(len(cj_list)):
        for j in range(i+1, len(cj_list)):
            n1, p1 = cj_list[i]
            n2, p2 = cj_list[j]
            if bfs_connected(sk, p1, p2):
                if n2 not in adj[n1]: adj[n1].append(n2)
                if n1 not in adj[n2]: adj[n2].append(n1)
    return {k: v for k, v in adj.items() if v}


def pct(px, py):
    return round(px/TARGET_W*100, 1), round(py/TARGET_H*100, 1)


def process_floor_plan(image_path: str) -> dict:
    """Full pipeline. Returns graph dict identical to app.py /upload-floorplan response."""
    img  = load_image(image_path)
    mask = walkable_mask(img)
    rooms, dist_map = detect_rooms(mask)

    if not rooms:
        raise ValueError("No rooms detected — ensure light floors and dark walls")

    room_threshold = dist_map.max() * ROOM_DIST_RATIO
    rooms.sort(key=lambda r: r["area"], reverse=True)
    meeting_rooms = rooms[:NUM_MEETING]
    regular_rooms = rooms[NUM_MEETING:]
    regular_rooms.sort(key=lambda r: (int(r["cy_px"]//80), int(r["cx_px"]//80)))

    node_positions, room_names, meeting_points = {}, [], []

    for i, r in enumerate(meeting_rooms, 1):
        name = f"M{i}"
        meeting_points.append(name); room_names.append(name)
        x, y = pct(r["cx_px"], r["cy_px"])
        node_positions[name] = {"x": x, "y": y}

    for i, r in enumerate(regular_rooms, 1):
        name = str(i)
        room_names.append(name)
        x, y = pct(r["cx_px"], r["cy_px"])
        node_positions[name] = {"x": x, "y": y}

    sk            = corridor_skeleton(mask, dist_map, room_threshold)
    raw_junctions = skeleton_junctions(sk)
    clustered     = cluster_points(raw_junctions, MIN_CJ_DIST)

    def in_any_room(px, py):
        return any(math.hypot(px-r["cx_px"], py-r["cy_px"]) < 50 for r in rooms)

    cj_pts = [(px, py) for (px, py) in clustered if not in_any_room(px, py)]
    cj_pts.sort(key=lambda p: (int(p[1]//60), int(p[0]//60)))

    cj_pixel_coords = {}
    for i, (px, py) in enumerate(cj_pts, 1):
        name = f"CJ_{i}"
        cj_pixel_coords[name] = (px, py)
        x, y = pct(px, py)
        node_positions[name] = {"x": x, "y": y}

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
            "total_edges":        sum(len(v) for v in adjacency.values())//2,
        }
    }


def draw_result(image_path, result, out_path=None):
    img = load_image(image_path)
    pos = result["NODE_POSITIONS"]
    adj = result["NODE_ADJACENCY"]

    drawn = set()
    for n, neighbours in adj.items():
        if n not in pos: continue
        x1 = int(pos[n]["x"]/100*TARGET_W)
        y1 = int(pos[n]["y"]/100*TARGET_H)
        for nb in neighbours:
            if nb not in pos or (n,nb) in drawn or (nb,n) in drawn: continue
            drawn.add((n,nb))
            x2 = int(pos[nb]["x"]/100*TARGET_W)
            y2 = int(pos[nb]["y"]/100*TARGET_H)
            cv2.line(img, (x1,y1), (x2,y2), (80,200,80), 2)

    for name, d in pos.items():
        px = int(d["x"]/100*TARGET_W)
        py = int(d["y"]/100*TARGET_H)
        if name.startswith("M"):
            col, r, t = (0,200,80), 13, 2
        elif name.startswith("CJ"):
            col, r, t = (40,140,255), 6, -1
        else:
            col, r, t = (220,60,60), 9, -1
        cv2.circle(img, (px,py), r, col, t)
        cv2.putText(img, name, (px+8, py-4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, (20,20,20), 1)

    for i, (lbl, col) in enumerate([
        ("m1-m4  Meeting/Assembly room",  (0,200,80)),
        ("1,2,3… Regular guest room",      (220,60,60)),
        ("CJ_N   Corridor junction",       (40,140,255)),
    ]):
        cv2.circle(img, (20, 20+i*22), 6, col, -1)
        cv2.putText(img, lbl, (32, 25+i*22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (20,20,20), 1)

    out = out_path or image_path.replace(".png","_result.png")
    cv2.imwrite(out, img)
    return out


if __name__ == "__main__":
    targets = sys.argv[1:] or [
        "test_hotel.png", "test_office.png",
        "test_complex.png", "test_grid.png"
    ]

    for path in targets:
        if not os.path.exists(path):
            print(f"⚠  Skipping {path}"); continue

        print(f"\n📐  {path}")
        try:
            result = process_floor_plan(path)
            m = result["metadata"]
            print(f"   Rooms     : {m['rooms_total']}  "
                  f"(m1-m{m['meeting_rooms']} meeting, {m['regular_rooms']} regular)")
            print(f"   Junctions : {m['corridor_junctions']}  (CJ_1 … CJ_{m['corridor_junctions']})")
            print(f"   Nodes     : {m['total_nodes']}    Edges: {m['total_edges']}")
            print(f"   Meeting pts: {result['MEETING_POINTS']}")

            # Save visual
            out_img = draw_result(path, result)
            print(f"   Visual    : {out_img}")

            # Save JSON
            out_json = path.replace(".png", "_graph.json")
            with open(out_json, "w") as f:
                json.dump(result, f, indent=2)
            print(f"   JSON      : {out_json}")

            # Print node list for DB seeding
            print(f"\n   ── Node list for DB seeding ──")
            rooms  = [n for n in result["NODE_POSITIONS"] if not n.startswith("CJ_") and n not in result["MEETING_POINTS"]]
            cjs    = [n for n in result["NODE_POSITIONS"] if n.startswith("CJ_")]
            print(f"   Meeting : {result['MEETING_POINTS']}")
            print(f"   Rooms   : {sorted(rooms, key=lambda x: int(x))}")
            print(f"   CJ nodes: {cjs}")

        except Exception as e:
            print(f"   ❌ Error: {e}")
            import traceback; traceback.print_exc()

    print("\n✅ Done. Use the _graph.json files to seed your MongoDB.")