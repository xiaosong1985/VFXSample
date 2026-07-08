import type { IVfxBlockData, IVfxBlockTypeDef } from "../data/VfxTypes";
import { VFX_SETTABLE_ATTRIBUTES, getAttributeType, getAttributeComponents, getAttributeSpaceable } from "../data/VfxOperatorDefs";
import { VfxSlot, buildBlockSlotId } from "./VfxSlot";
import type { VfxStage } from "./VfxStage";
import { createPropRow, calcPropRowHeight, createNumericInput, createVecNumericFields, type IVfxPropDef } from "./VfxPropRow";
import { VfxI18n } from "../i18n";

/**
 * Block 行 UI — 嵌入 Context 内部的一行
 *
 * 普通 Block 高度固定 30px。setAttribute 等特殊 Block 可更高。
 * 输入端口的 slotId 编码为 "block_<blockId>_<inputId>"，
 * 端口的 ownerNodeId 指向父 Context ID（连接数据按 Context 寻址）。
 */
export class VfxBlock {
    static BLOCK_HEIGHT = 30;
    static BLOCK_MARGIN = 2;
    static BLOCK_PADDING_H = 4;
    static HEADER_ROW = 30;
    static ATTR_ROW = 26;
    static COMP_ROW = 24;

    public blockData: IVfxBlockData;
    public typeDef: IVfxBlockTypeDef;

    private _ui: gui.Widget;
    private _bgCard: gui.Shape;
    private _label: gui.TextField;
    private _inputSlots: VfxSlot[] = [];
    private _outputSlots: VfxSlot[] = [];
    private _parentContextId: number;
    private _stage: VfxStage;
    private _height: number;
    private _isSelected: boolean = false;
    private _isDragging: boolean = false;
    private _dragStartY: number = 0;
    private _dragOrigY: number = 0;

    constructor(blockData: IVfxBlockData, typeDef: IVfxBlockTypeDef, parentContextId: number, stage: VfxStage) {
        this.blockData = blockData;
        this.typeDef = typeDef;
        this._parentContextId = parentContextId;
        this._stage = stage;
        this._height = this._calcHeight();
    }

    get ui(): gui.Widget { return this._ui; }
    get inputSlots(): VfxSlot[] { return this._inputSlots; }
    get outputSlots(): VfxSlot[] { return this._outputSlots; }
    get height(): number { return this._height; }
    get isSelected(): boolean { return this._isSelected; }
    get parentContextId(): number { return this._parentContextId; }

    private _connectedSlotKeys: string = "";
    /** 当前 context 下所有已连接的 block slot ID 缓存（O(1) 查找） */
    private _linkedSlotSet: Set<string> | null = null;

    /** 构建当前 context 的已连接 slot 反向索引 */
    private _getLinkedSlotSet(): Set<string> {
        if (this._linkedSlotSet) return this._linkedSlotSet;
        const set = new Set<string>();
        if (this._stage) {
            const ctxId = this._parentContextId;
            for (const op of this._stage.graphData.operators) {
                if (!op.output) continue;
                for (const outSid of Object.keys(op.output)) {
                    for (const c of op.output[outSid].infoArr) {
                        if (c.nodeId === ctxId) set.add(c.slotId);
                    }
                }
            }
        }
        this._linkedSlotSet = set;
        return set;
    }

    /** 使 slot 连接缓存失效（连接变更时调用） */
    invalidateLinkedSlotCache(): void {
        this._linkedSlotSet = null;
    }

    /** 检查输入连接状态是否变更，返回 true 表示需要重建 */
    needsRebuildForConnectionChange(): boolean {
        this.invalidateLinkedSlotCache();
        const allIds = this._getAllInputSlotIds();
        const keys = allIds.map(id => this._isSlotLinked(id) ? id : "").join(",");
        if (keys !== this._connectedSlotKeys) {
            this._connectedSlotKeys = keys;
            return true;
        }
        return false;
    }

    /** 获取所有可能的输入 slot ID */
    private _getAllInputSlotIds(): string[] {
        const ids: string[] = ["enabled"];
        if (this.typeDef.inputs) {
            for (const inp of this.typeDef.inputs) ids.push(inp.id);
        }
        // setAttribute 的分量 slots
        if (this.blockData.typeId === "setAttribute") {
            const attrType = getAttributeType((this.blockData.props?.attribute as string) || "position");
            const comps = this._getAttrComps(attrType);
            for (const c of comps) {
                ids.push("value_" + c.id);
                ids.push("b_value_" + c.id);
            }
            ids.push("blend");
        }
        // 已创建的输入 slot（含复合类型子 slot）
        for (const s of this._inputSlots) {
            const sid = s.slotId;
            // slotId 已含 block 前缀，转回短名
            const prefix = `block_${this.blockData.id}_`;
            const shortId = sid.startsWith(prefix) ? sid.substring(prefix.length) : sid;
            if (!ids.includes(shortId)) ids.push(shortId);
        }
        return ids;
    }

    /** 获取属性分量列表 */
    private _getAttrComps(attrType: string): { id: string; name: string }[] {
        if (attrType === "vec3" ) return [{ id: "x", name: "X" }, { id: "y", name: "Y" }, { id: "z", name: "Z" }];
        if (attrType === "color") return [{ id: "r", name: "R" }, { id: "g", name: "G" }, { id: "b", name: "B" }];
        return [];
    }

    /** 检查某个 block 输入端口是否有连线（传入短名，内部加前缀） */
    private _isSlotLinked(inputId: string): boolean {
        return this._isSlotLinkedByFullId(buildBlockSlotId(this.blockData.id, inputId));
    }

    /** 检查已构建的完整 slotId 是否有连线（O(1) 查找） */
    private _isSlotLinkedByFullId(sid: string): boolean {
        return this._getLinkedSlotSet().has(sid);
    }

    /** 获取需要显示的分量（展开时全部，收起时只显示有连线的） */
    private _getVisibleComps(comps: { id: string; name: string }[], expanded: boolean, prefix: string): { id: string; name: string }[] {
        if (expanded) return comps;
        return comps.filter(c => this._isSlotLinked(prefix + c.id));
    }

