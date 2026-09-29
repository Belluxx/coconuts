import * as THREE from 'three/webgpu';
import { desktop } from './agents/bridge';
import { createMessageBoat } from './agents/messageBoat';
import { createAgentSetup } from './agents/setup';
import { IslandAudio } from './audio/audio';
import { createLandscape } from './land/landscape';
import { groundHeight } from './land/terrain';
import { IslandCollisions } from './player/collisions';
import { IslandControls } from './player/controls';
import { Rowboat } from './player/rowing';
import { QUALITY, loadQuality, saveQuality, type QualityLevel } from './quality';
import { createFish } from './reef/fish';
import { createSeabed } from './reef/seabed';
import { createSeascape } from './reef/seascape';
import { createVisitors } from './reef/visitors';
import { createLocalLighting } from './render/localLighting';
import { preloadIsland, renderFrameAndWait } from './render/preload';
import { createPostProcessing, createRenderer } from './render/renderer';
import { createAtmosphere } from './sky/atmosphere';
import { skyAt, type SkyPosition } from './sky/celestial';
import { DayClock } from './sky/clock';
import { createEnvironmentMap } from './sky/environmentMap';
import { createStructures } from './structures/structures';
import { createHints, type IslandAction } from './ui/hints';
import { createInterface, createLoader } from './ui/interface';
import { createCaustics } from './water/caustics';
import { createOcean } from './water/ocean';
import { createRefractionCapture } from './water/refraction';
import { createUnderwaterLight } from './water/underwaterLight';

/**
 * Loading steps and their typical duration in milliseconds, measured on a Mac,
 * which weights the progress bar. Quality changes repeat only the shader steps.
 */
const SHADER_STEPS = {
  'Compiling shaders above water': 19300,
  'Compiling shaders below water': 13400,
  'Rendering the first view': 300,
};
const STARTUP_STEPS = {
  'Starting WebGPU': 50,
  'Loading the sky': 2100,
  'Capturing reflections': 1600,
  // Includes spinning up the surf simulation.
  'Shaping the island': 4000,
  'Growing the reef': 850,
  'Filling the ocean': 250,
  'Building the pier and bungalow': 1500,
  'Mapping collisions': 7400,
  'Setting up controls': 200,
  ...SHADER_STEPS,
};

if (desktop) document.documentElement.classList.add('desktop');
const loader = createLoader(STARTUP_STEPS);
start().catch(loader.fail);

/**
 * Render layers: 0 is the view, 1 the water mirror, 2 the shadow casters.
 * Vegetation manages its own detail layers; underwater life is not mirrored.
 */
function assignLayers(scene: THREE.Scene, notMirrored: THREE.Object3D[]) {
  scene.traverse(object => {
    if (object.userData.vegetationDetail) return;
    object.layers.enable(1);
    object.layers.enable(2);
  });
  for (const root of notMirrored) root.traverse(object => object.layers.disable(1));
}

