const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas(); // Initial call

// Game state
let score = 0;
let player;
let projectiles = [];
let particles = [];
let trenchObstacles = [];
let enemies = []; 
let keys = {};
let frame = 0;
let gameState = 'playing'; // 'playing', 'escaping', 'win', 'lose'
let escapeTimer = 0;

// 3D settings
const fov = 600;
const trenchLength = 30000;
let cameraZ = 0;
let exhaustPort;

// 3D WORLD-SPACE DIMENSIONS
const TRENCH_WIDTH = 300; 
const TRENCH_HEIGHT = 200;

// --- 3D Projection Logic (First Person) ---
function project(x, y, z) {
    const rx = x - player.x;
    const ry = y - player.y;
    const rz = z - cameraZ;

    if (rz < 10) return { isVisible: false }; 
    
    const scale = fov / rz;
    const px = rx * scale + canvas.width / 2;
    const py = ry * scale + canvas.height / 2;
    
    return { x: px, y: py, scale: scale, isVisible: true };
}

class Player {
    constructor() { this.x = 0; this.y = 0; this.z = 0; this.alive = true; }
    draw() {
        if (!this.alive) return;
        const cx = canvas.width / 2; const cy = canvas.height / 2; const size = 15; 
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.9)'; ctx.lineWidth = 1.2; 
        ctx.strokeRect(cx - size, cy - size, size * 2, size * 2);
        ctx.beginPath(); ctx.moveTo(cx - size * 1.5, cy); ctx.lineTo(cx + size * 1.5, cy);
        ctx.moveTo(cx, cy - size * 1.5); ctx.lineTo(cx, cy + size * 1.5); ctx.stroke();
    }
    update() {
        if (!this.alive) return;
        const moveSpeedX = 6; const moveSpeedY = 5;
        if (keys['ArrowLeft']) this.x -= moveSpeedX;
        if (keys['ArrowRight']) this.x += moveSpeedX;
        if (keys['ArrowUp']) this.y -= moveSpeedY;
        if (keys['ArrowDown']) this.y += moveSpeedY;
        const margin = 20;
        this.x = Math.max(-(TRENCH_WIDTH - margin), Math.min(TRENCH_WIDTH - margin, this.x));
        this.y = Math.max(-(TRENCH_HEIGHT - margin), Math.min(TRENCH_HEIGHT - margin, this.y));
    }
}

class Projectile {
    constructor(startX, startY, startZ, targetX, targetY, targetZ) {
        this.x = startX; this.y = startY; this.z = startZ;
        this.color = '#FF3333'; const speed = 150; 
        const distZ = targetZ - startZ; const steps = distZ / speed;
        this.vx = (targetX - startX) / steps; this.vy = (targetY - startY) / steps; this.vz = speed; this.length = 400; 
    }
    draw() {
        const relativeZ_start = this.z - cameraZ; if (relativeZ_start < 10) return;
        const start = project(this.x, this.y, this.z);
        const end = project(this.x - (this.vx * 2), this.y - (this.vy * 2), this.z - this.length); 
        if(!start.isVisible) return;
        ctx.strokeStyle = this.color; ctx.lineWidth = 1; 
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    }
    update() { this.x += this.vx; this.y += this.vy; this.z += this.vz; }
}

class Enemy {
    constructor(z) {
        this.z = z;
        this.x = (Math.random() - 0.5) * (TRENCH_WIDTH * 0.6);
        this.y = (Math.random() - 0.5) * (TRENCH_HEIGHT * 1.5);
        this.size = 20; this.color = '#AAAAAA'; this.alive = true;
        this.vertices = [];
        for(let i=0; i<6; i++) { const angle = i * Math.PI / 3; this.vertices.push({x: -25 + Math.cos(angle)*20, y: Math.sin(angle)*20, z: 0}); }
        for(let i=0; i<6; i++) { const angle = i * Math.PI / 3; this.vertices.push({x: 25 + Math.cos(angle)*20, y: Math.sin(angle)*20, z: 0}); }
        this.vertices.push({x:0, y:0, z:0});
    }
    update() { this.z -= 10; this.x += Math.sin(frame * 0.05 + this.z) * 2; }
    draw() {
        const relativeZ = this.z - cameraZ; if (relativeZ < 10) return;
        const proj = project(this.x, this.y, this.z); if (!proj.isVisible) return;
        ctx.strokeStyle = this.color; ctx.lineWidth = 1.5; ctx.beginPath();
        const p = (v) => project(this.x + v.x, this.y + v.y, this.z + v.z);
        let start = p(this.vertices[0]); ctx.moveTo(start.x, start.y);
        for(let i=1; i<6; i++) { const pt = p(this.vertices[i]); ctx.lineTo(pt.x, pt.y); } ctx.lineTo(start.x, start.y);
        start = p(this.vertices[6]); ctx.moveTo(start.x, start.y);
        for(let i=7; i<12; i++) { const pt = p(this.vertices[i]); ctx.lineTo(pt.x, pt.y); } ctx.lineTo(start.x, start.y);
        const pod = p(this.vertices[12]); const lw = p(this.vertices[0]); const rw = p(this.vertices[6]);
        ctx.moveTo(lw.x, lw.y); ctx.lineTo(pod.x, pod.y); ctx.moveTo(rw.x, rw.y); ctx.lineTo(pod.x, pod.y); ctx.stroke();
    }
}

