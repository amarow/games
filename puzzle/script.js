'use strict';

/* ---------------------------------------------------------------------
 * Konfiguration
 * ------------------------------------------------------------------- */

const MOTIFS = [
    {
        id: 'schloss',
        label: 'Schloss',
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/Neuschwanstein_Castle_2024.jpg/1920px-Neuschwanstein_Castle_2024.jpg',
        credit: null
    },
    {
        id: 'berge',
        label: 'Berge',
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Lauterbrunnen%2C_Bernese_Oberland.jpg/1920px-Lauterbrunnen%2C_Bernese_Oberland.jpg',
        credit: '"Lauterbrunnen, Bernese Oberland" von Edwin Lee (CC BY 2.0)'
    },
    {
        id: 'fluss',
        label: 'Fluss',
        url: 'https://upload.wikimedia.org/wikipedia/commons/9/96/Mosel.jpg',
        credit: '"The Mosel valley in Germany" von Laurascudder (CC BY-SA 3.0)'
    }
];

const PIECE_COUNTS = [50, 100, 500, 1000];
const TRAY_BATCH_SIZE = 50;
const LS_KEY = 'puzzle-progress';
const DB_NAME = 'puzzle-db';
const DB_STORE = 'images';

/* ---------------------------------------------------------------------
 * IndexedDB Helper (eigenes Foto)
 * ------------------------------------------------------------------- */

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveCustomImageBlob(blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(blob, 'custom');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function loadCustomImageBlob() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get('custom');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/* ---------------------------------------------------------------------
 * Seeded RNG (mulberry32) - deterministisch fuer eine gegebene Seed-Zahl
 * ------------------------------------------------------------------- */

function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ---------------------------------------------------------------------
 * Bild laden (Preset-URL oder Blob) -> einheitliches {width,height,source}
 * ------------------------------------------------------------------- */

function loadPresetImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
        img.onerror = () => reject(new Error('Bild konnte nicht geladen werden: ' + url));
        img.src = url;
    });
}

async function loadBlobImage(blob) {
    const bitmap = await createImageBitmap(blob);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
}

/* ---------------------------------------------------------------------
 * Jigsaw-Geometrie: Grid, Kanten-Polylinien, Teil-Pfade
 * ------------------------------------------------------------------- */

function computeGrid(pieceCount, aspect) {
    let cols = Math.max(1, Math.round(Math.sqrt(pieceCount * aspect)));
    let rows = Math.max(1, Math.round(pieceCount / cols));
    return { rows, cols };
}

function bumpFn(t, center, width) {
    const d = t - center;
    return Math.exp(-(d * d) / (2 * width * width));
}

function randEdgeParams(rng) {
    return {
        sign: rng() < 0.5 ? -1 : 1,
        center: 0.46 + rng() * 0.08,
        width: 0.085 + rng() * 0.03,
        knobScale: 0.85 + rng() * 0.3
    };
}

function buildSegmentPoints(x0, y0, x1, y1, axis, isBoundary, params, knobBase) {
    if (isBoundary) return [{ x: x0, y: y0 }, { x: x1, y: y1 }];
    const N = 20;
    const pts = [];
    const knob = knobBase * params.knobScale;
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const v = params.sign * knob * bumpFn(t, params.center, params.width);
        if (axis === 'h') pts.push({ x: x0 + (x1 - x0) * t, y: y0 + v });
        else pts.push({ x: x0 + v, y: y0 + (y1 - y0) * t });
    }
    pts[0] = { x: x0, y: y0 };
    pts[N] = { x: x1, y: y1 };
    return pts;
}

function buildEdges(rows, cols, pw, ph, rng, knobBase) {
    const hLines = [];
    for (let r = 0; r <= rows; r++) {
        hLines[r] = [];
        for (let c = 0; c < cols; c++) {
            const x0 = c * pw, x1 = (c + 1) * pw, y = r * ph;
            const isBoundary = (r === 0 || r === rows);
            const params = isBoundary ? null : randEdgeParams(rng);
            hLines[r][c] = buildSegmentPoints(x0, y, x1, y, 'h', isBoundary, params, knobBase);
        }
    }
    const vLines = [];
    for (let c = 0; c <= cols; c++) {
        vLines[c] = [];
        for (let r = 0; r < rows; r++) {
            const y0 = r * ph, y1 = (r + 1) * ph, x = c * pw;
            const isBoundary = (c === 0 || c === cols);
            const params = isBoundary ? null : randEdgeParams(rng);
            vLines[c][r] = buildSegmentPoints(x, y0, x, y1, 'v', isBoundary, params, knobBase);
        }
    }
    return { hLines, vLines };
}

