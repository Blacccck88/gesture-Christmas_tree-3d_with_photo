/**
 * 照片：加载、缩图、做成金框拍立得、沿树身螺旋排布。
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mainGroup, renderer } from './scene.js';
import { Particle, particleSystem } from './particle.js';
import { createPlaceholderTexture } from './utils.js';

/**
 * 黄金角。照片沿螺旋排布时只按高度算角度会退化：
 * 当照片数正好是 loops 的倍数（例如 3 张 / 3 圈），每张相差整圈，
 * 结果所有照片叠在同一条竖线上。叠加黄金角可以保证任意数量都均匀散开。
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export const photoMeshGroup = new THREE.Group();

// 框体几何/材质共享，每张照片只新建一个平面。
// 用 1×1 的基础板再按照片比例缩放，换尺寸不用重建几何。
const FRAME_GEO = new THREE.BoxGeometry(1, 1, 0.05);
const FRAME_MAT = new THREE.MeshBasicMaterial({
    // 纯平面金色，不参与光照。
    // 抛光金属框在侧向聚光灯下会形成一条极亮的镜面高光，被 Bloom 一晕就是
    // 一条「金条」糊在照片边上；BasicMaterial 根本没有高光，从根上杜绝。
    // 亮度刻意压在 bloom 阈值（0.65）之下，免得整块框又发起光来。
    color: 0xb8933e,
    toneMapped: false,
});

/**
 * 真正的计数。
 *
 * 不能用 photoMeshGroup.children.length —— 被抽到眼前的照片会临时挂到 scene 上，
 * 那样它就不在 children 里了，上限会凭空少算一张。
 */
let photoTotal = 0;
let layoutQueued = false;

/** 已经挂上树的照片（上传去重的依据） */
const seenKeys = new Set();

export function initPhotos() {
    mainGroup.add(photoMeshGroup);
}

export function photoCount() {
    return photoTotal;
}

export function photoParticles() {
    return particleSystem.filter((p) => p.type === 'PHOTO');
}

/* ------------------------------------------------------------------ 加载 */

/**
 * 启动时加载照片。
 *
 * 顺序：images/manifest.json（用户自己的照片）→ 内置示例图 → 引导卡。
 * 每一级都带超时，任何一张图卡住都不会拖住整棵树。
 */
export async function loadInitialPhotos() {
    const local = await readManifest();
    const useFallback = !local.length;
    const sources = useFallback ? CONFIG.preload.fallbackImages : local.map((n) => `./images/${n}`);

    await Promise.all(sources.map((url) => addRemote(url, useFallback ? 'fallback' : 'manifest')));

    // 一张都没加载成功（离线、或者图床挂了）就挂上引导卡，而不是让树光秃秃的
    if (photoCount() === 0) {
        console.info('[tree] 未加载到任何照片，已挂上引导卡。把照片放进 ./images/ 并列进 manifest.json 即可替换。');
        for (let i = 0; i < CONFIG.photos.placeholderCount; i++) {
            addPhotoToScene(createPlaceholderTexture(i), 'placeholder');
        }
    } else {
        console.info(`[tree] 已挂上 ${photoCount()} 张照片（按 N 或捏合手指可以抽一张到眼前）`);
    }
}

async function readManifest() {
    try {
        const res = await fetch(CONFIG.preload.manifest, { cache: 'no-cache' });
        if (!res.ok) return [];
        const list = await res.json();
        return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
    } catch {
        // 没有 manifest 是完全正常的情况，不值得打扰用户
        return [];
    }
}

