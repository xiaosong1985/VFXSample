/**
 * VfxCurveField — VFX 曲线编辑 Inspector 控件
 *
 * 复用 LayaIDE 内置 CurveInput 控件（关键帧拖拽 / 切线 / 权重 / 预设 / 右键复制粘贴），
 * 在字段边界做 VFX 原生格式 ↔ CurveInput 点 的双向桥接：
 *   - curve / sampleCurve 操作节点：{ frameData: [time,value,inTan,outTan,inW,outW,weightedMode, ...] }（扁平 7/key）
 *   - Curve 属性：                  { frames: [{time,value,inTangent,outTangent,inWeight,outWeight,weightedMode}, ...] }
 * 编译器 / .vfx / 转换器始终读写原生格式，编辑器只临时转换 → 零格式污染、与转换器解耦。
 *
 * 属性定义用 `inspector: "vfxCurve"` 选用本控件（见 VfxNodeDefs.registerAllVfxTypes 注册）。
 * isCurve+isWeight 与 LayaIDE 内置 Particle 曲线一致（加权贝塞尔），否则切线被当非加权解释会过冲（显示成两条线）。
 */
interface ICurvePoint { t: number; val: number; inTan: number; outTan: number; inW: number; outW: number; wMode: number; }

export class VfxCurveField extends IEditor.PropertyField {
    /** LayaIDE CurveInput 控件（私有类型，按 any 处理） */
    private _input: any;
    /** 上次读到的存储格式，提交时按原格式写回（不改变 operator/property 各自的约定） */
    private _fmt: "frameData" | "frames" = "frameData";

    public create() {
        this._input = gui.UIPackage.createWidgetSync("~/ui/basic/CurveEdit/CurveInput.widget");
        this._input.isCurve = true;     // 带切线（贝塞尔），非折线
        this._input.isWeight = true;    // 加权切线（与内置 Particle 曲线一致，VFX frameData 自带权重）
        this._input.checkable = false;
        this._input.on("submit", () => this._commit());
        return { ui: this._input };
    }

    public refresh(): void {
        const pts = this._readPoints(this.target.getValue());

        // 显示值域按数据自适应（VFX 曲线值可能 >1，如 size 曲线），避免被默认 0..1 裁切
        let minV = 0, maxV = 1;
        for (const p of pts) { if (p.val < minV) minV = p.val; if (p.val > maxV) maxV = p.val; }
        this._input.curveMin = minV;
        this._input.curveMax = maxV;

        this._input.clearPoints();
        if (pts.length >= 2) {
            for (const p of pts) {
                const pt = this._input.addPoint();
                pt.px = p.t; pt.py = p.val;
                pt.inTangent = p.inTan; pt.outTangent = p.outTan;
                pt.inWeight = p.inW; pt.outWeight = p.outW;
            }
        } else {
            this._input.setDefaultPoints();
        }
        this._input.applyChange();
    }

    /**
     * 从存储值解析关键帧点，同时记录原格式。
     * ⚠️ Unity 导出会把关键帧补帧到固定 8 帧，多余的是 (time=0,value=0) 占位帧。
     * 对齐内置 CurveField：时间非严格递增就停止读取，丢掉补帧（否则缩略图会从末帧画回 (0,0) → 多一条斜线）。
     */
    private _readPoints(v: any): ICurvePoint[] {
        const out: ICurvePoint[] = [];
        let lastT = -Infinity;
        const push = (p: ICurvePoint): boolean => {
            if (out.length > 0 && p.t <= lastT) return false; // 时间不再递增 → 补帧，停止
            out.push(p); lastT = p.t; return true;
        };

        if (v && Array.isArray(v.frames)) {
            this._fmt = "frames";
            for (const f of v.frames) {
                const ok = push({
                    t: Number(f.time) || 0, val: Number(f.value) || 0,
                    inTan: Number(f.inTangent) || 0, outTan: Number(f.outTangent) || 0,
                    inW: f.inWeight != null ? Number(f.inWeight) : 1 / 3,
                    outW: f.outWeight != null ? Number(f.outWeight) : 1 / 3,
                    wMode: Number(f.weightedMode) || 0,
                });
                if (!ok) break;
            }
            return out;
        }

        this._fmt = "frameData";
        const fd = v && Array.isArray(v.frameData) ? v.frameData : null;
        if (fd) {
            for (let i = 0; i + 3 < fd.length; i += 7) {
                const ok = push({
                    t: fd[i] || 0, val: fd[i + 1] || 0,
                    inTan: fd[i + 2] || 0, outTan: fd[i + 3] || 0,
                    inW: fd[i + 4] != null ? fd[i + 4] : 1 / 3,
                    outW: fd[i + 5] != null ? fd[i + 5] : 1 / 3,
                    wMode: fd[i + 6] || 0,
                });
                if (!ok) break;
            }
        }
        return out;
    }

    /** CurveInput 点 → 原存储格式，写回 */
    private _commit(): void {
        const points: any[] = this._input.points || [];
        const w = (v: any, d: number) => (v != null ? Number(v) : d);
        if (this._fmt === "frames") {
            const frames = points.map(p => ({
                time: p.px, value: p.py,
                inTangent: p.inTangent, outTangent: p.outTangent,
                inWeight: w(p.inWeight, 1 / 3), outWeight: w(p.outWeight, 1 / 3),
                weightedMode: 0,
            }));
            this.target.setValue({ frames });
        } else {
            const frameData: number[] = [];
            for (const p of points) {
                frameData.push(p.px, p.py, p.inTangent, p.outTangent, w(p.inWeight, 1 / 3), w(p.outWeight, 1 / 3), 0);
            }
            this.target.setValue({ frameData });
        }
    }
}
