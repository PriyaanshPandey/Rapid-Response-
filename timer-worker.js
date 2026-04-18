// Web Worker timer — immune to background tab throttling
// Posts 'tick' messages at requested intervals even when tab is hidden

let timers = {};
let nextId = 1;

self.onmessage = function(e) {
  const { action, id, ms } = e.data;
  
  if (action === 'start') {
    const timerId = id || nextId++;
    if (timers[timerId]) clearInterval(timers[timerId]);
    timers[timerId] = setInterval(() => {
      self.postMessage({ id: timerId, type: 'tick' });
    }, ms || 100);
    self.postMessage({ id: timerId, type: 'started' });
  }
  
  if (action === 'setTimeout') {
    const timerId = id || nextId++;
    timers[timerId] = setTimeout(() => {
      self.postMessage({ id: timerId, type: 'timeout' });
      delete timers[timerId];
    }, ms || 0);
  }
  
  if (action === 'clear') {
    if (timers[id]) {
      clearInterval(timers[id]);
      clearTimeout(timers[id]);
      delete timers[id];
    }
  }
  
  if (action === 'clearAll') {
    Object.keys(timers).forEach(k => {
      clearInterval(timers[k]);
      clearTimeout(timers[k]);
    });
    timers = {};
  }
};
