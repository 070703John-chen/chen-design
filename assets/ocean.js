/* Procedural ocean background - canvas 2D, no dependencies.
   Markup: <canvas class="ocean" data-variant="hero|band" data-rows="30"></canvas>
   Body class "wave-off" freezes the animation.

   v2 (perf rewrite):
   - no per-row shadowBlur (that was the whole cost); replaced by one specular gradient pass
   - render at 0.75x, DPR capped at 1
   - 30fps cap instead of 60
   - row geometry + colour cached instead of recomputed every frame
   - three quality modes on the nav button: full / lite / off
   - adaptive downgrade: if achieved frame interval stays above 45ms, shed rows -> glow -> freeze
*/
(function () {
  'use strict';

  var reduced = (typeof window.__MOTION === 'boolean') ? !window.__MOTION : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = [];
  var raf = 0;
  var t0 = 0;
  var last = 0;
  var PRESET = {
    full: { rows: 1, step: 9, glow: 1, scale: 0.75, fps: 30 },
    lite: { rows: 0.5, step: 15, glow: 0, scale: 0.5, fps: 24 }
  };
  var QUALITY = { rows: 1, step: 9, glow: 1, scale: 0.75, fps: 30 };
  var ema = 8;                      /* smoothed frame cost, ms */
  var degrades = 0;
  var frozen = false;
  var slowStreak = 0;              /* consecutive slow frames */
  var warmup = 20;                 /* frames ignored after a start / resize */
  var btn = null;
  var mode = 'full';
  var STORE = 'oceanQuality';

  function mix(a, b, t) {
    var ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
    var br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
    return 'rgb(' + Math.round(ar + (br - ar) * t) + ',' +
      Math.round(ag + (bg - ag) * t) + ',' +
      Math.round(ab + (bb - ab) * t) + ')';
  }

  /* 高光色跟随主色：原来写死青蓝（120,220,240 / 196,240,255），
     导致暖色主题下水面仍然是冷青。 */
  function rgbOf(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
  }

  function lighten(hex, k) {
    var c = rgbOf(hex);
    return 'rgba(' + Math.round(c[0] + (255 - c[0]) * k) + ',' +
      Math.round(c[1] + (255 - c[1]) * k) + ',' +
      Math.round(c[2] + (255 - c[2]) * k) + ',';
  }

  function Ocean(canvas) {
    var v = canvas.getAttribute('data-variant') || 'hero';
    this.c = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.o = {
      rows: parseInt(canvas.getAttribute('data-rows') || (v === 'band' ? '34' : '22'), 10),
      colorA: canvas.getAttribute('data-color-a') || '#2FB6C6',
      colorB: canvas.getAttribute('data-color-b') || '#0B3C55',
      alpha: parseFloat(canvas.getAttribute('data-alpha') || (v === 'band' ? '0.5' : '0.42')),
      amp: parseFloat(canvas.getAttribute('data-amp') || (v === 'band' ? '1.15' : '0.85')),
      speed: parseFloat(canvas.getAttribute('data-speed') || '1'),
      horizon: parseFloat(canvas.getAttribute('data-horizon') || (v === 'band' ? '0.12' : '0.2')),
      fill: canvas.getAttribute('data-fill') === '1',
      glow: parseFloat(canvas.getAttribute('data-glow') || '0.9'),
      bgTop: canvas.getAttribute('data-bg-top') || '',
      bgBottom: canvas.getAttribute('data-bg-bottom') || ''
    };
    this.visible = true;
    this.cache = null;
    this.resize();
  }

  Ocean.prototype.resize = function () {
    var c = this.c;
    var w = c.clientWidth || c.offsetWidth || 1;
    var h = c.clientHeight || c.offsetHeight || 1;
    var s = Math.min(window.devicePixelRatio || 1, 1) * QUALITY.scale;
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    this.ctx.setTransform(s, 0, 0, s, 0, 0);
    this.w = w;
    this.h = h;
    this.cache = null;              /* gradients depend on size */
  };

  /* per-row geometry + colour, rebuilt only when row count or size changes */
  Ocean.prototype.build = function () {
    var o = this.o, w = this.w, h = this.h;
    var rows = Math.max(6, Math.round(o.rows * QUALITY.rows));
    var list = [];
    for (var i = 0; i < rows; i++) {
      var p = i / (rows - 1);
      list.push({
        p: p,
        y: h * (o.horizon + (1 - o.horizon) * Math.pow(p, 0.82)),
        amp: (1.6 + 15 * Math.pow(p, 1.7)) * o.amp,
        wl: 70 + 250 * p,
        sp: (0.5 + 0.62 * p) * o.speed,
        a: (0.05 + 0.6 * Math.pow(p, 0.95)) * o.alpha,
        col: mix(o.colorA, o.colorB, p),
        lw: 0.6 + 1.5 * p
      });
    }
    this.rows = list;
    this.cache = { rows: list };

    if (o.bgTop) {
      var g = this.ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, o.bgTop);
      g.addColorStop(1, o.bgBottom || o.bgTop);
      this.bgGrad = g;
    } else {
      this.bgGrad = null;
    }

    /* specular band standing in for the old per-row shadowBlur glow */
    var hy = h * (o.horizon + (1 - o.horizon) * 0.18);
    var sg = this.ctx.createLinearGradient(0, hy - h * 0.18, 0, hy + h * 0.22);
    sg.addColorStop(0, lighten(o.colorA, 0.45) + '0)');
    sg.addColorStop(0.5, lighten(o.colorA, 0.55) + (0.16 * o.glow).toFixed(3) + ')');
    sg.addColorStop(1, lighten(o.colorA, 0.45) + '0)');
    this.specGrad = sg;
  };

  Ocean.prototype.draw = function (t) {
    var ctx = this.ctx, w = this.w, h = this.h, o = this.o;
    if (!this.cache) this.build();
    var rows = this.rows;
    var step = QUALITY.step;

    ctx.clearRect(0, 0, w, h);

    if (this.bgGrad) {
      ctx.fillStyle = this.bgGrad;
      ctx.fillRect(0, 0, w, h);
    }

    /* slow sheen sweeping across the surface */
    var sx = (((t * 0.055 * o.speed) % 1.5) - 0.25) * w;
    var sg = ctx.createLinearGradient(sx - 160, 0, sx + 160, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, lighten(o.colorA, 0.62) + (0.055 * o.glow).toFixed(3) + ')');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h);

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      ctx.beginPath();
      for (var x = -10; x <= w + 10; x += step) {
        var yy = r.y
          + Math.sin((x / r.wl) * 6.28318 + t * r.sp + i * 0.9) * r.amp
          + Math.sin((x / (r.wl * 0.41)) * 6.28318 - t * r.sp * 1.35 + i * 1.7) * r.amp * 0.34;
        if (x === -10) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      if (o.fill) {
        ctx.lineTo(w + 10, h);
        ctx.lineTo(-10, h);
        ctx.closePath();
        ctx.fillStyle = r.col.replace('rgb(', 'rgba(').replace(')', ',' + (r.a * 0.13).toFixed(3) + ')');
        ctx.fill();
        /* rebuild the crest line for the stroke (the fill consumed it) */
        ctx.beginPath();
        for (var x2 = -10; x2 <= w + 10; x2 += step) {
          var y2 = r.y
            + Math.sin((x2 / r.wl) * 6.28318 + t * r.sp + i * 0.9) * r.amp
            + Math.sin((x2 / (r.wl * 0.41)) * 6.28318 - t * r.sp * 1.35 + i * 1.7) * r.amp * 0.34;
          if (x2 === -10) ctx.moveTo(x2, y2);
          else ctx.lineTo(x2, y2);
        }
      }
      ctx.strokeStyle = r.col;
      ctx.globalAlpha = r.a;
      ctx.lineWidth = r.lw;
      ctx.stroke();
    }

    /* one soft glow pass instead of dozens of blurred strokes */
    if (QUALITY.glow) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.specGrad;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalAlpha = 1;
  };

  /* 统一改按钮文案：必须保留 .t-long / .t-short 两个 span，
     直接 textContent 覆盖会把移动端短文案结构抹掉。 */
  function setBtnLabel(short, title) {
    if (!btn) return;
    var lg = btn.querySelector('.t-long'), sm = btn.querySelector('.t-short');
    if (lg && sm) { lg.textContent = short; sm.textContent = '动效'; }
    else btn.textContent = short;
    if (title) btn.title = title;
  }

  function degrade() {
    degrades++;
    slowStreak = 0;
    if (degrades === 1) {
      QUALITY.rows = Math.max(0.3, QUALITY.rows * 0.6);
      QUALITY.step = Math.min(24, QUALITY.step + 5);
    } else if (degrades === 2) {
      QUALITY.glow = 0;
      QUALITY.scale = Math.max(0.4, QUALITY.scale * 0.7);
    } else {
      frozen = true;               /* still too heavy: hold one static frame */
      stop();
      for (var i = 0; i < items.length; i++) items[i].draw(2.2);
      setBtnLabel('动效 省电', '海面帧率过低，已冻结为静帧；内容渐显不受影响。点击可手动切换档位');
      return;
    }
    for (var j = 0; j < items.length; j++) { items[j].resize(); items[j].cache = null; }
  }

  function applyMode(next, byUser) {
    mode = next;
    var p = PRESET[next] || PRESET.full;
    QUALITY = { rows: p.rows, step: p.step, glow: p.glow, scale: p.scale, fps: p.fps };
    degrades = 0;
    frozen = false;
    ema = 8;
    slowStreak = 0;
    warmup = 20;
    try { localStorage.setItem(STORE, next); } catch (e) {}
    /* 动效总开关：静 = 全部静止；全/轻 = 允许内容渐显。
       只有用户主动点击才写进本地存储，初始化时不写，
       否则系统设置会被误当成"用户的选择"固化下来。 */
    if (byUser) {
      try { localStorage.setItem('pg-motion', next === 'off' ? 'off' : 'on'); } catch (e) {}
      window.__MOTION = (next !== 'off');
      document.body.classList.toggle('motion-off', next === 'off');
      /* 打开动效：把视口下方的内容重新武装成待渐显状态 */
      if (next !== 'off' && window.__RV_REARM) window.__RV_REARM();
      else if (window.__RV_SPLASH) window.__RV_SPLASH();
    } else {
      document.body.classList.toggle('motion-off', next === 'off');
    }
    for (var i = 0; i < items.length; i++) { items[i].resize(); items[i].cache = null; }
    if (mode === 'off') {
      document.body.classList.add('wave-off');
      stop();
    } else {
      document.body.classList.remove('wave-off');
      start();
    }
    if (btn) {
      var lbl = mode === 'full' ? '动效 全' : mode === 'lite' ? '动效 轻' : '动效 关';
      var ttl = mode === 'full' ? '动效：全效（含内容渐显）。点击切换到轻量'
        : mode === 'lite' ? '动效：轻量（帧少一半、更省电，内容渐显保留）。点击关闭'
          : '动效已关闭：海面与内容渐显全部静止。点击恢复全效';
      setBtnLabel(lbl, ttl);
      btn.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
    }
  }

  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (last && ts - last < (1000 / QUALITY.fps) - 1) return;
    /* interval between two actually-drawn frames: if the machine cannot keep
       up, this grows past the cap and we drop quality */
    if (last) ema = ema * 0.85 + (ts - last) * 0.15;
    last = ts;
    if (!t0) t0 = ts;
    var t = (ts - t0) / 1000;

    for (var i = 0; i < items.length; i++) {
      if (items[i].visible) items[i].draw(t);
    }
    if (warmup > 0) {
      warmup--;
    } else {
      /* threshold scales with the current cap: full = 30fps, lite = 24fps */
      var slow = ema > (1000 / QUALITY.fps) * 1.6;
      slowStreak = slow ? slowStreak + 1 : 0;
      if (!frozen && slowStreak >= 3 && degrades < 3) {
        degrade();
        warmup = 15;
      }
    }
  }

  function start() {
    if (raf || frozen || document.body.classList.contains('wave-off')) return;
    last = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function init() {
    var list = document.querySelectorAll('canvas.ocean');
    for (var i = 0; i < list.length; i++) {
      var o = new Ocean(list[i]);
      items.push(o);
      if ('ResizeObserver' in window) {
        new ResizeObserver(function () { o.resize(); }).observe(list[i]);
      }
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (ents) {
          ents.forEach(function (e) { o.visible = e.isIntersecting; });
        }, { threshold: 0 });
        io.observe(list[i]);
      }
    }

    btn = document.getElementById('waveBtn');
    if (btn) {
      var saved = null;
      try { saved = localStorage.getItem(STORE); } catch (e) {}
      /* URL 参数优先于本地存储：?sea=off|lite|full
         方便分享链接时直接指定观感（发给老板就带 ?sea=off，省电也不晃眼） */
      var qs = null;
      try { qs = new URLSearchParams(location.search).get('sea'); } catch (e) {}
      var initial = (qs && (qs === 'off' || PRESET[qs])) ? qs
                  : (saved === 'off' || (saved && PRESET[saved])) ? saved
                  : (reduced ? 'off' : 'full');
      applyMode(initial);
      if (qs) { try { localStorage.setItem(STORE, initial); } catch (e) {} }
      btn.addEventListener('click', function () {
        applyMode(mode === 'full' ? 'lite' : mode === 'lite' ? 'off' : 'full', true);
      });
    }

    window.addEventListener('resize', function () {
      for (var i = 0; i < items.length; i++) items[i].resize();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    if (reduced) {
      for (var j = 0; j < items.length; j++) items[j].draw(2.2);
    } else if (mode !== 'off') {
      start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
