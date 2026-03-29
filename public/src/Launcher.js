import { GameEngine } from './GameEngine.js';
import { Sandbox }    from './modes/Sandbox.js';
import { Assembler }  from './modes/Assembler.js';
import { Forge }      from './modes/Forge.js';
import { Modeler }    from './modes/Modeler.js';
import { Raytracer }  from './modes/Raytracer.js';

const STEPS = [
  { id: 'renderer', label: 'Three.js'    },
  { id: 'lights',   label: 'Lumières'    },
  { id: 'physics',  label: 'Rapier WASM' },
  { id: 'ready',    label: 'Prêt'        },
];

export class Launcher {

  constructor() {
    this.engine      = new GameEngine();
    this._overlay    = null;
    this._stepEls    = {};
    this._activeMode = null;
  }

  async start() {
    this._buildUI();
    this._showScreen('init');
    await this.engine.init((id) => this._onStep(id));
    await this._delay(400); // légère pause avant d'afficher le menu
    this._showScreen('menu');
  }

  // ─── Construction de l'UI ──────────────────────────────────────────────────

  _buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #launcher {
        position: fixed; inset: 0; z-index: 100;
        background: #0a0a10;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-family: 'Segoe UI', system-ui, sans-serif;
        color: #fff;
        transition: opacity 0.5s;
      }
      #launcher.hidden { opacity: 0; pointer-events: none; }

      .l-title {
        font-size: 3.5rem; font-weight: 800;
        letter-spacing: 0.25em; color: #00aaff;
        text-shadow: 0 0 30px #00aaff88;
        margin-bottom: 2.5rem;
      }

      /* ── Écran init ── */
      #screen-init { display: none; flex-direction: column; align-items: center; gap: 0.5rem; }
      #screen-init.active { display: flex; }

      .l-step {
        display: flex; align-items: center; gap: 0.8rem;
        padding: 0.35rem 1rem; border-radius: 6px;
        width: 220px; opacity: 0.3;
        transition: opacity 0.3s, color 0.3s;
        font-size: 1rem;
      }
      .l-step.active  { opacity: 1; color: #00ff88; }
      .l-step.done    { opacity: 1; color: #aaffcc; }
      .l-step-icon    { font-size: 1.1rem; width: 1.4rem; text-align: center; }
      .l-step-label   { flex: 1; }

      /* ── Écran menu ── */
      #screen-menu { display: none; flex-direction: column; align-items: center; gap: 1rem; }
      #screen-menu.active { display: flex; }

      .l-subtitle {
        font-size: 0.9rem; color: #556; letter-spacing: 0.15em;
        text-transform: uppercase; margin-bottom: 1rem;
      }

      .l-btn {
        width: 240px; padding: 16px 0;
        background: transparent; color: #fff;
        border: 1px solid #334; border-radius: 10px;
        font-size: 1rem; font-weight: 600;
        letter-spacing: 0.1em; cursor: pointer;
        transition: background 0.2s, border-color 0.2s;
      }
      .l-btn:hover, .l-btn:active { background: #00aaff22; border-color: #00aaff; }
      .l-btn.primary { background: #00aaff; border-color: #00aaff; color: #000; }
      .l-btn.primary:hover { background: #00ccff; }
      .l-btn:disabled { opacity: 0.3; cursor: default; }
    `;
    document.head.appendChild(style);

    this._overlay = document.createElement('div');
    this._overlay.id = 'launcher';
    this._overlay.innerHTML = `
      <div class="l-title">rBang</div>

      <div id="screen-init">
        ${STEPS.map(s => `
          <div class="l-step" id="step-${s.id}">
            <span class="l-step-icon">○</span>
            <span class="l-step-label">${s.label}</span>
          </div>
        `).join('')}
      </div>

      <div id="screen-menu">
        <div class="l-subtitle">Choisir un mode</div>
        <button class="l-btn primary" id="btn-sandbox">▶ Bac à sable</button>
        <button class="l-btn" id="btn-assembler">🔧 Assembleur</button>
        <button class="l-btn" id="btn-forge">⚙ Forge</button>
        <button class="l-btn" id="btn-modeler">◈ Modeler</button>
        <button class="l-btn" id="btn-raytracer">✦ Raytracer</button>
      </div>
    `;

    document.body.appendChild(this._overlay);

    // Références aux éléments de step
    STEPS.forEach(s => {
      this._stepEls[s.id] = this._overlay.querySelector(`#step-${s.id}`);
    });

    // Bindings menu
    this._overlay.querySelector('#btn-sandbox')
      .addEventListener('click', () => this._launch(new Sandbox(this.engine)));
    this._overlay.querySelector('#btn-assembler')
      .addEventListener('click', () => this._launch(new Assembler(this.engine)));
    this._overlay.querySelector('#btn-forge')
      .addEventListener('click', () => this._launch(new Forge(this.engine)));
    this._overlay.querySelector('#btn-modeler')
      .addEventListener('click', () => this._launch(new Modeler(this.engine)));
    this._overlay.querySelector('#btn-raytracer')
      .addEventListener('click', () => this._launch(new Raytracer(this.engine)));
  }

  // ─── Gestion des écrans ────────────────────────────────────────────────────

  _showScreen(name) {
    this._overlay.querySelectorAll('[id^="screen-"]').forEach(el => {
      el.classList.toggle('active', el.id === `screen-${name}`);
    });
  }

  _onStep(id) {
    // Marquer l'étape précédente comme done
    const ids = STEPS.map(s => s.id);
    const idx = ids.indexOf(id);
    if (idx > 0) {
      const prev = this._stepEls[ids[idx - 1]];
      if (prev) { prev.classList.remove('active'); prev.classList.add('done'); prev.querySelector('.l-step-icon').textContent = '✓'; }
    }
    // Marquer l'étape courante comme active
    const el = this._stepEls[id];
    if (el) { el.classList.add('active'); el.querySelector('.l-step-icon').textContent = '⟳'; }

    // Si c'est "ready", tout marquer done
    if (id === 'ready') {
      STEPS.forEach(s => {
        const e = this._stepEls[s.id];
        if (e) { e.classList.remove('active'); e.classList.add('done'); e.querySelector('.l-step-icon').textContent = '✓'; }
      });
    }
  }

  // ─── Lancement d'un mode ──────────────────────────────────────────────────

  async _launch(mode) {
    this._activeMode = mode;
    this._overlay.classList.add('hidden');
    setTimeout(() => this._overlay.remove(), 500);
    await mode.start();
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