function buildPiecePoints(r, c, hLines, vLines) {
    const top = hLines[r][c];
    const right = vLines[c + 1][r];
    const bottom = hLines[r + 1][c].slice().reverse();
    const left = vLines[c][r].slice().reverse();
    const pts = [];
    pts.push(...top);
    pts.push(...right.slice(1));
    pts.push(...bottom.slice(1));
    pts.push(...left.slice(1, -1));
    return pts;
}

function createPieceCanvas(r, c, pts, pw, ph, pad, sourceCanvas) {
    const w = Math.ceil(pw + 2 * pad), h = Math.ceil(ph + 2 * pad);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.className = 'piece';
    const ctx = canvas.getContext('2d');
    const originX = c * pw - pad, originY = r * ph - pad;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x - originX, pts[0].y - originY);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - originX, pts[i].y - originY);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(sourceCanvas, -originX, -originY);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x - originX, pts[0].y - originY);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x - originX, pts[i].y - originY);
    ctx.closePath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
    ctx.restore();

    return canvas;
}

/* ---------------------------------------------------------------------
 * Applikationszustand
 * ------------------------------------------------------------------- */

const state = {
    selectedMotif: null,   // {type:'preset', id} | {type:'custom'}
    selectedCount: 500,
    customThumb: null,     // dataURL fuer die Kachel
    puzzle: null           // aktives Puzzle
};

function getMotifById(id) { return MOTIFS.find(m => m.id === id); }

/* ---------------------------------------------------------------------
 * DOM-Referenzen
 * ------------------------------------------------------------------- */

const el = {
    motifOptions: document.getElementById('motif-options'),
    countOptions: document.getElementById('count-options'),
    startBtn: document.getElementById('start-btn'),
    uploadInput: document.getElementById('upload-input'),
    loadError: document.getElementById('load-error'),
    resumeBanner: document.getElementById('resume-banner'),
    resumeText: document.getElementById('resume-text'),
    resumeContinueBtn: document.getElementById('resume-continue-btn'),
    resumeDiscardBtn: document.getElementById('resume-discard-btn'),
    configPanel: document.getElementById('config-panel'),
    progressBar: document.getElementById('progress-bar'),
    progressLabel: document.getElementById('progress-label'),
    progressFill: document.getElementById('progress-fill'),
    gameArea: document.getElementById('game-area'),
    stage: document.getElementById('puzzle-stage'),
    trayZone: document.getElementById('tray-zone'),
    boardZone: document.getElementById('board-zone'),
    boardGhost: document.getElementById('board-ghost'),
    newBatchBtn: document.getElementById('new-batch-btn'),
    sortTrayBtn: document.getElementById('sort-tray-btn'),
    autoSolveBtn: document.getElementById('auto-solve-btn'),
    backToConfigBtn: document.getElementById('back-to-config-btn'),
    creditFooter: document.getElementById('credit-footer')
};

/* ---------------------------------------------------------------------
 * Konfigurations-UI aufbauen
 * ------------------------------------------------------------------- */

function renderMotifOptions() {
    el.motifOptions.innerHTML = '';

    MOTIFS.forEach(motif => {
        const btn = document.createElement('div');
        btn.className = 'motif-btn';
        btn.tabIndex = 0;
        btn.innerHTML = `<img src="${motif.url}" alt="${motif.label}"><span>${motif.label}</span>`;
        btn.addEventListener('click', () => selectMotif({ type: 'preset', id: motif.id }));
        el.motifOptions.appendChild(btn);
    });

    const uploadTile = document.createElement('div');
    uploadTile.className = 'motif-btn upload-btn';
    uploadTile.id = 'upload-tile';
    uploadTile.innerHTML = `<span>+ Eigenes Bild</span>`;
    uploadTile.addEventListener('click', () => {
        if (state.customThumb) selectMotif({ type: 'custom' });
        else el.uploadInput.click();
    });
    el.motifOptions.appendChild(uploadTile);

    refreshUploadTile();
}