    private _calcHeight(): number {
        if (this.blockData.typeId === "singleBurst") {
            // spawnMode + delayMode + separator + count + delay
            return VfxBlock.HEADER_ROW + 4 * VfxBlock.ATTR_ROW + VfxBlock.BLOCK_PADDING_H + 4;
        }
        if (this.blockData.typeId === "setAttribute") {
            const source = this.blockData.props?.source as string;
            if (source === "Source") return VfxBlock.BLOCK_HEIGHT;
            const attrName = (this.blockData.props?.attribute as string) || "position";
            const comps = getAttributeComponents(getAttributeType(attrName));
            const expanded = !!this.blockData.props?._expanded && comps.length > 0;
            const isBlend = this.blockData.props?.composition === "Blend";
            const hasRandom = this.blockData.props?.random && this.blockData.props.random !== "Off";
            const expandedB = hasRandom && !!this.blockData.props?._expandedB && comps.length > 0;
            const visibleComps = this._getVisibleComps(comps, expanded, "value_");
            const visibleBComps = hasRandom ? this._getVisibleComps(comps, expandedB, "b_value_") : [];
            return VfxBlock.HEADER_ROW + VfxBlock.ATTR_ROW
                + visibleComps.length * VfxBlock.COMP_ROW
                + (hasRandom ? VfxBlock.ATTR_ROW : 0)
                + visibleBComps.length * VfxBlock.COMP_ROW
                + (isBlend ? VfxBlock.COMP_ROW : 0) + 4;
        }
        // 通用 Block：按 calcPropRowHeight 计算每个属性的真实高度（支持复合类型展开）
        const visibleProps = this._getVisibleProps();
        let propH = 0;
        for (const prop of visibleProps) {
            propH += calcPropRowHeight(
                prop as IVfxPropDef,
                this.blockData.props || {},
                (sid: string) => this._isSlotLinked(sid),
            );
        }
        const inputRows = this.typeDef.inputs ? this.typeDef.inputs.length : 0;
        const contentH = Math.max(propH, inputRows * VfxBlock.ATTR_ROW);
        if (contentH > 0) {
            return VfxBlock.HEADER_ROW + contentH + 4;
        }
        return VfxBlock.BLOCK_HEIGHT;
    }

    /** 构建 Block 行 UI，返回根 Widget */
    createUI(containerWidth: number): gui.Widget {
        if (this.blockData.typeId === "setAttribute") {
            return this._createSetAttributeUI(containerWidth);
        }
        if (this.blockData.typeId === "singleBurst") {
            return this._createSingleBurstUI(containerWidth);
        }
        return this._createDefaultUI(containerWidth);
    }

    // ---- 启用/禁用 toggle ----

    /** 创建与 Inspector 一致的 checkbox toggle */
    private _createEnableToggle(x: number, y: number): gui.Button {
        const cb = IEditor.GUIUtils.createCheckbox(true);
        cb.title = "";
        cb.setPos(x, y - 2);
        cb.setSize(15, 19);
        cb.selected = this.blockData.enabled;

        // pointer_down 只阻止冒泡（防止点复选框时把 block 选中/拖拽）；toggle 逻辑走 changed
        cb.on("pointer_down", (e: gui.Event) => {
            if (e.input.button === 0) e.stopPropagation();
        }, this);
        // 复选框状态变更 → 同步数据 + 原地重设视觉。
        // 不再 rebuildBlocks()：那样会重建整个 context 的所有 block，产生一帧撕裂闪烁；
        // enabled 只影响本 block 的 bg/label 颜色，原地改即可。
        cb.on("changed", () => {
            this.blockData.enabled = cb.selected;
            this._applyEnabledVisual();
        }, this);

        this._ui.addChild(cb);

        // enabled 输入端口（toggle 左侧）
        const enableSlotDef = { id: "enabled", name: "Enabled", type: "bool" };
        const enableSlotId = buildBlockSlotId(this.blockData.id, enableSlotDef.id);
        const enableSlot = new VfxSlot(enableSlotDef, true, this._parentContextId, this._stage, enableSlotId);
        const enableSlotUI = enableSlot.createUI(24, false, true);
        enableSlotUI.setPos(-11, (VfxBlock.HEADER_ROW - 24) / 2);
        this._ui.addChild(enableSlotUI);
        this._inputSlots.push(enableSlot);

        return cb;
    }

    /** 原地重设 enabled 视觉（bg 卡片色 + 标题色），不重建 → 无闪烁。三种 UI 变体共用 _bgCard/_label 字段 */
    private _applyEnabledVisual(): void {
        const on = this.blockData.enabled;
        if (this._bgCard) this._bgCard.getGraphics(gui.SRect).fillColor.parse(on ? "#2a2a2a" : "#1e1e1e");
        if (this._label) this._label.color = on ? 0xCCCCCC : 0x555555;
    }

    // ---- 默认 Block UI ----