/** 远程图（manifest 里的本地图也算）→ 带超时的 fetch → 纹理 */
async function addRemote(url, source = 'manifest') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.preload.timeout);

    try {
        const res = await fetch(url, { signal: controller.signal, mode: 'cors' });
        if (!res.ok) return false;
        const blob = await res.blob();
        const texture = await createTextureFromBlob(blob);
        return texture ? addPhotoToScene(texture, source) : false;
    } catch {
        // 拉不到就算了：一张图不该影响整棵树
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 用户选的文件批量入树。
 *
 * 两张变化：
 * 1. 先缩图再上传纹理（见 createTextureFromBlob）—— 这是「空白图片」的根治；
 * 2. 并发限制在 4 —— 一次解 60 张原图会把主线程占死几百毫秒，表现就是
 *    「点了选择文件之后画面卡住」。
 *
 * @returns {Promise<{added: number, skipped: number}>}
 */
export async function addFiles(files) {
    const room = CONFIG.photos.maxCount - photoCount();
    if (room <= 0) {
        console.warn(`[tree] 已达到 ${CONFIG.photos.maxCount} 张上限，忽略本次选择`);
        return { added: 0, skipped: files.length };
    }

    const batch = files.slice(0, room);
    if (files.length > room) {
        console.warn(`[tree] 选中 ${files.length} 张，只加载前 ${room} 张（上限 ${CONFIG.photos.maxCount}）`);
    }

    let added = 0;
    let skipped = files.length - batch.length;

    await runPool(batch, 4, async (file) => {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (seenKeys.has(key)) {
            skipped++;         // 同一个文件夹选两次不会重复挂
            return;
        }
        seenKeys.add(key);

        try {
            const texture = await createTextureFromBlob(file);
            if (texture && addPhotoToScene(texture)) added++;
            else skipped++;
        } catch (err) {
            // iPhone 的 HEIC 在多数桌面浏览器里解不了，安静跳过并计数
            console.warn(`[tree] 读不了这张图：${file.name}`, err?.message ?? err);
            skipped++;
        }
    });

    return { added, skipped };
}

/**
 * Blob/File → 缩小后的纹理。
 *
 * 关键的一步：手机照片动辄 4000×3000，直接当纹理会吃掉 ~48MB 显存。
 * 几十张就是几个 GB，WebGL 到上限后不会报错，只是纹理静默变成白板。
 * 这里先按 maxTextureEdge 等比缩到小图（树上那张只有 20 来像素宽，
 * 抽到眼前也只要 ~500px），显存和加载时间都降一个数量级。
 *
 * createImageBitmap 的解码在别的线程，不会卡住渲染；顺带处理了 EXIF 方向
 * （iPhone 竖拍的照片不会横过来）。
 */
async function createTextureFromBlob(blob) {
    const maxEdge = CONFIG.photos.maxTextureEdge;
    let bitmap = null;

    try {
        // 不传 options：默认就是 imageOrientation: 'from-image'，
        // 顺带把 iPhone 竖拍的 EXIF 方向摆正（传参数反而在老浏览器上不被识别）
        bitmap = await createImageBitmap(blob);
    } catch {
        // 老 Safari 没有 createImageBitmap 的 resize / EXIF 支持，退回 <img>
        bitmap = await loadViaImage(blob);
    }

    if (!bitmap) return null;

    const srcW = bitmap.width || bitmap.naturalWidth;
    const srcH = bitmap.height || bitmap.naturalHeight;
    if (!srcW || !srcH) {
        bitmap.close?.();
        return null;
    }

    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // 照片贴在斜面上时，各向异性过滤能明显减轻「糊成一片」
    texture.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() ?? 1);
    texture.needsUpdate = true;
    return texture;
}

function loadViaImage(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('image decode failed'));
        };
        img.src = url;
    });
}

/** 简易并发池：同时最多 limit 个任务，避免一次性解几十张图。 */
async function runPool(items, limit, worker) {
    let cursor = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        while (cursor < items.length) {
            const index = cursor++;
            await worker(items[index]);
        }
    });
    await Promise.all(runners);
}

/* ------------------------------------------------------------------ 建场景 */

/**
 * @param {THREE.Texture} texture
 * @param {'user'|'manifest'|'fallback'|'placeholder'} source
 *   用户自己传的照片叫 'user'。上传之后，ui 会把 'fallback' / 'placeholder'
 *   这些凑数的清掉，只留用户自己的。
 */