class TrenchObstacle {
    constructor(z) {
        this.z = z;
        const thickness = Math.random() * 40 + 20; 
        const height = (TRENCH_HEIGHT * 2) - thickness;
        const up = Math.random() > 0.5;
        this.y_base = (Math.random() - 0.5) * height;
        this.y_tip = this.y_base + (up ? thickness : -thickness);
        
        const colors = ['#3399FF', '#FF3333', '#33FF99', '#FFFF33'];
        this.color = colors[Math.floor(Math.random() * colors.length)];
        
        const x_left = -TRENCH_WIDTH; const x_right = TRENCH_WIDTH;
        const z_front = 0; const z_back = 20;
        
        this.vertices = [
            {x: x_left, y: this.y_base, z: z_front}, {x: x_left, y: this.y_base, z: z_back}, {x: x_left, y: this.y_tip, z: (z_front + z_back)/2},
            {x: x_right, y: this.y_base, z: z_front}, {x: x_right, y: this.y_base, z: z_back}, {x: x_right, y: this.y_tip, z: (z_front + z_back)/2},
        ];
        this.edges = [{f:0,t:1}, {f:1,t:2}, {f:2,t:0}, {f:3,t:4}, {f:4,t:5}, {f:5,t:3}, {f:0,t:3}, {f:1,t:4}, {f:2,t:5}];
    }
    
    draw() {
        if (this.z < cameraZ + 10) return; 
        const r = parseInt(this.color.slice(1, 3), 16);
        const g = parseInt(this.color.slice(3, 5), 16);
        const b = parseInt(this.color.slice(5, 7), 16);
        
        const dist = this.z - cameraZ;
        const dynamicWidth = Math.min(2, Math.max(0.5, 800 / dist));

        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.15)`; 
        
        const pts = this.vertices.map(v => project(v.x, v.y, this.z + v.z));
        if (pts.every(p => p.isVisible)) {
            // Simple logic: draw two main faces (front/back) and side connectors
            // Just filling the main projected shape logic for visual effect
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.fill();
            ctx.beginPath(); ctx.moveTo(pts[3].x, pts[3].y); ctx.lineTo(pts[4].x, pts[4].y); ctx.lineTo(pts[5].x, pts[5].y); ctx.fill();
            
            // Connectors fill
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[3].x, pts[3].y); ctx.lineTo(pts[5].x, pts[5].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.fill();
            ctx.beginPath(); ctx.moveTo(pts[1].x, pts[1].y); ctx.lineTo(pts[4].x, pts[4].y); ctx.lineTo(pts[5].x, pts[5].y); ctx.lineTo(pts[2].x, pts[2].y); ctx.fill();
        }

        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.8)`; ctx.lineWidth = dynamicWidth; 
        ctx.beginPath();
        this.edges.forEach(edge => {
            const v1 = this.vertices[edge.f]; const v2 = this.vertices[edge.t];
            const p1 = project(v1.x, v1.y, this.z + v1.z); const p2 = project(v2.x, v2.y, this.z + v2.z);
            if(p1.isVisible && p2.isVisible) { ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
        });
        ctx.stroke();
    }
        
    checkCollision(player){ 
        const dz = (cameraZ + 20) - this.z; 
        if (dz > 0 && dz < 40) {
            const top_y = Math.max(this.y_base, this.y_tip);
            const bottom_y = Math.min(this.y_base, this.y_tip);
            if (player.y > bottom_y && player.y < top_y) return true;
        }
        return false;
    }
}