function refreshUploadTile() {
    const tile = document.getElementById('upload-tile');
    if (!tile) return;
    if (state.customThumb) {
        tile.innerHTML = `<img src="${state.customThumb}" alt="Eigenes Bild"><span>Eigenes Bild</span>`;
        const changeBtn = document.createElement('span');
        changeBtn.textContent = ' (ändern)';
        changeBtn.style.fontSize = '0.6rem';
        changeBtn.style.color = '#888';
        changeBtn.addEventListener('click', (e) => { e.stopPropagation(); el.uploadInput.click(); });
        tile.appendChild(changeBtn);
    } else {
        tile.innerHTML = `<span>+ Eigenes Bild</span>`;
    }
}

function renderCountOptions() {
    el.countOptions.innerHTML = '';
    PIECE_COUNTS.forEach(count => {
        const btn = document.createElement('div');
        btn.className = 'count-btn';
        btn.tabIndex = 0;
        btn.textContent = count;
        btn.addEventListener('click', () => selectCount(count));
        el.countOptions.appendChild(btn);
    });
    updateCountSelectionUI();
}

function selectMotif(motif) {
    state.selectedMotif = motif;
    [...el.motifOptions.children].forEach(c => c.classList.remove('selected'));
    if (motif.type === 'preset') {
        const idx = MOTIFS.findIndex(m => m.id === motif.id);
        el.motifOptions.children[idx].classList.add('selected');
    } else {
        document.getElementById('upload-tile').classList.add('selected');
    }
    updateStartButtonState();
    updateCreditFooter();
}

function selectCount(count) {
    state.selectedCount = count;
    updateCountSelectionUI();
}

function updateCountSelectionUI() {
    [...el.countOptions.children].forEach((c, i) => {
        c.classList.toggle('selected', PIECE_COUNTS[i] === state.selectedCount);
    });
}

function updateStartButtonState() {
    el.startBtn.disabled = !state.selectedMotif;
}

function updateCreditFooter() {
    if (!state.selectedMotif || state.selectedMotif.type !== 'preset') {
        el.creditFooter.textContent = '';
        return;
    }
    const motif = getMotifById(state.selectedMotif.id);
    el.creditFooter.textContent = motif.credit ? 'Bildquelle: ' + motif.credit : '';
}

async function handleUpload(file) {
    showError('');
    try {
        const bitmap = await createImageBitmap(file);
        const maxSide = 2200;
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
        await saveCustomImageBlob(blob);
        state.customThumb = canvas.toDataURL('image/jpeg', 0.6);
        refreshUploadTile();
        selectMotif({ type: 'custom' });
    } catch (err) {
        console.error(err);
        showError('Bild konnte nicht verarbeitet werden.');
    }
}

function showError(msg) {
    el.loadError.textContent = msg;
    el.loadError.style.display = msg ? 'block' : 'none';
}

/* ---------------------------------------------------------------------
 * Layout-Hilfsfunktionen (Stage/Board/Tray Rechtecke)
 * ------------------------------------------------------------------- */

function getStageOffsets() {
    const stageRect = el.stage.getBoundingClientRect();
    const boardRect = el.boardZone.getBoundingClientRect();
    const trayRect = el.trayZone.getBoundingClientRect();
    return {
        board: { x: boardRect.left - stageRect.left, y: boardRect.top - stageRect.top, w: boardRect.width, h: boardRect.height },
        tray: { x: trayRect.left - stageRect.left, y: trayRect.top - stageRect.top, w: trayRect.width, h: trayRect.height }
    };
}

/* ---------------------------------------------------------------------
 * Puzzle-Generierung
 * ------------------------------------------------------------------- */

