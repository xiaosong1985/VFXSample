// 用户项目里访问 IDE 自带 commonjs 模块（@svgdotjs/electron/sharp 等）走 IEditor.require，
// 不能像 LayaPro 源码那样 `import`（用户工程没装 node_modules，esbuild 解析不到包路径）。
// 模块顶层调 IEditor.require 会 ReferenceError（extension boot 期 IEditor 还没注入全局），
// 改用惰性 lazy getter，第一次构造 VfxStage 时（panel 打开后）再 require
let _SVG: any;
function SVG(...args: any[]): any {
    if (!_SVG) _SVG = IEditor.require("@svgdotjs/svg.js").SVG;
    return _SVG(...args);
}
import type { IVfxGraphData, IVfxContextData, IVfxOperatorData, IVfxEventData } from "../data/VfxTypes";
import { getEventDef, getContextDef, getOperatorDef } from "../data/VfxNodeDefs";
import { VfxEvent } from "./VfxEvent";
import { VfxContext } from "./VfxContext";
import { VfxNode } from "./VfxNode";
import { VfxLine } from "./VfxLine";
import { VfxNodePicker } from "./VfxNodePicker";
import { getSlotColor } from "./VfxSlot";

const BG_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAQBJREFUeNrs1rEKwjAUhlETUkj3vP9rdmr1Ysammk2w5wdxuLgcMHyptfawuZX4pJSWZTnfnu/lnIe/jNNxHHGNn//HNbbv+4dr6V+11uF527arU7+u63qfa/bnmh8sWLBgwYJlqRf8MEptXPBXJXa37BSl3ixYsGDBMliwFLyCV/DeLIMFCxYsWLBMwSt4Be/NggXLYMGCBUvBK3iNruC9WbBgwYJlsGApeAWv4L1ZBgsWLFiwYJmCV/AK3psFC5bBggULloJX8BpdwXuzYMGCBctgwVLwCl7Be7MMFixYsGDBsu8FH1FaSmExVfAxBa/gvVmwYMGCZbBg/W4vAQYA5tRF9QYlv/QAAAAASUVORK5CYII=";

/** 可选中的节点类型 */
export type VfxSelectable = VfxContext | VfxNode | VfxEvent;

/**
 * VFX Graph 画布
 * 管理 Context 和 Operator 双群组
 */
export class VfxStage extends gui.Widget {
    static SVG_SIZE = 100000;

    private _data: IVfxGraphData;
    private _history: IEditor.IDataHistory;

    private _cont: gui.Widget;
    private _selectBox: gui.Shape;
    private _lineContainer: gui.Widget;
    public lineSVG: any;

    private _eventMap: Map<number, VfxEvent> = new Map();
    private _contextMap: Map<number, VfxContext> = new Map();
    private _operatorMap: Map<number, VfxNode> = new Map();
    private _selection: VfxSelectable[] = [];
    public lines: VfxLine[] = [];

    /** System 虚线框 SVG 元素 */
    private _systemBoxes: any[] = [];

    /** refreshAllLines 防抖定时器 */
    private _refreshLinesTimer: any = null;

    /** 字段值提交进行中的深度计数。>0 时 VfxContext._onDataChange 跳过整块 rebuildBlocks，
     *  避免纯值编辑触发整 context 拆建重绘(背景 Shape 重建延迟一帧 → 一帧撕裂闪烁)。
     *  DataWatcher 是同步通知，故同步深度计数可靠。结构性变更走显式 onRebuild；外部变更(undo/redo)无此标志照常重建。 */
    _fieldEditDepth: number = 0;

    /** 包裹"字段值提交"的数据写入：期间的 DataWatcher 通知不触发整块重建。 */
    runFieldEdit(fn: () => void): void {
        this._fieldEditDepth++;
        try { fn(); }
        finally { this._fieldEditDepth--; }
    }

    private _panStartXY: { x: number; y: number } | null = null;
    private _panMoved: boolean = false;
    private _boxSelectStart: { x: number; y: number; lx: number; ly: number } | null = null;
    private _boxSelectBox: { x: number; y: number; w: number; h: number } | null = null;

    private _nodePicker: VfxNodePicker;

    /** 剪贴板（深拷贝的节点数据快照） */
    private _clipboard: { events: IVfxEventData[]; contexts: IVfxContextData[]; operators: IVfxOperatorData[] } | null = null;
    /** 连续粘贴次数，用于累加位置偏移 */
    private _pasteCount: number = 0;

    /** 选择变更回调 */
    public onSelectionChanged: (() => void) | null = null;

    constructor() {
        super();
    }

    get cont(): gui.Widget { return this._cont; }
    get scale(): number { return this._cont ? this._cont.scaleX : 1; }
    set scale(v: number) {
        if (this._cont) {
            this._cont.scaleX = v;
            this._cont.scaleY = v;
        }
    }
    get graphData(): IVfxGraphData { return this._data; }

    // ---- 初始化 ----

    async init(): Promise<void> {
        this.touchable = true;
        this.element.clipping = true;

        // 背景：网格 PNG tile 平铺 + 深灰兜底色（对齐蓝图 BPBasicStage.init）
        // 之前用 gui.Shape 子节点装 backgroundImage，但 Shape 自身 fillColor 把图盖掉了，
        // 看上去就是纯黑。直接挂到 stage 本体的 DOM element 即可
        this.element.style.backgroundImage = `url(${BG_IMAGE})`;
        this.element.style.backgroundColor = "#161616";

        // 内容容器
        this._cont = new gui.Widget();
        this._cont.touchThrough = true;
        this.addChild(this._cont);
        // 滚轮缩放时 _cont 会被施加 CSS transform: scaleX/scaleY（editor-ui 纯 DOM 渲染）。
        // 把它提升为独立 GPU 合成层，缩放变成合成器变换而非整棵 DOM 子树（含巨型 SVG 连线层）
        // 重新栅格化——重栅格期间合成器继续显示旧位图，消除内容闪烁（蓝图节点 DOM 简单不明显）。
        this._cont.element.style.willChange = "transform";
        this._cont.element.style.backfaceVisibility = "hidden";

        // SVG 连线层
        this._lineContainer = new gui.Widget();
        this._lineContainer.touchable = false;
        this._cont.addChild(this._lineContainer);

        this.lineSVG = SVG().addTo(this._lineContainer.element)
            .size(VfxStage.SVG_SIZE, VfxStage.SVG_SIZE);
        this.lineSVG.node.style.left = `${-(VfxStage.SVG_SIZE * 0.5)}px`;
        this.lineSVG.node.style.top = `${-(VfxStage.SVG_SIZE * 0.5)}px`;
        this.lineSVG.node.style.position = "absolute";
        // 巨型 SVG（10万像素）单独提升为合成层，避免随 _cont 缩放被反复重栅格化
        this.lineSVG.node.style.willChange = "transform";
        this.lineSVG.node.style.backfaceVisibility = "hidden";

        // 框选矩形
        this._selectBox = new gui.Shape();
        this._selectBox.visible = false;
        const gBox = this._selectBox.getGraphics(gui.SRect);
        gBox.lineWidth = 1;
        gBox.lineColor.parse("#4488ff");
        gBox.fillColor.parse("#224488");
        gBox.fillColor.a = 0.15;
        this.addChild(this._selectBox);

        // 节点选择弹窗
        this._nodePicker = new VfxNodePicker(this);
        await this._nodePicker.create();

        // 事件
        this.on("pointer_down", this._onPointerDown, this);
        this.on("mouse_wheel", this._onMouseWheel, this);
        this.on("key_down", this._onKeyDown, this);
    }