async function start() {
  let level = loadQuality(), quality = QUALITY[level];
  const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
  await loader.step('Starting WebGPU');
  const renderer = await createRenderer(canvas, quality);
  await loader.step('Loading the sky');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(57, innerWidth / innerHeight, .15, 4500);
  camera.position.set(-18, groundHeight(-18, 24) + 1.8, 24);
  camera.lookAt(36, 7, -14);
  const atmosphere = await createAtmosphere(scene, quality);
  const clock = new DayClock();
  const sky = skyAt(clock.update(0, false), clock.country);
  atmosphere.setSky(sky);
  await loader.step('Capturing reflections');
  const environmentMap = createEnvironmentMap(renderer, scene, atmosphere.environmentMesh, sky);
  const caustics = createCaustics(renderer, atmosphere.environment, atmosphere.sun, atmosphere.moon);
  const underwaterLight = createUnderwaterLight(scene, caustics, atmosphere.environment);
  const refraction = createRefractionCapture();
  const collisions = new IslandCollisions();
  collisions.addGeometry(atmosphere.distantIslands.geometry);
  await loader.step('Shaping the island');
  const landscape = createLandscape(scene, caustics, refraction, environmentMap, collisions);
  await loader.step('Growing the reef');
  const seabed = createSeabed(scene, collisions);
  const seascape = createSeascape(seabed.obstacleBounds);
  const fish = createFish(scene, seascape);
  const visitors = createVisitors(scene, seascape);
  await loader.step('Filling the ocean');
  const ocean = createOcean(scene, refraction, quality, atmosphere.environment, environmentMap, underwaterLight);
  await loader.step('Building the pier and bungalow');
  const structures = createStructures(scene, collisions);
  assignLayers(scene, [fish.group, visitors.group, seabed.group, landscape.waterfall.root]);
  const localLighting = createLocalLighting(scene);
  await loader.step('Mapping collisions');
  collisions.build();
  await loader.step('Setting up controls');
  const post = createPostProcessing(renderer, scene, camera, underwaterLight, caustics);

  const rowboat = new Rowboat(structures.rowboat, structures.oars, structures.mooring, structures.yacht, collisions, ocean.surfaceHeight);
  const controls = new IslandControls(camera, canvas, collisions, ocean.surfaceHeight, rowboat, desktop?.activate);
  const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const audio = new IslandAudio();
  let captureNext = false;
  const ui = createInterface({
    audio, clock, quality: level,
    changeQuality: next => {
      if (next === level) return;
      loader.plan(SHADER_STEPS);
      void prepare(next).catch(loader.fail);
    },
    capture: () => { captureNext = true; },
    returnHome: () => controls.returnHome(motion ? 4.8 : .05),
    openAgentSetup: desktop ? () => void setup.open() : undefined,
    onPanelChange: open => controls.setLookEnabled(!open),
  });
  controls.onNotice = ui.toast;
  controls.onInteraction = ui.closePanel;

  // Letters and the agent setup dialog pause walking and fade the interface.
  const setModalOpen = (open: boolean) => {
    ui.setReading(open);
    controls.setEnabled(!open);
  };
  const setup = createAgentSetup(setModalOpen);
  const messageBoat = createMessageBoat(structures.yacht, camera, canvas, ocean.surfaceHeight, setModalOpen,
    () => !setup.isOpen && !ui.panelOpen && !controls.isTraveling);

  const hints = createHints(document.querySelector('#interface')!);
  const refocus = () => canvas.focus({ preventScroll: true });
  const restAction: IslandAction = { label: '', key: 'F', run: () => { controls.toggleResting(); refocus(); } };
  const boatAction: IslandAction = { label: '', key: 'F', run: () => { controls.toggleRowing(); refocus(); } };
  const bottleAction: IslandAction = { label: '', key: 'E', run: () => messageBoat.pickUp() };
  function updateHints(dt: number) {
    bottleAction.label = messageBoat.hasQuestion ? 'A question for you' : 'Read the message';
    restAction.label = controls.restAction ?? '';
    boatAction.label = controls.boatAction ?? '';
    boatAction.key = controls.isRowing ? 'Shift' : 'F';
    const visible = !ui.hidden && !ui.panelOpen && !setup.isOpen && !messageBoat.isReading && !controls.isTraveling;
    const action = messageBoat.canPickUp ? bottleAction : boatAction.label ? boatAction : restAction.label ? restAction : undefined;
    messageBoat.updateStatus(dt, visible);
    hints.update({
      action, visible,
      movement: controls.isRowing ? 'row' : controls.isSwimming ? 'swim' : 'walk',
      looking: canvas.classList.contains('mouse-looking'),
    }, dt);
  }

  /** Carry the hour into the sky, water, exposure and sounds. */
  function setTime(position: SkyPosition) {
    atmosphere.setSky(position);
    const light = atmosphere.light;
    underwaterLight.update();
    renderer.toneMappingExposure = light.exposure * post.adaptation;
    audio.setSoundscape({ daylight: light.daylight, chorus: light.chorus, night: light.lamps });
  }
  setTime(sky);

  function savePostcard() {
    canvas.toBlob(blob => {
      if (!blob) { ui.toast('Your postcard couldn’t be saved. Try again.'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'a-little-world-away.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      ui.toast('Postcard saved.');
    }, 'image/png');
  }

  let lastTime = performance.now(), elapsed = 0, lastShadow = -Infinity;
  function renderFrame() {
    const now = performance.now(), realDt = Math.min((now - lastTime) / 1000, 1), dt = Math.min(realDt, .05);
    lastTime = now;
    if (document.hidden) return;
    const surf = ocean.update(realDt);
    elapsed += realDt;
    controls.update(dt, elapsed);
    ocean.updateViewer(camera);
    const waterSurface = ocean.surfaceHeight(camera.position.x, camera.position.z);
    post.update(waterSurface, realDt);
    landscape.waterfall.setSubmerged(post.underwater);
    audio.updateImmersion(waterSurface - camera.position.y);
    audio.updateSurf(surf, camera.position, camera.quaternion);
    audio.updateFalls(camera.position, camera.quaternion);
    const daylight = atmosphere.light.daylight;
    landscape.update(dt, elapsed, camera.position, quality, daylight, motion);
    seabed.update(camera.position);
    structures.update(elapsed, daylight);
    fish.update(elapsed, camera.position);
    visitors.update(elapsed, camera.position);
    messageBoat.update(dt);
    atmosphere.update(elapsed, camera, motion, waterSurface);
    updateHints(realDt);
    setTime(skyAt(clock.update(realDt, motion), clock.country, sky));
    ui.update(now);
    localLighting.update(dt, elapsed, camera, atmosphere.light.lamps, quality);
    if (now - lastShadow > 1000 / quality.shadowHz) {
      atmosphere.updateShadows();
      lastShadow = now;
    }
    environmentMap.update(now / 1000, sky);
    caustics.update();
    post.render();
    if (captureNext) {
      captureNext = false;
      savePostcard();
    }
  }

  /** Apply a preset behind the loading cover and compile its shaders before play resumes. */
  async function prepare(next: QualityLevel) {
    renderer.setAnimationLoop(null);
    controls.setEnabled(false);
    loader.cover();
    level = next;
    quality = QUALITY[next];
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
    atmosphere.setQuality(quality);
    landscape.setQuality(quality, camera.position);
    ocean.setQuality(quality);
    post.setQuality(quality);
    fish.setQuality(quality);
    visitors.setQuality(quality);
    await preloadIsland({ renderer, scene, camera, post, quality, atmosphere, ocean, localLighting, environmentMap, caustics,
      dynamicShadowCasters: visitors.group,
      beforePass: underwater => loader.step(underwater ? 'Compiling shaders below water' : 'Compiling shaders above water') });
    await loader.step('Rendering the first view');
    // Refresh the restored view and all dependent captures before uncovering it.
    lastTime = performance.now();
    lastShadow = -Infinity;
    for (let frame = 0; frame < 2; frame++) await renderFrameAndWait(renderer, renderFrame);
    saveQuality(next);
    loader.uncover();
    controls.setEnabled(!setup.isOpen && !messageBoat.isReading);
    lastTime = performance.now();
    renderer.setAnimationLoop(renderFrame);
  }

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
    renderer.setSize(innerWidth, innerHeight);
  });
  // Don't fast-forward the island after the tab was hidden.
  document.addEventListener('visibilitychange', () => { lastTime = performance.now(); });

  await prepare(level);
  void setup.start();
}
