import type { IVfxEventData, IVfxEventTypeDef } from "../data/VfxTypes";
import { VfxSlot } from "./VfxSlot";
import type { VfxStage } from "./VfxStage";

/**
 * Event 节点 UI
 * 事件触发节点，无输入端口，仅有 flow 输出端口。
 */
export class VfxEvent extends gui.Widget {
    public eventData: IVfxEventData;
    public typeDef: IVfxEventTypeDef;

    private _stage: VfxStage;
    private _bg: gui.Shape;
    private _selectShape: gui.Shape;
    private _header: gui.Shape;
    private _titleLabel: gui.TextField;
    private _nameInput: gui.TextInput;
    private _flowInSlots: VfxSlot[] = [];
    private _flowOutSlots: VfxSlot[] = [];
    private _isSelected: boolean = false;

    private static _downXY: { x: number; y: number } | null = null;
    private _isMouseMoved: boolean = false;

    static NODE_WIDTH = 160;
    static HEADER_HEIGHT = 28;
    static SLOT_HEIGHT = 24;
    static FLOW_OVERHANG = 20;

    constructor() {
        super();
        this.on("pointer_down", this._onPointerDown, this);
    }

    get stage(): VfxStage { return this._stage; }
    get isSelected(): boolean { return this._isSelected; }

    setData(data: IVfxEventData, typeDef: IVfxEventTypeDef, stage: VfxStage): void {
        if (this.eventData) {
            IEditor.DataWatcher.removeListener(this.eventData, this._onDataChange, this);
        }
        this.eventData = data;
        this.typeDef = typeDef;
        this._stage = stage;
        IEditor.DataWatcher.addListener(this.eventData, this._onDataChange, this);
        this._buildUI();
    }

    // ---- 从 widget 模板构建节点 UI ----

    /** 公开重建入口，供 undo/redo 刷新 */
    rebuildUI(): void { this._buildUI(); }

