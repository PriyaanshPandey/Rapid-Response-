"""
Enhanced Floor Plan Processor with Intelligent Junction Detection
Handles complex layouts with robust graph simplification
"""

import cv2
import numpy as np
from skimage.morphology import skeletonize, remove_small_objects
from collections import deque
import json
import sys
import os
import math
from scipy.spatial import KDTree
from sklearn.cluster import DBSCAN
from dataclasses import dataclass
from typing import List, Tuple, Dict, Set, Optional
from enum import Enum

# ── Constants ────────────────────────────────────────────────────────────────
TARGET_W          = 900
TARGET_H          = 700
WALKABLE_MIN_GRAY = 150
ROOM_DIST_RATIO   = 0.20
MIN_ROOM_PX       = 300
NUM_MEETING       = 4

# New enhanced parameters
MIN_CURVATURE_ANGLE = 30  # degrees - minimum angle for turn detection
MAX_STRAIGHT_DEVIATION = 5  # pixels - max deviation from straight line
CORRIDOR_WIDTH_RATIO = 0.15  # relative to max distance transform
MIN_JUNCTION_DISTANCE = 35  # pixels - increased from 22
BRANCH_LENGTH_THRESHOLD = 15  # pixels - remove short noisy branches
CLUSTERING_EPS = 0.15  # DBSCAN epsilon (relative to image size)
MIN_SAMPLES = 1

class NodeType(Enum):
    INTERSECTION = "intersection"  # T or + junctions
    CORNER = "corner"  # L bends and turns
    DOORWAY = "doorway"  # room connection points
    LINEAR = "linear"  # straight corridor points (to be removed)

@dataclass
class SkeletonNode:
    pos: Tuple[int, int]
    degree: int
    node_type: Optional[NodeType] = None
    branches: List[List[Tuple[int, int]]] = None
    angle: Optional[float] = None

