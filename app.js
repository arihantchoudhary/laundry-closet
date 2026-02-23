/* ═══════════════════════════════════════════════════
   Laundry Closet — by Jake Hofman & Amelia Chen
   Snap clothes, build outfits, look great every day.
   ═══════════════════════════════════════════════════ */

// ─── IndexedDB Storage ───
const ClothingDB = {
  DB_NAME: 'laundry-closet',
  DB_VERSION: 1,
  STORE: 'clothes',
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE)) {
          const store = db.createObjectStore(this.STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('addedAt', 'addedAt', { unique: false });
        }
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  async add(item) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      const req = tx.objectStore(this.STORE).add(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getByCategory(cat) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const idx = tx.objectStore(this.STORE).index('category');
      const req = idx.getAll(cat);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async remove(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      const req = tx.objectStore(this.STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  async count() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
};

// ─── Camera ───
const Camera = {
  stream: null,
  facing: 'environment',
  videoEl: null,
  canvasEl: null,

  async init() {
    this.videoEl = document.getElementById('camera-feed');
    this.canvasEl = document.getElementById('camera-canvas');
    try {
      if (this.stream) this.stop();
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 1080 }, height: { ideal: 1440 } },
        audio: false
      });
      this.videoEl.srcObject = this.stream;
    } catch (err) {
      console.warn('Camera unavailable:', err.message);
    }
  },

  async flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    await this.init();
  },

  capture() {
    const v = this.videoEl;
    const c = this.canvasEl;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return new Promise(resolve => {
      c.toBlob(blob => resolve(blob), 'image/jpeg', 0.85);
    });
  },

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
};

