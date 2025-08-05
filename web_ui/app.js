export async function runApp({ canvas }) {
  const ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // --- AUDIO SETUP ---
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ac.createOscillator();
  const amp = ac.createGain();

  osc.type = 'sine';
  osc.frequency.value = 440; // Test tone: A4
  amp.gain.value = 0.8;

  osc.connect(amp).connect(ac.destination);
  osc.start();
  await ac.resume().then(() => console.log("✅ AudioContext resumed"));

  // --- ANIMATION LOOP ---
  let running = true;
  function loop() {
    if (!running) return;
    drawScene(ctx, canvas);
    requestAnimationFrame(loop);
  }

  loop();

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  // --- SIMPLE DRAW ---
  function drawScene(ctx, canvas) {
    const t = performance.now() / 1000;
    const { width: w, height: h } = canvas;
    const cx = w / 2, cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // background pulse
    ctx.fillStyle = `rgba(30,40,80,1)`;
    ctx.fillRect(0, 0, w, h);

    // pulsing circle
    const radius = 50 + 20 * Math.sin(t * 2);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(180, 220, 255, 0.7)`;
    ctx.fill();

    // text
    ctx.fillStyle = 'white';
    ctx.font = '20px sans-serif';
    ctx.fillText("Stellar Shield Test Mode", cx - 90, cy - 80);
  }

  // --- OPTIONAL: Stop All ---
  window.addEventListener('shield:end', () => {
    running = false;
    try { osc.stop(); ac.close(); } catch (e) {}
    console.log("🛑 Shield stopped.");
  });
}

// --- Global Error Logging ---
window.onerror = function (msg, url, line, col, err) {
  console.error("🔥 JS Error:", msg, "at", line + ":" + col);
  if (err?.stack) console.error(err.stack);
};