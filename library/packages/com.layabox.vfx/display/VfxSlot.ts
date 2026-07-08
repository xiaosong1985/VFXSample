import type { IVfxSlotDef } from "../data/VfxTypes";
import { canConvertType } from "../data/VfxOperatorDefs";
import type { VfxStage } from "./VfxStage";
import { VfxLine } from "./VfxLine";
import { VfxI18n } from "../i18n";

/** 根据类型返回颜色（slot 端口 + Blackboard 属性圆点/类型标签 共用）。
 *  覆盖 slot 类型与 property 类型("number" 是 Float 的 property 别名)。 */
export function getSlotColor(type: string): string {
    switch (type) {
        case "flow": return "#FFFFFF";
        case "float": case "number": return "#9EFB44";
        case "int": case "uint": return "#1DE0AC";
        case "bool": return "#5FD3BC";
        case "vec2": return "#7AD1FF";
        case "vec3": case "position": case "direction": case "vector": return "#fdc086";
        case "vec4": return "#FFD45E";
        case "color": return "#E077A4";
        case "Gradient": return "#C792EA";
        case "Curve": return "#B5784A";
        case "Texture2D": case "Texture3D": case "TextureCube": case "Texture2DArray": return "#F0883E";
        case "Mesh": return "#60A5FA";
        case "AABox": return "#4FC3D9";
        case "GraphicsBuffer": return "#8B5CF6";
        case "transform": case "camera": return "#9AA0A6";
        default: return "#cccccc";
    }
}

/** 解析复合 Block slotId: "block_<blockId>_<inputId>" */
export function parseBlockSlotId(slotId: string): { blockId: number; inputId: string } | null {
    const m = slotId.match(/^block_(\d+)_(.+)$/);
    if (!m) return null;
    return { blockId: parseInt(m[1], 10), inputId: m[2] };
}

/** 构建复合 Block slotId */
export function buildBlockSlotId(blockId: number, inputId: string): string {
    return `block_${blockId}_${inputId}`;
}

/**
 * 连接插槽
 *
 * 通用设计：支持 Context flow 端口、Block 输入端口、Operator 输入/输出端口。
 * ownerNodeId 用于连接数据中的 nodeId 字段（Context ID 或 Operator ID）。
 * slotId 用于连接数据中的 slotId 字段（可能是复合 "block_<id>_<slot>" 格式）。
 */
/** 遍历 flowLinks 中所有目标（兼容单对象和数组格式） */
function _iterateFlowTargets(flowLinks: Record<string, any>): { targetId: number; targetSlotId: string }[] {
    const result: { targetId: number; targetSlotId: string }[] = [];
    for (const val of Object.values(flowLinks)) {
        if (Array.isArray(val)) {
            for (const item of val) result.push(item);
        } else if (val && typeof val === "object" && "targetId" in val) {
            result.push(val);
        }
    }
    return result;
}

/** 移除所有 flowLinks 中指向指定 (nodeId, slotId) 的连接 */
function _removeFlowTarget(contexts: any[], events: any[], nodeId: number, slotId: string): void {
    for (const node of [...contexts, ...events]) {
        if (!node.flowLinks) continue;
        for (const sid of Object.keys(node.flowLinks)) {
            const val = node.flowLinks[sid];
            if (Array.isArray(val)) {
                node.flowLinks[sid] = val.filter(
                    (lk: any) => !(lk.targetId === nodeId && lk.targetSlotId === slotId)
                );
                if (node.flowLinks[sid].length === 0) delete node.flowLinks[sid];
                else if (node.flowLinks[sid].length === 1) node.flowLinks[sid] = node.flowLinks[sid][0];
            } else if (val?.targetId === nodeId && val?.targetSlotId === slotId) {
                delete node.flowLinks[sid];
            }
        }
    }
}

export class VfxSlot {
    /** 拖拽连线全局状态 */
    static currentSlot: VfxSlot | null = null;
    static overSlot: VfxSlot | null = null;
    static tmpLine: VfxLine | null = null;

    /** 右键菜单 */
    private static _menu: ReturnType<typeof IEditor.Menu.create>;
    private static _rightSlot: VfxSlot | null = null;