async function generatePuzzle(imageSource, pieceCount, seed) {
    const aspect = imageSource.width / imageSource.height;
    const { rows, cols } = computeGrid(pieceCount, aspect);

    const offsets = getStageOffsets();
    const margin = 16;
    const maxW = Math.max(100, offsets.board.w - margin);
    const maxH = Math.max(100, offsets.board.h - margin);

    let boardW, boardH;
    if (maxW / maxH > aspect) { boardH = maxH; boardW = boardH * aspect; }
    else { boardW = maxW; boardH = boardW / aspect; }

    const pw = boardW / cols, ph = boardH / rows;
    const knobBase = Math.min(pw, ph) * 0.32;
    const pad = Math.min(pw, ph) * 0.42;

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = Math.max(1, Math.round(boardW));
    srcCanvas.height = Math.max(1, Math.round(boardH));
    srcCanvas.getContext('2d').drawImage(imageSource.source, 0, 0, srcCanvas.width, srcCanvas.height);

    const rng = mulberry32(seed);
    const { hLines, vLines } = buildEdges(rows, cols, pw, ph, rng, knobBase);

    const pieces = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const pts = buildPiecePoints(r, c, hLines, vLines);
            const canvas = createPieceCanvas(r, c, pts, pw, ph, pad, srcCanvas);
            pieces.push({
                id: r * cols + c, r, c, el: canvas,
                w: canvas.width, h: canvas.height, pad,
                status: 'pool', targetX: 0, targetY: 0
            });
        }
    }

    let ghostUrl;
    try { ghostUrl = srcCanvas.toDataURL('image/jpeg', 0.7); }
    catch (e) { ghostUrl = null; }

    return { rows, cols, pw, ph, pad, boardW, boardH, pieces, ghostUrl, seed, pieceCount };
}

function positionBoardAndGhost(puzzle) {
    const offsets = getStageOffsets();
    const originX = offsets.board.x + (offsets.board.w - puzzle.boardW) / 2;
    const originY = offsets.board.y + (offsets.board.h - puzzle.boardH) / 2;
    puzzle.boardOrigin = { x: originX, y: originY };

    puzzle.pieces.forEach(p => {
        p.targetX = originX + p.c * puzzle.pw - p.pad;
        p.targetY = originY + p.r * puzzle.ph - p.pad;
    });

    if (puzzle.ghostUrl) {
        el.boardGhost.style.backgroundImage = `url(${puzzle.ghostUrl})`;
        el.boardGhost.style.left = (originX - offsets.board.x) + 'px';
        el.boardGhost.style.top = (originY - offsets.board.y) + 'px';
        el.boardGhost.style.width = puzzle.boardW + 'px';
        el.boardGhost.style.height = puzzle.boardH + 'px';
        el.boardGhost.style.right = 'auto';
        el.boardGhost.style.bottom = 'auto';
    }
}

/* ---------------------------------------------------------------------
 * Tisch/Pool-Logik
 * ------------------------------------------------------------------- */

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function refillTray() {
    const puzzle = state.puzzle;
    // aktuelle Tisch-Teile zurueck in den Pool
    puzzle.pieces.forEach(p => {
        if (p.status === 'tray') {
            p.status = 'pool';
            if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
        }
    });
    const poolPieces = shuffle(puzzle.pieces.filter(p => p.status === 'pool'));
    const batch = poolPieces.slice(0, TRAY_BATCH_SIZE);
    batch.forEach(p => { p.status = 'tray'; });
    scatterTray();
}

function scatterTray() {
    const offsets = getStageOffsets();
    const margin = 8;
    state.puzzle.pieces.filter(p => p.status === 'tray').forEach(p => {
        if (!p.el.parentNode) el.stage.appendChild(p.el);
        const maxX = Math.max(1, offsets.tray.w - p.w - margin * 2);
        const maxY = Math.max(1, offsets.tray.h - p.h - margin * 2);
        const left = offsets.tray.x + margin + Math.random() * maxX;
        const top = offsets.tray.y + margin + Math.random() * maxY;
        const rot = (Math.random() * 36 - 18).toFixed(1);
        p.el.classList.remove('snap-anim', 'dragging');
        p.el.style.left = left + 'px';
        p.el.style.top = top + 'px';
        p.el.style.transform = `rotate(${rot}deg)`;
        p.el.style.zIndex = String(1 + Math.floor(Math.random() * 40));
        p.el.classList.remove('placed');
    });
}

