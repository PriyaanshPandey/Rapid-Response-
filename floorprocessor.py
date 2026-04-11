import cv2
import numpy as np
from skimage.morphology import skeletonize
import networkx as nx
import json
from typing import Dict, List, Tuple, Set

class FloorPlanProcessor:
    def __init__(self):
        self.image = None
        self.binary = None
        self.skeleton = None
        self.nodes = {}
        self.graph = {}
        self.node_counter = 0
        
    def load_image(self, image_path: str):
        """Load and preprocess floor plan image"""
        self.image = cv2.imread(image_path)
        if self.image is None:
            raise ValueError(f"Cannot load image: {image_path}")
        return self
    
    def convert_to_binary(self, threshold: int = 127):
        """Convert to binary: white = walkable, black = walls"""
        gray = cv2.cvtColor(self.image, cv2.COLOR_BGR2GRAY)
        # Invert so white = walkable (corridors)
        _, self.binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)
        return self
    
    def skeletonize_corridors(self):
        """Extract corridor center lines (skeleton)"""
        # Convert to binary (0/1) for skeletonize
        binary_01 = (self.binary > 0).astype(np.uint8)
        self.skeleton = skeletonize(binary_01).astype(np.uint8) * 255
        return self
    
    def find_junctions_and_endpoints(self):
        """Detect intersection points (junctions) and dead ends (room entries)"""
        # Use hit-or-miss transform to find junctions
        kernel_junction = np.array([[1, 1, 1],
                                    [1, 1, 1],
                                    [1, 1, 1]], dtype=np.uint8)
        
        # Dilate to make junctions more detectable
        dilated = cv2.dilate(self.skeleton, kernel_junction, iterations=1)
        
        # Find points with 3+ neighbors = junctions
        h, w = self.skeleton.shape
        junction_points = []
        endpoint_points = []
        
        for y in range(1, h-1):
            for x in range(1, w-1):
                if self.skeleton[y, x] > 0:
                    # Count neighbors in 8-connectivity
                    neighbors = sum([
                        self.skeleton[y-1, x-1] > 0, self.skeleton[y-1, x] > 0, self.skeleton[y-1, x+1] > 0,
                        self.skeleton[y, x-1] > 0,                             self.skeleton[y, x+1] > 0,
                        self.skeleton[y+1, x-1] > 0, self.skeleton[y+1, x] > 0, self.skeleton[y+1, x+1] > 0
                    ])
                    
                    if neighbors >= 3:
                        junction_points.append((x, y))
                    elif neighbors == 1:
                        endpoint_points.append((x, y))
        
        # Merge nearby junctions (within 15 pixels)
        merged_junctions = self._merge_close_points(junction_points, 15)
        
        return merged_junctions, endpoint_points
    
    def _merge_close_points(self, points: List[Tuple], min_distance: int) -> List[Tuple]:
        """Merge points that are too close together"""
        if not points:
            return []
        
        merged = []
        used = set()
        
        for i, p1 in enumerate(points):
            if i in used:
                continue
            cluster = [p1]
            for j, p2 in enumerate(points[i+1:], i+1):
                if j in used:
                    continue
                dist = np.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)
                if dist < min_distance:
                    cluster.append(p2)
                    used.add(j)
            
            # Use centroid of cluster
            avg_x = int(sum(p[0] for p in cluster) / len(cluster))
            avg_y = int(sum(p[1] for p in cluster) / len(cluster))
            merged.append((avg_x, avg_y))
        
        return merged
    