    public slotDef: IVfxSlotDef;
    public isInput: boolean;
    /** 连接数据中使用的节点 ID */
    public ownerNodeId: number;
    /** 连接数据中使用的插槽 ID（可能是复合 ID） */
    public slotId: string;
    public stage: VfxStage;

    private _ui: gui.Widget;
    private _icon: gui.Shape;
    private _label: gui.TextField;

    constructor(slotDef: IVfxSlotDef, isInput: boolean, ownerNodeId: number, stage: VfxStage, slotId?: string) {
        this.slotDef = slotDef;
        this.isInput = isInput;
        this.ownerNodeId = ownerNodeId;
        this.stage = stage;
        this.slotId = slotId || slotDef.id;
    }

    get isFlow(): boolean {
        return this.slotDef.type === "flow";
    }

    /**
     * 纯编程构建插槽 UI，返回根 Widget
     * @param iconOnRight 强制图标在右侧（用于 Block 行内的输入端口）
     * @param hideLabel   不显示标签文字
     */
    createUI(containerWidth: number, iconOnRight?: boolean, hideLabel?: boolean): gui.Widget {
        this._ui = new gui.Widget();
        this._ui.setSize(containerWidth, 24);
        this._ui.touchThrough = true;

        const color = getSlotColor(this.slotDef.type);

        this._icon = new gui.Shape();
        this._icon.setSize(14, 14);

        if (this.isFlow) {
            // flow 插槽用方形（区分数据插槽的圆形）
            const g = this._icon.getGraphics(gui.SRect);
            g.lineWidth = 2;
            g.lineColor.parse(color);
            g.fillColor.parse("#1a1a1a"); // 默认空心
        } else {
            // 数据插槽用圆形
            const g = this._icon.getGraphics(gui.SEllipse);
            g.lineWidth = 2;
            g.lineColor.parse(color);
            g.fillColor.parse("#1a1a1a"); // 默认空心
        }
        this._icon.touchable = true;

        // 图标位置：iconOnRight 可覆盖默认的 isInput 规则
        const putRight = iconOnRight != null ? iconOnRight : !this.isInput;
        if (putRight) {
            this._icon.x = containerWidth - 18;
        } else {
            this._icon.x = 4;
        }
        this._icon.y = 5;
        this._ui.addChild(this._icon);

        // 标签（flow 插槽、hideLabel 时不显示）
        if (!this.isFlow && !hideLabel) {
            this._label = new gui.TextField();
            this._label.text = this.slotDef.name;
            this._label.style.fontSize = 12;
            this._label.color = 0xCCCCCC;
            this._label.touchable = false;
            this._label.setSize(containerWidth - 40, 20);
            this._label.y = 3;
            if (!putRight) {
                this._label.x = 22;
            } else {
                this._label.x = 4;
                this._label.style.align = gui.AlignType.Right;
            }
            this._ui.addChild(this._label);
        }

        this._icon.on("pointer_down", this._onIconDown, this);
        this._icon.on("roll_over", this._onRollOver, this);
        this._icon.on("roll_out", this._onRollOut, this);

        return this._ui;
    }

    get ui(): gui.Widget {
        return this._ui;
    }

    /** 获取图标的全局中心坐标 */
    getIconGlobalCenter(): { x: number; y: number } {
        return this._ui.localToGlobal(
            this._icon.x + this._icon.width / 2,
            this._icon.y + this._icon.height / 2
        );
    }

    /**
     * 获取图标中心在 cont 容器本地坐标系下的位置。
     * 通过手动遍历父链累加 x/y，避免 localToGlobal/globalToLocal 的变换矩阵缓存问题。
     */
    getIconContLocalCenter(cont: gui.Widget): { x: number; y: number } {
        let x = this._icon.x + this._icon.width / 2;
        let y = this._icon.y + this._icon.height / 2;
        let w: gui.Widget = this._ui;
        while (w && w !== cont) {
            x += w.x;
            y += w.y;
            w = w.parent as gui.Widget;
        }
        return { x, y };
    }

    // ---- 连接验证 ----