function isEdgePiece(puzzle, piece) {
    return piece.r === 0 || piece.r === puzzle.rows - 1 || piece.c === 0 || piece.c === puzzle.cols - 1;
}

function sortTray() {
    const puzzle = state.puzzle;
    if (!puzzle) return;
    const trayPieces = puzzle.pieces.filter(p => p.status === 'tray');
    if (trayPieces.length === 0) return;

    const offsets = getStageOffsets();
    const margin = 8, gap = 4, groupGap = 16, minStep = 16;
    const pieceW = trayPieces[0].w, pieceH = trayPieces[0].h;
    const cols = Math.max(1, Math.floor((offsets.tray.w - margin * 2 + gap) / (pieceW + gap)));

    const edgePieces = trayPieces.filter(p => isEdgePiece(puzzle, p));
    const innerPieces = trayPieces.filter(p => !isEdgePiece(puzzle, p));

    const rowsEdge = Math.ceil(edgePieces.length / cols) || 0;
    const rowsInner = Math.ceil(innerPieces.length / cols) || 0;
    const totalRows = rowsEdge + rowsInner;
    const hasBothGroups = rowsEdge > 0 && rowsInner > 0;

    // Falls das normale Raster (Kantenhoehe + Abstand) nicht in den Tisch passt,
    // werden die Reihen gestaucht (leichte Ueberlappung wie gestapelte Kartenreihen),
    // damit stets alle Teile innerhalb der Tisch-Flaeche sichtbar bleiben.
    const availH = Math.max(pieceH, offsets.tray.h - margin * 2 - (hasBothGroups ? groupGap : 0));
    const idealStep = pieceH + gap;
    const stepY = totalRows > 0 ? Math.max(minStep, Math.min(idealStep, availH / totalRows)) : idealStep;

    let y = offsets.tray.y + margin;
    let z = 1;

    function layoutGroup(pieces) {
        if (pieces.length === 0) return;
        pieces.forEach((p, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const left = offsets.tray.x + margin + col * (pieceW + gap);
            const top = y + row * stepY;
            p.el.classList.add('snap-anim');
            p.el.style.left = left + 'px';
            p.el.style.top = top + 'px';
            p.el.style.transform = 'rotate(0deg)';
            p.el.style.zIndex = String(z++);
        });
        const rowsUsed = Math.ceil(pieces.length / cols);
        y += (rowsUsed - 1) * stepY + pieceH;
    }

    layoutGroup(edgePieces);
    if (hasBothGroups) y += groupGap;
    layoutGroup(innerPieces);
}

/* ---------------------------------------------------------------------
 * Drag & Drop
 * ------------------------------------------------------------------- */

let dragCtx = null;
let topZ = 1000;
let autoSolveActive = false;