export function addPhotoToScene(texture, source = 'user') {
    if (photoTotal >= CONFIG.photos.maxCount) {
        texture.dispose();
        return false;
    }

    // 按原图比例缩放，长边固定成 longEdge，避免照片被拉变形
    const long = CONFIG.photos.longEdge;
    const border = CONFIG.photos.border;
    let width = long;
    let height = long;
    if (texture.image) {
        const aspect = texture.image.width / texture.image.height;
        if (aspect > 1) height = long / aspect;
        else width = long * aspect;
    }

    const frame = new THREE.Mesh(FRAME_GEO, FRAME_MAT);
    frame.scale.set(width + border * 2, height + border * 2, 1);

    const photo = new THREE.Mesh(
        new THREE.PlaneGeometry(width, height),
        new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.DoubleSide,
            // 照片是「照片」，不是场景里的一块反光板：
            // 不参与色调映射，颜色才是原图的颜色（Reinhard + exposure 2.2
            // 会把所有照片压成灰白的一片）。
            toneMapped: false,
        })
    );
    photo.position.z = 0.04;

    const group = new THREE.Group();
    group.add(frame, photo);
    group.scale.setScalar(1);
    group.userData.photoIndex = photoTotal;
    group.userData.source = source;
    // 抽到眼前时按这个换算缩放，竖图和横图占屏一致
    group.userData.longEdge = long;

    photoMeshGroup.add(group);
    particleSystem.push(new Particle(group, 'PHOTO'));
    photoTotal++;

    queueLayout();
    return true;
}

/**
 * 按条件摘掉照片（换一批照片时用）。
 * 正在抽到眼前的那张不在此列 —— 交还动画还在跑，别半路拆台。
 * @returns {number} 实际摘掉的数量
 */
export function removeWhere(pred) {
    let removed = 0;

    for (let i = particleSystem.length - 1; i >= 0; i--) {
        const p = particleSystem[i];
        if (p.type !== 'PHOTO' || p.focused || !pred(p)) continue;

        p.mesh.removeFromParent();
        // 相框几何体是共享的，只销毁这张照片自己的
        const plane = p.mesh.children[1];
        if (plane) {
            plane.geometry.dispose();
            plane.material.map?.dispose();
            plane.material.dispose();
        }
        particleSystem.splice(i, 1);
        photoTotal--;
        removed++;
    }

    if (removed) updatePhotoLayout();
    return removed;
}

/**
 * 沿树的锥面把照片排成螺旋。
 * 每加一张就重排一次是 O(n²)，所以合并到下一个微任务里只跑一次。
 */
function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    queueMicrotask(() => {
        layoutQueued = false;
        updatePhotoLayout();
    });
}

export function updatePhotoLayout() {
    const photos = photoParticles();
    if (!photos.length) return;

    const fullH = CONFIG.particles.treeHeight;
    const h = fullH * 0.9;
    const stepY = h / photos.length;

    /**
     * 照片一多就得整体缩小，否则相邻两张会糊成一团。
     * 螺旋上相邻两张的竖向间距是 h/count，要让照片本身小于这个间距是做不到的
     * （6 张时就已经放不下了），所以按 sqrt 收敛：6 张以内保持原尺寸，
     * 30 张左右缩到一半，64 张缩到 0.42 —— 大概是原版 1.2 的观感。
     */
    const scaleFactor = THREE.MathUtils.clamp(Math.sqrt(8 / photos.length), 0.42, 1);

    photos.forEach((p, i) => {
        const y = -h / 2 + stepY * i + stepY / 2;
        const normalizedH = (y + fullH / 2) / fullH;

        // 比树身半径再外扩一点，让照片浮在装饰物外面
        const r = Math.max(CONFIG.particles.treeRadius * (1.0 - normalizedH), 1.0) + CONFIG.photos.radialOffset;
        const angle = normalizedH * Math.PI * 2 * CONFIG.photos.loops + i * GOLDEN_ANGLE;

        p.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);

        // 被抽到眼前的那张正在世界坐标里飞，别去动它
        if (!p.focused) p.baseScale = scaleFactor;
    });
}