// ─── Color Extraction ───
const ColorExtractor = {
  async extract(blob) {
    const img = await this._loadImage(blob);
    const canvas = document.createElement('canvas');
    const size = 50;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const buckets = {};
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      // Skip very dark or very light pixels
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 20 || lum > 240) continue;
      // Quantize to 32 levels per channel
      const key = `${(r >> 3) << 3},${(g >> 3) << 3},${(b >> 3) << 3}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }

    const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    const palette = sorted.slice(0, 5).map(([k]) => k.split(',').map(Number));
    return {
      dominant: palette[0] || [128, 128, 128],
      palette
    };
  },

  _loadImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }
};

// ─── Thumbnail Generator ───
async function makeThumbnail(blob, maxW = 300) {
  const img = await ColorExtractor._loadImage(blob);
  const ratio = maxW / img.width;
  const canvas = document.createElement('canvas');
  canvas.width = maxW;
  canvas.height = img.height * ratio;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), 'image/jpeg', 0.75);
  });
}

// ─── Outfit Matching ───
const OutfitMatcher = {
  async generate(count = 5) {
    const items = await ClothingDB.getAll();
    const byCategory = {};
    items.forEach(item => {
      if (!byCategory[item.category]) byCategory[item.category] = [];
      byCategory[item.category].push(item);
    });

    const tops = byCategory.top || [];
    const bottoms = byCategory.bottom || [];
    if (tops.length === 0 || bottoms.length === 0) return [];

    const shoes = byCategory.shoes || [];
    const layers = byCategory.outerwear || [];
    const accs = byCategory.accessory || [];
    const seed = this._dateSeed();
    const outfits = [];

    for (let i = 0; i < count; i++) {
      const rng = this._rng(seed + i * 7919);
      const outfit = {
        top: tops[Math.floor(rng() * tops.length)],
        bottom: bottoms[Math.floor(rng() * bottoms.length)]
      };
      if (shoes.length > 0) outfit.shoes = shoes[Math.floor(rng() * shoes.length)];
      if (layers.length > 0 && rng() > 0.55) outfit.outerwear = layers[Math.floor(rng() * layers.length)];
      if (accs.length > 0 && rng() > 0.65) outfit.accessory = accs[Math.floor(rng() * accs.length)];
      outfit.score = this._score(outfit);
      outfits.push(outfit);
    }

    return outfits.sort((a, b) => b.score - a.score);
  },

  _score(outfit) {
    let s = 50;
    const colors = [];
    for (const key of ['top', 'bottom', 'shoes', 'outerwear', 'accessory']) {
      if (outfit[key]?.dominantColor) colors.push(outfit[key].dominantColor);
    }

    // Color harmony
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const [h1, s1] = this._rgbToHsl(colors[i]);
        const [h2, s2] = this._rgbToHsl(colors[j]);
        const diff = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));

        if (s1 < 0.15 || s2 < 0.15) s += 10;           // Neutral always works
        else if (diff <= 30) s += 10;                     // Analogous
        else if (diff >= 150 && diff <= 210) s += 15;     // Complementary
        else if (diff >= 105 && diff <= 135) s += 8;      // Triadic
      }
    }

    // Completeness bonus
    if (outfit.shoes) s += 8;
    if (outfit.outerwear) s += 4;
    if (outfit.accessory) s += 4;

    return Math.min(100, Math.max(0, s));
  },

  _rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;
    }
    return [h, s, l];
  },

  _dateSeed() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  },

  _rng(seed) {
    let t = seed + 0x6D2B79F5;
    return function () {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
};

// ─── Utility: blob to object URL ───
function blobUrl(blob) {
  if (!blob) return '';
  return URL.createObjectURL(blob);
}

// ─── Toast ───
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

// ─── App Controller ───
const App = {
  selectedCategory: 'top',
  closetFilter: 'all',
  _objectUrls: [],

  init() {
    // Tab navigation
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this.navigate(tab.dataset.view));
    });

    // Data-navigate buttons
    document.querySelectorAll('[data-navigate]').forEach(btn => {
      btn.addEventListener('click', () => this.navigate(btn.dataset.navigate));
    });

    // Camera category chips
    document.querySelectorAll('.category-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.category-chips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.selectedCategory = chip.dataset.cat;
      });
    });

    // Capture button
    document.getElementById('camera-capture').addEventListener('click', () => this.capturePhoto());

    // Flip camera
    document.getElementById('camera-flip').addEventListener('click', () => Camera.flip());

    // File upload fallback
    document.getElementById('file-upload').addEventListener('change', e => {
      if (e.target.files[0]) this.reviewPhoto(e.target.files[0]);
    });

    // Review actions
    document.getElementById('review-retake').addEventListener('click', () => this.closeReview());
    document.getElementById('review-save').addEventListener('click', () => this.savePhoto());

    // Closet filter chips
    document.querySelectorAll('.filter-chips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.closetFilter = chip.dataset.filter;
        this.renderCloset();
      });
    });

    // Refresh outfits
    document.getElementById('refresh-outfits').addEventListener('click', () => this.renderOutfits());

    // Start camera
    Camera.init();
  },

  navigate(view) {
    // Clean up old object URLs
    this._objectUrls.forEach(u => URL.revokeObjectURL(u));
    this._objectUrls = [];

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`[data-view="${view}"]`);
    if (activeTab) activeTab.classList.add('active');

    if (view === 'camera') Camera.init();
    else Camera.stop();

    if (view === 'closet') this.renderCloset();
    if (view === 'today') this.renderOutfits();
  },

  async capturePhoto() {
    try {
      const blob = await Camera.capture();
      this.reviewPhoto(blob);
    } catch (err) {
      showToast('Could not capture — try uploading instead');
    }
  },

  _pendingBlob: null,

  reviewPhoto(blob) {
    this._pendingBlob = blob;
    const preview = document.getElementById('capture-preview');
    const url = blobUrl(blob);
    this._objectUrls.push(url);
    preview.src = url;
    document.getElementById('review-category').value = this.selectedCategory;
    document.getElementById('capture-review').classList.remove('hidden');
  },

  closeReview() {
    document.getElementById('capture-review').classList.add('hidden');
    this._pendingBlob = null;
  },

  async savePhoto() {
    if (!this._pendingBlob) return;
    const blob = this._pendingBlob;
    const category = document.getElementById('review-category').value;

    showToast('Saving...');

    try {
      const [thumb, colors] = await Promise.all([
        makeThumbnail(blob),
        ColorExtractor.extract(blob)
      ]);

      await ClothingDB.add({
        imageBlob: blob,
        thumbBlob: thumb,
        category,
        dominantColor: colors.dominant,
        colorPalette: colors.palette,
        addedAt: Date.now()
      });

      this.closeReview();
      showToast('Saved to closet!');
    } catch (err) {
      console.error(err);
      showToast('Error saving — try again');
    }
  },

  async renderCloset() {
    const items = this.closetFilter === 'all'
      ? await ClothingDB.getAll()
      : await ClothingDB.getByCategory(this.closetFilter);

    const count = await ClothingDB.count();
    document.getElementById('closet-count').textContent = count;

    const grid = document.getElementById('closet-grid');
    const empty = document.getElementById('closet-empty');

    if (items.length === 0) {
      grid.style.display = 'none';
      empty.style.display = '';
      return;
    }

    empty.style.display = 'none';
    grid.style.display = '';
    grid.innerHTML = '';

    items.sort((a, b) => b.addedAt - a.addedAt).forEach(item => {
      const div = document.createElement('div');
      div.className = 'closet-item';

      const url = blobUrl(item.thumbBlob || item.imageBlob);
      this._objectUrls.push(url);

      const [r, g, b] = item.dominantColor || [128, 128, 128];

      div.innerHTML = `
        <img src="${url}" alt="${item.category}">
        <span class="item-badge">${item.category}</span>
        <span class="item-color" style="background:rgb(${r},${g},${b})"></span>
        <button class="item-delete" aria-label="Delete">x</button>
      `;

      div.querySelector('.item-delete').addEventListener('click', async e => {
        e.stopPropagation();
        await ClothingDB.remove(item.id);
        showToast('Removed');
        this.renderCloset();
      });

      grid.appendChild(div);
    });
  },

  async renderOutfits() {
    const outfits = await OutfitMatcher.generate(6);
    const container = document.getElementById('outfit-cards');
    const empty = document.getElementById('today-empty');

    if (outfits.length === 0) {
      container.style.display = 'none';
      empty.style.display = '';
      return;
    }

    empty.style.display = 'none';
    container.style.display = '';
    container.innerHTML = '';

    outfits.forEach((outfit, idx) => {
      const card = document.createElement('div');
      card.className = 'outfit-card';

      const pieces = ['top', 'bottom', 'shoes', 'outerwear', 'accessory']
        .filter(k => outfit[k])
        .map(k => {
          const item = outfit[k];
          const url = blobUrl(item.thumbBlob || item.imageBlob);
          this._objectUrls.push(url);
          return `<div class="outfit-piece">
            <img src="${url}" alt="${k}">
            <span>${k}</span>
          </div>`;
        }).join('');

      const colorDots = ['top', 'bottom', 'shoes', 'outerwear', 'accessory']
        .filter(k => outfit[k]?.dominantColor)
        .map(k => {
          const [r, g, b] = outfit[k].dominantColor;
          return `<span class="color-dot" style="background:rgb(${r},${g},${b})"></span>`;
        }).join('');

      card.innerHTML = `
        <div class="outfit-card-header">
          <span class="outfit-label">Outfit ${idx + 1}</span>
          <span class="outfit-score">
            <span class="score-bar"><span class="score-fill" style="width:${outfit.score}%"></span></span>
            ${outfit.score}
          </span>
        </div>
        <div class="outfit-items">${pieces}</div>
        <div class="outfit-colors">${colorDots}</div>
      `;

      container.appendChild(card);
    });
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