    // ---- 数据绑定 ----

    setData(data: IVfxGraphData, history: IEditor.IDataHistory): void {
        if (this._data) {
            IEditor.DataWatcher.removeListener(this._data, this._onDataChange, this);
            this._clearAll();
        }
        if (this._history) {
            this._history.onChanged.remove(this._onHistoryChanged, this);
        }

        this._history = history;
        this._data = data;
        VfxStage._migrateSpaceData(data);
        IEditor.DataWatcher.addListener(this._data, this._onDataChange, this);
        this._history.onChanged.add(this._onHistoryChanged, this);

        this._rebuildEvents();
        this._rebuildContexts();
        this._rebuildOperators();
        this.scheduleRefreshLines();
    }

    /** 迁移旧数据中的 space 字段 */
    private static _migrateSpaceData(data: IVfxGraphData): void {
        // inlineSphere: props.space → props._space
        for (const op of data.operators) {
            if (op.typeId === "inlineSphere" && op.props) {
                if ("space" in op.props && !("_space" in op.props)) {
                    op.props._space = op.props.space;
                }
                delete op.props.space;
            }
        }
        // arcSphere 默认值中删除 sphere.space
        for (const ctx of data.contexts) {
            for (const block of ctx.blocks) {
                if (block.typeId === "setPositionShape" && block.props?.arcSphere) {
                    const sphere = (block.props.arcSphere as any)?.sphere;
                    if (sphere && "space" in sphere) {
                        delete sphere.space;
                    }
                }
            }
        }
    }

    /** undo/redo 完成后刷新所有节点 UI */
    private _onHistoryChanged(): void {
        // onChanged 在「数据变化 / undo / redo」都会触发（IDataHistory 接口语义）。
        // 普通数据变化时 DataWatcher 已经做了增量更新，全图重建会引起闪烁。
        // 仅在 undo/redo（processing=true）时才需要全图重建，因为那时数据可能跨多节点跳变，
        // 单纯走 DataWatcher 的局部回调不一定能完整刷新出来。
        if (!this._history.processing) return;

        // 结构变更（增删节点）
        this._rebuildEvents();
        this._rebuildContexts();
        this._rebuildOperators();
        // 属性变更（已有节点的 UI 刷新）
        for (const [, ctx] of this._contextMap) ctx.rebuildBlocks();
        for (const [, node] of this._operatorMap) node.rebuildUI();
        for (const [, evt] of this._eventMap) evt.rebuildUI();
        this.refreshAllLines();
    }

    private _onDataChange(sender: any, target: any, key: string): void {
        const path: string[] = IEditor.DataWatcher.getPath(target, sender);
        if (!path) return;
        path.push(key);

        // events 数组增删
        if (path.length === 2 && path[0] === "events"
            && (key === "length" || !isNaN(Number(key)))) {
            this._rebuildEvents();
        }
        // contexts 数组增删
        if (path.length === 2 && path[0] === "contexts"
            && (key === "length" || !isNaN(Number(key)))) {
            this._rebuildContexts();
        }
        // operators 数组增删
        if (path.length === 2 && path[0] === "operators"
            && (key === "length" || !isNaN(Number(key)))) {
            this._rebuildOperators();
        }
    }

    // ---- Event 管理 ----

    private _rebuildEvents(): void {
        const existingIds = new Set(this._eventMap.keys());
        const dataIds = new Set(this._data.events.map(e => e.id));

        for (const id of existingIds) {
            if (!dataIds.has(id)) {
                const evt = this._eventMap.get(id);
                evt.dispose();
                this._eventMap.delete(id);
            }
        }

        for (const evtData of this._data.events) {
            if (!this._eventMap.has(evtData.id)) {
                const evtDef = getEventDef(evtData.typeId);
                if (!evtDef) continue;

                const evtUI = new VfxEvent();
                evtUI.setData(evtData, evtDef, this);
                this._cont.addChild(evtUI);
                this._eventMap.set(evtData.id, evtUI);
            }
        }

        this.scheduleRefreshLines();
    }

    // ---- Context 管理 ----

    private _rebuildContexts(): void {
        const existingIds = new Set(this._contextMap.keys());
        const dataIds = new Set(this._data.contexts.map(c => c.id));

        for (const id of existingIds) {
            if (!dataIds.has(id)) {
                const ctx = this._contextMap.get(id);
                ctx.dispose();
                this._contextMap.delete(id);
            }
        }

        for (const ctxData of this._data.contexts) {
            if (!this._contextMap.has(ctxData.id)) {
                const ctxDef = getContextDef(ctxData.typeId);
                if (!ctxDef) continue;

                const ctxUI = new VfxContext();
                ctxUI.setData(ctxData, this);
                this._cont.addChild(ctxUI);
                this._contextMap.set(ctxData.id, ctxUI);
            }
        }

        this.scheduleRefreshLines();
    }

    // ---- Operator 管理 ----