    private _buildUI(): void {
        this.removeChildren();
        this._flowInSlots.length = 0;
        this._flowOutSlots.length = 0;

        const W = VfxEvent.NODE_WIDTH;
        const hasProps = this.typeDef.properties && this.typeDef.properties.length > 0;
        const flowInputs = this.typeDef.flowInputs || [];
        const hasFlowIn = flowInputs.length > 0;
        const hasFlowOut = this.typeDef.flowOutputs.length > 0;

        // body 高度：属性 50px / flow 输入行 / 无内容则仅 header
        let bodyH = 0;
        if (hasProps) bodyH = 50; // 6+14+2+22+6
        if (hasFlowIn) bodyH = Math.max(bodyH, flowInputs.length * VfxEvent.SLOT_HEIGHT + 12);
        const bgH = VfxEvent.HEADER_HEIGHT + bodyH;
        const hasBody = bodyH > 0;
        const totalH = bgH + (hasFlowOut ? VfxEvent.FLOW_OVERHANG : 0);
        this.setSize(W, totalH);

        // 从 widget 模板创建基础结构
        const tmpl = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxEventNode.widget");

        this._bg = tmpl.getChild("bg", gui.Shape);
        this._bg.setSize(W, bgH);

        this._header = tmpl.getChild("header", gui.Shape);
        this._header.setSize(W, VfxEvent.HEADER_HEIGHT);
        const gHeader = this._header.getGraphics(gui.SRect);
        gHeader.borderRadius = hasBody ? [6, 6, 0, 0] : [6, 6, 6, 6];
        gHeader.fillColor.parse(this.typeDef.color);

        this._titleLabel = tmpl.getChild("title", gui.TextField);
        this._titleLabel.text = this.typeDef.title;
        this._titleLabel.setSize(W - 20, VfxEvent.HEADER_HEIGHT);

        this._selectShape = tmpl.getChild("select", gui.Shape);
        this._selectShape.visible = false;
        this._selectShape.setSize(W + 4, bgH + 4);

        // 将模板子组件移动到当前节点
        while (tmpl.numChildren > 0) {
            this.addChild(tmpl.getChildAt(0));
        }

        // ── Event Name 属性（仅有 properties 时显示） ──
        if (hasProps) {
            const bodyY = VfxEvent.HEADER_HEIGHT + 6;

            const nameLabel = new gui.TextField();
            nameLabel.text = "Event Name";
            nameLabel.style.fontSize = 11;
            nameLabel.color = 0xAAAAAA;
            nameLabel.setPos(10, bodyY);
            nameLabel.setSize(W - 20, 14);
            this.addChild(nameLabel);

            this._nameInput = new gui.TextInput();
            this._nameInput.text = this.eventData.props?.eventName ?? "OnPlay";
            this._nameInput.style.fontSize = 12;
            this._nameInput.style.color = 0xFFFFFF;
            this._nameInput.prompt = "OnPlay";
            this._nameInput.setPos(10, bodyY + 16);
            this._nameInput.setSize(W - 20, 22);
            this._nameInput.element.style.backgroundColor = "#2a2a2a";
            this._nameInput.element.style.borderRadius = "3px";
            this.addChild(this._nameInput);

            this._nameInput.on("focus_out", this._onNameSubmit, this);
            this._nameInput.on("key_down", this._onNameKeyDown, this);
        }

        // flow 输入插槽（作为行显示在 body 内，图标骑在左边框上）
        if (hasFlowIn) {
            let yOffset = VfxEvent.HEADER_HEIGHT + 6;
            for (const slotDef of flowInputs) {
                const slot = new VfxSlot(slotDef, true, this.eventData.id, this._stage, slotDef.id);
                const slotUI = slot.createUI(W);
                // icon 在 slotUI 内 x=4, 中心 x=11；偏移让中心对齐 x=0（左边框）
                slotUI.setPos(-11, yOffset);
                this.addChild(slotUI);
                this._flowInSlots.push(slot);
                yOffset += VfxEvent.SLOT_HEIGHT;
            }
        }

        // flow 输出插槽（图标骑在底部边框上）
        if (hasFlowOut) {
            const count = this.typeDef.flowOutputs.length;
            const spacing = W / (count + 1);

            for (let i = 0; i < count; i++) {
                const slotDef = this.typeDef.flowOutputs[i];
                const cx = spacing * (i + 1);

                // 标签（在图标下方）
                const label = new gui.TextField();
                label.text = slotDef.name;
                label.style.fontSize = 10;
                label.color = 0xAAAAAA;
                label.style.align = gui.AlignType.Center;
                label.setSize(80, 14);
                label.setPos(cx - 40, bgH + 9);
                this.addChild(label);

                // 端口图标（中心对齐到 bgH，即底部边框）
                const slot = new VfxSlot(slotDef, false, this.eventData.id, this._stage, slotDef.id);
                const slotUI = slot.createUI(24, false, true);
                // icon 在 slotUI 内 (4, 5)，中心 (11, 12)；让中心对齐 (cx, bgH)
                slotUI.setPos(cx - 11, bgH - 12);
                this.addChild(slotUI);
                this._flowOutSlots.push(slot);
            }
        }

        // 设置位置
        super.x = Math.floor(this.eventData.uiData.x);
        super.y = Math.floor(this.eventData.uiData.y);
    }

    // ---- Event Name 输入处理 ----

    private _onNameSubmit(): void {
        const newName = this._nameInput.text.trim();
        if (!this.eventData.props) this.eventData.props = {};
        if (this.eventData.props.eventName !== newName) {
            this.eventData.props.eventName = newName || "OnPlay";
            this._nameInput.text = this.eventData.props.eventName;
        }
    }

    private _onNameKeyDown(e: gui.Event): void {
        if (e.input.keyCode === "Enter" || e.input.keyCode === "NumpadEnter") {
            this._onNameSubmit();
            gui.GRoot.getInst(this).inputMgr.setFocus(null);
        }
        // 阻止按键事件冒泡到画布（防止 Delete 删除节点等）
        e.stopPropagation();
    }

    // ---- DataWatcher 回调 ----