class ExhaustPort {
     constructor(z) { this.x = 0; this.y = 0; this.z = z; this.size = 30; this.hit = false; }
    draw() {
        if (this.hit) return;
        const proj = project(this.x, this.y, this.z); if(!proj.isVisible) return;
        ctx.strokeStyle = 'yellow'; ctx.lineWidth = 3 * proj.scale;
        ctx.beginPath(); ctx.arc(proj.x, proj.y, this.size * proj.scale, 0, Math.PI * 2); ctx.stroke();
        for(let i=0; i<8; i++) {
            const angle = (i / 8) * Math.PI * 2; const r = this.size * proj.scale * 2;
            ctx.beginPath(); ctx.moveTo(proj.x + Math.cos(angle)*r*0.5, proj.y + Math.sin(angle)*r*0.5);
            ctx.lineTo(proj.x + Math.cos(angle)*r, proj.y + Math.sin(angle)*r); ctx.stroke();
        }
    }
    isHitBy(proj){
        if(this.hit) return false;
        const dz = Math.abs(proj.z - this.z);
        const dx = Math.abs(proj.x - this.x); const dy = Math.abs(proj.y - this.y);
        if(dz < 200 && dx < 80 && dy < 80){ this.hit = true; return true; }
        return false;
    }
}

class Particle {
     constructor(x, y, v, color = '#fff') { 
         this.x = x; this.y = y; this.vx = v.x; this.vy = v.y; 
         this.alpha = 1; this.color = color;
     }
     update() { this.x += this.vx; this.y += this.vy; this.alpha -= 0.03; }
     draw() {
        ctx.strokeStyle = this.color.replace(')', `, ${this.alpha})`).replace('rgb', 'rgba'); 
        if(this.color.startsWith('#')) ctx.strokeStyle = `rgba(255,255,255,${this.alpha})`; 
        
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(this.x - this.vx * 5, this.y - this.vy * 5); ctx.stroke();
    }
}
function createExplosion(x, y, count, color = '#fff') {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 5 + 1;
        particles.push(new Particle(x, y, { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed }, color));
    }
}

function drawTrench() {
    const segments = 50; const segmentLength = 1000; 
    const shimmerAlpha = 0.03 + Math.sin(frame * 0.1) * 0.01;
    const corners = [ {x: -TRENCH_WIDTH, y: TRENCH_HEIGHT}, {x: TRENCH_WIDTH, y: TRENCH_HEIGHT}, {x: -TRENCH_WIDTH, y: -TRENCH_HEIGHT}, {x: TRENCH_WIDTH, y: -TRENCH_HEIGHT} ];
    ctx.strokeStyle = '#00FF00';

    corners.forEach(corner => {
        for(let i=0; i<segments; i++){
             const z1 = Math.floor(cameraZ / segmentLength) * segmentLength + (i * segmentLength);
             const z2 = z1 + segmentLength;
             if(z1 > trenchLength) break;
             if(z2 < cameraZ + 10) continue;
             const p1 = project(corner.x, corner.y, z1);
             const p2 = project(corner.x, corner.y, z2);
             if(p1.isVisible && p2.isVisible){
                 const dist = (z1 + z2)/2 - cameraZ;
                 const width = Math.min(1, Math.max(0.1, 500 / dist));
                 ctx.lineWidth = width;
                 ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
             }
        }
    });

    const startIdx = Math.floor(cameraZ / segmentLength);
    for (let i = 0; i < segments - 1; i++) {
        const z1 = (startIdx + i) * segmentLength;
        const z2 = z1 + segmentLength;
        if (z1 > trenchLength) break;
        if (z1 < cameraZ + 10) continue;

        const pF1L = project(-TRENCH_WIDTH, TRENCH_HEIGHT, z1);
        const pF1R = project(TRENCH_WIDTH, TRENCH_HEIGHT, z1);
        const pC1L = project(-TRENCH_WIDTH, -TRENCH_HEIGHT, z1);
        const pC1R = project(TRENCH_WIDTH, -TRENCH_HEIGHT, z1);
        const pF2L = project(-TRENCH_WIDTH, TRENCH_HEIGHT, z2);
        const pF2R = project(TRENCH_WIDTH, TRENCH_HEIGHT, z2);
        const pC2L = project(-TRENCH_WIDTH, -TRENCH_HEIGHT, z2);
        const pC2R = project(TRENCH_WIDTH, -TRENCH_HEIGHT, z2);

        if(pF1L.isVisible && pF1R.isVisible && pC1L.isVisible && pC1R.isVisible && pF2L.isVisible && pF2R.isVisible && pC2L.isVisible && pC2R.isVisible) {
            const dist = z1 - cameraZ;
            const width = Math.min(1, Math.max(0.1, 500 / dist));
            const panelAlpha = shimmerAlpha * Math.max(0, 1 - dist / 5000); 
            ctx.lineWidth = width;
            ctx.fillStyle = `rgba(0, 255, 0, ${panelAlpha})`;
            
            ctx.beginPath(); ctx.moveTo(pF1L.x, pF1L.y); ctx.lineTo(pF2L.x, pF2L.y); ctx.lineTo(pC2L.x, pC2L.y); ctx.lineTo(pC1L.x, pC1L.y); ctx.fill();
            ctx.beginPath(); ctx.moveTo(pF1R.x, pF1R.y); ctx.lineTo(pF2R.x, pF2R.y); ctx.lineTo(pC2R.x, pC2R.y); ctx.lineTo(pC1R.x, pC1R.y); ctx.fill();
            ctx.beginPath(); ctx.moveTo(pF1L.x, pF1L.y); ctx.lineTo(pF2L.x, pF2L.y); ctx.lineTo(pF2R.x, pF2R.y); ctx.lineTo(pF1R.x, pF1R.y); ctx.fill();

            ctx.strokeStyle = '#00FF00';
            ctx.beginPath();
            ctx.moveTo(pF1L.x, pF1L.y); ctx.lineTo(pF1R.x, pF1R.y);
            ctx.moveTo(pC1L.x, pC1L.y); ctx.lineTo(pC1R.x, pC1R.y);
            ctx.moveTo(pF1L.x, pF1L.y); ctx.lineTo(pC1L.x, pC1L.y);
            ctx.moveTo(pF1R.x, pF1R.y); ctx.lineTo(pC1R.x, pC1R.y);
            ctx.stroke();
        }
    }
}

