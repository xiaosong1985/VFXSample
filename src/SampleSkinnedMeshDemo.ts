const { regClass, property } = Laya;

/**
 * SampleSkinnedMesh 验证：把场景里的 SkinnedMeshRenderer 注册到 VFX 的 SkinnedMesh source map
 *
 * 用法：
 * - 挂在 VisualEffect 节点上
 * - Inspector 把 targetSkinnedMesh 拖入场景里的 SkinnedMesh 节点（如 LayaMonkey）
 *
 * 期望：粒子点云贴在 SkinnedMesh 表面，跟随骨骼动画扭动
 */
@regClass()
export class SampleSkinnedMeshDemo extends Laya.Script {

    declare owner: Laya.Sprite3D;

    @property({ type: "Node" })
    targetSkinnedMesh: Laya.Sprite3D = null;

    /**
     * 必须与 VFX 资产里骨骼网格 source 的名字一致。
     * UNI VFX (Energy DM 等) 用 Unity 暴露属性名 "SkinnedMesh"——别填动画名/角色名,否则 sourceFound=false,粒子塌到原点。
     */
    @property({ type: String })
    sourceName: string = "SkinnedMesh";

    /**
     * SkinnedMeshTransform: VFX 资产里驱动 bolts/sparks 位置的骨骼变换 source 名(Unity 暴露属性名)。
     */
    @property({ type: String })
    transformSourceName: string = "SkinnedMeshTransform";

    /**
     * 该 transform source 绑定到哪根骨骼(按名字在 SkinnedMeshRenderer.bones 里找)。
     * Energy DM 在 Unity 里绑的是 Ellen_Hips(胯骨)——闪电围绕它跟随动画。
     */
    @property({ type: String })
    transformBoneName: string = "Ellen_Hips";

    private _ve: any = null;

    onStart(): void {
        this._ve = this.findVisualEffect();
        if (!this._ve) {
            console.warn("[SampleSkinnedMeshDemo] VisualEffect 组件未找到");
            return;
        }
        if (!this.targetSkinnedMesh) {
            console.warn("[SampleSkinnedMeshDemo] targetSkinnedMesh 未设置 — 拖一个挂着 SkinnedMeshRenderer 的节点到 Inspector");
            return;
        }
        // 在目标节点及其子节点查找 SkinnedMeshRenderer
        const renderer = this._findSkinnedMeshRenderer(this.targetSkinnedMesh);
        if (!renderer) {
            console.warn("[SampleSkinnedMeshDemo] 目标节点及子节点找不到 SkinnedMeshRenderer 组件");
            return;
        }
        this._ve.setSkinnedMeshSource(this.sourceName, renderer);
        // LayaAir mesh 在 owner Sprite3D 的 MeshFilter 组件上（不在 SkinnedMeshRenderer 上）
        const mesh = renderer.owner?.getComponent(Laya.MeshFilter)?.sharedMesh;
        const positions: any[] = [];
        try { mesh?.getPositions(positions); } catch {}
        console.log(`[SampleSkinnedMeshDemo] 注册 sourceName="${this.sourceName}" → vertexCount=${positions.length} bones=${renderer.bones?.length}`);

        // SkinnedMeshTransform: 按名字在骨骼数组里找目标骨骼(Ellen_Hips),注册给 VFX,
        // 引擎每帧用它的世界矩阵驱动 bolts/sparks 位置 → 围绕该骨骼跟随动画。
        if (this.transformSourceName && this.transformBoneName && this._ve.setTransformSource) {
            const bone = this._findBoneByName(renderer.bones, this.transformBoneName);
            if (bone) {
                this._ve.setTransformSource(this.transformSourceName, bone);
                console.log(`[SampleSkinnedMeshDemo] 注册 transformSource="${this.transformSourceName}" → 骨骼 "${this.transformBoneName}"`);
            } else {
                console.warn(`[SampleSkinnedMeshDemo] 骨骼 "${this.transformBoneName}" 没找到(bones=${renderer.bones?.length}),SkinnedMeshTransform 未绑`);
            }
        }

        // VFXTransform: Energy DM 的 bolts/sparks/surge 位置 = (随机Y) × VFXTransform 矩阵(对齐 Unity)。
        // Unity prefab 把 VFXTransform 绑到角色 FBX 根 → 粒子列摆在角色处跟随。这里绑到角色根节点
        // (targetSkinnedMesh 拖入的节点)。其本地 TRS(offset/旋转,prefab override)后续 C 步处理。
        if (this._ve.setTransformSource && this.targetSkinnedMesh) {
            this._ve.setTransformSource("VFXTransform", this.targetSkinnedMesh);
            console.log(`[SampleSkinnedMeshDemo] 注册 transformSource="VFXTransform" → 角色根 "${this.targetSkinnedMesh.name}"`);
        }
    }

    /** 在 SkinnedMeshRenderer.bones 数组里按名字找骨骼节点 */
    private _findBoneByName(bones: any[], name: string): any {
        if (!bones) return null;
        for (const b of bones) {
            if (b && b.name === name) return b;
        }
        // 退而求其次:名字包含(兼容 Ellen_Hips vs Hips)
        for (const b of bones) {
            if (b && typeof b.name === "string" && (b.name.indexOf(name) >= 0 || name.indexOf(b.name) >= 0)) return b;
        }
        return null;
    }

    private _findSkinnedMeshRenderer(node: Laya.Sprite3D): any {
        const direct = (node as any).getComponent?.(Laya.SkinnedMeshRenderer);
        if (direct) return direct;
        // 递归子节点
        for (let i = 0; i < node.numChildren; i++) {
            const c = node.getChildAt(i);
            if (c instanceof Laya.Sprite3D) {
                const r = this._findSkinnedMeshRenderer(c);
                if (r) return r;
            }
        }
        return null;
    }

    /** 在 owner 自身 + 子节点（递归）查找 VisualEffect 组件 */
    private findVisualEffect(node?: Laya.Sprite3D): any {
        const target = node || this.owner;
        const components = (target as any)._components;
        if (components) {
            for (const comp of components) {
                if (!comp) continue;
                if (comp.constructor?.name === "VisualEffect") return comp;
                if ("setSkinnedMeshSource" in comp) return comp;
            }
        }
        // 递归子节点
        for (let i = 0; i < target.numChildren; i++) {
            const c = target.getChildAt(i);
            if (c instanceof Laya.Sprite3D) {
                const ve = this.findVisualEffect(c);
                if (ve) return ve;
            }
        }
        return null;
    }

    onDestroy(): void {
        if (this._ve) this._ve.clearSkinnedMeshSource(this.sourceName);
    }
}
