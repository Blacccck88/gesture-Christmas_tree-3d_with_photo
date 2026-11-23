/**
 * 全局配置。
 * 想调效果基本只改这一个文件就够了。
 */

export const CONFIG = {
    colors: {
        bg: 0x050d1a,            // 深邃午夜蓝
        fog: 0x050d1a,
        champagneGold: 0xffd966,
        deepGreen: 0x03180a,
        accentRed: 0x990000,
    },

    /**
     * 粒子数量按设备能力分档。
     * 全部装饰物 + 金尘都走 InstancedMesh，所以数量再大也只有个位数 draw call，
     * 真正的瓶颈是每帧要在 JS 里合成多少个矩阵 —— 手机上降档就是降这个。
     */
    quality: {
        high:   { count: 1500, dustCount: 2000, snowCount: 1000, pixelRatio: 2 },
        medium: { count: 1000, dustCount: 1200, snowCount: 600,  pixelRatio: 1.5 },
        low:    { count: 700,  dustCount: 700,  snowCount: 400,  pixelRatio: 1 },
    },

    particles: {
        // count / dustCount / snowCount 由 applyQuality() 在启动时按设备填入
        treeHeight: 24,
        treeRadius: 8,
    },

    render: {
        // pixelRatio 同样由 applyQuality() 填入
    },

    camera: {
        z: 50,
        minDistance: 15,
        maxDistance: 120,
    },

    photos: {
        /**
         * 上限从 120 降到 64。
         * 一张手机原图 4000×3000 直接上传成纹理要 ~48MB 显存，选一个十张的文件夹
         * 就是半张显卡 —— 超了之后 WebGL 不报错，只是纹理默默变白，看起来就是
         * 「空白图片」。现在每张照片进 GPU 前会先缩到 maxTextureEdge，
         * 64 张合计约 90MB，稳。
         */
        maxCount: 64,
        maxTextureEdge: 512,     // 纹理长边上限（像素）
        loops: 3,                // 照片沿树身螺旋绕几圈
        placeholderCount: 6,     // 一张照片都加载不到时挂几张提示卡
        longEdge: 2.8,           // 照片长边的世界尺寸（树高 24，太小的照片根本看不清）
        radialOffset: 3.9,       // 比树身半径再外扩多少，让照片浮在装饰物外面
        border: 0.13,            // 金框宽度（世界单位）
        /**
         * 照片朝向镜头的程度：1 = 始终完全正对镜头。
         * 原版让照片一律「背对树轴、正面朝外」，绝大多数照片侧对甚至背对镜头，
         * 只剩一条金边或一块镜像的背板，很难看。现在 TREE 和 SCATTER 两种形态
         * 都让照片正对镜头（见 particle.js），照片内容永远看得清。
         * 想找回一点立体偏转可以往下调（0 = 完全朝树轴外侧）。
         */
        faceCamera: 1.0,
    },

    /** 「抽一张照片到眼前」的表现参数 */
    focus: {
        distance: 13.5,          // 照片停在相机前方多远
        fillHeight: 0.42,        // 占可见高度的比例（0.6 会挡掉半屏，太占）
        fillWidth: 0.5,          // 占可见宽度的比例（竖图时生效）
        inDuration: 0.45,        // 飞到眼前用多久（秒）—— 别拖，捏了就到
        outDuration: 0.4,        // 飞回树上用多久
        bloomWhileFocus: 0.18,   // 看照片时把辉光压下去，否则照片会糊成一片白
    },

    preload: {
        /**
         * 把照片放进 ./images/，再建一个 images/manifest.json 列出文件名即可自动加载。
         * 参考 images/manifest.example.json。没有这个文件就静默跳过。
         */
        manifest: './images/manifest.json',

        /**
         * 没有任何本地照片时用的默认示例图。
         * 特意放在 assets/ 下、并且是本地文件：以前指向 Unsplash 外链，
         * 国内经常拉不下来，Promise 一挂就是几十秒，树上空空如也。
         */
        fallbackImages: [
            './assets/photos/01-bokeh.jpg',
            './assets/photos/02-aurora.jpg',
            './assets/photos/03-snowforest.jpg',
            './assets/photos/04-window.jpg',
            './assets/photos/05-pine.jpg',
            './assets/photos/06-ornaments.jpg',
        ],

        timeout: 6000,           // 单张图最多等多久（毫秒），超时就跳过，别拖住整棵树
    },

    gestures: {
        /**
         * 判定全部用「掌宽」（食指根 5 ↔ 小指根 17）做归一化基准。
         * 比用腕-中指根的长度稳定得多：手指一伸一屈它就变，掌宽不会。
         */
        pinchEnter: 0.35,        // 拇指尖↔食指尖 / 掌宽 低于此值 → 捏合
        pinchExit: 0.55,         // 高于此值才算松开（滞回，防边界抖动）
        pinchMinReach: 0.78,     // 食指伸出程度下限，用来排除「握拳时拇指贴着食指」。
                                 // 捏合时食指本来就是弯的，reach 常见 0.8~1.3，捏得紧的人
                                 // 能到 0.85 以下；握拳在 0.6~0.75。0.78 取两者之间偏松的
                                 // 一侧 —— 宁可偶发多抽一张，也别漏掉真捏合
        pinchDynamicMax: 0.65,   // 动态触发：动作结束时 pinch 得低于这个值
        pinchDropRate: 1.2,      // 动态触发：pinch 每秒下降超过这个值算「快速捏下去」
        fingerStraightRatio: 1.18, // 指尖到手腕 / 近端指节到手腕 超过此值算伸直
        openMinFingers: 4,       // 至少几根手指伸直算张开
        fistMaxFingers: 1,       // 至多几根算握拳
        minPalmWidth: 0.03,      // 掌宽小于此值说明手太远 / 太糊，忽略这一帧
        confirmFrames: 2,        // 连续多少帧一致才认这个手势（防抖）
        pinchReleaseMs: 150,     // 捏合松开后等多久才把照片送回去（防误抖）
        smoothing: 0.55,         // 手位置 EMA 系数，越小越稳但越迟
        maxDetectFps: 30,        // 手势识别限帧，给渲染留出时间
        wasmProbeTimeout: 2500,  // 探测 wasm 镜像的超时（毫秒）
    },
};