def extract_nodes(self):
    """Create node objects from junctions and endpoints"""
    junctions, endpoints = self.find_junctions_and_endpoints()
    
    self.nodes = {}
    self.node_counter = 0
    
    # Add junctions (corridor intersections)
    for i, (x, y) in enumerate(junctions):
        node_id = f"CJ_{i+1}"
        self.nodes[node_id] = {
            'type': 'junction',
            'x': x / self.image.shape[1] * 100,  # Convert to percentage
            'y': y / self.image.shape[0] * 100,
            'pixel_x': x,
            'pixel_y': y
        }
    
    # Add endpoints (room connections)
    for i, (x, y) in enumerate(endpoints):
        node_id = f"R_{i+1}"
        self.nodes[node_id] = {
            'type': 'room',
            'x': x / self.image.shape[1] * 100,
            'y': y / self.image.shape[0] * 100,
            'pixel_x': x,
            'pixel_y': y
        }
    
    return self  # Return self for method chaining# ✅ CHANGE THIS - was returning self.nodes
    
    def build_graph(self):
        """Build adjacency graph from skeleton using BFS"""
        if not self.nodes:
            self.extract_nodes()
        
        h, w = self.skeleton.shape
        node_positions = {node_id: (data['pixel_x'], data['pixel_y']) 
                         for node_id, data in self.nodes.items()}
        
        # Build graph using path finding on skeleton
        G = nx.Graph()
        
        # Add all nodes
        for node_id in self.nodes:
            G.add_node(node_id)
        
        # For each pair of nodes, find if there's a path on skeleton
        node_ids = list(self.nodes.keys())
        for i in range(len(node_ids)):
            for j in range(i+1, len(node_ids)):
                n1, n2 = node_ids[i], node_ids[j]
                
                # Check if nodes are within reasonable distance (max 300px)
                pos1 = node_positions[n1]
                pos2 = node_positions[n2]
                dist = np.sqrt((pos1[0]-pos2[0])**2 + (pos1[1]-pos2[1])**2)
                
                if dist < 300:  # Only check nearby nodes
                    path_exists = self._path_on_skeleton(pos1, pos2)
                    if path_exists:
                        G.add_edge(n1, n2)
        
        # Convert NetworkX graph to adjacency dict
        self.graph = {}
        for node in G.nodes():
            self.graph[node] = list(G.neighbors(node))
        
        return self.graph
    
    def _path_on_skeleton(self, start: Tuple, end: Tuple, max_steps: int = 500) -> bool:
        """BFS on skeleton to check if path exists between two points"""
        from collections import deque
        
        h, w = self.skeleton.shape
        visited = set()
        queue = deque([(start[0], start[1])])
        visited.add(start)
        
        for _ in range(max_steps):
            if not queue:
                break
            x, y = queue.popleft()
            
            # Check if reached target
            if abs(x - end[0]) < 5 and abs(y - end[1]) < 5:
                return True
            
            # Check 8 neighbors
            for dx in [-1, 0, 1]:
                for dy in [-1, 0, 1]:
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if (0 <= nx < w and 0 <= ny < h and 
                        (nx, ny) not in visited and 
                        self.skeleton[ny, nx] > 0):
                        visited.add((nx, ny))
                        queue.append((nx, ny))
        
        return False
    
    def generate_json(self, output_path: str = None) -> Dict:
        """Generate JSON compatible with your frontend"""
        # Convert to percentage coordinates for frontend
        node_positions = {}
        for node_id, data in self.nodes.items():
            node_positions[node_id] = {
                'x': round(data['x'], 2),
                'y': round(data['y'], 2)
            }
        
        result = {
            'NODE_POSITIONS': node_positions,
            'NODE_ADJACENCY': self.graph,
            'metadata': {
                'image_width': self.image.shape[1],
                'image_height': self.image.shape[0],
                'total_nodes': len(self.nodes),
                'total_edges': sum(len(v) for v in self.graph.values()) // 2
            }
        }
        
        if output_path:
            with open(output_path, 'w') as f:
                json.dump(result, f, indent=2)
        
        return result
    
    def visualize(self, output_path: str = 'processed_map.png'):
        """Create visualization overlay for debugging"""
        vis = cv2.cvtColor(self.skeleton, cv2.COLOR_GRAY2BGR)
        
        # Draw nodes
        for node_id, data in self.nodes.items():
            x, y = data['pixel_x'], data['pixel_y']
            color = (0, 255, 0) if data['type'] == 'junction' else (255, 0, 0)
            cv2.circle(vis, (x, y), 5, color, -1)
            cv2.putText(vis, node_id, (x+5, y-5), 
                       cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255,255,255), 1)
        
        # Draw edges
        for node_id, neighbors in self.graph.items():
            pos1 = (self.nodes[node_id]['pixel_x'], self.nodes[node_id]['pixel_y'])
            for neighbor in neighbors:
                if node_id < neighbor:  # Draw each edge once
                    pos2 = (self.nodes[neighbor]['pixel_x'], self.nodes[neighbor]['pixel_y'])
                    cv2.line(vis, pos1, pos2, (0, 255, 255), 2)
        
        cv2.imwrite(output_path, vis)
        return output_path

# Quick test
if __name__ == "__main__":
    processor = FloorPlanProcessor()
    processor.load_image("floor-map.png")\
             .convert_to_binary()\
             .skeletonize_corridors()\
             .extract_nodes()\
             .build_graph()
    
    result = processor.generate_json("generated_graph.json")
    processor.visualize("debug_output.png")
    print(f"Generated {result['metadata']['total_nodes']} nodes")