    canConnect(other: VfxSlot): boolean {
        if (this.isInput === other.isInput) return false;
        if (this.ownerNodeId === other.ownerNodeId) return false;
        // flow 只能连 flow，数据只能连数据
        if (this.isFlow !== other.isFlow) return false;
        // 数据类型兼容性检查
        if (!this.isFlow) {
            const inSlot = this.isInput ? this : other;
            const outSlot = this.isInput ? other : this;
            if (!VfxSlot._typesCompatible(outSlot.slotDef.type, inSlot.slotDef.type)) return false;
        }
        return true;
    }

    /** 检查输出类型是否可以连接到输入类型 */
    private static _typesCompatible(outType: string, inType: string): boolean {
        return canConvertType(outType, inType);
    }

    // ---- 拖拽连线 ----

    private _onIconDown(e: gui.Event): void {
        if (e.input.button === 0) {
            e.stopPropagation();

            if (e.input.altKey) {
                this.removeAllLinks();
                return;
            }

            VfxSlot.tmpLine = new VfxLine(this.stage);
            VfxSlot.tmpLine.lineColor = getSlotColor(this.slotDef.type);
            if (this.isFlow) VfxSlot.tmpLine.lineStyle = "flow";

            const center = this.getIconContLocalCenter(this.stage.cont);
            VfxSlot.tmpLine.beginLocal(center.x, center.y);
            VfxSlot.currentSlot = this;

            e.capturePointer();
            this._icon.on("pointer_move", this._onIconMove, this);
            this._icon.on("pointer_up", this._onIconUp, this);
        } else if (e.input.button === 2) {
            e.stopPropagation();
            if (this.isLinked) {
                this._showSlotMenu();
            }
        }
    }

    private _onIconMove(e: gui.Event): void {
        if (VfxSlot.tmpLine) {
            const point = gui.GRoot.getInst(this.stage).getPointerPos();
            const cont = this.stage.cont;
            const stageLocal = this.stage.globalToLocal(point.x, point.y);
            const contLocalX = (stageLocal.x - cont.x) / cont.scaleX;
            const contLocalY = (stageLocal.y - cont.y) / cont.scaleY;
            VfxSlot.tmpLine.moveEndLocal(contLocalX, contLocalY);
        }
    }

    private _onIconUp(e: gui.Event): void {
        this._icon.off("pointer_move", this._onIconMove, this);
        this._icon.off("pointer_up", this._onIconUp, this);

        if (VfxSlot.overSlot && VfxSlot.currentSlot && this.canConnect(VfxSlot.overSlot)) {
            this._connect(VfxSlot.overSlot);
        }

        if (VfxSlot.tmpLine) {
            VfxSlot.tmpLine.dispose();
            VfxSlot.tmpLine = null;
        }
        VfxSlot.currentSlot = null;
        VfxSlot.overSlot = null;
    }

    // ---- 创建连接 ----

