// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — Hacker Animation Controller
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[Animations.' + fn + ']', msg); } }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** @type {boolean|null} */
  var _reducedMotionCache = null;

  (function _initReducedMotionCache() {
    if (window.matchMedia) {
      var mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      _reducedMotionCache = mql.matches;
      try {
        mql.addEventListener('change', function (e) {
          _reducedMotionCache = e.matches;
          log('shouldReduceMotion', 'cache invalidated → ' + _reducedMotionCache);
        });
      } catch (_) {
        mql.addListener(function (e) { _reducedMotionCache = e.matches; });
      }
      log('shouldReduceMotion', 'cache init: ' + _reducedMotionCache);
    }
  })();

  /** @returns {boolean} */
  function shouldReduceMotion() {
    if (_reducedMotionCache !== null) { return _reducedMotionCache; }
    var result = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    log('shouldReduceMotion', 'uncached fallback → ' + result);
    return result;
  }

  // ─── State tracking for cleanup ─────────────────────────────────────────

  /** @type {number|null} */
  var matrixRaf = null;
  /** @type {IntersectionObserver|null} */
  var _entranceObserver = null;
  var _entranceAnimClass = 'animate-fade-slide-up';
  var _observedCount = 0;
  /** @type {function|null} */
  var _matrixResizeHandler = null;
  /** @type {HTMLCanvasElement|null} */
  var _matrixCanvas = null;
  /** @type {Object|null} */
  var _matrixConfig = null;
  var _resizeThrottleTimer = null;

  // ─── Constants ─────────────────────────────────────────────────────────

  var RESIZE_THROTTLE_MS = 200;
  var FRAME_BUDGET_MS = 16;
  var OBSERVE_ENTRANCE_LIMIT = 200;
  var PARTICLE_CLEANUP_FALLBACK_MS = 1200;
  var COUNT_LARGE_THRESHOLD = 10000;
  var COUNT_MEDIUM_THRESHOLD = 1000;
  var COUNT_LARGE_SKIP = 50;
  var COUNT_MEDIUM_SKIP = 10;

  // ─── Matrix Rain ───────────────────────────────────────────────────────

  var MATRIX_CHARS_DEFAULT = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ chars?: string }} [config]
   */
  function initMatrixRain(canvas, config) {
    log('initMatrixRain', 'start — config=' + JSON.stringify(config || {}));
    if (shouldReduceMotion()) { log('initMatrixRain', 'reduced-motion → skip'); return; }
    var ctx = canvas.getContext('2d');
    if (!ctx) { log('initMatrixRain', 'no 2d context → abort'); return; }

    config = config || {};
    var chars = config.chars || MATRIX_CHARS_DEFAULT;
    _matrixCanvas = canvas;
    _matrixConfig = config;

    var savedOpacity = parseFloat(canvas.style.opacity) || 0.06;
    var fontSize = 14;
    var columns = 0;
    /** @type {number[]} */
    var drops = [];
    var lastFrameTime = 0;

    function resize() {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      columns = Math.floor(canvas.width / fontSize);
      drops = [];
      for (var c = 0; c < columns; c++) {
        drops[c] = Math.random() * -100;
      }
      log('initMatrixRain', 'resize cols=' + columns + ' w=' + canvas.width + ' h=' + canvas.height);
    }

    function throttledResize() {
      if (_resizeThrottleTimer) { return; }
      _resizeThrottleTimer = setTimeout(function () {
        _resizeThrottleTimer = null;
        resize();
        log('initMatrixRain', 'throttled resize executed');
      }, RESIZE_THROTTLE_MS);
    }

    resize();
    _matrixResizeHandler = throttledResize;
    window.addEventListener('resize', throttledResize);

    function draw(timestamp) {
      matrixRaf = requestAnimationFrame(draw);
      // Dynamic frame-budget: cap at ~60fps
      var delta = timestamp - lastFrameTime;
      if (lastFrameTime > 0 && delta < FRAME_BUDGET_MS) { return; }
      lastFrameTime = timestamp;

      ctx.fillStyle = 'rgba(0, 0, 0, ' + savedOpacity + ')';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = fontSize + 'px monospace';

      for (var i = 0; i < drops.length; i++) {
        var charIdx = Math.floor(Math.random() * chars.length);
        var ch = chars[charIdx];
        var x = i * fontSize;
        var y = drops[i] * fontSize;

        var brightness = Math.random();
        if (brightness > 0.95) {
          ctx.fillStyle = '#ffffff';
        } else if (brightness > 0.8) {
          ctx.fillStyle = '#39ff14';
        } else {
          ctx.fillStyle = 'rgba(0, 255, 65, 0.3)';
        }

        ctx.fillText(ch, x, y);

        if (y > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    }

    matrixRaf = requestAnimationFrame(draw);
    log('initMatrixRain', 'running — charset=' + chars.length + ' cols=' + columns);
  }

  /**
   * Stop matrix rain without destroying other animations.
   */
  function stopMatrix() {
    log('stopMatrix', 'stopping');
    if (matrixRaf) {
      cancelAnimationFrame(matrixRaf);
      matrixRaf = null;
    }
    if (_matrixResizeHandler) {
      window.removeEventListener('resize', _matrixResizeHandler);
      _matrixResizeHandler = null;
    }
    if (_resizeThrottleTimer) {
      clearTimeout(_resizeThrottleTimer);
      _resizeThrottleTimer = null;
    }
    log('stopMatrix', 'stopped');
  }

  /**
   * Restart matrix rain using stored canvas + config.
   */
  function startMatrix() {
    log('startMatrix', 'attempting restart');
    if (matrixRaf) { log('startMatrix', 'already running → skip'); return; }
    if (!_matrixCanvas) { log('startMatrix', 'no canvas stored → abort'); return; }
    initMatrixRain(_matrixCanvas, _matrixConfig);
    log('startMatrix', 'restarted');
  }

  // ─── Count Up ──────────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} element
   * @param {number} targetValue
   * @param {number} [duration]
   * @param {string} [suffix]
   */
  function countUp(element, targetValue, duration, suffix) {
    log('countUp', 'target=' + targetValue);
    duration = duration || 800;
    suffix = suffix || '';
    var startTime = null;
    var startValue = parseInt(element.textContent, 10) || 0;
    var diff = targetValue - startValue;
    if (diff === 0) { return; }

    var lastRendered = startValue;

    function step(timestamp) {
      if (!startTime) { startTime = timestamp; }
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.round(startValue + diff * eased);

      // Frame-skip for large numbers (named thresholds)
      var absDiff = Math.abs(diff);
      var skip = absDiff > COUNT_LARGE_THRESHOLD ? COUNT_LARGE_SKIP : (absDiff > COUNT_MEDIUM_THRESHOLD ? COUNT_MEDIUM_SKIP : 1);
      var shouldRender = progress >= 1 || Math.abs(current - lastRendered) >= skip;

      if (shouldRender) {
        element.textContent = current + suffix;
        lastRendered = current;
      }

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        element.textContent = targetValue + suffix;
        element.style.animation = 'countPop 300ms var(--ease-spring)';
        setTimeout(function () { element.style.animation = ''; }, 300);
      }
    }

    requestAnimationFrame(step);
  }

  // ─── Stagger ───────────────────────────────────────────────────────────

  /**
   * @param {NodeListOf<Element>|Element[]} elements
   * @param {number} [delay]
   * @param {string} [animationName]
   * @returns {number[]} Array of timeout IDs for cancellation
   */
  function stagger(elements, delay, animationName) {
    log('stagger', 'count=' + elements.length + ' delay=' + (delay || 60) + 'ms');
    delay = delay || 60;
    animationName = animationName || 'fadeSlideUp';
    var list = Array.prototype.slice.call(elements);
    /** @type {number[]} */
    var timeoutIds = [];

    function cancel() {
      log('stagger', 'cancel — clearing ' + timeoutIds.length + ' timeouts');
      for (var t = 0; t < timeoutIds.length; t++) { clearTimeout(timeoutIds[t]); }
      timeoutIds = [];
    }

    if (shouldReduceMotion()) {
      log('stagger', 'reduced-motion → instant reveal');
      for (var r = 0; r < list.length; r++) { list[r].style.opacity = '1'; }
      return { cancel: cancel, timeoutIds: timeoutIds };
    }

    for (var i = 0; i < list.length; i++) {
      (function (el, index) {
        el.style.opacity = '0';
        var tid = setTimeout(function () {
          el.style.animationName = animationName;
          el.style.animationDuration = 'var(--duration-slow)';
          el.style.animationTimingFunction = 'var(--ease-out)';
          el.style.animationFillMode = 'forwards';
          log('stagger', 'reveal index=' + index);
        }, index * delay);
        timeoutIds.push(tid);
      })(list[i], i);
    }

    log('stagger', 'scheduled ' + timeoutIds.length + ' reveals');
    return { cancel: cancel, timeoutIds: timeoutIds };
  }

  // ─── Typewriter Text ──────────────────────────────────────────────────

  /**
   * @param {HTMLElement} element
   * @param {string} text
   * @param {number} [speed]
   * @param {function} [callback]
   * @returns {Promise<void>}
   */
  function typeText(element, text, speed, callback) {
    log('typeText', 'len=' + text.length + ' speed=' + (speed || 30));
    speed = speed || 30;

    return new Promise(function (resolve) {
      function dispatchComplete() {
        try {
          element.dispatchEvent(new CustomEvent('typingComplete', { bubbles: true, detail: { text: text } }));
          log('typeText', 'typingComplete event dispatched');
        } catch (_) { log('typeText', 'CustomEvent not supported'); }
      }

      if (shouldReduceMotion()) {
        log('typeText', 'reduced-motion → instant');
        element.textContent = text;
        if (callback) { callback(); }
        dispatchComplete();
        resolve();
        return;
      }
      var idx = 0;
      element.textContent = '';

      function tick() {
        if (idx < text.length) {
          element.textContent += text[idx];
          idx++;
          setTimeout(tick, speed);
        } else {
          log('typeText', 'typing complete');
          if (callback) { callback(); }
          dispatchComplete();
          resolve();
        }
      }
      tick();
    });
  }

  // ─── Ripple (green glow ring) ──────────────────────────────────────────

  /**
   * @param {HTMLElement} button
   * @param {MouseEvent} event
   */
  function ripple(button, event) {
    log('ripple', 'trigger');
    if (shouldReduceMotion()) { return; }
    var rect = button.getBoundingClientRect();
    var x = event.clientX - rect.left;
    var y = event.clientY - rect.top;
    var maxSize = Math.max(rect.width, rect.height);
    log('ripple', 'maxSize=' + Math.round(maxSize) + ' rect=' + Math.round(rect.width) + 'x' + Math.round(rect.height));

    var el = document.createElement('span');
    el.className = 'ripple';
    el.style.width = maxSize + 'px';
    el.style.height = maxSize + 'px';
    el.style.left = (x - maxSize / 2) + 'px';
    el.style.top = (y - maxSize / 2) + 'px';

    button.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) { el.parentNode.removeChild(el); }
    }, 700);
  }

  // ─── Particles (ASCII chars burst) ─────────────────────────────────────

  var particleChars = ['0', '1', '>', '<', '/', '\\', '*', '#', '@', '$'];

  /**
   * @param {HTMLElement} origin
   * @param {number} [count]
   */
  function particles(origin, count) {
    log('particles', 'burst count=' + (count || 8));
    if (shouldReduceMotion()) { log('particles', 'reduced-motion → skip'); return; }
    count = count || 8;
    var rect = origin.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var fragment = document.createDocumentFragment();
    var dots = [];

    for (var i = 0; i < count; i++) {
      var dot = document.createElement('span');
      dot.style.position = 'fixed';
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
      dot.style.color = '#00ff41';
      dot.style.fontFamily = 'monospace';
      dot.style.fontSize = '12px';
      dot.style.pointerEvents = 'none';
      dot.style.zIndex = '100';
      dot.style.textShadow = '0 0 6px rgba(0,255,65,0.8)';
      dot.textContent = particleChars[Math.floor(Math.random() * particleChars.length)];

      var angle = (Math.PI * 2 / count) * i;
      var dist = 30 + Math.random() * 40;
      var dx = Math.cos(angle) * dist;
      var dy = Math.sin(angle) * dist;

      dot.style.setProperty('--dx', dx + 'px');
      dot.style.setProperty('--dy', dy + 'px');
      dot.style.animation = 'particleBurst 600ms var(--ease-out) forwards';

      fragment.appendChild(dot);
      dots.push(dot);
    }

    document.body.appendChild(fragment);
    log('particles', 'appended ' + dots.length + ' particles');

    // Cleanup: animationend primary, setTimeout as genuine fallback only
    var cleaned = false;
    var fallbackTimer = null;
    function cleanup() {
      if (cleaned) { return; }
      cleaned = true;
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      for (var j = 0; j < dots.length; j++) {
        if (dots[j] && dots[j].parentNode) { dots[j].parentNode.removeChild(dots[j]); }
      }
      log('particles', 'cleaned ' + dots.length + ' particles');
    }

    if (dots[0]) {
      dots[0].addEventListener('animationend', cleanup);
    }
    // Fallback only if animationend never fires (element removed before animation ends)
    fallbackTimer = setTimeout(function () {
      log('particles', 'fallback cleanup (animationend did not fire)');
      cleanup();
    }, PARTICLE_CLEANUP_FALLBACK_MS);
  }

  // ─── Glitch Effect ────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} el
   * @param {number} [duration]
   */
  function glitchEffect(el, duration) {
    log('glitchEffect', 'start');
    duration = duration || 500;
    if (shouldReduceMotion()) { return; }
    el.style.animation = 'glitchFlicker ' + duration + 'ms steps(2) ' + Math.ceil(duration / 100) + '';

    function onEnd() {
      el.style.animation = '';
      el.removeEventListener('animationend', onEnd);
    }
    el.addEventListener('animationend', onEnd);
    // Fallback if element removed before animationend fires
    setTimeout(function () { if (el.style.animation) { el.style.animation = ''; } }, duration + 100);
  }

  // ─── Flash Pulse ──────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} el
   */
  function flashPulse(el) {
    log('flashPulse', 'trigger');
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = 'phosphorPulse 600ms var(--ease-out)';
    setTimeout(function () { el.style.animation = ''; }, 600);
  }

  // ─── Observe Entrance ──────────────────────────────────────────────────

  /**
   * @param {string} selector
   * @param {string} [animationClass]
   */
  function observeEntrance(selector, animationClass) {
    log('observeEntrance', selector);
    animationClass = animationClass || 'animate-fade-slide-up';
    _entranceAnimClass = animationClass;
    if (!window.IntersectionObserver) {
      var els = document.querySelectorAll(selector);
      for (var i = 0; i < els.length; i++) { els[i].style.opacity = '1'; }
      return;
    }

    if (!_entranceObserver) {
      _entranceObserver = new IntersectionObserver(function (entries) {
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].isIntersecting) {
            var cls = entries[j].target.getAttribute('data-entrance-anim') || _entranceAnimClass;
            entries[j].target.classList.add(cls);
            _entranceObserver.unobserve(entries[j].target);
            _observedCount--;
            if (_observedCount <= 0) {
              _entranceObserver.disconnect();
              _entranceObserver = null;
              _observedCount = 0;
              log('observeEntrance', 'observer disconnected — all revealed');
            }
          }
        }
      }, { threshold: 0.1 });
    }

    var targets = document.querySelectorAll(selector);
    if (_observedCount + targets.length > OBSERVE_ENTRANCE_LIMIT) {
      log('observeEntrance', 'LIMIT exceeded (' + (_observedCount + targets.length) + '>' + OBSERVE_ENTRANCE_LIMIT + ') → instant reveal');
      for (var m = 0; m < targets.length; m++) { targets[m].classList.add(animationClass); }
      return;
    }
    for (var k = 0; k < targets.length; k++) {
      targets[k].setAttribute('data-entrance-anim', animationClass);
      _entranceObserver.observe(targets[k]);
      _observedCount++;
    }
    log('observeEntrance', 'observing ' + targets.length + ' (total=' + _observedCount + ')');
  }

  // ─── Destroy All (global cleanup) ─────────────────────────────────────

  var _destroying = false;

  function destroyAll() {
    if (_destroying) { log('destroyAll', 'already in progress → skip (idempotent)'); return; }
    _destroying = true;
    log('destroyAll', 'cleanup start');
    // Stop matrix rain
    if (matrixRaf) {
      cancelAnimationFrame(matrixRaf);
      matrixRaf = null;
    }
    if (_matrixResizeHandler) {
      window.removeEventListener('resize', _matrixResizeHandler);
      _matrixResizeHandler = null;
    }
    if (_resizeThrottleTimer) {
      clearTimeout(_resizeThrottleTimer);
      _resizeThrottleTimer = null;
    }
    // Disconnect observer
    if (_entranceObserver) {
      _entranceObserver.disconnect();
      _entranceObserver = null;
      _observedCount = 0;
    }
    // Remove any lingering particles
    var leftover = document.querySelectorAll('span[style*="particleBurst"]');
    for (var i = 0; i < leftover.length; i++) {
      if (leftover[i] && leftover[i].parentNode) { leftover[i].parentNode.removeChild(leftover[i]); }
    }
    _destroying = false;
    log('destroyAll', 'cleanup complete');
  }

  // ─── Export ────────────────────────────────────────────────────────────

  window.SudxAnimations = {
    initMatrixRain: initMatrixRain,
    startMatrix: startMatrix,
    stopMatrix: stopMatrix,
    countUp: countUp,
    stagger: stagger,
    typeText: typeText,
    ripple: ripple,
    particles: particles,
    glitchEffect: glitchEffect,
    flashPulse: flashPulse,
    observeEntrance: observeEntrance,
    destroyAll: destroyAll,
  };
})();
