/**
 * MediaPipe 手势识别，支持两只手。
 *
 * 设计前提：这一整块都是「锦上添花」。没有摄像头、用户拒绝授权、CDN 连不上，
 * 都只会让手势失效，绝不能影响 3D 场景的渲染。
 *
 * 这一版相比原来的三处改动，都是为了「灵敏」：
 *
 * 1. `numHands` 从 1 改成 2。原来只认「最确信的那只手」，两只手在画面里时
 *    识别结果会在两手之间来回跳，表现为疯狂抖动。
 * 2. 归一化基准从「腕→中指根」换成「掌宽」。前者手指一伸一屈就变长，
 *    同一个捏合动作在手张开时会算出完全不同的比值。
 * 3. 加了双阈值滞回 + 连续帧确认。临界点左右抖是必然的，没有滞回就会
 *    在「捏合 / 张开」之间反复横跳。
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { CONFIG, STATE } from './config.js';
import { grabNextPhoto, releasePhoto } from './focus.js';
import { setStatus, setDebug, toast } from './ui.js';

const MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/**
 * 允许 ?model=... / ?wasm=... 覆盖资源地址。
 * 官方模型的域名在部分地区连不上，自建镜像时改 URL 比改源码方便得多。
 */
function overrideParam(key) {
    try {
        return new URLSearchParams(location.search).get(key) || null;
    } catch {
        return null;
    }
}

/**
 * wasm 镜像。
 *
 * 8.7MB 的 wasm 从 cdn.jsdelivr.net 拉，国内实测能等半分钟 —— 这段时间里
 * 手势完全没反应，用户只会得出「这东西不灵敏」的结论。npmmirror 是国内镜像，
 * 实测快一个量级，所以开跑之前先探一下谁最快。
 */
const WASM_MIRRORS = [
    'https://registry.npmmirror.com/@mediapipe/tasks-vision/0.10.3/files/wasm',
    'https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm',
];

/** [指尖, 近端指节]，除大拇指外的四根：食、中、无名、小指 */
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];

const ERROR_LIMIT = 30;
const MISS_LIMIT = 3;

let handLandmarker = null;
let video = null;
let lastVideoTime = -1;
let lastDetectAt = 0;
let consecutiveErrors = 0;

/** 两个槽位，一人最多两只手 */
const trackers = [createTracker(), createTracker()];

let grabbing = false;
let lastPinchAt = 0;
let handPosInit = false;

/* ------------------------------------------------------------------ 启动 */

/** @returns {Promise<boolean>} 手势是否成功启用 */
export async function initGestures() {
    video = document.getElementById('webcam');

    setStatus('正在加载手势模型…');
    try {
        const base = await pickWasmBase();
        const vision = await FilesetResolver.forVisionTasks(base);
        handLandmarker = await createLandmarker(vision);
    } catch (err) {
        console.warn('[tree] 手势模型加载失败，仅鼠标模式可用', err);
        disableWebcamUI('手势模型加载失败 · 鼠标仍可操作');
        return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        disableWebcamUI('此浏览器不支持摄像头 · 鼠标仍可操作');
        return false;
    }

    setStatus('模型就绪，等待摄像头授权…');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 },
                facingMode: 'user',
            },
        });
        video.srcObject = stream;
        // 注意要包一层 rAF：predictWebcam 的第一个参数是 rAF 给的时间戳，
        // 直接当监听器用的话拿到的是 Event 对象，后面的限帧判断全是 NaN。
        video.addEventListener('loadeddata', () => requestAnimationFrame(predictWebcam), { once: true });
        setStatus('摄像头已开启，伸手试试');
        return true;
    } catch (err) {
        console.warn('[tree] 摄像头不可用', err);
        disableWebcamUI('摄像头不可用 · 鼠标仍可操作');
        return false;
    }
}

/** GPU 跑不动就退 CPU —— 有些核显上 GPU delegate 会直接创建失败。 */
async function createLandmarker(vision) {
    const modelAssetPath = overrideParam('model') || MODEL_URL;

    for (const delegate of ['GPU', 'CPU']) {
        try {
            return await HandLandmarker.createFromOptions(vision, {
                baseOptions: { modelAssetPath, delegate },
                runningMode: 'VIDEO',
                numHands: 2,
            });
        } catch (err) {
            console.warn(`[tree] 手势模型 ${delegate} 后端不可用，尝试下一个`, err?.message ?? err);
        }
    }
    throw new Error('no usable delegate');
}