class EnhancedFloorProcessor:
    def __init__(self):
        self.debug_images = {}
        
    def load_image(self, path):
        img = cv2.imread(path)
        if img is None:
            raise FileNotFoundError(f"Cannot read: {path}")
        return cv2.resize(img, (TARGET_W, TARGET_H), interpolation=cv2.INTER_AREA)

    def walkable_mask(self, img):
        """Enhanced walkable area detection with adaptive thresholding"""
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Adaptive thresholding for varying lighting conditions
        binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, 11, 2)
        
        # Combine with simple threshold
        simple_mask = (gray > WALKABLE_MIN_GRAY).astype(np.uint8) * 255
        mask = cv2.bitwise_or(binary, simple_mask)
        
        # Morphological cleaning
        k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k_close, iterations=1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k_open, iterations=1)
        
        return mask

    def detect_rooms(self, mask):
        """Room detection with improved separation"""
        dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
        
        # Dynamic threshold based on distance distribution
        dist_flat = dist[dist > 0]
        if len(dist_flat) > 0:
            otsu_thresh = np.percentile(dist_flat, 70)
            threshold = min(dist.max() * ROOM_DIST_RATIO, otsu_thresh)
        else:
            threshold = dist.max() * ROOM_DIST_RATIO
            
        sure_fg = (dist > threshold).astype(np.uint8) * 255
        
        # Watershed for better room separation
        kernel = np.ones((3,3), np.uint8)
        sure_fg = cv2.erode(sure_fg, kernel, iterations=2)
        
        n, labels, stats, centroids = cv2.connectedComponentsWithStats(sure_fg, 8)
        
        rooms = []
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            
            # Filter valid rooms
            if area < MIN_ROOM_PX:
                continue
            if bw > TARGET_W * 0.9 or bh > TARGET_H * 0.9:
                continue
                
            rooms.append({
                "cx_px": float(centroids[i][0]),
                "cy_px": float(centroids[i][1]),
                "area": area,
                "bw": bw,
                "bh": bh,
                "label": i
            })
            
        return rooms, dist, threshold

    def extract_corridor_mask(self, mask, dist_map, room_threshold):
        """Extract corridor mask with width information"""
        # Initial corridor mask (non-room areas)
        corridor_mask = ((dist_map <= room_threshold) & (mask > 0)).astype(np.uint8) * 255
        
        # Calculate local corridor width
        width_map = np.zeros_like(dist_map)
        for y in range(dist_map.shape[0]):
            for x in range(dist_map.shape[1]):
                if corridor_mask[y, x] > 0:
                    # Distance to nearest wall approximates half-width
                    width_map[y, x] = dist_map[y, x]
        
        # Filter out open areas (width > threshold)
        width_threshold = dist_map.max() * CORRIDOR_WIDTH_RATIO
        corridor_mask = ((width_map <= width_threshold) & (corridor_mask > 0)).astype(np.uint8) * 255
        
        # Clean and connect corridors
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        corridor_mask = cv2.morphologyEx(corridor_mask, cv2.MORPH_CLOSE, k, iterations=3)
        corridor_mask = cv2.morphologyEx(corridor_mask, cv2.MORPH_OPEN, k, iterations=1)
        corridor_mask = cv2.bitwise_and(corridor_mask, mask)
        
        return corridor_mask

    def enhanced_skeleton(self, corridor_mask):
        """Extract skeleton with pruning of short branches"""
        bin01 = (corridor_mask > 0).astype(np.uint8)
        skeleton = skeletonize(bin01).astype(np.uint8) * 255
        
        # Remove small branches
        # Label skeleton branches
        labeled, num_features = cv2.connectedComponents(skeleton)
        
        # Calculate branch lengths
        branch_lengths = {}
        for i in range(1, num_features + 1):
            branch_lengths[i] = np.sum(labeled == i)
        
        # Keep only branches above threshold
        filtered_skeleton = np.zeros_like(skeleton)
        for i in range(1, num_features + 1):
            if branch_lengths[i] >= BRANCH_LENGTH_THRESHOLD:
                filtered_skeleton[labeled == i] = 255
                
        return filtered_skeleton

    def analyze_skeleton_nodes(self, skeleton):
        """Analyze skeleton to find true decision points"""
        h, w = skeleton.shape
        nodes = []
        
        # First pass: find all potential nodes
        for y in range(2, h - 2):
            for x in range(2, w - 2):
                if skeleton[y, x] == 0:
                    continue
                    
                # Count neighbors in 8-connectivity
                nb = 0
                neighbor_positions = []
                for dy in [-1, 0, 1]:
                    for dx in [-1, 0, 1]:
                        if dx == 0 and dy == 0:
                            continue
                        if skeleton[y + dy, x + dx] > 0:
                            nb += 1
                            neighbor_positions.append((x + dx, y + dy))
                
                if nb >= 3:  # Potential junction
                    # Trace branches to determine if it's a real junction
                    branches = self.trace_branches(skeleton, (x, y), neighbor_positions)
                    
                    # Calculate branch angles
                    angles = self.calculate_branch_angles(branches, (x, y))
                    
                    # Determine node type
                    node_type = self.classify_node_type(nb, angles, branches)
                    
                    nodes.append(SkeletonNode(
                        pos=(x, y),
                        degree=nb,
                        node_type=node_type,
                        branches=branches,
                        angle=np.mean(angles) if angles else None
                    ))
        
        return nodes

    def trace_branches(self, skeleton, start_pos, neighbor_positions):
        """Trace each branch from a junction to find its path"""
        branches = []
        h, w = skeleton.shape
        
        for neighbor in neighbor_positions:
            branch = [start_pos, neighbor]
            current = neighbor
            previous = start_pos
            
            # Trace until hitting another junction or end
            while True:
                # Find next pixel (excluding previous)
                next_pixels = []
                for dy in [-1, 0, 1]:
                    for dx in [-1, 0, 1]:
                        if dx == 0 and dy == 0:
                            continue
                        nx, ny = current[0] + dx, current[1] + dy
                        if (nx, ny) == previous:
                            continue
                        if 0 <= nx < w and 0 <= ny < h and skeleton[ny, nx] > 0:
                            next_pixels.append((nx, ny))
                
                if len(next_pixels) == 0:  # End of branch
                    break
                elif len(next_pixels) == 1:  # Continue straight
                    previous = current
                    current = next_pixels[0]
                    branch.append(current)
                else:  # Hit another junction
                    branch.append(next_pixels[0])  # Add first branch
                    break
            
            branches.append(branch)
        
        return branches

    def calculate_branch_angles(self, branches, junction_pos):
        """Calculate the angle of each branch leaving the junction"""
        angles = []
        jx, jy = junction_pos
        
        for branch in branches:
            if len(branch) < 2:
                continue
            # Get direction vector (first few points for stability)
            px, py = branch[1]
            dx = px - jx
            dy = py - jy
            angle = math.atan2(dy, dx) * 180 / math.pi
            angles.append(angle)
        
        return angles

    def classify_node_type(self, degree, angles, branches):
        """Classify the type of skeleton node"""
        if degree >= 4:
            return NodeType.INTERSECTION
        
        elif degree == 3:
            # Check if it's a T-junction or Y-junction
            if angles:
                # Calculate angular spread
                sorted_angles = sorted(angles)
                gaps = []
                for i in range(len(sorted_angles)):
                    gap = sorted_angles[(i + 1) % len(sorted_angles)] - sorted_angles[i]
                    if gap < 0:
                        gap += 360
                    gaps.append(gap)
                
                # T-junction typically has one gap > 150 degrees
                if max(gaps) > 150:
                    return NodeType.INTERSECTION
                else:
                    return NodeType.CORNER
            return NodeType.INTERSECTION
        
        else:  # degree == 2
            # Check if it's a corner (direction change) or straight line
            if len(branches) >= 2 and len(branches[0]) >= 3 and len(branches[1]) >= 3:
                # Get direction before and after
                vec1 = (branches[0][1][0] - branches[0][0][0],
                       branches[0][1][1] - branches[0][0][1])
                vec2 = (branches[1][1][0] - branches[1][0][0],
                       branches[1][1][1] - branches[1][0][1])
                
                # Calculate angle change
                dot = vec1[0]*vec2[0] + vec1[1]*vec2[1]
                det = vec1[0]*vec2[1] - vec1[1]*vec2[0]
                angle_change = abs(math.atan2(det, dot) * 180 / math.pi)
                
                if angle_change > MIN_CURVATURE_ANGLE:
                    return NodeType.CORNER
                else:
                    return NodeType.LINEAR
            return NodeType.LINEAR

    def adaptive_clustering(self, nodes, image_shape):
        """Cluster nearby nodes using DBSCAN"""
        if not nodes:
            return []
        
        # Extract positions
        positions = np.array([node.pos for node in nodes])
        
        # Adaptive epsilon based on image size
        eps = min(image_shape) * CLUSTERING_EPS
        
        # DBSCAN clustering
        clustering = DBSCAN(eps=eps, min_samples=MIN_SAMPLES).fit(positions)
        
        # Merge nodes in same cluster
        merged_nodes = []
        unique_labels = set(clustering.labels_)
        
        for label in unique_labels:
            if label == -1:  # Noise points (keep as is)
                cluster_indices = [i for i, l in enumerate(clustering.labels_) if l == label]
                for idx in cluster_indices:
                    merged_nodes.append(nodes[idx])
            else:
                cluster_indices = [i for i, l in enumerate(clustering.labels_) if l == label]
                if len(cluster_indices) > 1:
                    # Merge cluster: take average position, keep highest degree node
                    cluster_nodes = [nodes[i] for i in cluster_indices]
                    avg_x = int(np.mean([n.pos[0] for n in cluster_nodes]))
                    avg_y = int(np.mean([n.pos[1] for n in cluster_nodes]))
                    
                    # Keep node with highest degree (most connections)
                    best_node = max(cluster_nodes, key=lambda n: n.degree)
                    best_node.pos = (avg_x, avg_y)
                    merged_nodes.append(best_node)
                else:
                    merged_nodes.append(nodes[cluster_indices[0]])
        
        return merged_nodes

    def filter_nodes_by_corridor_width(self, nodes, corridor_mask, dist_map):
        """Remove nodes that are in wide areas (open spaces)"""
        filtered_nodes = []
        
        for node in nodes:
            x, y = node.pos
            if 0 <= x < corridor_mask.shape[1] and 0 <= y < corridor_mask.shape[0]:
                # Check corridor width at this point
                width = dist_map[y, x]
                max_width = dist_map.max()
                
                # Remove if in open area
                if width > max_width * CORRIDOR_WIDTH_RATIO:
                    continue
                filtered_nodes.append(node)
        
        return filtered_nodes

    def filter_linear_nodes(self, nodes):
        """Remove nodes classified as LINEAR (straight line points)"""
        return [node for node in nodes if node.node_type != NodeType.LINEAR]

    def simplify_graph(self, nodes, skeleton):
        """Simplify graph by merging linear chains and keeping only key nodes"""
        if not nodes:
            return nodes
        
        # Build adjacency between nodes along skeleton
        node_positions = {node.pos: node for node in nodes}
        
        # For each node, find paths to other nodes
        simplified_nodes = []
        processed = set()
        
        for start_node in nodes:
            if start_node.pos in processed:
                continue
            
            # Start a new chain
            chain = [start_node]
            processed.add(start_node.pos)
            
            # Trace in both directions
            for direction in range(2):  # Forward and backward
                current = start_node
                while True:
                    # Find next node along skeleton (excluding previous)
                    next_node = self.find_next_node(current, chain[-1] if len(chain) > 1 else None, nodes, skeleton)
                    if not next_node or next_node.pos in processed:
                        break
                    
                    chain.append(next_node)
                    processed.add(next_node.pos)
                    current = next_node
            
            # Keep only endpoints (degree != 2) and corners
            if len(chain) > 0:
                # Keep first and last if they're not linear
                keep_nodes = []
                for node in chain:
                    if node.node_type != NodeType.LINEAR:
                        keep_nodes.append(node)
                
                # If only linear nodes, keep the middle one
                if not keep_nodes and len(chain) > 0:
                    keep_nodes = [chain[len(chain)//2]]
                
                simplified_nodes.extend(keep_nodes)
        
        return simplified_nodes

    def find_next_node(self, current_node, previous_node, all_nodes, skeleton):
        """Find the next node along the skeleton path"""
        h, w = skeleton.shape
        
        # BFS to find nearest node
        visited = set([current_node.pos])
        queue = deque([(current_node.pos[0], current_node.pos[1], 0)])
        
        while queue:
            x, y, dist = queue.popleft()
            
            # Check if we've reached another node
            for node in all_nodes:
                if node.pos != current_node.pos and abs(node.pos[0] - x) + abs(node.pos[1] - y) <= 2:
                    return node
            
            if dist > 100:  # Limit search distance
                return None
            
            # Explore neighbors
            for dx, dy in [(-1,0), (1,0), (0,-1), (0,1), (-1,-1), (-1,1), (1,-1), (1,1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited:
                    if skeleton[ny, nx] > 0:
                        visited.add((nx, ny))
                        queue.append((nx, ny, dist + 1))
        
        return None

    def connect_rooms_to_corridor(self, rooms, corridor_nodes, skeleton):
        """Connect rooms only to nearest corridor node, not to graph"""
        connections = []
        
        for room in rooms:
            rx, ry = room["cx_px"], room["cy_px"]
            
            # Find nearest corridor node
            best_node = None
            best_dist = float('inf')
            
            for node in corridor_nodes:
                nx, ny = node.pos
                dist = math.hypot(rx - nx, ry - ny)
                
                # Check if there's a clear path
                if dist < best_dist and self.has_clear_path(skeleton, (int(rx), int(ry)), (nx, ny)):
                    best_dist = dist
                    best_node = node
            
            if best_node:
                connections.append((room, best_node))
        
        return connections

    def has_clear_path(self, skeleton, start, end, max_steps=200):
        """Check if there's a clear path between two points"""
        h, w = skeleton.shape
        visited = set([start])
        queue = deque([start])
        steps = 0
        
        while queue and steps < max_steps:
            x, y = queue.popleft()
            steps += 1
            
            if abs(x - end[0]) <= 5 and abs(y - end[1]) <= 5:
                return True
            
            for dx, dy in [(-1,0), (1,0), (0,-1), (0,1), (-1,-1), (-1,1), (1,-1), (1,1)]:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited:
                    # Allow walking through skeleton or small gaps
                    if skeleton[ny, nx] > 0 or steps < 10:
                        visited.add((nx, ny))
                        queue.append((nx, ny))
        
        return False

    def build_adjacency_matrix(self, nodes, connections):
        """Build final adjacency matrix for graph"""
        adjacency = {}
        node_names = {}
        
        # Assign names to nodes
        for i, node in enumerate(nodes):
            name = f"CJ_{i+1}"
            node_names[node.pos] = name
        
        # Initialize adjacency
        for node in nodes:
            name = node_names[node.pos]
            adjacency[name] = []
        
        # Connect corridor nodes based on skeleton paths
        for i, node1 in enumerate(nodes):
            for j, node2 in enumerate(nodes[i+1:], i+1):
                if self.has_clear_path(skeleton, node1.pos, node2.pos):
                    name1 = node_names[node1.pos]
                    name2 = node_names[node2.pos]
                    adjacency[name1].append(name2)
                    adjacency[name2].append(name1)
        
        # Add room connections
        for room, corridor_node in connections:
            room_name = room.get("name", f"R_{room['label']}")
            cj_name = node_names[corridor_node.pos]
            
            if room_name not in adjacency:
                adjacency[room_name] = []
            if cj_name not in adjacency[room_name]:
                adjacency[room_name].append(cj_name)
            if room_name not in adjacency[cj_name]:
                adjacency[cj_name].append(room_name)
        
        return adjacency

    def process_floor_plan(self, image_path: str) -> dict:
        """Main processing pipeline"""
        # Load and prepare
        img = self.load_image(image_path)
        mask = self.walkable_mask(img)
        
        # Detect rooms
        rooms, dist_map, room_threshold = self.detect_rooms(mask)
        if not rooms:
            raise ValueError("No rooms detected")
        
        # Sort and label rooms
        rooms.sort(key=lambda r: r["area"], reverse=True)
        meeting_rooms = rooms[:NUM_MEETING]
        regular_rooms = rooms[NUM_MEETING:]
        regular_rooms.sort(key=lambda r: (int(r["cy_px"]//80), int(r["cx_px"]//80)))
        
        # Label rooms
        for i, room in enumerate(meeting_rooms, 1):
            room["name"] = f"M{i}"
        for i, room in enumerate(regular_rooms, 1):
            room["name"] = str(i)
        
        # Extract and process corridors
        corridor_mask = self.extract_corridor_mask(mask, dist_map, room_threshold)
        skeleton = self.enhanced_skeleton(corridor_mask)
        
        # Find and filter nodes
        raw_nodes = self.analyze_skeleton_nodes(skeleton)
        width_filtered = self.filter_nodes_by_corridor_width(raw_nodes, corridor_mask, dist_map)
        type_filtered = self.filter_linear_nodes(width_filtered)
        clustered_nodes = self.adaptive_clustering(type_filtered, skeleton.shape)
        final_nodes = self.simplify_graph(clustered_nodes, skeleton)
        
        # Connect rooms to corridor
        room_connections = self.connect_rooms_to_corridor(rooms, final_nodes, skeleton)
        
        # Build adjacency
        adjacency = self.build_adjacency_matrix(final_nodes, room_connections)
        
        # Build node positions (percentage coordinates)
        node_positions = {}
        for room in rooms:
            x, y = round(room["cx_px"]/TARGET_W*100, 1), round(room["cy_px"]/TARGET_H*100, 1)
            node_positions[room["name"]] = {"x": x, "y": y}
        
        for node in final_nodes:
            name = f"CJ_{len([n for n in node_positions if n.startswith('CJ_')]) + 1}"
            x, y = round(node.pos[0]/TARGET_W*100, 1), round(node.pos[1]/TARGET_H*100, 1)
            node_positions[name] = {"x": x, "y": y}
        
        meeting_points = [room["name"] for room in meeting_rooms]
        
        return {
            "NODE_POSITIONS": node_positions,
            "NODE_ADJACENCY": adjacency,
            "MEETING_POINTS": meeting_points,
            "metadata": {
                "rooms_total": len(rooms),
                "meeting_rooms": len(meeting_rooms),
                "regular_rooms": len(regular_rooms),
                "corridor_junctions": len(final_nodes),
                "total_nodes": len(node_positions),
                "total_edges": sum(len(v) for v in adjacency.values()) // 2,
                "original_junctions": len(raw_nodes),
                "filtered_junctions": len(final_nodes),
                "reduction_percentage": (1 - len(final_nodes)/max(1, len(raw_nodes))) * 100
            }
        }

# Main execution
if __name__ == "__main__":
    processor = EnhancedFloorProcessor()
    targets = sys.argv[1:] or [
        "test_hotel.png", "test_office.png",
        "test_complex.png", "test_grid.png"
    ]
    
    for path in targets:
        if not os.path.exists(path):
            print(f"⚠ Skipping {path}")
            continue
        
        print(f"\n📐 Processing: {path}")
        try:
            result = processor.process_floor_plan(path)
            m = result["metadata"]
            print(f"   Rooms: {m['rooms_total']} (M1-M{m['meeting_rooms']} meeting, {m['regular_rooms']} regular)")
            print(f"   Junctions: {m['corridor_junctions']} (reduced from {m['original_junctions']}, {m['reduction_percentage']:.1f}% reduction)")
            print(f"   Nodes: {m['total_nodes']}, Edges: {m['total_edges']}")
            
            # Save results
            out_json = path.replace(".png", "_enhanced_graph.json")
            with open(out_json, "w") as f:
                json.dump(result, f, indent=2)
            print(f"   Saved: {out_json}")
            
        except Exception as e:
            print(f"   ❌ Error: {e}")
            import traceback
            traceback.print_exc()
    
    print("\n✅ Enhanced processing complete")