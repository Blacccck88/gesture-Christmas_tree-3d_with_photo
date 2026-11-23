/**
 * 「抽一张照片到眼前」。
 *
 * 以前这段逻辑塞在 gestures.js 里，靠把全局 mode 改成 FOCUS 来实现，结果是：
 *  - particle.js 里 FOCUS 会把**所有粒子**（包括整棵树）都推到星云球面上，
 *    于是捏一下手指，整棵树炸开；
 *  - 照片的目标位置每帧都要从自转中的 mainGroup 反解世界坐标，目标一直在动，
 *    照片永远差一截，看起来发飘。
 *
 * 现在的做法：把照片从树上摘下来临时挂到 scene 上（场景根节点不带旋转），
 * 之后所有动画都在**世界坐标**里做 —— 相机不动，目标就不动，飞行是干净的
 * 三次缓出；相机动了，照片就精确跟着相机走，不会抖。
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { camera, scene, mainGroup, bloomPass, BLOOM_BASE } from './scene.js';
import { photoMeshGroup, photoParticles, photoCount } from './photos.js';
import { photoLocalQuaternion } from './particle.js';
import { damp, clamp01, easeOutCubic, easeInOutCubic, easeOutBack } from './utils.js';

/** 正在飞入 / 停留 / 飞回的照片，通常只有一两条 */
const active = [];

/** 抽签队列：抽完一轮才重排，保证「每次都不一样」 */
let deck = [];
let lastPicked = null;

const listeners = [];

// 复用临时对象，热路径上不产生垃圾
const _targetPos = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _targetScale = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _slotPos = new THREE.Vector3();
const _slotQuat = new THREE.Quaternion();
const _slotLocalQuat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/* ------------------------------------------------------------------ 对外 */

/** 订阅「当前有没有照片在看」的变化，供 UI 显示计数。 */
export function subscribeFocus(fn) {
    listeners.push(fn);
    return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
    };
}

export function isPhotoFocused() {
    return active.some((e) => e.phase !== 'out');
}

/** 抽下一张（不重复）。没有照片可抽时返回 null。 */
export function grabNextPhoto() {
    // 正在看的那张先快速送回去，避免两张同时抢镜头
    for (const e of active) if (e.phase !== 'out') startOut(e, CONFIG.focus.outDuration * 0.6);

    const particle = pickNext();
    if (!particle) return null;

    // 这张可能正在飞回树上（连抽时会遇到）：取消它剩下的回程，
    // 直接从当前位置接着飞回来，视觉上是连贯的
    const flyingBack = active.findIndex((e) => e.particle === particle && e.phase === 'out');
    if (flyingBack >= 0) active.splice(flyingBack, 1);

    const group = particle.mesh;
    particle.focused = true;

    group.getWorldPosition(_pos);
    group.getWorldQuaternion(_quat);
    group.getWorldScale(_scale);

    // attach 会保留世界变换；之后这棵树怎么转都与它无关了
    scene.attach(group);

    active.push({
        particle,
        group,
        phase: 'in',
        t: 0,
        duration: CONFIG.focus.inDuration,
        fromPos: _pos.clone(),
        fromQuat: _quat.clone(),
        fromScale: _scale.clone(),
    });

    notify();
    return group;
}

/** 把眼前的照片送回树上。 */
export function releasePhoto() {
    for (const e of active) if (e.phase !== 'out') startOut(e, CONFIG.focus.outDuration);
    notify();
}

/**
 * 立刻把所有在途的照片拍回树上，不做动画。
 * 「整批换照片」时用：先把它们交还，removeWhere 才不会漏掉正在飞的那张。
 */
export function releaseAllImmediately() {
    for (let i = active.length - 1; i >= 0; i--) {
        const entry = active[i];
        photoMeshGroup.attach(entry.group);
        entry.group.scale.setScalar(entry.particle.baseScale);
        entry.particle.focused = false;
        active.splice(i, 1);
    }
    notify();
}

/** 每帧驱动，放在 updateParticles 之后调用。 */
export function updateFocus(dt) {
    if (!active.length) {
        bloomPass.strength += (BLOOM_BASE - bloomPass.strength) * damp(3, dt);
        return;
    }

    for (let i = active.length - 1; i >= 0; i--) {
        const entry = active[i];
        if (entry.phase === 'out') {
            if (updateOut(entry, dt)) active.splice(i, 1);
        } else {
            updateIn(entry, dt);
        }
    }

    // 看照片时把辉光压下去。Bloom 是整屏的，照片占半屏时会被罩成一片白雾，
    // 看起来就像「图片是空白的」。
    const want = isPhotoFocused() ? CONFIG.focus.bloomWhileFocus : BLOOM_BASE;
    bloomPass.strength += (want - bloomPass.strength) * damp(4, dt);
}

/* ------------------------------------------------------------------ 内部 */