    private _connect(other: VfxSlot): void {
        const outSlot = this.isInput ? other : this;
        const inSlot = this.isInput ? this : other;
        const stage = this.stage; // 缓存引用，防止 DataWatcher 回调中 dispose
        const data = stage.graphData;

        if (outSlot.isFlow) {
            // Flow 连接：写入源节点的 flowLinks（Context 或 Event）
            const srcCtx = data.contexts.find(c => c.id === outSlot.ownerNodeId);
            const srcEvt = (data.events || []).find(e => e.id === outSlot.ownerNodeId);
            const srcNode = srcCtx || srcEvt;
            if (srcNode) {
                // 清除已有的指向此 input 的连接（保证 input 端 1-to-1）
                _removeFlowTarget(data.contexts, data.events || [], inSlot.ownerNodeId, inSlot.slotId);

                // 写入连接：数组格式支持单 output 多连接
                if (!srcNode.flowLinks) srcNode.flowLinks = {};
                const existing = srcNode.flowLinks[outSlot.slotId];
                const newTarget = { targetId: inSlot.ownerNodeId, targetSlotId: inSlot.slotId };
                if (Array.isArray(existing)) {
                    existing.push(newTarget);
                } else if (existing && typeof existing === "object" && "targetId" in existing) {
                    // 旧单值 → 升级为数组
                    srcNode.flowLinks[outSlot.slotId] = [existing, newTarget];
                } else {
                    srcNode.flowLinks[outSlot.slotId] = newTarget;
                }
            }
        } else {
            // 数据连接：写入 Operator 的 output
            const srcOp = data.operators.find(o => o.id === outSlot.ownerNodeId);
            if (srcOp) {
                if (!srcOp.output) srcOp.output = {};
                if (!srcOp.output[outSlot.slotId]) {
                    srcOp.output[outSlot.slotId] = { infoArr: [] };
                }
                const arr = srcOp.output[outSlot.slotId].infoArr;
                const exists = arr.find(
                    c => c.nodeId === inSlot.ownerNodeId && c.slotId === inSlot.slotId
                );
                if (!exists) {
                    arr.push({ nodeId: inSlot.ownerNodeId, slotId: inSlot.slotId });
                }
            }

            // 主输入与分量互斥：连接一方时自动断开另一方
            // 通用模式：slotId 以 _x / _y / _z / _w / _r / _g / _b / _a 结尾为分量
            const inSid = inSlot.slotId;
            const lastUnder = inSid.lastIndexOf('_');
            const suffix = lastUnder > 0 ? inSid.substring(lastUnder + 1) : '';
            const isComponentSlot = suffix.length === 1 && 'xyzwrgba'.includes(suffix);

            if (isComponentSlot) {
                // 分量连接 → 断开主输入连接
                const mainSlotId = inSid.substring(0, lastUnder);
                for (const op of data.operators) {
                    if (!op.output) continue;
                    for (const sid of Object.keys(op.output)) {
                        op.output[sid].infoArr = op.output[sid].infoArr.filter(
                            c => !(c.nodeId === inSlot.ownerNodeId && c.slotId === mainSlotId)
                        );
                    }
                }
            } else {
                // 主输入连接 → 断开所有分量连接
                const prefix = inSid + '_';
                for (const op of data.operators) {
                    if (!op.output) continue;
                    for (const sid of Object.keys(op.output)) {
                        op.output[sid].infoArr = op.output[sid].infoArr.filter(
                            c => !(c.nodeId === inSlot.ownerNodeId && c.slotId.startsWith(prefix))
                        );
                    }
                }
            }
        }
        stage.refreshAllLines();
    }

    // ---- 断开连接 ----

    get isLinked(): boolean {
        const data = this.stage.graphData;

        if (this.isFlow) {
            if (this.isInput) {
                // flow-in: 有其他 Context 或 Event 的 flowLinks 指向此节点 + slotId
                const fromContexts = data.contexts.some(c => {
                    if (!c.flowLinks) return false;
                    return _iterateFlowTargets(c.flowLinks).some(
                        lk => lk.targetId === this.ownerNodeId && lk.targetSlotId === this.slotId
                    );
                });
                if (fromContexts) return true;
                return (data.events || []).some(e => {
                    if (!e.flowLinks) return false;
                    return _iterateFlowTargets(e.flowLinks).some(
                        lk => lk.targetId === this.ownerNodeId && lk.targetSlotId === this.slotId
                    );
                });
            } else {
                // flow-out: 本节点（Context 或 Event）的 flowLinks 中有此 slotId
                const ctx = data.contexts.find(c => c.id === this.ownerNodeId);
                if (ctx?.flowLinks?.[this.slotId] != null) return true;
                const evt = (data.events || []).find(e => e.id === this.ownerNodeId);
                return evt?.flowLinks?.[this.slotId] != null;
            }
        }

        if (this.isInput) {
            for (const op of data.operators) {
                if (!op.output) continue;
                for (const sid of Object.keys(op.output)) {
                    if (op.output[sid].infoArr.some(
                        c => c.nodeId === this.ownerNodeId && c.slotId === this.slotId
                    )) return true;
                }
            }
            return false;
        } else {
            const op = data.operators.find(o => o.id === this.ownerNodeId);
            if (!op?.output) return false;
            const slot = op.output[this.slotId];
            return slot && slot.infoArr && slot.infoArr.length > 0;
        }
    }