    private _rebuildOperators(): void {
        const existingIds = new Set(this._operatorMap.keys());
        const dataIds = new Set(this._data.operators.map(o => o.id));

        for (const id of existingIds) {
            if (!dataIds.has(id)) {
                const node = this._operatorMap.get(id);
                node.dispose();
                this._operatorMap.delete(id);
            }
        }

        for (const opData of this._data.operators) {
            if (!this._operatorMap.has(opData.id)) {
                const opDef = getOperatorDef(opData.typeId);
                if (!opDef) continue;

                const nodeUI = new VfxNode();
                nodeUI.setData(opData, opDef, this);
                this._cont.addChild(nodeUI);
                this._operatorMap.set(opData.id, nodeUI);
            }
        }

        this.scheduleRefreshLines();
    }

    /** 公开的清空方法：切文件前先调一次让用户立刻看到空白，再异步加载新内容 */
    clearAll(): void {
        this._clearAll();
        if (this._data) {
            IEditor.DataWatcher.removeListener(this._data, this._onDataChange, this);
            this._data = null;
        }
        if (this._history) {
            this._history.onChanged.remove(this._onHistoryChanged, this);
            this._history = null;
        }
        // 重置画布的 pan / zoom / selection / 框选状态，避免上个文件的视图状态残留到新文件
        this._selection = [];
        if (this._cont) {
            this._cont.x = 0;
            this._cont.y = 0;
            this._cont.scaleX = 1;
            this._cont.scaleY = 1;
        }
        if (this._selectBox) this._selectBox.visible = false;
    }

    private _clearAll(): void {
        for (const [, evt] of this._eventMap) evt.dispose();
        this._eventMap.clear();
        for (const [, ctx] of this._contextMap) ctx.dispose();
        this._contextMap.clear();
        for (const [, node] of this._operatorMap) node.dispose();
        this._operatorMap.clear();
        const linesToDispose = this.lines.slice();
        for (const line of linesToDispose) line.dispose();
        this.lines.length = 0;
        for (const box of this._systemBoxes) box.remove();
        this._systemBoxes.length = 0;
    }

    getEventUI(eventId: number): VfxEvent | null {
        return this._eventMap.get(eventId) || null;
    }

    getContextUI(contextId: number): VfxContext | null {
        return this._contextMap.get(contextId) || null;
    }

    getOperatorUI(operatorId: number): VfxNode | null {
        return this._operatorMap.get(operatorId) || null;
    }

    // ---- 属性 hover 高亮（左侧 Blackboard 悬停属性 → 画布对应 getProperty 节点高亮）----

    private _propHighlighted: VfxNode[] = [];

    /** 高亮所有引用指定 property 的 getProperty 节点 */
    highlightPropertyNodes(propName: string): void {
        this.clearPropertyHighlight();
        if (!this._data || !propName) return;
        for (const op of this._data.operators) {
            if (op.typeId !== "getProperty" || op.props?.property !== propName) continue;
            const ui = this._operatorMap.get(op.id);
            if (ui) { ui.setHovered(true); this._propHighlighted.push(ui); }
        }
    }

    /** 清除属性 hover 高亮 */
    clearPropertyHighlight(): void {
        for (const ui of this._propHighlighted) ui.setHovered(false);
        this._propHighlighted.length = 0;
    }

    // ---- 创建节点 ----

    createEvent(typeId: string, x: number, y: number): void {
        const evtDef = getEventDef(typeId);
        if (!evtDef || !this._data) return;

        const id = ++this._data.autoID;
        const props: Record<string, any> = {};
        if (evtDef.properties) {
            for (const p of evtDef.properties) {
                if (p.default != null) props[p.name] = p.default;
            }
        }
        const evtData: IVfxEventData = {
            id,
            typeId,
            uiData: { x: Math.floor(x), y: Math.floor(y) },
            props,
        };
        this._data.events.push(evtData);
    }

    createContext(typeId: string, x: number, y: number): void {
        const ctxDef = getContextDef(typeId);
        if (!ctxDef || !this._data) return;

        const id = ++this._data.autoID;
        const props: Record<string, any> = {};
        if (ctxDef.properties) {
            for (const p of ctxDef.properties) {
                if (p.default != null) props[p.name] = p.default;
            }
        }
        const ctxData: IVfxContextData = {
            id,
            typeId,
            uiData: { x: Math.floor(x), y: Math.floor(y) },
            blocks: [],
            props,
        };
        this._data.contexts.push(ctxData);
    }

    createOperator(typeId: string, x: number, y: number): void {
        const opDef = getOperatorDef(typeId);
        if (!opDef || !this._data) return;

        const id = ++this._data.autoID;
        const props: Record<string, any> = {};
        if (opDef.properties) {
            for (const p of opDef.properties) {
                if (p.default != null) props[p.name] = p.default;
            }
        }
        const opData: IVfxOperatorData = {
            id,
            typeId,
            uiData: { x: Math.floor(x), y: Math.floor(y) },
            props,
        };
        this._data.operators.push(opData);
    }

    /** 创建 Attribute 节点（getAttribute operator，预设 attribute 名） */
    createAttributeNode(attributeName: string, x: number, y: number): void {
        const opDef = getOperatorDef("getAttribute");
        if (!opDef || !this._data) return;

        const id = ++this._data.autoID;
        const opData: IVfxOperatorData = {
            id,
            typeId: "getAttribute",
            uiData: { x: Math.floor(x), y: Math.floor(y) },
            props: { attribute: attributeName },
        };
        this._data.operators.push(opData);
    }

    /** 创建 Property 节点（getProperty operator，预设 property 名） */
    createPropertyNode(propertyName: string, x: number, y: number): void {
        const opDef = getOperatorDef("getProperty");
        if (!opDef || !this._data) return;

        const id = ++this._data.autoID;
        const opData: IVfxOperatorData = {
            id,
            typeId: "getProperty",
            uiData: { x: Math.floor(x), y: Math.floor(y) },
            props: { property: propertyName },
        };
        this._data.operators.push(opData);
    }

    // ---- 连线管理 ----

    /** 防抖调度 refreshAllLines，多次调用只执行一次 */
    scheduleRefreshLines(): void {
        if (this._refreshLinesTimer != null) return;
        this._refreshLinesTimer = setTimeout(() => {
            this._refreshLinesTimer = null;
            this.refreshAllLines();
        }, 50);
    }

