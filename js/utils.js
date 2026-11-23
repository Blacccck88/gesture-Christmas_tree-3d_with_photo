import * as THREE from 'three';

/**
 * 帧率无关的阻尼系数。
 *
 * 原来到处写的 `lerp(a, b, k * dt)` 在高刷屏上会明显更快/更慢，
 * 用 1 - e^(-k·dt) 才能保证 60Hz 和 144Hz 下的手感一致。
 */
export function damp(k, dt) {
    return 1 - Math.exp(-k * dt);
}

export function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 飞入用：起步快、收尾慢，东西「扑」过来才有重量感。 */
export function easeOutCubic(t) {
    const x = clamp01(t);
    return 1 - Math.pow(1 - x, 3);
}

/** 位姿插值用：两头慢中间快，避免照片一边飞一边僵着转。 */
export function easeInOutCubic(t) {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 缩放用：略微超过 1 再回落，照片「抓」到眼前时有一点回弹。 */
export function easeOutBack(t, overshoot = 1.25) {
    const x = clamp01(t) - 1;
    return 1 + (overshoot + 1) * x * x * x + overshoot * x * x;
}

/** 生成拐杖糖的红白斜条纹贴图。 */
export function createCaneTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#880000';
    ctx.beginPath();
    for (let i = -128; i < 256; i += 32) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 32, 128);
        ctx.lineTo(i + 16, 128);
        ctx.lineTo(i - 16, 0);
    }
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    return texture;
}

/** 生成一个软边圆点，用作雪花贴图。 */
export function createSnowflakeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.6)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 32, 32);

    return new THREE.CanvasTexture(canvas);
}

/**
 * 一张都加载不到照片时的「引导卡」。
 *
 * 旧版是一块深色渐变 + 一朵雪花，在整片午夜蓝的背景里跟空画框没区别 ——
 * 用户以为图片加载坏了。现在做成米白色的卡片 + 金色相机线稿，一眼就知道
 * 这是「等你放照片进来」的位置，而不是坏了。
 */
export function createPlaceholderTexture(index) {
    const size = 320;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // 纸面：米白 + 一点点由暖到冷的过渡，避免纯色死板
    const paper = ctx.createLinearGradient(0, 0, size * 0.3, size);
    paper.addColorStop(0, '#fbf6ea');
    paper.addColorStop(1, '#e8dfcc');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, size, size);

    // 内嵌金线画框
    ctx.strokeStyle = 'rgba(184, 142, 62, 0.75)';
    ctx.lineWidth = 2;
    ctx.strokeRect(14, 14, size - 28, size - 28);
    ctx.strokeStyle = 'rgba(184, 142, 62, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, 20, size - 40, size - 40);

    // 相机线稿
    const cx = size / 2;
    const cy = size / 2 - 22;
    ctx.strokeStyle = 'rgba(150, 110, 46, 0.9)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 52, cy - 26);
    ctx.lineTo(cx - 30, cy - 26);
    ctx.lineTo(cx - 22, cy - 38);
    ctx.lineTo(cx + 22, cy - 38);
    ctx.lineTo(cx + 30, cy - 26);
    ctx.lineTo(cx + 52, cy - 26);
    ctx.lineTo(cx + 52, cy + 34);
    ctx.lineTo(cx - 52, cy + 34);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + 4, 22, 0, Math.PI * 2);
    ctx.stroke();

    // 文案
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(120, 88, 38, 0.85)';
    ctx.font = '600 19px ui-monospace, Menlo, monospace';
    ctx.fillText('Y O U R   P H O T O', cx, size - 84);
    ctx.fillStyle = 'rgba(150, 118, 66, 0.55)';
    ctx.font = '500 15px ui-monospace, Menlo, monospace';
    ctx.fillText('点右上角 Select Files', cx, size - 58);

    // 每张卡的色调略微不同，挂成一串时不至于像复制的
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = `hsla(${(index * 47) % 360}, 40%, 60%, 0.06)`;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
