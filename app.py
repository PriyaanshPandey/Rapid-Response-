from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
from skimage.morphology import skeletonize
import os
from collections import deque
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'bmp', 'webp'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

class DynamicFloorPlanProcessor:
    """
    Strategy:
      1. Detect walkable pixels via thresholding.
      2. Distance Transform to evaluate room/space sizes.
      3. Skeletonize corridors.
      4. Detect junctions (corridor intercepts) and endpoints (rooms).
      5. Cluster nearby points.
      6. Sort endpoint clusters by Distance Transform size.
      7. Top 4 biggest = m1, m2, m3, m4. Rest = 1, 2, 3...
      8. Trace skeleton using BFS to automatically generate true graph adjacency.
    """

    def __init__(self, target_w=900, target_h=700):
        self.target_w = target_w
        self.target_h = target_h
        self.img = None
        self.skeleton = None
        self.dist_transform = None
        self.h = self.w = 0

    def load(self, path):
        img = cv2.imread(path)
        if img is None:
            raise ValueError(f"Cannot read {path}")
        self.img = cv2.resize(img, (self.target_w, self.target_h))
        self.h, self.w = self.img.shape[:2]
        return self

    def _walkable_mask(self):
        gray = cv2.cvtColor(self.img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        _, th = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        white_ratio = np.sum(th == 255) / th.size
        if white_ratio < 0.4:
            th = cv2.bitwise_not(th)

        # Auto-Cropping to kill the infinite "white space arrays" outside the walls
        walls = cv2.bitwise_not(th)
        coords = cv2.findNonZero(walls)
        if coords is not None:
            x, y, w, h = cv2.boundingRect(coords)
            margin = 10
            x1, y1 = max(0, x - margin), max(0, y - margin)
            x2, y2 = min(self.w, x + w + margin), min(self.h, y + h + margin)
            
            cleaned_th = np.zeros_like(th)
            cleaned_th[y1:y2, x1:x2] = th[y1:y2, x1:x2]
            th = cleaned_th
            
            cv2.rectangle(th, (x1, y1), (x2-1, y2-1), 0, margin*2)

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=2)
        th = cv2.morphologyEx(th, cv2.MORPH_OPEN,  kernel, iterations=1)
        return th

    def compute_distance_transform(self, mask):
        self.dist_transform = cv2.distanceTransform(mask, cv2.DIST_L2, 5)

    def skeletonise(self, mask):
        bin01 = (mask > 0).astype(np.uint8)
        skel = skeletonize(bin01).astype(np.uint8) * 255
        
        # Pruning tiny jagged branch nodes (Weird CJs) while saving fat room nodes
        max_dist = np.max(self.dist_transform) if self.dist_transform is not None else 1
        prune_thresh = max_dist * 0.3  # Room branches are fat, noise branches are thin

        for _ in range(15):
            endpoints = []
            h, w = skel.shape
            for y in range(1, h - 1):
                for x in range(1, w - 1):
                    if skel[y, x] > 0:
                        nb = int(skel[y-1,x-1]>0)+int(skel[y-1,x]>0)+int(skel[y-1,x+1]>0)+ \
                             int(skel[y,  x-1]>0)+                   int(skel[y,  x+1]>0)+ \
                             int(skel[y+1,x-1]>0)+int(skel[y+1,x]>0)+int(skel[y+1,x+1]>0)
                        if nb == 1:
                            endpoints.append((x, y))
            if not endpoints:
                break
            for x, y in endpoints:
                if self.dist_transform[y, x] < prune_thresh:
                    skel[y, x] = 0
                    
        self.skeleton = skel

    def _skeleton_special_pixels(self):
        sk = self.skeleton
        h, w = sk.shape
        junctions, endpoints = [], []
        for y in range(1, h - 1):
            for x in range(1, w - 1):
                if sk[y, x] == 0:
                    continue
                nb = int(sk[y-1,x-1]>0)+int(sk[y-1,x]>0)+int(sk[y-1,x+1]>0)+ \
                     int(sk[y,  x-1]>0)+                   int(sk[y,  x+1]>0)+ \
                     int(sk[y+1,x-1]>0)+int(sk[y+1,x]>0)+int(sk[y+1,x+1]>0)
                if nb >= 3:
                    junctions.append((x, y))
                elif nb == 1:
                    endpoints.append((x, y))
        return junctions, endpoints

    @staticmethod
    def _cluster(points, radius):
        if not points:
            return []
        pts = list(points)
        merged, used = [], [False] * len(pts)
        for i, p in enumerate(pts):
            if used[i]:
                continue
            cluster = [p]
            used[i] = True
            for j in range(i + 1, len(pts)):
                if used[j]:
                    continue
                if abs(p[0]-pts[j][0]) + abs(p[1]-pts[j][1]) < radius:
                    cluster.append(pts[j])
                    used[j] = True
            cx = int(sum(c[0] for c in cluster) / len(cluster))
            cy = int(sum(c[1] for c in cluster) / len(cluster))
            merged.append((cx, cy))
        return merged

    def _pct(self, x, y):
        return round(x / self.w * 100, 2), round(y / self.h * 100, 2)

    def trace_adjacency(self, nodes_dict):
        adjacency = {k: [] for k in nodes_dict.keys()}
        pixel_to_node = {}
        for nid, dat in nodes_dict.items():
            cx, cy = dat['x_px'], dat['y_px']
            for dy in range(-6, 7):
                for dx in range(-6, 7):
                    if dx*dx + dy*dy <= 36:
                        pixel_to_node[(cx+dx, cy+dy)] = nid
                        
        h, w = self.skeleton.shape
        
        for start_id, start_dat in nodes_dict.items():
            sx, sy = start_dat['x_px'], start_dat['y_px']
            visited = set()
            queue = deque([(sx, sy)])
            visited.add((sx, sy))
            
            found_neighbors = set()
            while queue:
                cx, cy = queue.popleft()
                
                if (cx, cy) in pixel_to_node:
                    reached_id = pixel_to_node[(cx, cy)]
                    if reached_id != start_id:
                        found_neighbors.add(reached_id)
                        continue
                
                for dx, dy in [(-1,0), (1,0), (0,-1), (0,1), (-1,-1), (-1,1), (1,-1), (1,1)]:
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        if self.skeleton[ny, nx] > 0 and (nx, ny) not in visited:
                            visited.add((nx, ny))
                            queue.append((nx, ny))
                            
            adjacency[start_id] = list(found_neighbors)
            
        # Ensure bidirectional
        for u in adjacency:
            for v in adjacency[u]:
                if u not in adjacency[v]:
                    adjacency[v].append(u)
                    
        return adjacency

    def _find_local_maxima(self, dist_map, threshold_ratio=0.5):
        # Dilate to find local peaks
        kernel = np.ones((7,7), np.uint8)
        local_max = cv2.dilate(dist_map, kernel) == dist_map
        # Filter by intensity to avoid noise in thin corridors
        peaks = (local_max & (dist_map > (np.max(dist_map) * threshold_ratio)))
        
        coords = np.column_stack(np.where(peaks))
        pts = [(int(c[1]), int(c[0])) for c in coords]
        return self._cluster(pts, 30)

    def process(self):
        mask = self._walkable_mask()
        self.compute_distance_transform(mask)
        self.skeletonise(mask)

        # 1. Use Local Maxima to find the "heart" of rooms/spaces
        # This is much more robust than skeleton endpoints
        room_peaks = self._find_local_maxima(self.dist_transform, 0.45)
        
        # 2. Find junctions for corridor connectivity
        raw_junctions, _ = self._skeleton_special_pixels()
        junctions = self._cluster(raw_junctions, 25)

        # Sort room peaks by their "thickness" (distance to wall) to find the biggest ones
        room_data = []
        for px, py in room_peaks:
            size = self.dist_transform[py, px]
            room_data.append((size, px, py))
        
        room_data.sort(key=lambda item: item[0], reverse=True)

        internal_nodes = {}
        node_positions = {}

        # Name the 4 biggest spaces m1, m2, m3, m4
        for i in range(min(4, len(room_data))):
            name = f"m{i+1}"
            _, px, py = room_data[i]
            x_pct, y_pct = self._pct(px, py)
            node_positions[name] = {"x": x_pct, "y": y_pct}
            internal_nodes[name] = {"x_px": px, "y_px": py}

        # Name remaining rooms 1, 2, 3...
        room_counter = 1
        for i in range(4, len(room_data)):
            name = str(room_counter)
            room_counter += 1
            _, px, py = room_data[i]
            x_pct, y_pct = self._pct(px, py)
            node_positions[name] = {"x": x_pct, "y": y_pct}
            internal_nodes[name] = {"x_px": px, "y_px": py}

        # Name junctions CJ_1, CJ_2...
        for i, (px, py) in enumerate(junctions):
            name = f"CJ_{i+1}"
            x_pct, y_pct = self._pct(px, py)
            node_positions[name] = {"x": x_pct, "y": y_pct}
            internal_nodes[name] = {"x_px": px, "y_px": py}

        # Crucial: Ensure the found room centers are "snapped" to the skeleton 
        # so trace_adjacency can find paths to them.
        for nid in internal_nodes:
            cx, cy = internal_nodes[nid]['x_px'], internal_nodes[nid]['y_px']
            # Find closest skeleton pixel
            skel_pixels = np.column_stack(np.where(self.skeleton > 0))
            if skel_pixels.size > 0:
                dists = np.sum((skel_pixels - [cy, cx])**2, axis=1)
                closest_idx = np.argmin(dists)
                target_y, target_x = skel_pixels[closest_idx]
                
                # Draw a line in skeleton from room peak to skeleton line to bridge gaps
                cv2.line(self.skeleton, (cx, cy), (int(target_x), int(target_y)), 255, 1)

        adjacency = self.trace_adjacency(internal_nodes)

        return {
            "NODE_POSITIONS": node_positions,
            "NODE_ADJACENCY": adjacency,
            "metadata": {
                "total_nodes": len(node_positions),
                "total_edges": sum(len(v) for v in adjacency.values()) // 2,
                "detected_rooms": len(room_peaks),
                "detected_junctions": len(junctions),
                "strategy": "robust-local-maxima"
            }
        }



# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@app.route('/upload-floorplan', methods=['POST'])
def upload_floorplan():
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image file'}), 400

        file = request.files['image']
        if not file.filename or not allowed_file(file.filename):
            return jsonify({'error': 'Invalid file type'}), 400

        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        proc = DynamicFloorPlanProcessor()
        result = proc.load(filepath).process()

        os.remove(filepath)

        return jsonify({
            'success': True,
            'graph': result,
            'message': (
                f"Mapped {result['metadata']['total_nodes']} dynamic nodes "
                f"({result['metadata']['detected_junctions']} junctions + "
                f"{result['metadata']['detected_rooms']} rooms detected)"
            )
        })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'strategy': 'dynamic-room-sizing'})


if __name__ == '__main__':
    print("🚀 Floor Plan Upload Server — canonical-template-mapping strategy")
    print("📍 http://localhost:5001")
    print("   Node names are ALWAYS the same. Only positions update.")
    app.run(debug=True, port=5001, host='0.0.0.0')