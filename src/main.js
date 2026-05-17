import { ANALYSIS_INTERVAL_MS, analyzeImageData, createEmptySignals, summarizeScene } from './sceneAnalyzer.js';

const state = {
  cameras: [{ id: 'demo-lobby', name: 'Lobby CCTV', type: 'cctv', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', status: 'ready' }],
  selectedId: 'demo-lobby',
  savedFaces: loadFaces(),
  timers: new Map(),
  nativeStreams: new Map(),
  previousFrames: new Map(),
};

const app = document.querySelector('#app');
render();

function render() {
  const selected = getSelectedCamera();
  const totals = state.cameras.reduce((acc, camera) => {
    acc.people += camera.signals?.people ?? 0;
    acc.vehicles += camera.signals?.vehicles ?? 0;
    acc.faces += camera.signals?.faces ?? 0;
    return acc;
  }, { people: 0, vehicles: 0, faces: 0 });

  app.innerHTML = `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">▣ Native + CCTV vision console</p>
        <h1>OmniCamera scene intelligence</h1>
        <p class="hero-copy">Connect phone, desktop, and CCTV cameras, monitor multiple feeds at once, and refresh scene summaries every 30 seconds with people, vehicle, and face signals.</p>
        <div class="hero-actions">
          <button class="primary" data-action="add-native">＋ Add native camera</button>
          <a class="secondary" href="#add-camera">＋ Link CCTV stream</a>
        </div>
      </div>
      <div class="metrics-card">
        <span>Live rollup</span><strong>${state.cameras.length}</strong><small>linked camera${state.cameras.length === 1 ? '' : 's'}</small>
        <div class="metric-grid">
          ${metric('People', totals.people)}${metric('Vehicles', totals.vehicles)}${metric('Faces', totals.faces)}
        </div>
      </div>
    </section>

    <section class="workspace">
      <aside class="sidebar">
        <h2>Camera network</h2>
        <p>Native camera access works on modern phones, tablets, and desktops. CCTV URLs can be HLS, MJPEG, WebRTC gateway, or vendor bridge endpoints.</p>
        <div class="camera-list">
          ${state.cameras.map((camera) => `
            <button class="camera-row ${camera.id === state.selectedId ? 'active' : ''}" data-select="${camera.id}">
              <span class="camera-icon">${camera.type === 'native' ? '▣' : camera.type === 'desktop' ? '▤' : '◉'}</span>
              <span><strong>${escapeHtml(camera.name)}</strong><small>${camera.status ?? 'ready'} · ${camera.lastUpdated ?? 'pending first scan'}</small></span>
            </button>`).join('')}
        </div>
        <form id="add-camera" class="card-form" data-form="camera">
          <h3>Link another camera</h3>
          <label>Camera name<input name="name" placeholder="Parking lot gate" required /></label>
          <label>Source type<select name="type"><option value="cctv">CCTV / IP camera</option><option value="desktop">Desktop capture bridge</option><option value="native">Phone camera bridge</option></select></label>
          <label>Stream URL<input name="url" placeholder="https://...m3u8 or /gateway/cam-01" required /></label>
          <button class="secondary full" type="submit">＋ Add camera</button>
        </form>
      </aside>

      <section class="content-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Selected feed</p><h2>${escapeHtml(selected.name)}</h2></div>
          <span class="refresh-pill">Auto updates every ${ANALYSIS_INTERVAL_MS / 1000}s</span>
        </div>
        <div class="feed-grid">${state.cameras.map(cameraTile).join('')}</div>
        <section class="insight-grid">
          <article class="summary-card wide">
            <h3>Scene summary</h3>
            <p>${escapeHtml(selected.summary ?? 'Waiting for the first analysis cycle. Native feeds can be scanned immediately after permission is granted.')}</p>
            <dl>${stat('People', selected.signals?.people ?? 0)}${stat('Vehicles', selected.signals?.vehicles ?? 0)}${stat('Faces', selected.signals?.faces ?? 0)}${stat('Motion', `${Math.round((selected.signals?.motion ?? 0) * 100)}%`)}</dl>
          </article>
          <article class="summary-card">
            <h3>Face directory</h3>
            <form class="face-form" data-form="face"><input name="face" placeholder="Save face by name" required /><button class="primary compact" type="submit">Save</button></form>
            <div class="face-list">${state.savedFaces.map((name) => `<span>${escapeHtml(name)}</span>`).join('')}</div>
          </article>
        </section>
      </section>
    </section>`;

  bindEvents();
  hydrateCameraElements();
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function stat(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

function cameraTile(camera) {
  const selected = camera.id === state.selectedId ? 'selected' : '';
  const media = camera.type === 'native'
    ? `<video data-native-video="${camera.id}" autoplay muted playsinline></video>`
    : isVideoStream(camera.url)
      ? `<video data-stream-video="${camera.id}" src="${escapeAttribute(camera.url)}" autoplay muted playsinline controls crossorigin="anonymous"></video>`
      : `<img data-stream-image="${camera.id}" src="${escapeAttribute(camera.url)}" alt="${escapeAttribute(camera.name)} stream preview" crossorigin="anonymous" />`;

  return `<article class="camera-tile ${selected}" data-select="${camera.id}">
    <div class="video-frame">${media}<canvas data-canvas="${camera.id}" aria-hidden="true"></canvas><span class="badge">${camera.type}</span></div>
    <div class="tile-copy"><strong>${escapeHtml(camera.name)}</strong><small>${escapeHtml(camera.summary ?? 'Ready for analysis')}</small></div>
  </article>`;
}

function bindEvents() {
  app.querySelector('[data-action="add-native"]')?.addEventListener('click', addNativeCamera);
  app.querySelectorAll('[data-select]').forEach((element) => element.addEventListener('click', () => {
    state.selectedId = element.dataset.select;
    render();
  }));
  app.querySelector('[data-form="camera"]')?.addEventListener('submit', addLinkedCamera);
  app.querySelector('[data-form="face"]')?.addEventListener('submit', saveFace);
}

function hydrateCameraElements() {
  state.cameras.forEach((camera) => {
    const video = app.querySelector(`[data-native-video="${camera.id}"]`);
    if (video && !state.nativeStreams.has(camera.id)) connectNativeCamera(camera.id, video);
    if (video && state.nativeStreams.has(camera.id)) video.srcObject = state.nativeStreams.get(camera.id);
    scheduleAnalysis(camera.id);
  });
}

async function connectNativeCamera(id, video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    updateCamera(id, { status: 'native camera unsupported' });
    return;
  }

  updateCamera(id, { status: 'requesting access' }, false);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    state.nativeStreams.set(id, stream);
    video.srcObject = stream;
    updateCamera(id, { status: 'native camera connected' });
  } catch (error) {
    updateCamera(id, { status: error.message || 'camera permission required' });
  }
}

function scheduleAnalysis(id) {
  if (state.timers.has(id)) return;
  const analyze = () => analyzeCamera(id);
  state.timers.set(id, window.setInterval(analyze, ANALYSIS_INTERVAL_MS));
  window.setTimeout(analyze, 1200);
}

function analyzeCamera(id) {
  const camera = state.cameras.find((item) => item.id === id);
  const canvas = app.querySelector(`[data-canvas="${id}"]`);
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  const source = app.querySelector(`[data-native-video="${id}"]`) || app.querySelector(`[data-stream-video="${id}"]`) || app.querySelector(`[data-stream-image="${id}"]`);
  if (!camera || !canvas || !context || !source) return;

  canvas.width = 160;
  canvas.height = 90;
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const signals = analyzeImageData(imageData, state.previousFrames.get(id), state.savedFaces);
    state.previousFrames.set(id, imageData);
    updateCamera(id, signalsToCamera(camera, signals));
  } catch {
    const fallbackSignals = { ...createEmptySignals(), dominantTone: 'stream preview', timestamp: new Date().toISOString() };
    updateCamera(id, signalsToCamera(camera, fallbackSignals));
  }
}

function signalsToCamera(camera, signals) {
  return {
    status: 'analyzed',
    signals,
    summary: summarizeScene(signals, camera.name),
    lastUpdated: new Date().toLocaleTimeString(),
  };
}

function addNativeCamera() {
  const id = `native-${crypto.randomUUID()}`;
  state.cameras.push({ id, name: `Native camera ${state.cameras.filter((camera) => camera.type === 'native').length + 1}`, type: 'native', status: 'requesting access' });
  state.selectedId = id;
  render();
}

function addLinkedCamera(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const id = `camera-${crypto.randomUUID()}`;
  state.cameras.push({ id, name: form.get('name').trim(), type: form.get('type'), url: form.get('url').trim(), status: 'ready' });
  state.selectedId = id;
  render();
}

function saveFace(event) {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get('face').trim();
  if (name && !state.savedFaces.includes(name)) {
    state.savedFaces.push(name);
    localStorage.setItem('omnicamera.faces', JSON.stringify(state.savedFaces));
    render();
  }
}

function updateCamera(id, patch, rerender = true) {
  state.cameras = state.cameras.map((camera) => camera.id === id ? { ...camera, ...patch } : camera);
  if (rerender) render();
}

function getSelectedCamera() {
  return state.cameras.find((camera) => camera.id === state.selectedId) ?? state.cameras[0];
}

function loadFaces() {
  const stored = localStorage.getItem('omnicamera.faces');
  return stored ? JSON.parse(stored) : ['Alex Johnson', 'Security Lead'];
}

function isVideoStream(url = '') {
  return /\.(m3u8|mp4|webm)(\?|$)/i.test(url);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function escapeAttribute(value = '') {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
