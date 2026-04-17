/**
 * SENTINEL Configuration
 * This file centralizes backend URLs for different environments.
 * For production (Render/Vercel), update these URLs to your deployed backend addresses.
 */

window.CONFIG = {
  // Replace these with your Render URLs (e.g., https://sentinel-node.onrender.com)
  NODE_API: window.location.hostname === 'localhost' ? 'http://localhost:5000' : 'https://rapidresponse-node.onrender.com', 
  PYTHON_API: window.location.hostname === 'localhost' ? 'http://localhost:5001' : 'https://rapidresponse-python.onrender.com'
};

// Check for development overrides (e.g. if running frontend on a custom port)
if (window.location.port === '5500' || window.location.port === '3000') {
    // Keep local defaults if on common dev ports
}