// --- NEW: Enhanced Escape Sequence Logic ---
function drawDeathStarEscape() {
    escapeTimer++;
    
    // Background (Fixed black)
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Camera Shake Logic (Simulates ship shaking from shockwave)
    let shakeX = 0;
    let shakeY = 0;
    // Shake starts shortly after explosion begins
    if (escapeTimer > 300 && escapeTimer < 500) {
        shakeX = (Math.random() - 0.5) * 20; // Strong shake
        shakeY = (Math.random() - 0.5) * 20;
    }

    ctx.save(); // Save context state
    ctx.translate(shakeX, shakeY); // Apply shake to everything drawn below

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    
    // Distance increases (flying away)
    const dist = 500 + (escapeTimer * 12); 
    let radius = 250 * (500 / dist);
    
    if (escapeTimer < 300) {
        // --- PHASE 1: The Retreat ---
        // Implosion effect right before boom
        if(escapeTimer > 280) {
            radius *= (1 - (escapeTimer - 280) / 40); // Shrink slightly
            ctx.strokeStyle = '#FFFFFF'; // Flash white
            ctx.lineWidth = 3;
        } else {
            ctx.strokeStyle = '#00FF00'; // Green Wireframe
            ctx.lineWidth = 1.5;
        }

        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
        
        // Latitude/Longitude lines
        ctx.beginPath(); ctx.ellipse(cx, cy, radius, radius * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx, cy, radius * 0.3, radius, 0, 0, Math.PI * 2); ctx.stroke();
        
        // Superlaser dish
        ctx.beginPath(); ctx.arc(cx - radius * 0.3, cy - radius * 0.3, radius * 0.25, 0, Math.PI * 2); ctx.stroke();

    } else if (escapeTimer === 300) {
        // --- PHASE 2: The BOOM ---
        // Massive particle spawn
        createExplosion(cx, cy, 400, '#FFFF00'); // Fire
        createExplosion(cx, cy, 200, '#FFFFFF'); // Hot core
        createExplosion(cx, cy, 300, '#00FF00'); // Debris
    } else if (escapeTimer > 300 && escapeTimer < 800) {
        // --- PHASE 3: The Aftermath ---
        const explosionAge = escapeTimer - 300;
        
        // Expanding Shockwaves (Slower and Majestic)
        // Ring 1 (Fire/Orange)
        const ring1 = explosionAge * 8; // Slower expansion
        ctx.strokeStyle = `rgba(255, 100, 0, ${Math.max(0, 1 - explosionAge/200)})`;
        ctx.lineWidth = 15;
        ctx.beginPath(); ctx.arc(cx, cy, ring1, 0, Math.PI*2); ctx.stroke();

        // Ring 2 (Deep Red/Heat)
        const ring2 = explosionAge * 4; // Even slower
        ctx.strokeStyle = `rgba(255, 0, 0, ${Math.max(0, 1 - explosionAge/400)})`;
        ctx.lineWidth = 30;
        ctx.beginPath(); ctx.arc(cx, cy, ring2, 0, Math.PI*2); ctx.stroke();
    } else if (escapeTimer > 800) {
        gameState = 'win';
    }
    
    // Update and draw particles (Debris flying towards camera)
    particles.forEach(p => { 
        p.x += (p.x - canvas.width/2) * 0.05;
        p.y += (p.y - canvas.height/2) * 0.05;
        p.update(); 
        p.draw(); 
    });

    ctx.restore(); // Restore context to remove shake for next frame/UI
}

