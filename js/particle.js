/**
 * 单个粒子的行为：在「树形」和「散开」两种目标位置之间插值。
 *
 * 抽到眼前的照片不归这里管 —— 它被 focus.js 借走、临时挂到 scene 上
 * 用世界坐标做动画，本类看到 focused 就直接跳过。
 */
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clock, camera, mainGroup } from './scene.js';
import { damp } from './utils.js';

/**
 * 复用的临时对象。
 * 原来的实现每个粒子每帧都 `new THREE.Vector3(s,s,s)`，3500 个粒子 × 60fps
 * 就是每秒二十多万个一次性对象，GC 压力全浪费在这上面了。
 */
const _tmpScale = new THREE.Vector3();

// 照片朝向计算用的临时对象，同样模块级复用
const _camLocal = new THREE.Vector3();
const _qOutward = new THREE.Quaternion();
const _orientProbe = new THREE.Object3D();

/**
 * 照片挂在树上时的朝向，结果是 **mainGroup 局部坐标系**下的四元数。
 *
 * 原版让照片一律「背对树轴、正面朝外」（lookAt(0,y,0) + rotateY(π)）。
 * 结果只有刚好转到镜头正前方的那一两张能被看见，其余全是侧面 ——
 * 在深蓝背景上就是一条细金边，很容易被当成「空白图片 / 加载失败」。
 *
 * 这里把「朝外」和「朝相机」按 faceCamera 混合：照片基本都看得清内容，
 * 树自转时又还保留一点角度变化，不会变成一排贴纸。
 * focus.js 里照片飞回树上时也调用它，保证落地瞬间的朝向是一致的。
 */
export function photoLocalQuaternion(posLocal, out) {
    // 相机位置换算到 mainGroup 局部坐标（调用前 mainGroup.matrixWorld 已刷新）
    _camLocal.copy(camera.position);
    mainGroup.worldToLocal(_camLocal);

    _orientProbe.position.copy(posLocal);
    _orientProbe.lookAt(0, posLocal.y, 0);
    _orientProbe.rotateY(Math.PI);          // 法线翻到径向外侧
    _qOutward.copy(_orientProbe.quaternion);

    _orientProbe.lookAt(_camLocal);         // 正对相机
    return out.slerpQuaternions(_qOutward, _orientProbe.quaternion, CONFIG.photos.faceCamera);
}

export const particleSystem = [];

/** 所有 InstancedMesh，每帧统一置一次 needsUpdate。 */
export const instancedMeshes = [];

export function registerInstancedMesh(mesh) {
    instancedMeshes.push(mesh);
    return mesh;
}

export class Particle {
    /**
     * @param {THREE.Object3D} mesh
     *   照片是真正在场景图里的 Group；装饰物和金尘则是**游离的 Object3D**
     *   —— 它不进场景图，只当一个持久的变换容器（位置 / 旋转 / 缩放），
     *   每帧把合成好的矩阵写进对应 InstancedMesh 的第 index 个实例。
     *   这样 3500 个粒子从 3500 次 draw call 压缩到 6 次。
     * @param {{mesh: THREE.InstancedMesh, index: number} | null} instanced
     */
    constructor(mesh, type, isDust = false, instanced = null) {
        this.mesh = mesh;
        this.type = type;
        this.isDust = isDust;
        this.instanced = instanced;

        /** 被 focus.js 借走时为 true，本类不再写它的变换 */
        this.focused = false;

        this.posTree = new THREE.Vector3();
        this.posScatter = new THREE.Vector3();
        this.baseScale = mesh.scale.x;

        const speedMult = type === 'PHOTO' ? 0.3 : 2.0;
        this.spinSpeed = new THREE.Vector3(
            (Math.random() - 0.5) * speedMult,
            (Math.random() - 0.5) * speedMult,
            (Math.random() - 0.5) * speedMult
        );

        this.calculatePositions();
    }

    calculatePositions() {
        this.randomizeScatterPosition(this.isDust ? 12 : 8, this.isDust ? 20 : 12);

        if (this.type === 'PHOTO') {
            // 照片的树形位置由 photos.js 的 updatePhotoLayout() 统一排布
            this.posTree.set(0, 0, 0);
            return;
        }

        const h = CONFIG.particles.treeHeight;
        let t = Math.pow(Math.random(), 0.8);
        const y = t * h - h / 2;

        const rMax = Math.max(CONFIG.particles.treeRadius * (1.0 - t), 0.5);
        const angle = t * 50 * Math.PI + Math.random() * Math.PI;
        const r = rMax * (0.8 + Math.random() * 0.4);

        this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
    }

    /** 在一个球壳里均匀取点，作为散开时的位置。 */
    randomizeScatterPosition(minR, spread) {
        const r = minR + Math.random() * spread;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        this.posScatter.set(
            r * Math.sin(phi) * Math.cos(theta),
            r * Math.sin(phi) * Math.sin(theta),
            r * Math.cos(phi)
        );
    }

    update(dt, mode) {
        if (this.focused) return;

        const target = mode === 'SCATTER' ? this.posScatter : this.posTree;
        this.mesh.position.lerp(target, damp(2.0, dt));

        if (mode === 'SCATTER' && this.type !== 'PHOTO') {
            // 装饰物 / 金尘自由翻滚；照片不参与，见下一分支
            this.mesh.rotation.x += this.spinSpeed.x * dt;
            this.mesh.rotation.y += this.spinSpeed.y * dt;
            this.mesh.rotation.z += this.spinSpeed.z * dt;
        } else if (this.type === 'PHOTO') {
            // 两种形态都正对镜头：树自转时照片绕着树走，但永远不把
            // 背面 / 侧边亮给观众。
            photoLocalQuaternion(this.mesh.position, this.mesh.quaternion);
        } else {
            const k = damp(1.0, dt);
            this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, k);
            this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, k);
            this.mesh.rotation.y += 0.5 * dt;
        }

        this.mesh.scale.lerp(_tmpScale.setScalar(this.targetScale(mode)), damp(4, dt));

        if (this.instanced) {
            this.mesh.updateMatrix();
            this.instanced.mesh.setMatrixAt(this.instanced.index, this.mesh.matrix);
        }
    }

    targetScale(mode) {
        if (this.isDust) {
            // 金尘只在散开时出现，聚成树时缩到 0 藏起来
            if (mode === 'TREE') return 0;
            return this.baseScale * (0.8 + 0.4 * Math.sin(clock.elapsedTime * 4 + this.mesh.id));
        }
        if (mode === 'SCATTER' && this.type === 'PHOTO') return this.baseScale * 2.5;
        return this.baseScale;
    }
}

/** 每帧更新全部粒子，最后统一提交实例矩阵。 */
export function updateParticles(dt, mode) {
    for (const p of particleSystem) p.update(dt, mode);
    for (const m of instancedMeshes) m.instanceMatrix.needsUpdate = true;
}