    refreshAllLines(): void {
        const linesToDispose = this.lines.slice();
        for (const line of linesToDispose) {
            if (line) line.dispose();
        }
        this.lines.length = 0;

        if (!this._data) return;

        // 0) Event flow 连接（Event → Context，支持数组格式）
        for (const evtData of this._data.events) {
            if (!evtData.flowLinks) continue;
            const srcEvtUI = this._eventMap.get(evtData.id);
            if (!srcEvtUI) continue;

            for (const outSlotId of Object.keys(evtData.flowLinks)) {
                const raw = evtData.flowLinks[outSlotId];
                const targets = Array.isArray(raw) ? raw : [raw];
                for (const lk of targets) {
                    if (!lk || !lk.targetId) continue;
                    const dstCtxUI = this._contextMap.get(lk.targetId);
                    if (!dstCtxUI) continue;

                    const outSlot = srcEvtUI.getFlowOutSlot(outSlotId);
                    const inSlot = dstCtxUI.getFlowInSlot(lk.targetSlotId);
                    if (!outSlot || !inSlot) continue;

                    const line = new VfxLine(this);
                    line.outNodeId = evtData.id;
                    line.outSlotId = outSlotId;
                    line.inNodeId = lk.targetId;
                    line.inSlotId = lk.targetSlotId;
                    line.lineColor = "#FFFFFF";
                    line.lineStyle = "flow";

                    const startPt = outSlot.getIconContLocalCenter(this._cont);
                    const endPt = inSlot.getIconContLocalCenter(this._cont);
                    line.setLocalEndpoints(startPt.x, startPt.y, endPt.x, endPt.y);
                }
            }
        }

        // 1) Flow 连接（Context → Context 或 Context → Event，通过 flowLinks）
        //    支持单对象和数组格式（Multi-Output: 一个 output slot 连多个目标）
        for (const ctxData of this._data.contexts) {
            if (!ctxData.flowLinks) continue;
            const srcCtxUI = this._contextMap.get(ctxData.id);
            if (!srcCtxUI) continue;

            for (const outSlotId of Object.keys(ctxData.flowLinks)) {
                const raw = ctxData.flowLinks[outSlotId];
                const targets = Array.isArray(raw) ? raw : [raw];

                for (const lk of targets) {
                    if (!lk || !lk.targetId) continue;

                    // 目标可能是 Context 或 Event（GPU Event）
                    let inSlot = null;
                    const dstCtxUI = this._contextMap.get(lk.targetId);
                    if (dstCtxUI) {
                        inSlot = dstCtxUI.getFlowInSlot(lk.targetSlotId);
                    } else {
                        const dstEvtUI = this._eventMap.get(lk.targetId);
                        if (dstEvtUI) {
                            inSlot = dstEvtUI.getFlowInSlot(lk.targetSlotId);
                        }
                    }

                    const outSlot = srcCtxUI.getFlowOutSlot(outSlotId);
                    if (!outSlot || !inSlot) continue;

                    const line = new VfxLine(this);
                    line.outNodeId = ctxData.id;
                    line.outSlotId = outSlotId;
                    line.inNodeId = lk.targetId;
                    line.inSlotId = lk.targetSlotId;
                    line.lineColor = "#FFFFFF";
                    line.lineStyle = "flow";

                    const startPt = outSlot.getIconContLocalCenter(this._cont);
                    const endPt = inSlot.getIconContLocalCenter(this._cont);
                    line.setLocalEndpoints(startPt.x, startPt.y, endPt.x, endPt.y);
                }
            }
        }

        // 2) 数据连接（Operator → Block/Operator）
        for (const opData of this._data.operators) {
            if (!opData.output) continue;
            const outNodeUI = this._operatorMap.get(opData.id);
            if (!outNodeUI) continue;

            for (const slotId of Object.keys(opData.output)) {
                const slotOut = opData.output[slotId];
                if (!slotOut?.infoArr) continue;

                const outSlot = outNodeUI.getOutputSlot(slotId);
                if (!outSlot) continue;

                for (const conn of slotOut.infoArr) {
                    let inSlot = null;

                    // 目标可能是 Context（通过 Block 复合 slotId）或 Operator
                    const ctxUI = this._contextMap.get(conn.nodeId);
                    if (ctxUI) {
                        inSlot = ctxUI.getInputSlot(conn.slotId);
                    } else {
                        const opUI = this._operatorMap.get(conn.nodeId);
                        if (opUI) inSlot = opUI.getInputSlot(conn.slotId);
                    }
                    if (!inSlot) continue;

                    const line = new VfxLine(this);
                    line.outNodeId = opData.id;
                    line.outSlotId = slotId;
                    line.inNodeId = conn.nodeId;
                    line.inSlotId = conn.slotId;
                    line.lineColor = getSlotColor(outSlot.slotDef.type);

                    const startPt = outSlot.getIconContLocalCenter(this._cont);
                    const endPt = inSlot.getIconContLocalCenter(this._cont);
                    line.setLocalEndpoints(startPt.x, startPt.y, endPt.x, endPt.y);
                }
            }
        }

        // 2.5) Shader-property 绑定连线（终端 operator → ShaderGraph 输出节点的命名端口）
        //      数据来自 ctx.props.shaderBindingLinks: { uniform名/exposedName: 终端 operator 的 laya id }
        //      派生只读连线：让"画布上没连线但运行时有效"的 shader 绑定可见（UNI 转换资产特性）
        for (const ctxData of this._data.contexts) {
            const links: Record<string, number | number[]> = (ctxData.props as any)?.shaderBindingLinks;
            if (!links || typeof links !== "object") continue;
            const ctxUI = this._contextMap.get(ctxData.id);
            if (!ctxUI) continue;

            for (const uniformKey of Object.keys(links)) {
                const inSlot = ctxUI.getInputSlot("shaderprop_" + uniformKey);
                if (!inSlot) continue;
                // value 可为单个 op id 或多个（combine 多分量 → 一个端口多条线）
                const raw = links[uniformKey];
                const opIds = Array.isArray(raw) ? raw : [raw];
                for (const opId of opIds) {
                    const opUI = this._operatorMap.get(opId);
                    if (!opUI) continue;                    // 终端 op 不在画布（unsupported type）→ 跳过
                    const outSlot = opUI.outputSlots[0];     // 终端 operator 主输出
                    if (!outSlot) continue;

                    const line = new VfxLine(this);
                    line.outNodeId = opId;
                    line.outSlotId = outSlot.slotId;
                    line.inNodeId = ctxData.id;
                    line.inSlotId = "shaderprop_" + uniformKey;
                    line.lineColor = getSlotColor(inSlot.slotDef.type);

                    const startPt = outSlot.getIconContLocalCenter(this._cont);
                    const endPt = inSlot.getIconContLocalCenter(this._cont);
                    line.setLocalEndpoints(startPt.x, startPt.y, endPt.x, endPt.y);
                }
            }
        }

        // 3) 更新所有插槽的连接状态视觉（空心/实心）
        this._updateAllSlotStates();

        // 4) 刷新 System 虚线框
        this._refreshSystemBoxes();
    }