function init() {
    player = new Player();
    exhaustPort = new ExhaustPort(trenchLength);
    cameraZ = 0; score = 0; escapeTimer = 0;
    projectiles = []; particles = []; trenchObstacles = []; enemies = []; keys = {};
    frame = 0; gameState = 'playing';
    
    for(let i = 0; i < 10; i++){
        const baseZ = 2000 + i * (trenchLength / 12);
        const randomOffset = (Math.random() - 0.5) * 1500;
        trenchObstacles.push(new TrenchObstacle(baseZ + randomOffset));
    }
    for(let i=0; i<3; i++) {
        enemies.push(new Enemy(3000 + i * 8000));
    }
}

function updateAndDraw() {
    if (player.alive) cameraZ += 30; 
    player.update();
    
    if (frame % 400 === 0 && enemies.length < 3) { enemies.push(new Enemy(cameraZ + 5000)); }

    projectiles.forEach((p, i) => {
        p.update();
        if ((p.z - cameraZ) > 4000) { setTimeout(() => projectiles.splice(i, 1), 0); }
    });
    enemies.forEach((e, i) => {
        e.update();
        if (e.z < cameraZ - 100) enemies.splice(i, 1);
    });

    ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    drawTrench();
    trenchObstacles.forEach(obs => obs.draw());
    enemies.forEach(e => e.draw());
    exhaustPort.draw();
    projectiles.forEach(p => p.draw());
    particles.forEach((p, i) => { if (p.alpha <= 0) particles.splice(i, 1); else p.update(); p.draw();});
    player.draw(); 

    ctx.fillStyle = 'white'; ctx.font = '24px "Orbitron", sans-serif';
    ctx.textAlign = 'left'; ctx.fillText(`Score: ${score}`, 20, 40);
    const distance = Math.max(0, trenchLength - cameraZ);
    ctx.textAlign = 'right'; ctx.fillText(`Target: ${Math.floor(distance / 100)}m`, canvas.width - 20, 40);
}

function detectCollisions() {
    trenchObstacles.forEach(obs => {
        if(player.alive && obs.checkCollision(player)){
            createExplosion(canvas.width/2, canvas.height/2, 50); 
            player.alive = false;
            setTimeout(() => gameState = 'lose', 1000);
        }
    });
    
    projectiles.forEach((p, pIdx) => {
        enemies.forEach((e, eIdx) => {
            const dz = Math.abs(p.z - e.z); const dx = Math.abs(p.x - e.x); const dy = Math.abs(p.y - e.y);
            if (dz < 100 && dx < 40 && dy < 40) {
                const projPos = project(e.x, e.y, e.z);
                if(projPos.isVisible) createExplosion(projPos.x, projPos.y, 30);
                enemies.splice(eIdx, 1); projectiles.splice(pIdx, 1); score += 100;
            }
        });
        
        if (exhaustPort.isHitBy(p)) { 
            score += 10000; 
            gameState = 'escaping'; 
        }
    });

    enemies.forEach(e => {
        const dz = Math.abs((cameraZ + 20) - e.z);
        if (dz < 50 && Math.abs(player.x - e.x) < 40 && Math.abs(player.y - e.y) < 40) {
             createExplosion(canvas.width/2, canvas.height/2, 50);
             player.alive = false;
             setTimeout(() => gameState = 'lose', 1000);
        }
    });
}