function attachDragHandlers(piece) {
    const target = piece.el;
    target.addEventListener('pointerdown', (e) => {
        if (piece.status === 'placed' || autoSolveActive) return;
        e.preventDefault();
        target.setPointerCapture(e.pointerId);
        dragCtx = {
            piece,
            startPointerX: e.clientX,
            startPointerY: e.clientY,
            startLeft: parseFloat(target.style.left) || 0,
            startTop: parseFloat(target.style.top) || 0
        };
        target.classList.add('dragging');
        target.classList.remove('snap-anim');
        target.style.transform = 'rotate(0deg)';
        target.style.zIndex = String(++topZ);
    });

    target.addEventListener('pointermove', (e) => {
        if (!dragCtx || dragCtx.piece !== piece) return;
        const dx = e.clientX - dragCtx.startPointerX;
        const dy = e.clientY - dragCtx.startPointerY;
        target.style.left = (dragCtx.startLeft + dx) + 'px';
        target.style.top = (dragCtx.startTop + dy) + 'px';
    });

    const endDrag = (e) => {
        if (!dragCtx || dragCtx.piece !== piece) return;
        target.classList.remove('dragging');
        try { target.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
        dragCtx = null;

        const curLeft = parseFloat(target.style.left) || 0;
        const curTop = parseFloat(target.style.top) || 0;
        const dist = Math.hypot(curLeft - piece.targetX, curTop - piece.targetY);
        const tolerance = Math.max(state.puzzle.pw, state.puzzle.ph) * 0.35;

        if (dist <= tolerance) {
            snapPiece(piece);
        } else {
            piece.status = 'loose';
        }
    };

    target.addEventListener('pointerup', endDrag);
    target.addEventListener('pointercancel', endDrag);
}

function snapPiece(piece) {
    const target = piece.el;
    target.classList.add('snap-anim');
    target.style.left = piece.targetX + 'px';
    target.style.top = piece.targetY + 'px';
    target.style.transform = 'rotate(0deg)';
    target.style.zIndex = '1';
    finalizePlacement(piece);
}

function finalizePlacement(piece) {
    const target = piece.el;
    piece.status = 'placed';
    target.classList.add('placed');

    setTimeout(() => {
        target.classList.remove('snap-anim');
        target.classList.add('pulse');
        setTimeout(() => target.classList.remove('pulse'), 450);
    }, 260);

    persistProgress();
    updateProgressBar();

    if (!state.puzzle.completed && state.puzzle.pieces.every(p => p.status === 'placed')) {
        state.puzzle.completed = true;
        playCompletionEffect(state.puzzle);
    }
}

/* ---------------------------------------------------------------------
 * Vorfuehrung: Teile automatisch nacheinander einsetzen (zum Zuschauen)
 * ------------------------------------------------------------------- */

let autoSolveToken = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function stopAutoSolve() {
    autoSolveToken++;
    autoSolveActive = false;
    el.autoSolveBtn.textContent = '▶ Vorführung';
    el.autoSolveBtn.classList.remove('active');
    el.newBatchBtn.disabled = false;
    el.sortTrayBtn.disabled = false;
}

function autoPlacePiece(piece) {
    const target = piece.el;
    if (!target.parentNode) {
        el.stage.appendChild(target);
        const offsets = getStageOffsets();
        target.style.left = (offsets.tray.x + offsets.tray.w / 2 - piece.w / 2) + 'px';
        target.style.top = (offsets.tray.y + offsets.tray.h / 2 - piece.h / 2) + 'px';
        target.style.transform = 'rotate(0deg)';
        target.classList.remove('placed');
    }
    target.style.zIndex = String(++topZ);
    void target.offsetWidth; // Reflow erzwingen, damit die Startposition vor dem Uebergang greift

    target.classList.add('snap-anim');
    target.style.left = piece.targetX + 'px';
    target.style.top = piece.targetY + 'px';
    target.style.transform = 'rotate(0deg)';
    target.style.zIndex = '1';
    finalizePlacement(piece);
}

async function toggleAutoSolve() {
    if (autoSolveActive) {
        stopAutoSolve();
        return;
    }
    const puzzle = state.puzzle;
    if (!puzzle) return;

    const remaining = puzzle.pieces.filter(p => p.status !== 'placed');
    if (remaining.length === 0) return;
    remaining.sort((a, b) => (a.r - b.r) || (a.c - b.c));

    const myToken = ++autoSolveToken;
    autoSolveActive = true;
    el.autoSolveBtn.textContent = '■ Stoppen';
    el.autoSolveBtn.classList.add('active');
    el.newBatchBtn.disabled = true;
    el.sortTrayBtn.disabled = true;

    const stepDelay = Math.max(35, Math.min(220, 6000 / remaining.length));

    for (const piece of remaining) {
        if (autoSolveToken !== myToken) return;
        if (piece.status !== 'placed') autoPlacePiece(piece);
        await sleep(stepDelay);
    }

    if (autoSolveToken === myToken) stopAutoSolve();
}

/* ---------------------------------------------------------------------
 * Belohnungs-Effekt: Schlangenwelle ueber alle Teile beim Fertigstellen
 * ------------------------------------------------------------------- */

function computeSnakeOrder(puzzle) {
    const order = [];
    for (let r = 0; r < puzzle.rows; r++) {
        if (r % 2 === 0) {
            for (let c = 0; c < puzzle.cols; c++) order.push(puzzle.pieces[r * puzzle.cols + c]);
        } else {
            for (let c = puzzle.cols - 1; c >= 0; c--) order.push(puzzle.pieces[r * puzzle.cols + c]);
        }
    }
    return order;
}

function playCompletionEffect(puzzle) {
    const order = computeSnakeOrder(puzzle);
    const total = order.length;
    const stepDelay = Math.max(3, Math.min(80, 3000 / total));

    order.forEach((piece, i) => {
        setTimeout(() => {
            const target = piece.el;
            if (!target) return;
            target.classList.add('wiggle');
            setTimeout(() => target.classList.remove('wiggle'), 550);
        }, i * stepDelay);
    });
}

/* ---------------------------------------------------------------------
 * Fortschritt: localStorage
 * ------------------------------------------------------------------- */

function persistProgress() {
    const puzzle = state.puzzle;
    if (!puzzle) return;
    const placedIds = puzzle.pieces.filter(p => p.status === 'placed').map(p => p.id);
    const data = {
        version: 1,
        motif: state.selectedMotif,
        pieceCount: puzzle.pieceCount,
        seed: puzzle.seed,
        placedIds
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
}

function loadSavedProgress() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

function clearSavedProgress() { localStorage.removeItem(LS_KEY); }

function updateProgressBar() {
    const puzzle = state.puzzle;
    if (!puzzle) return;
    const placed = puzzle.pieces.filter(p => p.status === 'placed').length;
    const total = puzzle.pieces.length;
    el.progressLabel.textContent = placed + ' / ' + total + (placed === total ? '  🎉 Fertig!' : '');
    el.progressFill.style.width = (100 * placed / total) + '%';
}

/* ---------------------------------------------------------------------
 * Puzzle starten / fortsetzen
 * ------------------------------------------------------------------- */

function clearCurrentPuzzleDom() {
    dragCtx = null;
    stopAutoSolve();
    el.stage.querySelectorAll('.piece').forEach(node => node.remove());
    el.boardGhost.style.backgroundImage = 'none';
}

async function resolveImageSource(motif) {
    if (motif.type === 'preset') {
        return loadPresetImage(getMotifById(motif.id).url);
    }
    const blob = await loadCustomImageBlob();
    if (!blob) throw new Error('Kein eigenes Bild gespeichert.');
    return loadBlobImage(blob);
}

async function startPuzzle(options) {
    options = options || {};
    const motif = options.motif || state.selectedMotif;
    const pieceCount = options.pieceCount || state.selectedCount;
    const seed = options.seed || Math.floor(Math.random() * 2147483647);
    const placedIds = options.placedIds || [];

    if (!motif) return;

    showError('');
    el.startBtn.disabled = true;
    el.startBtn.textContent = 'Lädt...';

    try {
        const imageSource = await resolveImageSource(motif);

        clearCurrentPuzzleDom();

        el.configPanel.style.display = 'none';
        el.resumeBanner.style.display = 'none';
        el.gameArea.style.display = 'flex';
        el.progressBar.style.display = 'flex';
        document.body.classList.add('in-game');

        await new Promise(requestAnimationFrame);

        const puzzle = await generatePuzzle(imageSource, pieceCount, seed);
        state.puzzle = puzzle;
        state.selectedMotif = motif;

        positionBoardAndGhost(puzzle);

        placedIds.forEach(id => {
            const piece = puzzle.pieces.find(p => p.id === id);
            if (piece) piece.status = 'placed';
        });

        puzzle.pieces.forEach(piece => {
            attachDragHandlers(piece);
            if (piece.status === 'placed') {
                el.stage.appendChild(piece.el);
                piece.el.style.left = piece.targetX + 'px';
                piece.el.style.top = piece.targetY + 'px';
                piece.el.style.zIndex = '1';
                piece.el.classList.add('placed');
            }
        });

        refillTray();
        updateProgressBar();
        updateCreditFooter();
        persistProgress();
    } catch (err) {
        console.error(err);
        showError('Fehler beim Laden des Bildes. Bitte anderes Motiv/Bild versuchen.');
        document.body.classList.remove('in-game');
        el.configPanel.style.display = 'flex';
        el.gameArea.style.display = 'none';
        el.progressBar.style.display = 'none';
    } finally {
        el.startBtn.disabled = !state.selectedMotif;
        el.startBtn.textContent = 'Neues Puzzle starten';
    }
}

function backToConfig() {
    stopAutoSolve();
    document.body.classList.remove('in-game');
    el.gameArea.style.display = 'none';
    el.progressBar.style.display = 'none';
    el.configPanel.style.display = 'flex';
}

/* ---------------------------------------------------------------------
 * Resize-Handling (Repositionierung, keine Neuberechnung der Kanten)
 * ------------------------------------------------------------------- */

let resizeTimer = null;
window.addEventListener('resize', () => {
    if (!state.puzzle) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const puzzle = state.puzzle;
        positionBoardAndGhost(puzzle);
        puzzle.pieces.forEach(p => {
            if (p.status === 'placed') {
                p.el.style.left = p.targetX + 'px';
                p.el.style.top = p.targetY + 'px';
            } else if (p.status === 'loose') {
                p.status = 'pool';
                if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
            }
        });
        refillTrayKeepExisting();
    }, 200);
});