    /** 遍历所有插槽，刷新连接/未连接的视觉状态 */
    private _updateAllSlotStates(): void {
        for (const [, evt] of this._eventMap) {
            for (const s of evt.flowInSlots) s.updateLinkedState();
            for (const s of evt.flowOutSlots) s.updateLinkedState();
        }
        // 先检查连接变更并重建（避免迭代中修改集合）
        const ctxsToRebuild = new Set<number>();
        for (const [id, ctx] of this._contextMap) {
            for (const b of ctx.blocks) {
                if (b.needsRebuildForConnectionChange()) ctxsToRebuild.add(id);
            }
        }
        for (const id of ctxsToRebuild) {
            const ctx = this._contextMap.get(id);
            if (ctx) ctx.rebuildBlocks();
        }
        for (const [, node] of this._operatorMap) {
            node.checkAndRebuildIfConnectionChanged();
        }

        // 然后更新所有 slot 视觉状态
        for (const [, ctx] of this._contextMap) {
            for (const s of ctx.flowInSlots) s.updateLinkedState();
            for (const s of ctx.flowOutSlots) s.updateLinkedState();
            for (const b of ctx.blocks) {
                for (const s of b.inputSlots) s.updateLinkedState();
                for (const s of b.outputSlots) s.updateLinkedState();
            }
        }
        for (const [, node] of this._operatorMap) {
            for (const s of node.inputSlots) s.updateLinkedState();
            for (const s of node.outputSlots) s.updateLinkedState();
        }
    }

    // ---- System 虚线框 ----