function showEndScreen(win) {
    const title = win ? "THE FORCE IS STRONG WITH THIS ONE" : "YOU HAVE FAILED";
    const color = win ? "cyan" : "red";
    if (win && frame % 5 === 0) createExplosion(canvas.width/2, canvas.height/2, 5);
    ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {p.update(); p.draw();});
    ctx.fillStyle = color; ctx.font = '36px "Orbitron", sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 50);
    ctx.fillStyle = 'white'; ctx.font = '20px "Orbitron"';
    ctx.fillText(`Final Score: ${score}`, canvas.width / 2, canvas.height / 2 + 20);
    ctx.fillText('Press Space to play again', canvas.width / 2, canvas.height / 2 + 70);
}

function animate() {
    frame++;
    if(gameState === 'playing') {
        updateAndDraw();
        detectCollisions();
        if (cameraZ >= trenchLength && player.alive) gameState = 'lose';
    } else if (gameState === 'escaping') {
        drawDeathStarEscape(); 
    } else if (gameState === 'win') {
        showEndScreen(true);
    } else if (gameState === 'lose') {
        showEndScreen(false);
    }
    requestAnimationFrame(animate);
}

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && (gameState === 'win' || gameState === 'lose')) init();
    else {
        keys[e.code] = true;
        if (e.code === 'Space' && gameState === 'playing' && player.alive) {
            const aimDist = 1500;
            const targetX = player.x; 
            const targetY = player.y;
            const targetZ = cameraZ + aimDist;
            const spreadX = 400; const spreadY = 250;
            const offsets = [{x: -spreadX, y: -spreadY}, {x: spreadX, y: -spreadY}, {x: -spreadX, y: spreadY}, {x: spreadX, y: spreadY}];
            offsets.forEach(off => {
                 projectiles.push(new Projectile(player.x + off.x, player.y + off.y, cameraZ + 10, targetX, targetY, targetZ));
            });
            score -= 5;
        }
        if (e.code === 'KeyF') {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.log(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
                });
            } else {
                if (document.exitFullscreen) { document.exitFullscreen(); }
            }
        }
        if (e.code === 'Escape') {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage('closeGame', '*');
            } else {
                window.location.href = '../index.html';
            }
        }
    }
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

// --- MOBILE CONTROLS ---
function isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 0 && window.innerWidth <= 1024);
}

if (isMobile()) {
    // Auto-fullscreen on first interaction (touchend/click are safer for user gestures)
    const goFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    };
    document.addEventListener('touchend', goFullscreen, { passive: false });
    document.addEventListener('click', goFullscreen, { passive: false });

    // Swipe Down for Escape
    let touchStartY = 0;
    let touchStartX = 0;
    document.addEventListener('touchstart', e => {
        touchStartY = e.changedTouches[0].screenY;
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: false });

    document.addEventListener('touchend', e => {
        const touchEndY = e.changedTouches[0].screenY;
        const touchEndX = e.changedTouches[0].screenX;
        
        if (touchEndY - touchStartY > 100 && Math.abs(touchEndX - touchStartX) < 100) {
             if (window.parent && window.parent !== window) {
                window.parent.postMessage('closeGame', '*');
            } else {
                window.location.href = '../index.html';
            }
        }
    }, { passive: false });

    const mobileControls = document.getElementById('mobile-controls');
    if (mobileControls) {
        mobileControls.style.display = 'flex';
        
        const setupBtn = (id, code) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            
            const activate = (e) => {
                e.preventDefault();
                keys[code] = true;
                btn.classList.add('active');
                
                // Special handling for Space (Restart/Fire)
                if (code === 'Space') {
                    if (gameState === 'win' || gameState === 'lose') {
                        init();
                    }
                }
            };

            const deactivate = (e) => {
                e.preventDefault();
                keys[code] = false;
                btn.classList.remove('active');
            };

            btn.addEventListener('touchstart', activate, { passive: false });
            btn.addEventListener('touchend', deactivate, { passive: false });
            btn.addEventListener('touchcancel', deactivate, { passive: false });
            btn.addEventListener('mousedown', activate);
            btn.addEventListener('mouseup', deactivate);
            btn.addEventListener('mouseleave', deactivate);
        };

        setupBtn('btnUp', 'ArrowUp');
        setupBtn('btnDown', 'ArrowDown');
        setupBtn('btnLeft', 'ArrowLeft');
        setupBtn('btnRight', 'ArrowRight');
        setupBtn('btnFire', 'Space');
    }
}

init();
animate();