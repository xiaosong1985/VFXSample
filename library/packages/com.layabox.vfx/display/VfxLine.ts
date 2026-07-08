import type { VfxStage } from "./VfxStage";

/** SVG 画布尺寸（与 VfxStage.SVG_SIZE 保持一致） */
const SVG_SIZE = 100000;

/**
 * SVG 贝塞尔曲线连线
 * 参照 blueprintEditor/display/blueprint/BPLine.ts 的绘制算法
 */
export class VfxLine {
    private _stage: VfxStage;
    private _path: any;
    private _lineColor: string = "#cccccc";
    private _lineW: number = 3;

    private _startX: number = 0;
    private _startY: number = 0;
    private _endX: number = 0;
    private _endY: number = 0;
    private _cached: { sx: number; sy: number; ex: number; ey: number } | null = null;

    /** 连接标识（临时拖拽线时为默认值 -1/""） */
    public outNodeId: number = -1;
    public outSlotId: string = "";
    public inNodeId: number = -1;
    public inSlotId: string = "";

    /** 线条样式："data" 水平贝塞尔，"flow" 垂直贝塞尔 */
    public lineStyle: "data" | "flow" = "data";

    constructor(stage: VfxStage) {
        this._stage = stage;
    }

    set lineColor(color: string) {
        this._lineColor = color || "#cccccc";
    }

    /** 从全局坐标设置起点 */
    begin(globalX: number, globalY: number): void {
        const local = this._stage.cont.globalToLocal(globalX, globalY);
        this._startX = local.x;
        this._startY = local.y;
        this._endX = local.x;
        this._endY = local.y;
    }

    /** 从 cont 本地坐标设置起点（避免 localToGlobal/globalToLocal 缓存偏差） */
    beginLocal(localX: number, localY: number): void {
        this._startX = localX;
        this._startY = localY;
        this._endX = localX;
        this._endY = localY;
    }

    /** 拖拽过程中更新终点（全局坐标） */
    moveEnd(globalX: number, globalY: number): void {
        const local = this._stage.cont.globalToLocal(globalX, globalY);
        this._endX = local.x;
        this._endY = local.y;
        this._drawCurveLine();
    }

    /** 拖拽过程中更新终点（cont 本地坐标） */
    moveEndLocal(localX: number, localY: number): void {
        this._endX = localX;
        this._endY = localY;
        this._drawCurveLine();
    }

    /** 从局部坐标直接设置起终点 */
    setLocalEndpoints(sx: number, sy: number, ex: number, ey: number): void {
        this._startX = sx;
        this._startY = sy;
        this._endX = ex;
        this._endY = ey;
        this._drawCurveLine();
    }

    /** 从全局坐标设置起终点 */
    setEndpoints(startGX: number, startGY: number, endGX: number, endGY: number): void {
        const s = this._stage.cont.globalToLocal(startGX, startGY);
        const e = this._stage.cont.globalToLocal(endGX, endGY);
        this._startX = s.x;
        this._startY = s.y;
        this._endX = e.x;
        this._endY = e.y;
        this._drawCurveLine();
    }

    /** 刷新连线 */
    refresh(): void {
        this._cached = null;
        this._drawCurveLine();
    }

    /** 移除并清理 */
    dispose(): void {
        if (this._path) {
            this._path.remove();
            this._path = null;
        }
        this._cached = null;
        if (this._stage) {
            const i = this._stage.lines.indexOf(this);
            if (i >= 0) this._stage.lines.splice(i, 1);
        }
        this._stage = null;
    }

    /**
     * 核心绘制 — 贝塞尔曲线
     * data 线：水平控制点（左右端口）
     * flow 线：垂直控制点（上下端口）
     */
    private _drawCurveLine(): void {
        let { _startX: sx, _startY: sy, _endX: ex, _endY: ey } = this;
        if (isNaN(sx) || isNaN(sy) || isNaN(ex) || isNaN(ey) || !this._stage) return;

        if (this._cached && this._cached.sx === sx && this._cached.sy === sy
            && this._cached.ex === ex && this._cached.ey === ey) return;
        this._cached = { sx, sy, ex, ey };

        if (this._stage.lines.indexOf(this) === -1) {
            this._stage.lines.push(this);
        }

        const hw = SVG_SIZE * 0.5;
        sx += hw;
        ex += hw;
        sy += hw;
        ey += hw;

        let pathStr: string;

        if (this.lineStyle === "flow") {
            // 垂直贝塞尔 — flow 连接（上下端口）
            const dist = Math.abs(ey - sy);
            let ctrl = dist * 0.4;
            if (ctrl < 30) ctrl = 30;
            if (ctrl > 200) ctrl = 200;

            pathStr = `M ${sx} ${sy} C ${sx} ${sy + ctrl} ${ex} ${ey - ctrl} ${ex} ${ey}`;
        } else {
            // 水平贝塞尔 — 数据连接（左右端口）
            if (sy === ey) ey += 0.1;

            const dist = Math.sqrt((ex - sx) * (ex - sx) + (ey - sy) * (ey - sy));
            let CONTROL = Math.abs(dist) * 0.3;
            if (CONTROL > 200) CONTROL = 200;

            const cp1 = { x: sx + CONTROL, y: sy };
            const center = { x: (sx + ex) / 2, y: (sy + ey) / 2 };
            const cp2 = { x: ex - CONTROL, y: ey };
            pathStr = `M ${sx} ${sy} Q ${cp1.x} ${cp1.y} ${center.x} ${center.y} ${cp2.x} ${cp2.y} ${ex} ${ey}`;
        }

        const strokeWidth = this.lineStyle === "flow" ? 2 : this._lineW;

        if (!this._path) {
            this._path = this._stage.lineSVG.path(pathStr)
                .stroke({ width: strokeWidth, color: this._lineColor })
                .fill("none");
            this._path.node.style.pointerEvents = "none";
        }

        this._path.plot(pathStr)
            .stroke({ width: strokeWidth, color: this._lineColor })
            .fill("none");
    }
}