/** 挑最快的 wasm 镜像；全都探不通就退回官方 CDN。 */
async function pickWasmBase() {
    const custom = overrideParam('wasm');
    const mirrors = custom ? [custom, ...WASM_MIRRORS] : WASM_MIRRORS;

    try {
        return await Promise.any(mirrors.map((base) => probeMirror(base)));
    } catch {
        return mirrors[mirrors.length - 1];
    }
}

function probeMirror(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.gestures.wasmProbeTimeout);

    // 只取 1KB 试探：能连通、且带 CORS 头就说明可以直接用
    return fetch(`${base}/vision_wasm_internal.wasm`, {
        signal: controller.signal,
        headers: { Range: 'bytes=0-1024' },
    })
        .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            return base;
        })
        .finally(() => clearTimeout(timer));
}

function disableWebcamUI(message) {
    const wrapper = document.getElementById('webcam-wrapper');
    if (wrapper) wrapper.style.display = 'none';
    setStatus(message);
    // 预览框被藏起来了，状态文字也跟着看不见，所以再弹一条提示
    toast(message, 4200);
}

/* ------------------------------------------------------------------ 主循环 */

function predictWebcam(now) {
    // rAF 必须排在最前：一旦 detectForVideo 抛错（video 尚未就绪、GPU 上下文
    // 丢失、ROI 异常），循环就再也排不上队，手势会在余下的整个会话里静默失效。
    requestAnimationFrame(predictWebcam);

    if (typeof now !== 'number') now = performance.now();
    if (!handLandmarker || video.currentTime === lastVideoTime) return;

    // 手势识别限帧。60fps 的显示器上每帧都跑一次推理，渲染会被拖到掉帧，
    // 「丝滑」先输在这里。
    const interval = 1000 / (CONFIG.gestures.maxDetectFps || 30);
    if (now - lastDetectAt < interval) return;

    lastDetectAt = now;
    lastVideoTime = video.currentTime;

    try {
        processGestures(handLandmarker.detectForVideo(video, now));
    } catch (err) {
        // 偶发一帧失败无所谓，下一帧再来；连续失败才值得提醒
        if (++consecutiveErrors === ERROR_LIMIT) {
            console.warn(`[tree] 手势识别连续 ${ERROR_LIMIT} 帧出错，已降级为鼠标操作`, err);
            setStatus('手势识别异常 · 鼠标仍可操作');
        }
        return;
    }

    consecutiveErrors = 0;
}

/* ------------------------------------------------------------------ 识别 */

function processGestures(result) {
    const detections = (result?.landmarks ?? [])
        .map(analyze)
        .filter((a) => a && a.palmWidth >= CONFIG.gestures.minPalmWidth);

    const pairs = assign(detections);
    const matched = new Set(pairs.map(([, t]) => t));

    for (const [a, tracker] of pairs) updateTracker(tracker, a);
    for (const tracker of trackers) if (!matched.has(tracker)) markMissing(tracker);

    decide();
}

/**
 * 一帧的关键点 → 几个能判手势的标量。
 *
 * 全部用「掌宽」（食指根 ↔ 小指根）做归一化，手掌撑开的角度不会影响比值。
 * 距离算三维：手正对镜头时二维投影会把手指压短，加上 z 才稳。
 */
function analyze(lm) {
    if (!lm || lm.length < 21) return null;

    const palm = lm[0];
    const indexMcp = lm[5];
    const pinkyMcp = lm[17];
    const midMcp = lm[9];

    /**
     * 捏合相关的三个量（palmWidth / pinch / reach）有意用 2D 距离：
     * MediaPipe 的 z 是模型预测出来的相对深度，两个指尖真正贴到一起的
     * 捏合瞬间 z 反而会跳，3D 距离被撑大一截，pinch 正好卡在阈值上下 ——
     * 用户看到的「明明捏上了却不抽照片」大半来自这里。掌宽同样用 2D，
     * 分子分母口径一致。手指伸直与否仍用 3D：斜对镜头的手，2D 投影会把
     * 伸直的手指压短，判不出「张开」。
     */
    const palmWidth = dist2(indexMcp, pinkyMcp);
    const palmLen = dist2(palm, midMcp);
    if (palmWidth < 1e-6 || palmLen < 1e-6) return null;

    let extended = 0;
    for (const [tip, pip] of FINGERS) {
        // 指尖比近端指节离手腕更远 → 这根手指是伸直的
        if (dist3(lm[tip], palm) > dist3(lm[pip], palm) * CONFIG.gestures.fingerStraightRatio) extended++;
    }

    return {
        palmWidth,
        extended,
        pinch: dist2(lm[4], lm[8]) / palmWidth,          // 拇指尖 ↔ 食指尖
        reach: dist2(lm[8], palm) / palmLen,            // 食指伸出程度
        // 取负号做镜像：预览画面用 CSS scaleX(-1) 翻转过（照镜子的直觉），
        // MediaPipe 给的是未翻转的原始坐标，不翻的话画面和操作对不上。
        x: -(midMcp.x - 0.5) * 2,
        y: (midMcp.y - 0.5) * 2,
    };
}

function dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function dist2(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function createTracker() {
    return {
        present: false,
        missing: MISS_LIMIT,
        x: 0,
        y: 0,
        palmWidth: 0,
        extended: 0,
        pinch: 1,
        reach: 0,
        label: 'IDLE',
        candidate: null,
        candidateCount: 0,
        pinching: false,
        pinchReleaseFrames: 0,
    };
}

/**
 * 把这一帧检测到的手配到两个槽位上，尽量「按位置就近」，而不是按数组下标。
 * MediaPipe 两只手的顺序是按置信度排的，会互换；按下标取会让两只手的手势
 * 互相串味（左手张开、右手捏合，结果来回跳）。
 */
function assign(detections) {
    const pairs = [];
    for (let d = 0; d < detections.length; d++) {
        for (let t = 0; t < trackers.length; t++) {
            if (!trackers[t].present) continue;
            pairs.push([Math.hypot(detections[d].x - trackers[t].x, detections[d].y - trackers[t].y), d, t]);
        }
    }
    pairs.sort((a, b) => a[0] - b[0]);

    const usedD = new Set();
    const usedT = new Set();
    const result = [];

    for (const [, d, t] of pairs) {
        if (usedD.has(d) || usedT.has(t)) continue;
        usedD.add(d);
        usedT.add(t);
        result.push([detections[d], trackers[t]]);
    }

    // 多出来的检测（新出现的手）交给空槽位。
    // 注意 findIndex 的回调拿到的是 tracker 对象，而 usedT 里存的是下标，
    // 写成 `!usedT.has(t)` 会永远命中 0 号槽位，两只手就会互相覆盖。
    for (let d = 0; d < detections.length; d++) {
        if (usedD.has(d)) continue;
        const slot = trackers.findIndex((_, index) => !usedT.has(index));
        if (slot < 0) break;
        usedT.add(slot);
        result.push([detections[d], trackers[slot]]);
    }

    return result;
}

function updateTracker(tracker, a) {
    const G = CONFIG.gestures;
    const fresh = !tracker.present;

    tracker.present = true;
    tracker.missing = 0;
    tracker.palmWidth = a.palmWidth;
    tracker.extended = a.extended;
    tracker.pinch = a.pinch;
    tracker.reach = a.reach;

    // 平滑：手在画面里的抖动会被这层 EMA 吃掉，星云不会再跟着乱晃
    if (fresh) {
        tracker.x = a.x;
        tracker.y = a.y;
    } else {
        tracker.x += (a.x - tracker.x) * G.smoothing;
        tracker.y += (a.y - tracker.y) * G.smoothing;
    }

    // 捏合用双阈值滞回，释放还要连续两帧确认：
    // 只看单帧的话，捏着保持时 pinch 值抖过 exit 一帧，照片就被误送回去了
    if (!tracker.pinching) {
        if (a.pinch < G.pinchEnter && a.reach > G.pinchMinReach) {
            tracker.pinching = true;
            tracker.pinchReleaseFrames = 0;
        }
    } else if (a.pinch > G.pinchExit) {
        if (++tracker.pinchReleaseFrames >= 2) {
            tracker.pinching = false;
            tracker.pinchReleaseFrames = 0;
        }
    } else {
        tracker.pinchReleaseFrames = 0;
    }

    const raw = tracker.pinching
        ? 'PINCH'
        : a.extended >= G.openMinFingers
          ? 'OPEN'
          : a.extended <= G.fistMaxFingers
            ? 'FIST'
            : 'IDLE';

    commitLabel(tracker, raw);
}

/** 连续 confirmFrames 帧都是同一个手势才认，避免临界状态来回切。 */
function commitLabel(tracker, label) {
    const need = CONFIG.gestures.confirmFrames;

    if (label === tracker.label) {
        tracker.candidate = label;
        tracker.candidateCount = 0;
        return;
    }

    if (label === tracker.candidate) tracker.candidateCount++;
    else {
        tracker.candidate = label;
        tracker.candidateCount = 1;
    }

    if (tracker.candidateCount >= need) {
        tracker.label = label;
        tracker.candidateCount = 0;
    }
}

function markMissing(tracker) {
    if (!tracker.present) return;
    if (++tracker.missing < MISS_LIMIT) return;

    tracker.present = false;
    tracker.label = 'IDLE';
    tracker.candidate = null;
    tracker.candidateCount = 0;
    tracker.pinching = false;
}

/* ------------------------------------------------------------------ 决策 */

/**
 * 两只手的分工：
 *   一手张开 → 树散成星云（并由这只手控制视角）
 *   另一手捏合 → 抽一张照片到眼前（每捏一次换一张）
 *   同时出现 → 张开的那只管星云，捏合的那只抽照片，互不打扰
 */
function decide() {
    const live = trackers.filter((t) => t.present);

    // 捏合用「滞回后的原始状态」，不走 label 的多帧确认 ——
    // 抽照片是即时动作，等 confirmFrames 帧才抓会显得「按了没反应」。
    // label 那套防抖仍然用于 OPEN / FIST 这类模式切换，那个跳一下很显眼。
    const pinchHand = live.find((t) => t.pinching);
    const openHands = live.filter((t) => t.label === 'OPEN');
    const fistHand = live.find((t) => t.label === 'FIST');

    STATE.hands = live.map((t) => ({ label: t.pinching ? 'PINCH' : t.label, x: t.x, y: t.y }));

    // ① 抽照片：优先级最高，任何一只手捏合都算
    if (pinchHand) {
        lastPinchAt = performance.now();
        if (!grabbing) {
            grabbing = true;
            grabNextPhoto();
        }
    } else if (grabbing && performance.now() - lastPinchAt > CONFIG.gestures.pinchReleaseMs) {
        // 松开后等一小会儿再放回去：捏合的过程中拇指本来就会轻微抖开
        grabbing = false;
        releasePhoto();
    }

    // ② 树的形态
    if (openHands.length) {
        STATE.mode = 'SCATTER';
        STATE.hand.detected = true;

        // tracker 里已经做过一层 EMA 了，这里直接用，别再加一层 ——
        // 两层平滑串起来，转视角会有明显的「拖泥带水」感。
        let sx = 0;
        let sy = 0;
        for (const h of openHands) {
            sx += h.x;
            sy += h.y;
        }
        STATE.hand.x = sx / openHands.length;
        STATE.hand.y = sy / openHands.length;
        handPosInit = true;
    } else if (fistHand) {
        STATE.mode = 'TREE';
        STATE.hand.detected = false;
        handPosInit = false;
    } else {
        // 只捏着、或者认不出动作：形态保持不动，别乱切
        if (!live.length) handPosInit = false;
        STATE.hand.detected = false;
    }

    setStatus(statusText(live, pinchHand, openHands, fistHand));
    setDebug(debugText(live));
}

function statusText(live, pinchHand, openHands, fistHand) {
    if (!live.length) return '未检测到手 · 拖拽旋转 / 滚轮缩放';

    if (pinchHand && openHands.length) return '双手 · 张开=星云，捏合=抽照片';
    if (pinchHand) return '捏合 · 抽照片（松手放回）';
    if (openHands.length >= 2) return '双手张开 · 星云';
    if (openHands.length) return '张开 · 星云（左右移动手掌转视角）';
    if (fistHand) return '握拳 · 聚成树';
    return '看到手了 · 试试握拳 / 张开手掌 / 捏合';
}

function debugText(live) {
    if (!live.length) return '—';
    return live
        .map(
            (t, i) =>
                `#${i} ${t.label} 手指${t.extended} 捏${t.pinch.toFixed(2)} 伸${t.reach.toFixed(2)}`
        )
        .join('  |  ');
}