function refillTrayKeepExisting() {
    // Bereits im Tisch befindliche Teile werden nur neu gestreut,
    // fehlende Plaetze werden aus dem Pool aufgefuellt.
    const puzzle = state.puzzle;
    const trayCount = puzzle.pieces.filter(p => p.status === 'tray').length;
    if (trayCount < TRAY_BATCH_SIZE) {
        const poolPieces = shuffle(puzzle.pieces.filter(p => p.status === 'pool'));
        poolPieces.slice(0, TRAY_BATCH_SIZE - trayCount).forEach(p => { p.status = 'tray'; });
    }
    scatterTray();
}

/* ---------------------------------------------------------------------
 * Resume-Banner
 * ------------------------------------------------------------------- */

function initResumeBanner() {
    const saved = loadSavedProgress();
    if (!saved) return;
    el.resumeText.textContent = `Gespeichertes Puzzle gefunden (${saved.placedIds.length} Teile platziert).`;
    el.resumeBanner.style.display = 'flex';

    el.resumeContinueBtn.addEventListener('click', () => {
        startPuzzle({
            motif: saved.motif,
            pieceCount: saved.pieceCount,
            seed: saved.seed,
            placedIds: saved.placedIds
        });
    });

    el.resumeDiscardBtn.addEventListener('click', () => {
        clearSavedProgress();
        el.resumeBanner.style.display = 'none';
    });
}

