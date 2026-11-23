/**
 * 演示模式（?demo=1）。
 *
 * 两个用途：
 *  1. 录 README 用的 GIF / 视频时，不用手动按键就能跑完整套形态变化；
 *  2. 想把这棵树投在大屏幕上当背景时，它会自己循环播放。
 *
 * 会自动隐藏 UI，并接管形态切换 —— 此时手势识别和快捷键都不再生效。
 */
import { STATE } from './config.js';
import { grabNextPhoto, releasePhoto } from './focus.js';

// 每一步：树的形态 + 要不要抽一张照片到眼前 + 停留多久（秒）
const SEQUENCE = [
    { mode: 'TREE', focus: false, hold: 5 },
    { mode: 'SCATTER', focus: false, hold: 4 },
    { mode: 'SCATTER', focus: true, hold: 4.5 },
];

let active = false;
let step = 0;
let elapsed = 0;

export function isDemoMode() {
    return active;
}

export function initDemo() {
    active = new URLSearchParams(location.search).get('demo') === '1';
    if (!active) return false;

    document.body.classList.add('ui-hidden-all');
    STATE.mode = SEQUENCE[0].mode;
    onEnter(SEQUENCE[0]);

    console.info('[tree] 演示模式：自动循环形态，UI 已隐藏。去掉 ?demo=1 即可恢复正常。');
    return true;
}

export function updateDemo(dt) {
    if (!active) return;

    elapsed += dt;
    if (elapsed < SEQUENCE[step].hold) return;

    elapsed = 0;
    step = (step + 1) % SEQUENCE.length;
    STATE.mode = SEQUENCE[step].mode;
    onEnter(SEQUENCE[step]);
}

function onEnter(stepConfig) {
    if (stepConfig.focus) grabNextPhoto();
    else releasePhoto();
}
