/**
 * 界面：加载遮罩、上传按钮、首次引导、保存图片、快捷键、状态条。
 */
import { CONFIG, STATE } from './config.js';
import { addFiles, photoCount, removeWhere } from './photos.js';
import { saveImage } from './capture.js';
import { isDemoMode } from './demo.js';
import { grabNextPhoto, releasePhoto, releaseAllImmediately, subscribeFocus } from './focus.js';

const SEEN_KEY = 'grand-luxury-tree:onboarded';

let statusEl = null;
let debugEl = null;
let captionEl = null;
let toastEl = null;
let onboardingEl = null;
let toastTimer = 0;

export function initUI() {
    statusEl = document.getElementById('status-info');
    debugEl = document.getElementById('debug-info');
    captionEl = document.getElementById('focus-caption');
    toastEl = document.getElementById('toast');
    onboardingEl = document.getElementById('onboarding');

    document.getElementById('file-input').addEventListener('change', onFilesChosen);
    document.getElementById('folder-input').addEventListener('change', onFilesChosen);
    document.getElementById('save-btn').addEventListener('click', onSave);
    // 手势之外永远可用的兜底：摄像头识别不灵的时候点这里
    document.getElementById('pull-btn').addEventListener('click', () => {
        grabNextPhoto();
    });
    document.getElementById('help-btn').addEventListener('click', () => toggleOnboarding(true));
    document.getElementById('onboarding-close').addEventListener('click', () => toggleOnboarding(false));

    window.addEventListener('keydown', onKeyDown);
    subscribeFocus(onFocusChange);

    if (!isDemoMode() && !hasSeenOnboarding()) toggleOnboarding(true);
}

/* ---------- 首次引导 ---------- */

function hasSeenOnboarding() {
    // 隐私模式下 localStorage 会直接抛异常，读不到就当没看过，无伤大雅
    try {
        return localStorage.getItem(SEEN_KEY) === '1';
    } catch {
        return false;
    }
}

function toggleOnboarding(show) {
    if (!onboardingEl) return;
    onboardingEl.hidden = !show;

    if (show) return;
    try {
        localStorage.setItem(SEEN_KEY, '1');
    } catch {
        // 存不下就算了，下次再弹一遍也不是什么大问题
    }
}

/* ---------- 上传照片 ---------- */

async function onFilesChosen(event) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []).filter((f) => f.type.startsWith('image/'));

    // 必须在任何早退之前清空：否则用户选了一个筛完为空的文件夹（比如里面都是
    // 浏览器报不出 MIME 的 .heic），再选同一个文件夹时 change 事件根本不会触发，
    // 按钮看起来就像坏了。
    input.value = '';

    if (!files.length) return;

    const room = CONFIG.photos.maxCount - photoCount();
    toast(`正在读取 ${Math.min(files.length, Math.max(room, 0))} 张照片…`, 2000);

    const { added, skipped } = await addFiles(files);

    if (added) {
        // 用户开始传自己的照片后，内置示例图和引导卡就没用了，清掉，
        // 树上只留用户自己的照片。
        releaseAllImmediately();
        const cleaned = removeWhere((p) => {
            const source = p.mesh.userData.source;
            return source === 'fallback' || source === 'placeholder';
        });

        toast(
            `已挂上 ${added} 张照片${cleaned ? '，示例图已撤下' : ''}${skipped ? ` · ${skipped} 张读不了` : ''} · 按 N 抽一张`
        );
    } else {
        toast('这些文件都读不了 · 试试 JPG / PNG');
    }
}

/* ---------- 保存图片 ---------- */

async function onSave(e) {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        const ok = await saveImage();
        btn.textContent = ok ? 'Saved' : 'Failed';
    } catch (err) {
        console.error('[tree] 保存图片失败', err);
        btn.textContent = 'Failed';
    }

    setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
    }, 1600);
}

/* ---------- 快捷键 ---------- */

function onKeyDown(e) {
    // 在输入框里打字时不触发快捷键
    if (e.target instanceof HTMLInputElement) return;
    // 放过一切组合键：Cmd/Ctrl+S 是「保存网页」，不该把树炸开；
    // Cmd+H 是 macOS 的隐藏窗口，Ctrl+D 是加书签，都不该被我们截胡。
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 演示模式接管了形态切换，按键掺和进来只会打架
    if (isDemoMode()) return;

    if (e.key === 'Escape') {
        toggleOnboarding(false);
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'h':
            // 隐藏全部 UI，方便截图 / 录屏当壁纸
            document.body.classList.toggle('ui-hidden-all');
            break;
        case 'd':
            // 手势调试数值默认藏起来，需要调阈值时按 D 打开
            document.body.classList.toggle('debug-visible');
            break;
        case 't':
            STATE.mode = 'TREE';
            releasePhoto();
            break;
        case 's':
            STATE.mode = 'SCATTER';
            releasePhoto();
            break;
        case 'n':
        case ' ':
            // 没有摄像头也能换照片：把「抽一张」搬到键盘上
            e.preventDefault();
            grabNextPhoto();
            break;
    }
}

/* ---------- 照片计数 ---------- */

function onFocusChange(info) {
    document.body.classList.toggle('photo-focus', info.active);
    if (!captionEl) return;

    captionEl.hidden = !info.active;
    if (info.active) captionEl.textContent = `${info.index} / ${info.total}`;
}

/* ---------- 状态显示 ---------- */

/** 面向用户的一行提示。手势循环每帧都会调，内容没变就不碰 DOM。 */
export function setStatus(text) {
    if (!statusEl || statusEl.textContent === text) return;
    statusEl.textContent = text;
}

/** 手势原始数值，只有按过 D 才可见。 */
export function setDebug(text) {
    if (debugEl) debugEl.textContent = text;
}

/**
 * 一次性提示条。
 * 不放在摄像头预览框里 —— 没有摄像头时那个框整个是隐藏的。
 */
export function toast(text, ms = 2800) {
    if (!toastEl) return;

    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.remove('toast-leaving');

    toastTimer = setTimeout(() => {
        toastEl.classList.add('toast-leaving');
        toastTimer = setTimeout(() => {
            toastEl.hidden = true;
            toastEl.classList.remove('toast-leaving');
        }, 360);
    }, ms);
}

export function hideLoader() {
    const loader = document.getElementById('loader');
    if (!loader) return;
    loader.style.opacity = '0';
    setTimeout(() => loader.remove(), 800);
}