    private _createDefaultUI(containerWidth: number): gui.Widget {
        const pad = VfxBlock.BLOCK_PADDING_H;
        const innerW = containerWidth - pad * 2;
        const H = this._height;

        // 从 widget 模板创建
        this._ui = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxBlockRow.widget");
        this._ui.setSize(containerWidth, H);

        // 背景
        this._bgCard = this._ui.getChild("bgCard", gui.Shape);
        this._bgCard.setSize(innerW, H - 2);
        const gBg = this._bgCard.getGraphics(gui.SRect);
        gBg.fillColor.parse(this.blockData.enabled ? "#2a2a2a" : "#1e1e1e");

        // toggle 复选框（隐藏模板中的占位，改用 createCheckbox）
        const templateToggle = this._ui.getChild("toggle");
        if (templateToggle) templateToggle.visible = false;
        const hasInputs = this.typeDef.inputs && this.typeDef.inputs.length > 0;
        this._createEnableToggle(hasInputs ? 12 : 10, 8);

        // 标签
        this._label = this._ui.getChild("label", gui.TextField);
        this._label.text = this.typeDef.title;
        this._label.color = this.blockData.enabled ? 0xCCCCCC : 0x555555;
        if (hasInputs) this._label.x = 30;

        if (hasInputs) {
            // enable slot 占据 header 行左侧，其他 input 放在属性行区域
            let inputY = VfxBlock.HEADER_ROW + 1;
            for (const inputDef of this.typeDef.inputs) {
                const compositeSlotId = buildBlockSlotId(this.blockData.id, inputDef.id);
                const slot = new VfxSlot(inputDef, true, this._parentContextId, this._stage, compositeSlotId);
                const slotUI = slot.createUI(24, false, true);
                slotUI.setPos(-11, inputY);
                this._ui.addChild(slotUI);
                this._inputSlots.push(slot);
                inputY += VfxBlock.ATTR_ROW;
            }
        }

        // 输出端口（右边框上，图标中心对齐 Context 右边框）
        if (this.typeDef.outputs && this.typeDef.outputs.length > 0) {
            for (const outputDef of this.typeDef.outputs) {
                const compositeSlotId = buildBlockSlotId(this.blockData.id, outputDef.id);
                const slot = new VfxSlot(outputDef, false, this._parentContextId, this._stage, compositeSlotId);
                const slotUI = slot.createUI(24, true, true);
                // icon 在 slotUI 内 x=24-18=6, 中心 x=13；让中心对齐 containerWidth（右边框）
                slotUI.setPos(containerWidth - 13, (VfxBlock.HEADER_ROW - 24) / 2);
                this._ui.addChild(slotUI);
                this._outputSlots.push(slot);
            }
        }

        // 确保所有属性（含 blockHidden）填充默认值
        {
            if (!this.blockData.props) this.blockData.props = {};
            for (const prop of this.typeDef.properties || []) {
                const p = prop as any;
                if (this.blockData.props[p.name] == null) this.blockData.props[p.name] = p.default ?? (p.enumSource ? p.enumSource[0] : 0);
            }
        }

        // 通用属性行渲染（统一使用 VfxPropRow）
        {
            const props = this._getVisibleProps();
            if (props.length > 0) {
                const inputRight = containerWidth - pad - 4;
                let rowY = VfxBlock.HEADER_ROW;

                for (const prop of props) {
                    const p = prop as any;
                    const propName = p.name;

                    const rowResult = createPropRow({
                        propDef: p as IVfxPropDef,
                        parent: this._ui,
                        nodeId: this._parentContextId,
                        stage: this._stage,
                        getData: () => this.blockData.props![propName],
                        // 包 runFieldEdit：纯值编辑不触发整 context 重建(防一帧撕裂闪烁)。结构性变更另由 onRebuild 显式重建。
                        setData: (v: any) => { this._stage.runFieldEdit(() => { this.blockData.props![propName] = v; }); },
                        buildSlotId: (name: string) => buildBlockSlotId(this.blockData.id, name),
                        hasInputSlot: true,
                        showSpaceToggle: true,
                        isConnected: (sid: string) => this._isSlotLinkedByFullId(sid),
                        onRebuild: () => this.requestRebuild(),
                        // 展开/折叠、[L]/[W] 空间切换：只重建 + 增量重定位连线（不重建连线→不闪）
                        onExpandToggle: () => this.requestRebuildForExpand(),
                        expandState: this.blockData.props!,
                        startY: rowY,
                        labelX: pad + 8,
                        inputRight,
                        containerWidth,
                    });
                    this._inputSlots.push(...rowResult.inputSlots);
                    this._outputSlots.push(...rowResult.outputSlots);
                    rowY += rowResult.height;
                }
            }
        }

        this._addInteraction();
        return this._ui;
    }

    // ---- Set Attribute 特殊 UI ----