    removeAllLinks(): void {
        const data = this.stage.graphData;

        if (this.isFlow) {
            if (this.isInput) {
                // flow-in: 清除所有 Context/Event flowLinks 中指向此节点 + slotId 的连接
                for (const ctx of data.contexts) {
                    if (!ctx.flowLinks) continue;
                    for (const outSid of Object.keys(ctx.flowLinks)) {
                        const lk = ctx.flowLinks[outSid];
                        if (lk.targetId === this.ownerNodeId && lk.targetSlotId === this.slotId) {
                            delete ctx.flowLinks[outSid];
                        }
                    }
                }
                for (const evt of (data.events || [])) {
                    if (!evt.flowLinks) continue;
                    for (const outSid of Object.keys(evt.flowLinks)) {
                        const lk = evt.flowLinks[outSid];
                        if (lk.targetId === this.ownerNodeId && lk.targetSlotId === this.slotId) {
                            delete evt.flowLinks[outSid];
                        }
                    }
                }
            } else {
                // flow-out: 清除本节点（Context 或 Event）的此输出 slot 连接
                const ctx = data.contexts.find(c => c.id === this.ownerNodeId);
                if (ctx?.flowLinks) {
                    delete ctx.flowLinks[this.slotId];
                }
                const evt = (data.events || []).find(e => e.id === this.ownerNodeId);
                if (evt?.flowLinks) {
                    delete evt.flowLinks[this.slotId];
                }
            }
        } else if (this.isInput) {
            for (const op of data.operators) {
                if (!op.output) continue;
                for (const sid of Object.keys(op.output)) {
                    const arr = op.output[sid].infoArr;
                    for (let i = arr.length - 1; i >= 0; i--) {
                        if (arr[i].nodeId === this.ownerNodeId && arr[i].slotId === this.slotId) {
                            arr.splice(i, 1);
                        }
                    }
                }
            }
        } else {
            const op = data.operators.find(o => o.id === this.ownerNodeId);
            if (op?.output?.[this.slotId]) {
                op.output[this.slotId].infoArr.length = 0;
            }
        }

        this.stage.refreshAllLines();
    }

    // ---- 右键菜单 ----

    private _showSlotMenu(): void {
        if (!VfxSlot._menu) {
            VfxSlot._menu = IEditor.Menu.create([
                {
                    label: VfxI18n.ns.t("disconnectAll"),
                    click: () => {
                        VfxSlot._rightSlot?.removeAllLinks();
                        VfxSlot._rightSlot = null;
                    }
                },
            ]);
        }
        VfxSlot._rightSlot = this;
        VfxSlot._menu.show(this.stage);
    }

    // ---- 连接状态视觉更新 ----

    /** 根据连接状态更新图标外观：已连接=实心，未连接=空心 */
    updateLinkedState(): void {
        if (!this._icon || !this.stage) return;
        const linked = this.isLinked;
        const color = getSlotColor(this.slotDef.type);

        if (this.isFlow) {
            const g = this._icon.getGraphics(gui.SRect);
            g.lineWidth = 2;
            g.lineColor.parse(color);
            g.fillColor.parse(linked ? color : "#1a1a1a");
        } else {
            const g = this._icon.getGraphics(gui.SEllipse);
            g.lineWidth = 2;
            g.lineColor.parse(color);
            g.fillColor.parse(linked ? color : "#1a1a1a");
        }
    }

    // ---- Rollover 反馈 ----

    private _onRollOver(e: gui.Event): void {
        if (VfxSlot.currentSlot && VfxSlot.currentSlot !== this && this.canConnect(VfxSlot.currentSlot)) {
            VfxSlot.overSlot = this;
            const color = getSlotColor(this.slotDef.type);
            if (this.isFlow) {
                const g = this._icon.getGraphics(gui.SRect);
                g.lineWidth = 2;
                g.lineColor.parse("#ffffff");
                g.fillColor.parse(color);
            } else {
                const g = this._icon.getGraphics(gui.SEllipse);
                g.lineWidth = 2;
                g.lineColor.parse("#ffffff");
                g.fillColor.parse(color);
            }
        }
    }

    private _onRollOut(e: gui.Event): void {
        if (VfxSlot.overSlot === this) {
            VfxSlot.overSlot = null;
        }
        this.updateLinkedState();
    }

    dispose(): void {
        if (this._icon) {
            this._icon.off("pointer_down", this._onIconDown, this);
            this._icon.off("pointer_move", this._onIconMove, this);
            this._icon.off("pointer_up", this._onIconUp, this);
            this._icon.off("roll_over", this._onRollOver, this);
            this._icon.off("roll_out", this._onRollOut, this);
        }
        this.stage = null;
    }
}