/** 洗牌式的抽签：一轮内不重复，且不会连着两次抽到同一张。 */
function pickNext() {
    // 只有「正在看 / 正在飞来」的照片算占用；飞回途中的可以再抽，
    // 否则照片少的时候连抽几下就抽不出东西了。
    const busy = new Set(active.filter((e) => e.phase !== 'out').map((e) => e.particle));
    const pool = photoParticles().filter((p) => !busy.has(p));
    if (!pool.length) return null;

    // 中途加进来的照片、或者已经被抽走的，从队列里清掉
    deck = deck.filter((p) => pool.includes(p));

    if (!deck.length) {
        deck = pool.slice();
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        if (deck.length > 1 && deck[0] === lastPicked) {
            deck.push(deck.shift());
        }
    }

    const next = deck.shift();
    lastPicked = next;
    return next;
}

function startOut(entry, duration) {
    entry.phase = 'out';
    entry.t = 0;
    entry.duration = duration || CONFIG.focus.outDuration;
    entry.fromPos.copy(entry.group.position);
    entry.fromQuat.copy(entry.group.quaternion);
    entry.fromScale.copy(entry.group.scale);
}

/** 照片停在眼前的位姿：相机正前方 distance 处，正面朝相机，占屏一定比例。 */
function computeTarget(longEdge) {
    camera.getWorldDirection(_dir);
    _targetPos.copy(camera.position).addScaledVector(_dir, CONFIG.focus.distance);

    // 相机没有父节点，quaternion 就是世界朝向；平面法线是 +Z，直接跟随即可正对镜头
    _targetQuat.copy(camera.quaternion);

    const distance = CONFIG.focus.distance;
    const visibleH = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const visibleW = visibleH * camera.aspect;
    // 换算成「占可见尺寸的比例」：长边只有 longEdge 个世界单位（见 photos.js）
    const want = Math.min(visibleH * CONFIG.focus.fillHeight, visibleW * CONFIG.focus.fillWidth);
    _targetScale.setScalar(want / (longEdge || 1.2));
}

function updateIn(entry, dt) {
    computeTarget(entry.group.userData.longEdge);

    if (entry.phase === 'in') {
        entry.t += dt / entry.duration;
        const raw = clamp01(entry.t);
        const p = easeOutCubic(raw);

        entry.group.position.lerpVectors(entry.fromPos, _targetPos, p);
        // 稍微从上方掠过一点，比纯直线更像「被抓过来」
        entry.group.position.y += Math.sin(Math.PI * raw) * 1.8;

        entry.group.quaternion.copy(entry.fromQuat).slerp(_targetQuat, easeInOutCubic(raw));

        const s = THREE.MathUtils.lerp(entry.fromScale.x, _targetScale.x, easeOutBack(raw, 0.45));
        entry.group.scale.setScalar(s);

        if (raw >= 1) {
            entry.phase = 'held';
            entry.t = 1;
            finalizeHeld(entry, dt);
        }
        return;
    }

    finalizeHeld(entry, dt);
}

/** 停住之后：位置严格贴在目标上（相机转也不抖），旋转和缩放留一点阻尼。 */
function finalizeHeld(entry, dt) {
    const k = damp(12, dt);
    entry.group.position.copy(_targetPos);
    entry.group.quaternion.slerp(_targetQuat, k);
    const s = THREE.MathUtils.lerp(entry.group.scale.x, _targetScale.x, k);
    entry.group.scale.setScalar(s);
}

/** @returns {boolean} 是否已经交还给粒子系统 */
function updateOut(entry, dt) {
    entry.t += dt / entry.duration;
    const p = easeInOutCubic(clamp01(entry.t));

    // 树上的落点每帧重新换算：树在自转，用旧的落点会飞歪
    _slotPos.copy(entry.particle.posTree).applyMatrix4(mainGroup.matrixWorld);
    entry.group.position.lerpVectors(entry.fromPos, _slotPos, p);

    slotQuaternion(entry.particle, _slotQuat);
    entry.group.quaternion.copy(entry.fromQuat).slerp(_slotQuat, p);

    const s = THREE.MathUtils.lerp(entry.fromScale.x, entry.particle.baseScale, p);
    entry.group.scale.setScalar(s);

    if (entry.t < 1) return false;

    // 交还给粒子系统：attach 之后局部坐标正好等于树上那个位置
    photoMeshGroup.attach(entry.group);
    entry.particle.focused = false;
    notify();
    return true;
}

/**
 * 照片在树上的朝向（和 Particle 在 TREE 模式下共用 photoLocalQuaternion），
 * 换算成世界坐标 —— 飞回途中的照片挂在 scene 根节点上，用的是世界四元数。
 */
function slotQuaternion(particle, out) {
    photoLocalQuaternion(particle.posTree, _slotLocalQuat);
    out.copy(mainGroup.quaternion).multiply(_slotLocalQuat);
}

function notify() {
    const held = active.find((e) => e.phase !== 'out');
    // 照片可能被撤下一批（示例图），photoIndex 是创建时的序号会过期，
    // 角标的编号要按当前照片列表现算。
    const list = photoParticles();
    const info = held
        ? {
              active: true,
              index: list.findIndex((p) => p === held.particle) + 1,
              total: photoCount(),
          }
        : { active: false, index: 0, total: photoCount() };

    for (const fn of listeners) fn(info);
}