    private _createSetAttributeUI(containerWidth: number): gui.Widget {
        const pad = VfxBlock.BLOCK_PADDING_H;
        const innerW = containerWidth - pad * 2;
        const H = this._height;

        if (!this.blockData.props) this.blockData.props = {};
        const attrName = (this.blockData.props.attribute as string) || "position";
        const isFromSource = this.blockData.props.source === "Source";
        const composition = (this.blockData.props.composition as string) || "Overwrite";
        const isBlend = composition === "Blend";
        const hasRandom = this.blockData.props.random && this.blockData.props.random !== "Off";
        const capAttr = attrName.charAt(0).toUpperCase() + attrName.slice(1);
        const attrType = getAttributeType(attrName);
        const comps = getAttributeComponents(attrType);
        const hasComps = comps.length > 0;
        const expanded = !!this.blockData.props._expanded && hasComps;

        this._ui = new gui.Widget();
        this._ui.setSize(containerWidth, H);

        // 背景卡片
        this._bgCard = new gui.Shape();
        this._bgCard.setPos(pad, 1);
        this._bgCard.setSize(innerW, H - 2);
        const gBg = this._bgCard.getGraphics(gui.SRect);
        gBg.borderRadius = [4, 4, 4, 4];
        gBg.lineWidth = 0;
        gBg.fillColor.parse(this.blockData.enabled ? "#2a2a2a" : "#1e1e1e");
        this._ui.addChild(this._bgCard);

        // ── 标题行 ──
        this._createEnableToggle(pad + 6, 8);
        const prefix = composition === "Overwrite" ? "Set" : composition;
        const titleText = isFromSource
            ? prefix + " " + capAttr + "  From Source"
            : prefix + " " + capAttr;
        this._label = new gui.TextField();
        this._label.text = titleText;
        this._label.style.fontSize = 12;
        this._label.color = this.blockData.enabled ? 0xCCCCCC : 0x555555;
        this._label.setPos(pad + 24, 6);
        this._label.setSize(innerW - 46, 20);
        this._ui.addChild(this._label);

        // 属性选择下拉箭头（右上角）
        const dropBg = new gui.Shape();
        dropBg.setPos(containerWidth - pad - 24, 4);
        dropBg.setSize(20, 22);
        const gDrop = dropBg.getGraphics(gui.SRect);
        gDrop.borderRadius = [3, 3, 3, 3];
        gDrop.lineWidth = 0;
        gDrop.fillColor.parse("#333333");
        dropBg.touchable = true;
        this._ui.addChild(dropBg);

        const dropArrow = new gui.TextField();
        dropArrow.text = "\u25BC";
        dropArrow.style.fontSize = 9;
        dropArrow.color = 0x999999;
        dropArrow.setPos(3, 3);
        dropArrow.setSize(14, 16);
        dropBg.addChild(dropArrow);

        dropBg.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            const items = VFX_SETTABLE_ATTRIBUTES.map(a => ({
                label: a.name.charAt(0).toUpperCase() + a.name.slice(1),
                click: () => {
                    if (!this.blockData.props) this.blockData.props = {};
                    this.blockData.props.attribute = a.name;
                    // 切换 attribute 时重置展开状态
                    delete this.blockData.props._expanded;
                    const ctxUI = this._stage?.getContextUI(this._parentContextId);
                    if (ctxUI) ctxUI.rebuildBlocks();
                },
            }));
            const menu = IEditor.Menu.create(items);
            menu.show(this._stage);
        }, this);

        // ── [L]/[W] 空间切换按钮（spaceable 属性时显示） ──
        if (getAttributeSpaceable(attrName)) {
            const currentSpace = (this.blockData.props!._space as string) || "Local";
            const isWorld = currentSpace === "World";
            const spaceBtn = new gui.Shape();
            spaceBtn.setPos(containerWidth - pad - 50, 5);
            spaceBtn.setSize(22, 18);
            const gSpace = spaceBtn.getGraphics(gui.SRect);
            gSpace.borderRadius = [3, 3, 3, 3];
            gSpace.lineWidth = 0;
            gSpace.fillColor.parse(isWorld ? "#c67030" : "#3070c0");
            spaceBtn.touchable = true;
            this._ui.addChild(spaceBtn);

            const spaceLabel = new gui.TextField();
            spaceLabel.text = isWorld ? "W" : "L";
            spaceLabel.style.fontSize = 10;
            spaceLabel.style.bold = true;
            spaceLabel.color = 0xFFFFFF;
            spaceLabel.setPos(0, 1);
            spaceLabel.setSize(22, 16);
            spaceLabel.style.align = gui.AlignType.Center;
            spaceBtn.addChild(spaceLabel);

            spaceBtn.on("pointer_down", (e: gui.Event) => {
                if (e.input.button !== 0) return;
                e.stopPropagation();
                if (!this.blockData.props) this.blockData.props = {};
                this.blockData.props._space = isWorld ? "Local" : "World";
                this.requestRebuildForExpand();   // 单次重建 + 增量连线重定位（_space 键已被 DataWatcher 守卫跳过）
            }, this);
        }

        // ── source="Slot" 时显示属性输入行 + 可展开分量 ──
        if (!isFromSource) {
            let rowY = VfxBlock.HEADER_ROW;

            // 主属性输入行：输入端口 + [展开箭头] + 属性名
            if (this.typeDef.inputs && this.typeDef.inputs.length > 0) {
                const inputDef = this.typeDef.inputs[0];
                const compositeSlotId = buildBlockSlotId(this.blockData.id, inputDef.id);
                const slot = new VfxSlot(inputDef, true, this._parentContextId, this._stage, compositeSlotId);
                const slotUI = slot.createUI(24, false, true);
                slotUI.setPos(-11, rowY + 1);
                this._ui.addChild(slotUI);
                this._inputSlots.push(slot);
            }

            let labelX = 12;

            // 有分量时显示展开/收起箭头
            if (hasComps) {
                const expandBtn = new gui.Shape();
                expandBtn.setPos(12, rowY + 3);
                expandBtn.setSize(16, 18);
                const gExp = expandBtn.getGraphics(gui.SRect);
                gExp.borderRadius = [2, 2, 2, 2];
                gExp.lineWidth = 0;
                gExp.fillColor.parse("#00000000");
                expandBtn.touchable = true;
                this._ui.addChild(expandBtn);

                const expandArrow = new gui.TextField();
                expandArrow.text = expanded ? "\u25BC" : "\u25B6";
                expandArrow.style.fontSize = 8;
                expandArrow.color = 0xAAAAAA;
                expandArrow.setPos(2, 3);
                expandArrow.setSize(12, 12);
                expandBtn.addChild(expandArrow);

                expandBtn.on("pointer_down", (e: gui.Event) => {
                    if (e.input.button !== 0) return;
                    e.stopPropagation();
                    if (!this.blockData.props) this.blockData.props = {};
                    this.blockData.props._expanded = !this.blockData.props._expanded;
                    this.requestRebuildForExpand();   // 单次重建 + 增量连线重定位（_expanded 键已被 DataWatcher 守卫跳过）
                }, this);

                labelX = 30;
            }

            const attrLabel = new gui.TextField();
            attrLabel.text = capAttr;
            attrLabel.style.fontSize = 11;
            attrLabel.color = 0xAAAAAA;
            attrLabel.setPos(labelX, rowY + 4);
            attrLabel.setSize(60, 18);
            this._ui.addChild(attrLabel);

            // 主属性行输入框
            const inputRight = containerWidth - pad - 4;
            if (!this.blockData.props._values) this.blockData.props._values = {};
            const vals = this.blockData.props._values as Record<string, any>;

            // 初始化所有缺失的默认值，确保序列化时数据完整
            this._initValueDefaults(vals, attrType, hasRandom);

            // 主 slot 有连接时隐藏输入框及所有分量输入框
            const mainSlotId = this.typeDef.inputs?.[0]?.id || "value";
            const mainSlotLinked = this._isSlotLinked(mainSlotId);
            if (!mainSlotLinked) {
                // 收集已连接的分量，主行中对应分量的输入框也要禁用
                const linkedComps = new Set<string>();
                for (const c of comps) {
                    if (this._isSlotLinked("value_" + c.id)) linkedComps.add(c.id);
                }
                const skipComps = linkedComps.size > 0 ? linkedComps : undefined;

                if (attrType === "vec3" ) {
                    createVecNumericFields(this._ui, "vec3", inputRight, rowY,
                        (c: string) => vals[c] ?? 0,
                        (c: string, v: number) => { vals[c] = v; },
                        { skipComps });
                } else if (attrType === "color") {
                    createVecNumericFields(this._ui, "color", inputRight, rowY,
                        (c: string) => vals[c] ?? (c === "a" ? 1 : 0),
                        (c: string, v: number) => { vals[c] = v; },
                        { skipComps });
                } else {
                    // float / bool 等: 单个输入框
                    const scalarInput = createNumericInput(this._ui, inputRight - 70, rowY + 2, 70, 20);
                    scalarInput.value = vals.value ?? 0;
                    scalarInput.on("submit", () => { vals.value = scalarInput.value; });
                }
            }

            rowY += VfxBlock.ATTR_ROW;

            // ── 分量输入行（展开时全部，收起时仅显示有连线的） ──
            {
                const visibleComps = this._getVisibleComps(comps, expanded, "value_");
                for (const comp of visibleComps) {
                    // 分量输入端口
                    const compSlotId = buildBlockSlotId(this.blockData.id, "value_" + comp.id);
                    const compSlotDef = { id: "value_" + comp.id, name: comp.name, type: "float" };
                    const compSlot = new VfxSlot(compSlotDef, true, this._parentContextId, this._stage, compSlotId);
                    const compSlotUI = compSlot.createUI(24, false, true);
                    compSlotUI.setPos(-11, rowY);
                    this._ui.addChild(compSlotUI);
                    this._inputSlots.push(compSlot);

                    // 分量名称
                    const compLabel = new gui.TextField();
                    compLabel.text = comp.name.toUpperCase();
                    compLabel.style.fontSize = 11;
                    compLabel.color = 0x888888;
                    compLabel.setPos(30, rowY + 3);
                    compLabel.setSize(40, 18);
                    this._ui.addChild(compLabel);

                    // 分量输入框（主 slot 或分量 slot 有连接时隐藏）
                    if (!mainSlotLinked && !this._isSlotLinked("value_" + comp.id)) {
                        const compInput = createNumericInput(this._ui, inputRight - 70, rowY + 1, 70, 20);
                        compInput.value = vals[comp.id] ?? 0;
                        const cid = comp.id;
                        compInput.on("submit", () => { vals[cid] = compInput.value; });
                    }

                    rowY += VfxBlock.COMP_ROW;
                }
            }

            // ── Random B 值行 ──
            if (hasRandom) {
                const expandedB = !!this.blockData.props?._expandedB && hasComps;
                let bLabelX = 12;

                // B 展开/收起箭头
                if (hasComps) {
                    const expandBBtn = new gui.Shape();
                    expandBBtn.setPos(12, rowY + 3);
                    expandBBtn.setSize(16, 18);
                    const gExpB = expandBBtn.getGraphics(gui.SRect);
                    gExpB.borderRadius = [2, 2, 2, 2];
                    gExpB.lineWidth = 0;
                    gExpB.fillColor.parse("#00000000");
                    expandBBtn.touchable = true;
                    this._ui.addChild(expandBBtn);

                    const expandBArrow = new gui.TextField();
                    expandBArrow.text = expandedB ? "\u25BC" : "\u25B6";
                    expandBArrow.style.fontSize = 8;
                    expandBArrow.color = 0xAAAAAA;
                    expandBArrow.setPos(2, 3);
                    expandBArrow.setSize(12, 12);
                    expandBBtn.addChild(expandBArrow);

                    expandBBtn.on("pointer_down", (e: gui.Event) => {
                        if (e.input.button !== 0) return;
                        e.stopPropagation();
                        if (!this.blockData.props) this.blockData.props = {};
                        this.blockData.props._expandedB = !this.blockData.props._expandedB;
                        this.requestRebuildForExpand();   // 单次重建 + 增量连线重定位（_expandedB 键已被 DataWatcher 守卫跳过）
                    }, this);

                    bLabelX = 30;
                }

                const bLabel = new gui.TextField();
                bLabel.text = "B";
                bLabel.style.fontSize = 11;
                bLabel.color = 0x888888;
                bLabel.setPos(bLabelX, rowY + 4);
                bLabel.setSize(20, 18);
                this._ui.addChild(bLabel);

                // 收集已连接的 B 分量
                const linkedBComps = new Set<string>();
                for (const c of comps) {
                    if (this._isSlotLinked("b_value_" + c.id)) linkedBComps.add(c.id);
                }
                const skipBComps = linkedBComps.size > 0 ? linkedBComps : undefined;

                if (attrType === "vec3" ) {
                    createVecNumericFields(this._ui, "vec3", inputRight, rowY,
                        (c: string) => vals["b_" + c] ?? 0,
                        (c: string, v: number) => { vals["b_" + c] = v; },
                        { skipComps: skipBComps });
                } else if (attrType === "color") {
                    createVecNumericFields(this._ui, "color", inputRight, rowY,
                        (c: string) => vals["b_" + c] ?? (c === "a" ? 1 : 0),
                        (c: string, v: number) => { vals["b_" + c] = v; },
                        { skipComps: skipBComps });
                } else {
                    const bScalarInput = createNumericInput(this._ui, inputRight - 70, rowY + 2, 70, 20);
                    bScalarInput.value = vals.b_value ?? 0;
                    bScalarInput.on("submit", () => { vals.b_value = bScalarInput.value; });
                }

                rowY += VfxBlock.ATTR_ROW;

                // B 分量输入行（展开时全部，收起时仅显示有连线的）
                {
                    const visibleBComps = this._getVisibleComps(comps, expandedB, "b_value_");
                    for (const comp of visibleBComps) {
                        // 分量输入端口
                        const bCompSlotId = buildBlockSlotId(this.blockData.id, "b_value_" + comp.id);
                        const bCompSlotDef = { id: "b_value_" + comp.id, name: comp.name, type: "float" };
                        const bCompSlot = new VfxSlot(bCompSlotDef, true, this._parentContextId, this._stage, bCompSlotId);
                        const bCompSlotUI = bCompSlot.createUI(24, false, true);
                        bCompSlotUI.setPos(-11, rowY);
                        this._ui.addChild(bCompSlotUI);
                        this._inputSlots.push(bCompSlot);

                        const compLabel = new gui.TextField();
                        compLabel.text = comp.name.toUpperCase();
                        compLabel.style.fontSize = 11;
                        compLabel.color = 0x888888;
                        compLabel.setPos(30, rowY + 3);
                        compLabel.setSize(40, 18);
                        this._ui.addChild(compLabel);

                        // 分量输入框（有连接时隐藏）
                        if (!this._isSlotLinked("b_value_" + comp.id)) {
                            const compInput = createNumericInput(this._ui, inputRight - 70, rowY + 1, 70, 20);
                            compInput.value = vals["b_" + comp.id] ?? 0;
                            const bkey = "b_" + comp.id;
                            compInput.on("submit", () => { vals[bkey] = compInput.value; });
                        }

                        rowY += VfxBlock.COMP_ROW;
                    }
                }
            }

            // ── Blend 行（滑动条 + 数值） ──
            if (isBlend) {
                // Blend 输入端口
                const blendSlotId = buildBlockSlotId(this.blockData.id, "blend");
                const blendSlotDef = { id: "blend", name: "Blend", type: "float" };
                const blendSlot = new VfxSlot(blendSlotDef, true, this._parentContextId, this._stage, blendSlotId);
                const blendSlotUI = blendSlot.createUI(24, false, true);
                blendSlotUI.setPos(-11, rowY);
                this._ui.addChild(blendSlotUI);
                this._inputSlots.push(blendSlot);

                const blendLabel = new gui.TextField();
                blendLabel.text = "Blend";
                blendLabel.style.fontSize = 11;
                blendLabel.color = 0x888888;
                blendLabel.setPos(12, rowY + 3);
                blendLabel.setSize(50, 18);
                this._ui.addChild(blendLabel);

                // 有连接时隐藏滑动条和输入框
                if (this._isSlotLinked("blend")) {
                    rowY += VfxBlock.ATTR_ROW;
                } else {
                // 滑动条
                const sliderX = 60;
                const valueW = 40;
                const sliderW = inputRight - sliderX - valueW - 8;
                const sliderY = rowY + 8;
                const trackH = 4;

                // 轨道背景
                const track = new gui.Shape();
                track.setPos(sliderX, sliderY);
                track.setSize(sliderW, trackH);
                const gTrack = track.getGraphics(gui.SRect);
                gTrack.borderRadius = [2, 2, 2, 2];
                gTrack.lineWidth = 0;
                gTrack.fillColor.parse("#444444");
                this._ui.addChild(track);

                // 滑块圆点
                const blendVal = Math.max(0, Math.min(1, vals._blend ?? 0));
                const thumbR = 6;
                const thumb = new gui.Shape();
                thumb.setSize(thumbR * 2, thumbR * 2);
                thumb.setPos(sliderX + blendVal * sliderW - thumbR, sliderY + trackH / 2 - thumbR);
                const gThumb = thumb.getGraphics(gui.SEllipse);
                gThumb.lineWidth = 0;
                gThumb.fillColor.parse("#cccccc");
                thumb.touchable = true;
                this._ui.addChild(thumb);

                // 数值显示
                const valInput = createNumericInput(this._ui, inputRight - valueW, rowY + 1, valueW, 20);
                valInput.value = blendVal;
                valInput.min = 0;
                valInput.max = 1;

                // 拖拽滑块
                let dragStartX = 0;
                let dragStartVal = 0;
                thumb.on("pointer_down", (e: gui.Event) => {
                    if (e.input.button !== 0) return;
                    e.stopPropagation();
                    e.capturePointer();
                    dragStartX = e.input.x;
                    dragStartVal = vals._blend ?? 0;
                    const root = gui.GRoot.getInst(this._ui);
                    const onMove = (me: gui.Event) => {
                        const s = this._stage?.scale || 1;
                        const dx = (me.input.x - dragStartX) / s;
                        let nv = dragStartVal + dx / sliderW;
                        nv = Math.max(0, Math.min(1, nv));
                        nv = Math.round(nv * 100) / 100;
                        vals._blend = nv;
                        thumb.setPos(sliderX + nv * sliderW - thumbR, sliderY + trackH / 2 - thumbR);
                        valInput.value = nv;
                    };
                    const onUp = () => {
                        root.off("pointer_move", onMove, this);
                        root.off("pointer_up", onUp, this);
                    };
                    root.on("pointer_move", onMove, this);
                    root.on("pointer_up", onUp, this);
                }, this);

                // 输入框同步
                valInput.on("submit", () => {
                    let nv = valInput.value;
                    nv = Math.max(0, Math.min(1, nv));
                    nv = Math.round(nv * 100) / 100;
                    vals._blend = nv;
                    valInput.value = nv;
                    thumb.setPos(sliderX + nv * sliderW - thumbR, sliderY + trackH / 2 - thumbR);
                });

                rowY += VfxBlock.COMP_ROW;
                } // end else (blend not connected)
            }
        }

        this._addInteraction();
        return this._ui;
    }

    // ---- Single Burst UI ----

    private _createSingleBurstUI(containerWidth: number): gui.Widget {
        const pad = VfxBlock.BLOCK_PADDING_H;
        const innerW = containerWidth - pad * 2;
        const H = this._height;

        if (!this.blockData.props) this.blockData.props = {};
        if (this.blockData.props.spawnMode == null) this.blockData.props.spawnMode = "Constant";
        if (this.blockData.props.delayMode == null) this.blockData.props.delayMode = "Constant";
        if (this.blockData.props.count == null) this.blockData.props.count = 0;
        if (this.blockData.props.delay == null) this.blockData.props.delay = 0;

        this._ui = new gui.Widget();
        this._ui.setSize(containerWidth, H);

        // 背景卡片
        this._bgCard = new gui.Shape();
        this._bgCard.setPos(pad, 1);
        this._bgCard.setSize(innerW, H - 2);
        const gBg = this._bgCard.getGraphics(gui.SRect);
        gBg.borderRadius = [4, 4, 4, 4];
        gBg.lineWidth = 0;
        gBg.fillColor.parse(this.blockData.enabled ? "#2a2a2a" : "#1e1e1e");
        this._ui.addChild(this._bgCard);

        // ── 标题行 ──
        this._createEnableToggle(pad + 6, 8);
        this._label = new gui.TextField();
        this._label.text = this.typeDef.title;
        this._label.style.fontSize = 12;
        this._label.color = this.blockData.enabled ? 0xCCCCCC : 0x555555;
        this._label.setPos(pad + 24, 6);
        this._label.setSize(innerW - 46, 20);
        this._ui.addChild(this._label);

        // 下拉箭头（右上角）
        const dropBg = new gui.Shape();
        dropBg.setPos(containerWidth - pad - 24, 4);
        dropBg.setSize(20, 22);
        const gDrop = dropBg.getGraphics(gui.SRect);
        gDrop.borderRadius = [3, 3, 3, 3];
        gDrop.lineWidth = 0;
        gDrop.fillColor.parse("#333333");
        dropBg.touchable = true;
        this._ui.addChild(dropBg);
        const dropArrow = new gui.TextField();
        dropArrow.text = "\u25BE";
        dropArrow.style.fontSize = 9;
        dropArrow.color = 0x999999;
        dropArrow.setPos(3, 3);
        dropArrow.setSize(14, 16);
        dropBg.addChild(dropArrow);

        let rowY = VfxBlock.HEADER_ROW;
        const inputRight = containerWidth - pad - 4;
        const dropW = 120;

        // ── Spawn Mode 行 ──
        this._createDropdownRow(rowY, pad, inputRight, dropW, "Spawn Mode", "spawnMode", ["Constant", "Random"]);
        rowY += VfxBlock.ATTR_ROW;

        // ── Delay Mode 行 ──
        this._createDropdownRow(rowY, pad, inputRight, dropW, "Delay Mode", "delayMode", ["Constant", "Random"]);
        rowY += VfxBlock.ATTR_ROW;

        // ── 分隔线 ──
        const sep = new gui.Shape();
        sep.setPos(pad + 4, rowY);
        sep.setSize(innerW - 8, 1);
        const gSep = sep.getGraphics(gui.SRect);
        gSep.lineWidth = 0;
        gSep.fillColor.parse("#3a3a3a");
        this._ui.addChild(sep);
        rowY += 4;

        // ── Count 行（带输入端口） ──
        const countInputDef = this.typeDef.inputs?.find(i => i.id === "count");
        if (countInputDef) {
            const countSlotId = buildBlockSlotId(this.blockData.id, countInputDef.id);
            const countSlot = new VfxSlot(countInputDef, true, this._parentContextId, this._stage, countSlotId);
            const countSlotUI = countSlot.createUI(24, false, true);
            countSlotUI.setPos(-11, rowY + 1);
            this._ui.addChild(countSlotUI);
            this._inputSlots.push(countSlot);
        }
        const countLabel = new gui.TextField();
        countLabel.text = "Count";
        countLabel.style.fontSize = 11;
        countLabel.color = 0xAAAAAA;
        countLabel.setPos(12, rowY + 4);
        countLabel.setSize(60, 18);
        this._ui.addChild(countLabel);
        if (this.blockData.props.spawnMode === "Random") {
            if (!this.blockData.props.countRange) this.blockData.props.countRange = { x: 0, y: 10 };
            const range = this.blockData.props.countRange as { x: number; y: number };
            const halfW = (dropW - 4) / 2;
            const minInput = createNumericInput(this._ui, inputRight - dropW, rowY + 2, halfW, 20);
            minInput.value = range.x; minInput.min = 0;
            minInput.on("submit", () => { range.x = minInput.value; });
            const maxInput = createNumericInput(this._ui, inputRight - halfW, rowY + 2, halfW, 20);
            maxInput.value = range.y; maxInput.min = 0;
            maxInput.on("submit", () => { range.y = maxInput.value; });
        } else {
            const countInput = createNumericInput(this._ui, inputRight - dropW, rowY + 2, dropW, 20);
            countInput.value = this.blockData.props.count as number; countInput.min = 0;
            countInput.on("submit", () => { this.blockData.props!.count = countInput.value; });
        }
        rowY += VfxBlock.ATTR_ROW;

        // ── Delay 行（带输入端口） ──
        const delayInputDef = this.typeDef.inputs?.find(i => i.id === "delay");
        if (delayInputDef) {
            const delaySlotId = buildBlockSlotId(this.blockData.id, delayInputDef.id);
            const delaySlot = new VfxSlot(delayInputDef, true, this._parentContextId, this._stage, delaySlotId);
            const delaySlotUI = delaySlot.createUI(24, false, true);
            delaySlotUI.setPos(-11, rowY + 1);
            this._ui.addChild(delaySlotUI);
            this._inputSlots.push(delaySlot);
        }
        const delayLabel = new gui.TextField();
        delayLabel.text = "Delay";
        delayLabel.style.fontSize = 11;
        delayLabel.color = 0xAAAAAA;
        delayLabel.setPos(12, rowY + 4);
        delayLabel.setSize(60, 18);
        this._ui.addChild(delayLabel);
        if (this.blockData.props.delayMode === "Random") {
            if (!this.blockData.props.delayRange) this.blockData.props.delayRange = { x: 0, y: 1 };
            const range = this.blockData.props.delayRange as { x: number; y: number };
            const halfW = (dropW - 4) / 2;
            const minInput = createNumericInput(this._ui, inputRight - dropW, rowY + 2, halfW, 20);
            minInput.value = range.x; minInput.min = 0;
            minInput.on("submit", () => { range.x = minInput.value; });
            const maxInput = createNumericInput(this._ui, inputRight - halfW, rowY + 2, halfW, 20);
            maxInput.value = range.y; maxInput.min = 0;
            maxInput.on("submit", () => { range.y = maxInput.value; });
        } else {
            const delayInput = createNumericInput(this._ui, inputRight - dropW, rowY + 2, dropW, 20);
            delayInput.value = this.blockData.props.delay as number; delayInput.min = 0;
            delayInput.on("submit", () => { this.blockData.props!.delay = delayInput.value; });
        }

        this._addInteraction();
        return this._ui;
    }

    /** 创建下拉选择行：标签 + 下拉框 */
    private _createDropdownRow(rowY: number, pad: number, inputRight: number, dropW: number, label: string, propKey: string, options: string[]): void {
        const lbl = new gui.TextField();
        lbl.text = label;
        lbl.style.fontSize = 11;
        lbl.color = 0x888888;
        lbl.setPos(pad + 8, rowY + 4);
        lbl.setSize(90, 18);
        this._ui.addChild(lbl);

        // 下拉背景
        const dropBg = new gui.Shape();
        dropBg.setPos(inputRight - dropW, rowY + 2);
        dropBg.setSize(dropW, 20);
        const gDrop = dropBg.getGraphics(gui.SRect);
        gDrop.borderRadius = [3, 3, 3, 3];
        gDrop.lineWidth = 0;
        gDrop.fillColor.parse("#1e1e1e");
        dropBg.touchable = true;
        this._ui.addChild(dropBg);

        const valText = new gui.TextField();
        valText.text = (this.blockData.props?.[propKey] as string) || options[0];
        valText.style.fontSize = 11;
        valText.color = 0xCCCCCC;
        valText.setPos(6, 2);
        valText.setSize(dropW - 20, 16);
        dropBg.addChild(valText);

        const arrow = new gui.TextField();
        arrow.text = "\u25BE";
        arrow.style.fontSize = 9;
        arrow.color = 0x777777;
        arrow.setPos(dropW - 16, 3);
        arrow.setSize(12, 14);
        dropBg.addChild(arrow);

        dropBg.on("pointer_down", (e: gui.Event) => {
            if (e.input.button !== 0) return;
            e.stopPropagation();
            const items = options.map(opt => ({
                label: opt,
                click: () => {
                    if (!this.blockData.props) this.blockData.props = {};
                    this.blockData.props[propKey] = opt;
                    valText.text = opt;
                    this.requestRebuild();
                },
            }));
            const menu = IEditor.Menu.create(items);
            menu.show(this._stage);
        }, this);
    }

    // ---- 交互（选中 + 拖拽排序 + 右键菜单）----

    select(): void {
        if (this._isSelected) return;
        this._isSelected = true;
        this._updateSelectStyle();
        const ctxUI = this._stage?.getContextUI(this._parentContextId);
        if (ctxUI) {
            // 取消之前选中的 block
            if (ctxUI.selectedBlock && ctxUI.selectedBlock !== this) {
                ctxUI.selectedBlock.unselect();
            }
            ctxUI.selectedBlock = this;
            ctxUI.select();
            this._stage.onSelectionChanged?.();
        }
    }

    unselect(): void {
        if (!this._isSelected) return;
        this._isSelected = false;
        this._updateSelectStyle();
    }

    private _updateSelectStyle(): void {
        if (!this._bgCard) return;
        const g = this._bgCard.getGraphics(gui.SRect);
        g.lineWidth = this._isSelected ? 2 : 0;
        if (this._isSelected) g.lineColor.parse("#ff9232");
    }

    private _addInteraction(): void {
        this._ui.touchable = true;
        this._ui.on("pointer_down", (e: gui.Event) => {
            if (e.input.button === 0) {
                e.stopPropagation();
                this.select();

                // 开始拖拽
                this._dragStartY = e.input.y;
                this._dragOrigY = this._ui.y;
                this._isDragging = false;
                e.capturePointer();
                gui.GRoot.getInst(this._ui).on("pointer_move", this._onDragMove, this);
                gui.GRoot.getInst(this._ui).on("pointer_up", this._onDragEnd, this);
            } else if (e.input.button === 2) {
                e.stopPropagation();
                this._showBlockMenu();
            }
        }, this);
    }

    private _onDragMove(e: gui.Event): void {
        const dy = e.input.y - this._dragStartY;
        if (!this._isDragging && Math.abs(dy) < 5) return;
        this._isDragging = true;

        const ctxUI = this._stage?.getContextUI(this._parentContextId);
        if (!ctxUI) return;

        // 不移动 block UI，仅用鼠标偏移计算虚拟中心位置来显示指示线
        const s = this._stage.scale;
        const virtualCenterY = this._dragOrigY + dy / s + this._height / 2;
        ctxUI.showDragIndicator(this, virtualCenterY);
    }

    private _onDragEnd(e: gui.Event): void {
        gui.GRoot.getInst(this._ui).off("pointer_move", this._onDragMove, this);
        gui.GRoot.getInst(this._ui).off("pointer_up", this._onDragEnd, this);

        const ctxUI = this._stage?.getContextUI(this._parentContextId);
        if (ctxUI) {
            if (this._isDragging) {
                const dy = e.input.y - this._dragStartY;
                const s = this._stage.scale;
                const virtualCenterY = this._dragOrigY + dy / s + this._height / 2;
                ctxUI.finishBlockDrag(this, virtualCenterY);
            }
            ctxUI.hideDragIndicator();
        }
        this._isDragging = false;
    }

    /** 触发父 Context 重建 Block UI */
    requestRebuild(): void {
        const ctxUI = this._stage?.getContextUI(this._parentContextId);
        if (ctxUI) ctxUI.rebuildBlocks();
        // 拓扑可能变化（下拉切 attribute 等）→ 全量刷新连线
        this._stage?.refreshAllLines();
    }

    /** 展开/折叠专用：重建内容 + 增量重定位连线（连接拓扑不变，不 dispose/重建连线 → 消除连线闪烁） */
    requestRebuildForExpand(): void {
        const ctxUI = this._stage?.getContextUI(this._parentContextId);
        if (ctxUI) ctxUI.rebuildBlocks();
        this._stage?.updateLineEndpoints();
    }

    /** 根据复合 slotId 查找输入插槽 */
    getInputSlot(compositeSlotId: string): VfxSlot | null {
        return this._inputSlots.find(s => s.slotId === compositeSlotId) || null;
    }

    /** 根据复合 slotId 查找输出插槽 */
    getOutputSlot(compositeSlotId: string): VfxSlot | null {
        return this._outputSlots.find(s => s.slotId === compositeSlotId) || null;
    }

    private _showBlockMenu(): void {
        const menu = IEditor.Menu.create([
            {
                label: VfxI18n.ns.t("deleteBlock"),
                click: () => {
                    const ctxUI = this._stage?.getContextUI(this._parentContextId);
                    if (ctxUI) {
                        ctxUI.removeBlock(this.blockData.id);
                    }
                }
            },
        ]);
        menu.show(this._stage);
    }

    // ---- setAttribute 默认值初始化 ----

    /** 确保 _values 中所有分量键都有默认值 */
    private _initValueDefaults(vals: Record<string, any>, attrType: string, hasRandom: boolean): void {
        if (attrType === "vec3" ) {
            for (const k of ["x", "y", "z"]) {
                if (vals[k] == null) vals[k] = 0;
                if (hasRandom && vals["b_" + k] == null) vals["b_" + k] = 0;
            }
        } else if (attrType === "color") {
            for (const k of ["r", "g", "b", "a"]) {
                if (vals[k] == null) vals[k] = 1;
                if (hasRandom && vals["b_" + k] == null) vals["b_" + k] = (k === "a" ? 1 : 0);
            }
        } else {
            if (vals.value == null) vals.value = 0;
            if (hasRandom && vals.b_value == null) vals.b_value = 0;
        }
    }

    /** 评估属性的 hidden 表达式（同 VfxContext._evalHidden） */
    private _evalHidden(propDef: { hidden?: any }): boolean {
        if (!propDef.hidden) return false;
        if (typeof propDef.hidden === 'boolean') return propDef.hidden;
        if (typeof propDef.hidden !== 'string') return false;
        const data = this.blockData.props || {};
        try {
            return !!new Function('data', 'return ' + propDef.hidden)(data);
        } catch (_e) {
            return false;
        }
    }

    /** 获取当前不隐藏的属性列表 */
    private _getVisibleProps(): any[] {
        const props = this.typeDef.properties || [];
        return props.filter((p: any) => p.name !== "_expanded" && p.name !== "_expandedB" && !p.blockHidden && !this._evalHidden(p));
    }

    dispose(): void {
        for (const s of this._inputSlots) s.dispose();
        this._inputSlots.length = 0;
        for (const s of this._outputSlots) s.dispose();
        this._outputSlots.length = 0;
        this._stage = null;
    }
}
