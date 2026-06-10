// App orchestrator: connects net ⇄ 3D game ⇄ DOM screens and runs the
// render loop. Phase changes from the server drive everything.

import './styles.css';
import { net } from './net.js';
import { World } from './game/World.js';
import { Effects } from './game/Effects.js';
import { Race } from './game/Race.js';
import { Hud } from './ui/hud.js';
import {
  el, joinScreen, lobbyScreen, countdownScreen, resultsScreen,
  pantryScreen, cauldronScreen, deployScreen, revealScreen, podiumScreen,
} from './ui/screens.js';
import { PHASE } from '@shared/constants.js';
import { buildTrack } from '@shared/track.js';

const ui = document.getElementById('ui');
const hudRoot = document.getElementById('hud');
const toasts = document.getElementById('toasts');

const world = new World(document.getElementById('gl'));
const effects = new Effects(world.scene);
const hud = new Hud(hudRoot);

// idle backdrop before any race exists
world.setPalette(buildTrack(0));

let race = null;            // active Race controller (lives countdown → reveal)
let raceRound = 0;          // which round the controller was built for
let screen = null;
let joined = false;
let lastPhase = null;

function setScreen(next) {
  screen?.dispose?.();
  ui.innerHTML = '';
  screen = next;
  if (next?.el) ui.appendChild(next.el);
}

function toast(msg, cls = '') {
  const d = el('div', `toast ${cls}`, msg);
  toasts.appendChild(d);
  setTimeout(() => d.remove(), 3600);
}

function ensureRace(st) {
  if (!race || raceRound !== st.round) {
    race?.dispose();
    race = new Race(world, effects, hud, st.trackIndex);
    raceRound = st.round;
    hud.setItem(null);
    hud.setEssences(net.you?.essences);
  }
}

function disposeRace() {
  race?.dispose();
  race = null;
  raceRound = 0;
}

function onRoom(st) {
  if (!joined) return;
  const phaseChanged = st.phase !== lastPhase;
  lastPhase = st.phase;

  switch (st.phase) {
    case PHASE.LOBBY:
      disposeRace();
      hud.hide();
      setScreen(lobbyScreen(st));
      break;

    case PHASE.COUNTDOWN: {
      ensureRace(st);
      hud.show();
      setScreen(countdownScreen(st, race.track.name));
      break;
    }

    case PHASE.RACE:
      ensureRace(st);
      hud.show();
      setScreen(null);
      if (phaseChanged) hud.flash('GO!', '#7dff9b');
      break;

    case PHASE.RESULTS:
      hud.hide();
      setScreen(resultsScreen(st));
      break;

    case PHASE.PANTRY:
      hud.hide();
      setScreen(pantryScreen(st));
      break;

    case PHASE.CAULDRON:
      setScreen(cauldronScreen(st));
      break;

    case PHASE.DEPLOY:
      setScreen(deployScreen(st));
      break;

    case PHASE.REVEAL:
      setScreen(revealScreen(st));
      break;

    case PHASE.PODIUM:
      disposeRace();
      hud.hide();
      setScreen(podiumScreen(st));
      break;
  }
}

net.on('room', onRoom);
net.on('toast', (t) => toast(t.msg));
net.on('dropped', () => {
  joined = false;
  disposeRace();
  hud.hide();
  const panel = el('div', 'panel col center');
  panel.append(
    el('h2', '', 'Connection lost'),
    el('div', 'dim', 'The host closed the server, or your network hiccuped.'),
  );
  const btn = el('button', '', 'Reconnect');
  btn.addEventListener('click', () => window.location.reload());
  panel.appendChild(btn);
  setScreen({ el: panel, dispose: () => {} });
});

// entry
setScreen(joinScreen(() => {
  joined = true;
  if (net.room) onRoom(net.room);
}));

// ------------------------------------------------------------ render loop

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (race) {
    race.update(dt, now);
  } else {
    // idle orbit camera for lobby / podium
    const t = now / 1000;
    world.camera.position.set(Math.cos(t * 0.12) * 240, 90 + Math.sin(t * 0.05) * 20, Math.sin(t * 0.12) * 240);
    world.camera.lookAt(0, 30, 0);
  }
  effects.update(dt);
  world.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