/* ---------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------- */

async function init() {
    renderMotifOptions();
    renderCountOptions();
    updateStartButtonState();

    try {
        const blob = await loadCustomImageBlob();
        if (blob) {
            const bitmap = await createImageBitmap(blob);
            const c = document.createElement('canvas');
            const maxSide = 200;
            const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
            c.width = Math.round(bitmap.width * scale);
            c.height = Math.round(bitmap.height * scale);
            c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
            state.customThumb = c.toDataURL('image/jpeg', 0.6);
            refreshUploadTile();
        }
    } catch (e) { /* kein gespeichertes Bild, ignorieren */ }

    el.uploadInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) handleUpload(e.target.files[0]);
        e.target.value = '';
    });

    el.startBtn.addEventListener('click', () => {
        if (loadSavedProgress()) {
            const ok = confirm('Ein gespeichertes Puzzle wird dabei ueberschrieben. Neues Puzzle starten?');
            if (!ok) return;
        }
        clearSavedProgress();
        startPuzzle();
    });

    el.newBatchBtn.addEventListener('click', refillTray);
    el.sortTrayBtn.addEventListener('click', sortTray);
    el.autoSolveBtn.addEventListener('click', toggleAutoSolve);
    el.backToConfigBtn.addEventListener('click', backToConfig);

    initResumeBanner();
}

document.addEventListener('DOMContentLoaded', init);