    private _refreshSystemBoxes(): void {
        // 清旧
        for (const box of this._systemBoxes) box.remove();
        this._systemBoxes.length = 0;

        if (!this._data) return;

        const contexts = this._data.contexts;
        if (contexts.length === 0) return;

        // 构建双向邻接表 (contextId → Set<contextId>)
        const adj = new Map<number, Set<number>>();
        for (const ctx of contexts) {
            if (!adj.has(ctx.id)) adj.set(ctx.id, new Set());
            if (!ctx.flowLinks) continue;
            for (const sid of Object.keys(ctx.flowLinks)) {
                const tid = ctx.flowLinks[sid].targetId;
                // 确保 target 也是 context
                if (!contexts.some(c => c.id === tid)) continue;
                adj.get(ctx.id)!.add(tid);
                if (!adj.has(tid)) adj.set(tid, new Set());
                adj.get(tid)!.add(ctx.id);
            }
        }

        // BFS 找连通分量
        const visited = new Set<number>();
        const components: number[][] = [];
        for (const ctx of contexts) {
            if (visited.has(ctx.id)) continue;
            const comp: number[] = [];
            const queue = [ctx.id];
            visited.add(ctx.id);
            while (queue.length > 0) {
                const cur = queue.shift()!;
                comp.push(cur);
                const neighbors = adj.get(cur);
                if (!neighbors) continue;
                for (const nb of neighbors) {
                    if (!visited.has(nb)) {
                        visited.add(nb);
                        queue.push(nb);
                    }
                }
            }
            components.push(comp);
        }

        // 对每个连通分量检查是否构成完整 System
        const OUTPUT_TYPES = new Set(["outputBillboard", "outputMesh", "outputTrail"]);
        const SYSTEM_TYPES = new Set(["initialize", "update", ...OUTPUT_TYPES]);
        const hw = VfxStage.SVG_SIZE * 0.5;

        for (const comp of components) {
            let hasInit = false, hasUpdate = false, hasOutput = false;
            for (const id of comp) {
                const cd = contexts.find(c => c.id === id);
                if (!cd) continue;
                if (cd.typeId === "initialize") hasInit = true;
                else if (cd.typeId === "update") hasUpdate = true;
                else if (OUTPUT_TYPES.has(cd.typeId)) hasOutput = true;
            }
            if (!hasInit || !hasUpdate || !hasOutput) continue;

            // 计算包围盒（只包含 initialize/update/output，排除 spawn 等）
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const id of comp) {
                const cd = contexts.find(c => c.id === id);
                if (!cd || !SYSTEM_TYPES.has(cd.typeId)) continue;
                const ui = this._contextMap.get(id);
                if (!ui) continue;
                minX = Math.min(minX, ui.x);
                minY = Math.min(minY, ui.y);
                maxX = Math.max(maxX, ui.x + ui.width);
                maxY = Math.max(maxY, ui.y + ui.height);
            }
            if (minX === Infinity) continue;

            const pad = 20;
            const rx = minX - pad + hw;
            const ry = minY - pad + hw;
            const rw = (maxX - minX) + pad * 2;
            const rh = (maxY - minY) + pad * 2;

            const group = this.lineSVG.group();
            group.rect(rw, rh)
                .move(rx, ry)
                .stroke({ width: 1.5, color: "#888", dasharray: "6,4" })
                .fill("none")
                .attr({ "pointer-events": "none" });

            const sysIndex = this._systemBoxes.length + 1;
            group.text(`System ${sysIndex}`)
                .move(rx + 8, ry + 4)
                .font({ size: 13, family: "sans-serif" })
                .fill("#888")
                .attr({ "pointer-events": "none" });

            this._systemBoxes.push(group);
        }
    }

    // ---- 选择管理 ----

    get selection(): VfxSelectable[] { return this._selection; }

    addToSelection(node: VfxSelectable, isAdditive: boolean): void {
        if (!isAdditive) {
            const old = this._selection;
            this._selection = [];
            for (const n of old) {
                if (n !== node) n.unselect();
            }
        }
        if (this._selection.indexOf(node) === -1) {
            this._selection.push(node);
        }
        this.onSelectionChanged?.();
    }

    removeFromSelection(node: VfxSelectable): void {
        const i = this._selection.indexOf(node);
        if (i >= 0) this._selection.splice(i, 1);
        this.onSelectionChanged?.();
    }

    clearSelection(): void {
        const old = this._selection;
        this._selection = [];
        for (const n of old) n.unselect();
        this.onSelectionChanged?.();
    }

    moveSelection(mx: number, my: number): void {
        for (const n of this._selection) {
            if (n instanceof VfxEvent) {
                n.x = n.eventData.uiData.x + mx;
                n.y = n.eventData.uiData.y + my;
            } else if (n instanceof VfxContext) {
                n.x = n.contextData.uiData.x + mx;
                n.y = n.contextData.uiData.y + my;
            } else if (n instanceof VfxNode) {
                n.x = n.nodeData.uiData.x + mx;
                n.y = n.nodeData.uiData.y + my;
            }
        }
        // 拖动期间只更新现有连线端点坐标（不 dispose+rebuild），避免 SVG DOM 重排导致节点 Shape 闪烁
        this._updateLineEndpoints();
    }

    /**
     * 增量更新所有连线的端点坐标 —— 不 dispose、不新建。
     * 用于拖动场景：连线拓扑没变，只是节点移动，端点 slot 还是同一个，
     * 只需把 path 的 `d` 属性更新到新位置。
     */
    updateLineEndpoints(): void {
        this._updateLineEndpoints();
    }

    private _updateLineEndpoints(): void {
        for (const line of this.lines) {
            if (!line) continue;
            const outSlot = this._findOutSlot(line.outNodeId, line.outSlotId);
            const inSlot = this._findInSlot(line.inNodeId, line.inSlotId);
            if (!outSlot || !inSlot) continue;
            const startPt = outSlot.getIconContLocalCenter(this._cont);
            const endPt = inSlot.getIconContLocalCenter(this._cont);
            line.setLocalEndpoints(startPt.x, startPt.y, endPt.x, endPt.y);
        }
        // System 虚线框包围盒依赖各节点 x/y，节点移动时需要同步更新
        // 这里 SVG group 只有 1~2 个（每个 System 一个），dispose+new 开销远低于全量 line
        this._refreshSystemBoxes();
    }

    private _findOutSlot(nodeId: number, slotId: string): any {
        const evt = this._eventMap.get(nodeId);
        if (evt) return evt.getFlowOutSlot(slotId);
        const ctx = this._contextMap.get(nodeId);
        if (ctx) return ctx.getFlowOutSlot(slotId);
        const op = this._operatorMap.get(nodeId);
        if (op) return op.getOutputSlot(slotId);
        return null;
    }

    private _findInSlot(nodeId: number, slotId: string): any {
        const evt = this._eventMap.get(nodeId);
        if (evt) return evt.getFlowInSlot(slotId);
        const ctx = this._contextMap.get(nodeId);
        if (ctx) return ctx.getFlowInSlot(slotId) || ctx.getInputSlot(slotId);
        const op = this._operatorMap.get(nodeId);
        if (op) return op.getInputSlot(slotId);
        return null;
    }

    private _deleteSelection(): void {
        // 先快照并清空 selection，防止 DataWatcher 回调中
        // dispose → unselect → removeFromSelection 修改正在遍历的数组
        const toDelete = this._selection.slice();
        this._selection = [];

        // 收集待删除的 ID 集合
        const evtIds = new Set<number>();
        const ctxIds = new Set<number>();
        const opIds = new Set<number>();
        for (const node of toDelete) {
            if (node instanceof VfxEvent) {
                evtIds.add(node.eventData.id);
            } else if (node instanceof VfxContext) {
                ctxIds.add(node.contextData.id);
            } else if (node instanceof VfxNode) {
                opIds.add(node.nodeData.id);
            }
        }

        // 清除 Event 中指向待删除 Context 的 flow 连接
        for (const evt of this._data.events) {
            if (evtIds.has(evt.id)) continue;
            if (!evt.flowLinks) continue;
            for (const outSid of Object.keys(evt.flowLinks)) {
                if (ctxIds.has(evt.flowLinks[outSid].targetId)) {
                    delete evt.flowLinks[outSid];
                }
            }
        }

        // 清除指向待删除 Context 的 flow 连接
        for (const ctx of this._data.contexts) {
            if (!ctx.flowLinks) continue;
            for (const outSid of Object.keys(ctx.flowLinks)) {
                if (ctxIds.has(ctx.flowLinks[outSid].targetId)) {
                    delete ctx.flowLinks[outSid];
                }
            }
        }

        // 清除 Operator 中指向待删除 Context/Operator 的数据连接
        for (const op of this._data.operators) {
            if (opIds.has(op.id)) continue; // 自身也要删，跳过
            if (!op.output) continue;
            for (const sid of Object.keys(op.output)) {
                const arr = op.output[sid].infoArr;
                for (let i = arr.length - 1; i >= 0; i--) {
                    if (ctxIds.has(arr[i].nodeId) || opIds.has(arr[i].nodeId)) {
                        arr.splice(i, 1);
                    }
                }
            }
        }

        // 从数据数组中移除
        for (let i = this._data.events.length - 1; i >= 0; i--) {
            if (evtIds.has(this._data.events[i].id)) {
                this._data.events.splice(i, 1);
            }
        }
        for (let i = this._data.contexts.length - 1; i >= 0; i--) {
            if (ctxIds.has(this._data.contexts[i].id)) {
                this._data.contexts.splice(i, 1);
            }
        }
        for (let i = this._data.operators.length - 1; i >= 0; i--) {
            if (opIds.has(this._data.operators[i].id)) {
                this._data.operators.splice(i, 1);
            }
        }
    }

    // ---- 复制 / 粘贴 ----

    private _copySelection(): void {
        if (this._selection.length === 0) return;

        // 按类型分类，收集选中节点 ID
        const evtIds = new Set<number>();
        const ctxIds = new Set<number>();
        const opIds = new Set<number>();
        const events: IVfxEventData[] = [];
        const contexts: IVfxContextData[] = [];
        const operators: IVfxOperatorData[] = [];

        for (const node of this._selection) {
            if (node instanceof VfxEvent) {
                evtIds.add(node.eventData.id);
                events.push(node.eventData);
            } else if (node instanceof VfxContext) {
                ctxIds.add(node.contextData.id);
                contexts.push(node.contextData);
            } else if (node instanceof VfxNode) {
                opIds.add(node.nodeData.id);
                operators.push(node.nodeData);
            }
        }

        // 深拷贝并过滤外部连线
        const clonedEvents: IVfxEventData[] = events.map(e => {
            const c: IVfxEventData = JSON.parse(JSON.stringify(e));
            if (c.flowLinks) {
                for (const sid of Object.keys(c.flowLinks)) {
                    if (!ctxIds.has(c.flowLinks[sid].targetId)) delete c.flowLinks[sid];
                }
            }
            return c;
        });

        const clonedContexts: IVfxContextData[] = contexts.map(ctx => {
            const c: IVfxContextData = JSON.parse(JSON.stringify(ctx));
            if (c.flowLinks) {
                for (const sid of Object.keys(c.flowLinks)) {
                    if (!ctxIds.has(c.flowLinks[sid].targetId)) delete c.flowLinks[sid];
                }
            }
            return c;
        });

        const clonedOperators: IVfxOperatorData[] = operators.map(op => {
            const c: IVfxOperatorData = JSON.parse(JSON.stringify(op));
            if (c.output) {
                for (const sid of Object.keys(c.output)) {
                    c.output[sid].infoArr = c.output[sid].infoArr.filter(
                        conn => ctxIds.has(conn.nodeId) || opIds.has(conn.nodeId)
                    );
                }
            }
            return c;
        });

        this._clipboard = { events: clonedEvents, contexts: clonedContexts, operators: clonedOperators };
        this._pasteCount = 0;
    }

    private _pasteClipboard(): void {
        if (!this._clipboard || !this._data) return;
        const cb = this._clipboard;
        if (cb.events.length === 0 && cb.contexts.length === 0 && cb.operators.length === 0) return;

        this._pasteCount++;
        const offset = this._pasteCount * 30;

        // 构建 oldId → newId 映射
        const idMap = new Map<number, number>();
        for (const e of cb.events) idMap.set(e.id, ++this._data.autoID);
        for (const ctx of cb.contexts) {
            idMap.set(ctx.id, ++this._data.autoID);
            for (const b of ctx.blocks) idMap.set(b.id, ++this._data.autoID);
        }
        for (const op of cb.operators) idMap.set(op.id, ++this._data.autoID);

        // 深拷贝 + 重映射
        const newEventIds: number[] = [];

        for (const e of cb.events) {
            const ne: IVfxEventData = JSON.parse(JSON.stringify(e));
            ne.id = idMap.get(e.id)!;
            ne.uiData.x += offset;
            ne.uiData.y += offset;
            if (ne.flowLinks) {
                for (const sid of Object.keys(ne.flowLinks)) {
                    const mapped = idMap.get(ne.flowLinks[sid].targetId);
                    if (mapped != null) ne.flowLinks[sid].targetId = mapped;
                    else delete ne.flowLinks[sid];
                }
            }
            this._data.events.push(ne);
            newEventIds.push(ne.id);
        }

        const newCtxIds: number[] = [];
        for (const ctx of cb.contexts) {
            const nc: IVfxContextData = JSON.parse(JSON.stringify(ctx));
            nc.id = idMap.get(ctx.id)!;
            nc.uiData.x += offset;
            nc.uiData.y += offset;
            for (const b of nc.blocks) {
                const mapped = idMap.get(b.id);
                if (mapped != null) b.id = mapped;
            }
            if (nc.flowLinks) {
                for (const sid of Object.keys(nc.flowLinks)) {
                    const mapped = idMap.get(nc.flowLinks[sid].targetId);
                    if (mapped != null) nc.flowLinks[sid].targetId = mapped;
                    else delete nc.flowLinks[sid];
                }
            }
            this._data.contexts.push(nc);
            newCtxIds.push(nc.id);
        }

        const newOpIds: number[] = [];
        for (const op of cb.operators) {
            const no: IVfxOperatorData = JSON.parse(JSON.stringify(op));
            no.id = idMap.get(op.id)!;
            no.uiData.x += offset;
            no.uiData.y += offset;
            if (no.output) {
                for (const sid of Object.keys(no.output)) {
                    for (const conn of no.output[sid].infoArr) {
                        const mapped = idMap.get(conn.nodeId);
                        if (mapped != null) conn.nodeId = mapped;
                    }
                }
            }
            this._data.operators.push(no);
            newOpIds.push(no.id);
        }

        // 等 DataWatcher 重建后选中新节点
        setTimeout(() => {
            this.clearSelection();
            for (const id of newEventIds) {
                const ui = this._eventMap.get(id);
                if (ui) { ui.select(true); this._selection.push(ui); }
            }
            for (const id of newCtxIds) {
                const ui = this._contextMap.get(id);
                if (ui) { ui.select(true); this._selection.push(ui); }
            }
            for (const id of newOpIds) {
                const ui = this._operatorMap.get(id);
                if (ui) { ui.select(true); this._selection.push(ui); }
            }
            this.onSelectionChanged?.();
            this.refreshAllLines();
        }, 50);
    }

    // ---- 画布交互 ----

    /** 将 panel 本地坐标转换为 _cont 内容坐标（手动处理 scale） */
    private _panelToCont(px: number, py: number): { x: number; y: number } {
        return {
            x: (px - this._cont.x) / this._cont.scaleX,
            y: (py - this._cont.y) / this._cont.scaleY,
        };
    }

    private _onPointerDown(e: gui.Event): void {
        if (e.input.button === 0) {
            this.clearSelection();
            const panelLocal = this.globalToLocal(e.input.x, e.input.y);
            const contLocal = this._panelToCont(panelLocal.x, panelLocal.y);
            this._boxSelectStart = {
                x: panelLocal.x, y: panelLocal.y,
                lx: contLocal.x, ly: contLocal.y
            };
            this._boxSelectBox = null;
        } else {
            this._panStartXY = { x: e.input.x, y: e.input.y };
        }
        e.capturePointer();
        this.on("pointer_move", this._onPointerMove, this);
        this.on("pointer_up", this._onPointerUp, this);
    }

    private _onPointerMove(e: gui.Event): void {
        if (this._boxSelectStart) {
            const result = this.globalToLocal(e.input.x, e.input.y);
            this._selectBox.visible = true;

            let xnum = this._boxSelectStart.x;
            let ynum = this._boxSelectStart.y;
            let wnum = Math.abs(xnum - result.x);
            let hnum = Math.abs(ynum - result.y);
            if (xnum > result.x) xnum = result.x;
            if (ynum > result.y) ynum = result.y;

            this._selectBox.x = xnum;
            this._selectBox.y = ynum;
            this._selectBox.setSize(wnum, hnum);

            const contResult = this._panelToCont(result.x, result.y);
            let lx = this._boxSelectStart.lx;
            let ly = this._boxSelectStart.ly;
            let lw = Math.abs(lx - contResult.x);
            let lh = Math.abs(ly - contResult.y);
            if (lx > contResult.x) lx = contResult.x;
            if (ly > contResult.y) ly = contResult.y;
            this._boxSelectBox = { x: lx, y: ly, w: lw, h: lh };
            return;
        }

        if (this._panStartXY) {
            const mx = e.input.x - this._panStartXY.x;
            const my = e.input.y - this._panStartXY.y;
            if (Math.abs(mx) > 2 || Math.abs(my) > 2) {
                this._panMoved = true;
            }
            this._panStartXY.x = e.input.x;
            this._panStartXY.y = e.input.y;
            this._cont.x += mx;
            this._cont.y += my;
        }
    }

    private _onPointerUp(e: gui.Event): void {
        if (this._selectBox.visible) {
            this._selectBox.visible = false;
            // 最小框选尺寸阈值，避免微小拖动误选
            if (this._boxSelectBox && this._boxSelectBox.w > 4 && this._boxSelectBox.h > 4) {
                this._performBoxSelect(this._boxSelectBox);
            }
        }

        const wasPanMoved = this._panMoved;

        this._panStartXY = null;
        this._panMoved = false;
        this._boxSelectStart = null;
        this._boxSelectBox = null;
        this.off("pointer_move", this._onPointerMove, this);
        this.off("pointer_up", this._onPointerUp, this);

        if (e.input.button !== 0 && !wasPanMoved) {
            this._showRightMenu(e.input.x, e.input.y);
        }
    }

    private _performBoxSelect(box: { x: number; y: number; w: number; h: number }): void {
        const ex = box.x + box.w;
        const ey = box.y + box.h;

        for (const [, evtUI] of this._eventMap) {
            const nx = evtUI.x;
            const ny = evtUI.y;
            const nx2 = nx + evtUI.width;
            const ny2 = ny + evtUI.height;
            if (nx < ex && nx2 > box.x && ny < ey && ny2 > box.y) {
                evtUI.select(true);
            }
        }

        for (const [, ctxUI] of this._contextMap) {
            const nx = ctxUI.x;
            const ny = ctxUI.y;
            const nx2 = nx + ctxUI.width;
            const ny2 = ny + ctxUI.height;
            if (nx < ex && nx2 > box.x && ny < ey && ny2 > box.y) {
                ctxUI.select(true);
            }
        }

        for (const [, nodeUI] of this._operatorMap) {
            const nx = nodeUI.x;
            const ny = nodeUI.y;
            const nx2 = nx + nodeUI.width;
            const ny2 = ny + nodeUI.height;
            if (nx < ex && nx2 > box.x && ny < ey && ny2 > box.y) {
                nodeUI.select(true);
            }
        }
    }

    private _onMouseWheel(e: gui.Event): void {
        if (this._panStartXY) return;
        const delta = -e.input.mouseWheelDelta;
        const oldScale = this._cont.scaleX;
        if ((delta > 0 && oldScale >= 1.3) || (delta < 0 && oldScale <= 0.1)) return;

        let scaleDelta = 0.02;
        if (delta < 0) scaleDelta *= -1;

        const point = gui.GRoot.getInst(this).getPointerPos();
        const result = this.globalToLocal(point.x, point.y);
        const oldX = this._cont.x;
        const oldY = this._cont.y;

        this._cont.scaleX = this._cont.scaleY = (oldScale * 10 + scaleDelta * 10) / 10;

        const scaleOffsetX = ((oldX - result.x) / oldScale) * scaleDelta;
        const scaleOffsetY = ((oldY - result.y) / oldScale) * scaleDelta;
        this._cont.x = oldX + scaleOffsetX;
        this._cont.y = oldY + scaleOffsetY;

        // ★ 防跳动核心：editor-ui 里 x/y(style.left/top) 立即生效，而 scaleX/scaleY 的
        // CSS transform 走 Timers.callLater 延迟到下一帧 flush。新 x/y 是按【新 scale】算的，
        // 却先于 transform 生效 → 这一帧位置对、缩放还是旧值 → 整个 _cont(节点+SVG连线)跳动，
        // 下一帧 transform flush 才校正回来。这里强制同帧同步刷新 transform，让缩放与位移原子更新。
        const contEl: any = this._cont.element;
        if (contEl && typeof contEl.updateTransform === "function") contEl.updateTransform();
    }

    private _onKeyDown(e: gui.Event): void {
        if (e.input.keyCode === "Delete" || (e.input.keyCode === "Backspace" && e.input.ctrlOrCmdKey)) {
            this._deleteSelection();
        } else if (e.input.ctrlOrCmdKey) {
            if (e.input.keyCode === "KeyC") {
                this._copySelection();
            } else if (e.input.keyCode === "KeyV") {
                this._pasteClipboard();
            } else if (e.input.keyCode === "KeyZ" && this._history) {
                if (this._history.canUndo) this._history.undo();
            } else if (e.input.keyCode === "KeyY" && this._history) {
                if (this._history.canRedo) this._history.redo();
            }
        }
    }

    // ---- 右键菜单 ----

    private _showRightMenu(gx: number, gy: number): void {
        if (this._nodePicker.isShowing) this._nodePicker.hide();
        this._nodePicker.show(this._data, gx, gy);
    }
}
