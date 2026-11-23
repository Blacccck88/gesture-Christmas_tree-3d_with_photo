/**
 * 入口：按顺序搭好场景，先跑起渲染循环，再去后台加载手势模型。
 */
import { CONFIG, STATE, applyQuality } from './config.js';
import { initScene, composer, controls, mainGroup, clock } from './scene.js';
import { createTree, createDust, updateStar } from './tree.js';
import { createSnow, updateSnow } from './snow.js';
import { initPhotos, loadInitialPhotos } from './photos.js';
import { updateParticles } from './particle.js';
import { updateFocus } from './focus.js';
import { initGestures } from './gestures.js';
import { initUI, hideLoader, setStatus } from './ui.js';
import { initDemo, isDemoMode, updateDemo } from './demo.js';

function boot() {
    const tier = applyQuality();
    console.info(
        `[tree] 画质档位：${tier}（装饰物 ${CONFIG.particles.count} / 金尘 ${CONFIG.particles.dustCount} / 雪花 ${CONFIG.particles.snowCount}）` +
        ' · 可用 ?quality=high|medium|low 强制指定'
    );

    // 要在 initUI 之前确定，否则首次引导会盖在演示画面上
    initDemo();

    initScene();
    createTree();
    createDust();
    createSnow();
    initPhotos();
    initUI();

    // 关键：先让画面动起来再做别的。
    // 旧版本要 await 完 MediaPipe 才调 animate()，模型下载失败就是一片永久黑屏。
    animate();
    hideLoader();

    loadInitialPhotos();

    if (isDemoMode()) return;

    setStatus('正在加载手势模型…');
    initGestures().then((ok) => {
        if (ok) return;
        console.info('[tree] 手势不可用，可用鼠标拖拽旋转、滚轮缩放，T / S 切换形态，N 换一张照片');
    });
}

function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.1); // 切回标签页时 dt 会很大，钳一下防止粒子瞬移

    updateDemo(dt);
    updateRotation(dt);

    // 必须在 updateParticles 之前刷新：照片飞回树上时要读 mainGroup.matrixWorld
    // 把树上的落点换算成世界坐标，而 matrixWorld 默认要等到 render() 才更新。
    mainGroup.updateMatrixWorld(true);

    updateParticles(dt, STATE.mode);
    updateFocus(dt);
    updateSnow(dt);
    updateStar();

    controls.update();
    composer.render();
}

/** 手势散开时由手的位置驱动旋转，否则缓慢自转。 */
function updateRotation(dt) {
    if (STATE.mode === 'SCATTER' && STATE.hand.detected) {
        const targetY = STATE.hand.x * Math.PI * 0.9;
        const targetX = STATE.hand.y * Math.PI * 0.25;
        STATE.rotation.y += (targetY - STATE.rotation.y) * 4.5 * dt;
        STATE.rotation.x += (targetX - STATE.rotation.x) * 4.5 * dt;
    } else if (!STATE.userControllingCamera) {
        const spin = STATE.mode === 'TREE' ? 0.3 : 0.1;
        STATE.rotation.y += spin * dt;
        if (STATE.mode === 'TREE') {
            STATE.rotation.x += (0 - STATE.rotation.x) * 2.0 * dt;
        }
    }

    mainGroup.rotation.y = STATE.rotation.y;
    mainGroup.rotation.x = STATE.rotation.x;
}

boot();