    private _onDataChange(sender: any, target: any, key: string, value: any): void {
        if (target === this.eventData.uiData && (key === "x" || key === "y")) {
            if (key === "x") super.x = Math.floor(value);
            else super.y = Math.floor(value);
            this._stage.updateLineEndpoints();
        }
        // 外部修改 eventName（如 Undo/Inspector）时同步到输入框
        if (target === this.eventData.props && key === "eventName" && this._nameInput) {
            this._nameInput.text = value ?? "OnPlay";
        }
    }

    // ---- x/y 同步到 data ----

    set x(value: number) {
        if (this.eventData && this.eventData.uiData.x !== value) {
            this.eventData.uiData.x = value;
        }
        super.x = value;
    }
    get x() { return super.x; }

    set y(value: number) {
        if (this.eventData && this.eventData.uiData.y !== value) {
            this.eventData.uiData.y = value;
        }
        super.y = value;
    }
    get y() { return super.y; }

    // ---- 鼠标交互（拖拽+选中） ----

    private _onPointerDown(e: gui.Event): void {
        if (e.input.button !== 0) return;
        e.stopPropagation();

        this._isMouseMoved = false;
        VfxEvent._downXY = { x: e.input.x, y: e.input.y };

        if (e.input.ctrlKey || e.input.commandKey) {
            if (this._isSelected) this.unselect();
            else this.select(true);
            return;
        }

        this.select();
        e.capturePointer();
        gui.GRoot.getInst(this).on("pointer_move", this._onPointerMove, this);
        gui.GRoot.getInst(this).on("pointer_up", this._onPointerUp, this);
    }

    private _onPointerMove(e: gui.Event): void {
        if (!VfxEvent._downXY) return;

        if (!this._isMouseMoved) {
            const dx = e.input.x - VfxEvent._downXY.x;
            const dy = e.input.y - VfxEvent._downXY.y;
            if (Math.sqrt(dx * dx + dy * dy) < 5) return;
            this._isMouseMoved = true;
        }

        const s = this._stage.scale;
        const mx = (e.input.x - VfxEvent._downXY.x) / s;
        const my = (e.input.y - VfxEvent._downXY.y) / s;
        VfxEvent._downXY.x = e.input.x;
        VfxEvent._downXY.y = e.input.y;

        this._stage.moveSelection(mx, my);
    }

    private _onPointerUp(): void {
        VfxEvent._downXY = null;
        gui.GRoot.getInst(this).off("pointer_move", this._onPointerMove, this);
        gui.GRoot.getInst(this).off("pointer_up", this._onPointerUp, this);
    }

    // ---- 选中/取消选中 ----

    select(isAdditive: boolean = false): void {
        if (this._isSelected) return;
        this._isSelected = true;
        if (this.parent) this.parent.addChild(this);
        this._setSelectStyle(true);
        this._stage.addToSelection(this, isAdditive);
    }

    unselect(): void {
        if (!this._isSelected) return;
        this._isSelected = false;
        this._setSelectStyle(false);
        this._stage.removeFromSelection(this);
    }

    private _setSelectStyle(selected: boolean): void {
        if (this._selectShape) this._selectShape.visible = selected;
    }

    // ---- 插槽访问 ----

    get flowInSlots(): VfxSlot[] { return this._flowInSlots; }
    get flowOutSlots(): VfxSlot[] { return this._flowOutSlots; }

    getFlowInSlot(slotId: string): VfxSlot | null {
        return this._flowInSlots.find(s => s.slotDef.id === slotId) || null;
    }

    getFlowOutSlot(slotId: string): VfxSlot | null {
        return this._flowOutSlots.find(s => s.slotDef.id === slotId) || null;
    }

    // ---- 清理 ----

    dispose(): void {
        if (this.eventData) {
            IEditor.DataWatcher.removeListener(this.eventData, this._onDataChange, this);
        }
        if (this._nameInput) {
            this._nameInput.off("focus_out", this._onNameSubmit, this);
            this._nameInput.off("key_down", this._onNameKeyDown, this);
        }
        this.unselect();
        for (const s of this._flowInSlots) s.dispose();
        for (const s of this._flowOutSlots) s.dispose();
        if (this.parent) this.parent.removeChild(this);
        this.eventData = null;
        this._stage = null;
    }
}