/**
 * 运行时状态，模块之间共享读写。
 *
 * 注意：这里只有「树」的两种形态。抽照片不再是一种 mode ——
 * 以前捏合会把 mode 改成 FOCUS，而粒子更新里 FOCUS 会把整棵树都送到星云球面上，
 * 于是捏一下手指整棵树就炸开，非常突兀。现在照片的飞入飞出由 focus.js 单独管，
 * 树该是什么样还是什么样。
 */
export const STATE = {
    mode: 'TREE',                  // TREE | SCATTER
    hand: { detected: false, x: 0, y: 0 },
    hands: [],                     // 每帧识别到的手：[{ label, x, y }]
    rotation: { x: 0, y: 0 },
    userControllingCamera: false,  // 鼠标拖拽期间暂停自转
};

/**
 * 按设备能力挑一档画质，并把结果写回 CONFIG.particles。
 *
 * 判断依据有意保守：手机上跑满 1500 个装饰物 + 2000 粒金尘 + Bloom 会直接掉到
 * 十几帧，宁可少一点也要保证顺滑 —— 卡顿比粒子少更劝退。
 * 想强制某一档可以加 URL 参数：?quality=high|medium|low
 */
export function applyQuality() {
    const forced = new URLSearchParams(location.search).get('quality');
    // 必须用 hasOwnProperty：CONFIG.quality 是普通对象字面量，?quality=toString
    // 之类会顺着原型链取到函数，通过真值判断后解构出一堆 undefined，
    // 最终 setPixelRatio(NaN) 把画布尺寸变成 0，用户看到的是一片空白。
    const valid = forced !== null && Object.prototype.hasOwnProperty.call(CONFIG.quality, forced);
    const tier = valid ? forced : detectTier();

    const { count, dustCount, snowCount, pixelRatio } = CONFIG.quality[tier];
    Object.assign(CONFIG.particles, { count, dustCount, snowCount });
    Object.assign(CONFIG.render, { pixelRatio });
    CONFIG.activeQuality = tier;

    return tier;
}

function detectTier() {
    // 粗略指针 = 触摸屏，基本等同于手机 / 平板
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 500;

    if (isTouch && (narrow || cores <= 4)) return 'low';
    if (isTouch || cores <= 4) return 'medium';
    return 'high';
}
