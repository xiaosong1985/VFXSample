import type { IVfxContextData, IVfxContextTypeDef, IVfxBlockTypeDef, IVfxSlotDef } from "../data/VfxTypes";
import { getContextDef, getBlockDef, getBlocksForContext } from "../data/VfxNodeDefs";
import { VfxSlot } from "./VfxSlot";
import { VfxBlock } from "./VfxBlock";
import { parseBlockSlotId } from "./VfxSlot";
import type { VfxStage } from "./VfxStage";
import { createPropRow, type IVfxPropDef } from "./VfxPropRow";
import { VfxI18n } from "../i18n";

/**
 * Context 容器 UI
 *
 *             Start ●        ● Stop        ← 标签 + 图标在 bg 上沿
 * ┌──────────────●────────────●──────────┐  ← bg 顶部，flow-in 图标骑在边框上
 * │  ■ Spawn                             │  ← 彩色 header
 * ├──────────────────────────────────────┤
 * │  ● Constant Rate                    │  ← Block 行（● 在左边框上）
 * │  ● Burst                            │
 * │  + Add Block                        │
 * └──────────────────●───────────────────┘  ← bg 底部，flow-out 图标骑在边框上
 *              SpawnEvent                   ← 标签在 bg 下沿
 */
export class VfxContext extends gui.Widget {
    static CTX_WIDTH = 420;
    /** 属性标签列宽度（宽节点让长属性名不截断，对齐 Unity 左侧说明完整显示） */
    static LABEL_W = 160;
    static HEADER_HEIGHT = 28;
    static FLOW_OVERHANG = 20;

    public contextData: IVfxContextData;
    public typeDef: IVfxContextTypeDef;

    private _stage: VfxStage;
    private _bg: gui.Shape;
    private _selectShape: gui.Shape;
    private _header: gui.Shape;
    private _titleLabel: gui.TextField;
    private _blocks: VfxBlock[] = [];
    private _flowInSlots: VfxSlot[] = [];
    private _flowOutSlots: VfxSlot[] = [];
    /** ShaderGraph 输出节点的 shader-property 输入端口（slotId = "shaderprop_<uniform名>"）。
     *  从 props.shaderPropertyExpressions / shaderPropertyBindings 的 key 推导，
     *  让"operator → shader 属性"绑定在画布上显示成可见连线（连线源由 props.shaderBindingLinks 提供）。 */
    private _shaderPropSlots: VfxSlot[] = [];
    /** shader-property 端口的容器（重建时整体移除） */
    private _shaderPropRow: gui.Widget | null = null;
    private _flowOutRow: gui.Widget | null = null;
    /** createPropRow 生成的属性行 Widget（用于清理） */
    private _propRowWidgets: gui.Widget[] = [];
    /** ShaderGraph 输出：从 .bps 读出的材质暴露属性列表（异步加载后缓存） */
    private _matProps: Array<{ uniformName: string; fieldType: string; bpsDefault: any }> | null = null;
    /** 已加载材质属性的 shaderRes（避免重复加载；变了才重读） */
    private _matPropsLoadedKey: string = "";
    private _isRebuilding: boolean = false;
    /** 双缓冲：上一次重建残留的旧内容清理回调（延迟到新内容绘制后再移除，消除重建裸帧闪烁） */
    private _pendingCleanup: (() => void) | null = null;
    /** _recalcSize 期间是否保留旧 _bg（双缓冲时旧 bg 由延迟清理统一移除） */
    private _keepOldBg: boolean = false;
    /** 类级重建深度：任何 context 重建期间，DataWatcher 通知一律不再级联。
     *  实例级 _isRebuilding 只能挡自己重入；createDefaultUI 回填缺失属性默认值的写入
     *  会经 _onDataChange → stage.refreshAllLines 重建其他 context，跨 context 级联爆炸。
     *  重建是同步的，期间发生的写入只可能来自重建自身，抑制是安全的。 */
    private static _anyRebuildDepth: number = 0;
    private _isSelected: boolean = false;
    /** bg 矩形在 widget 内的起始 Y */
    private _bgY: number = 0;

    private static _downXY: { x: number; y: number } | null = null;
    private _isMouseMoved: boolean = false;

    /** 当前选中的 Block（用于 Inspector） */
    public selectedBlock: VfxBlock | null = null;

    constructor() {
        super();
        this.on("pointer_down", this._onPointerDown, this);
    }

    get stage(): VfxStage { return this._stage; }
    get isSelected(): boolean { return this._isSelected; }
    get blocks(): VfxBlock[] { return this._blocks; }
    get flowInSlots(): VfxSlot[] { return this._flowInSlots; }
    get flowOutSlots(): VfxSlot[] { return this._flowOutSlots; }

    setData(data: IVfxContextData, stage: VfxStage): void {
        if (this.contextData) {
            IEditor.DataWatcher.removeListener(this.contextData, this._onDataChange, this);
        }
        this.contextData = data;
        this.typeDef = getContextDef(data.typeId);
        this._stage = stage;
        IEditor.DataWatcher.addListener(this.contextData, this._onDataChange, this);
        this._buildUI();
    }

    // ---- 从 widget 模板构建 UI ----

    private _buildUI(): void {
        this.removeChildren();
        this._blocks.length = 0;
        this._flowInSlots.length = 0;
        this._flowOutSlots.length = 0;
        this._shaderPropSlots.length = 0;
        this._flowOutRow = null;

        const W = VfxContext.CTX_WIDTH;
        const hasFlowIn = this.typeDef.flowInputs.length > 0;

        // bg 顶部偏移（为 flow-in 标签留空间）
        this._bgY = hasFlowIn ? VfxContext.FLOW_OVERHANG : 0;

        // 从 widget 模板创建 header/title/select
        const tmpl = gui.UIPackage.createWidgetSync("editorResources/vfx/UI/VfxContextNode.widget");

        this._header = tmpl.getChild("header", gui.Shape);
        this._header.setSize(W, VfxContext.HEADER_HEIGHT);
        this._header.setPos(0, this._bgY);
        const gH = this._header.getGraphics(gui.SRect);
        gH.fillColor.parse(this.typeDef.color);
        this.addChild(this._header);

        this._titleLabel = tmpl.getChild("title", gui.TextField);
        this._titleLabel.text = this.typeDef.title;
        this._titleLabel.setPos(10, this._bgY + 5);
        this._titleLabel.setSize(W - 20, VfxContext.HEADER_HEIGHT);
        this.addChild(this._titleLabel);

        this._selectShape = tmpl.getChild("select", gui.Shape);
        this._selectShape.visible = false;
        // select shape 会在 _recalcSize 中定位

        // ── Flow 输入端口（图标骑在 bg 顶部边框上） ──
        if (hasFlowIn) {
            this._addFlowOnBorder(this.typeDef.flowInputs, true, this._bgY, this);
        }

        // ── Block 行 ──
        this.rebuildBlocks(this._bgY + VfxContext.HEADER_HEIGHT);

        // 设置位置
        super.x = Math.floor(this.contextData.uiData.x);
        super.y = Math.floor(this.contextData.uiData.y);
    }

    /**
     * 在 bg 边框线上添加 flow 端口
     * @param borderY  bg 边框的 Y 坐标（context 本地坐标）
     * @param parent   将 label / slotUI 添加到的父容器
     */
    private _addFlowOnBorder(
        slotDefs: IVfxSlotDef[], isInput: boolean,
        borderY: number, parent: gui.Widget
    ): void {
        const W = VfxContext.CTX_WIDTH;
        const count = slotDefs.length;
        const spacing = W / (count + 1);

        for (let i = 0; i < count; i++) {
            const def = slotDefs[i];
            const cx = spacing * (i + 1);

            // 标签（输入在图标上方，输出在图标下方）
            const label = new gui.TextField();
            label.text = def.name;
            label.style.fontSize = 10;
            label.color = 0xAAAAAA;
            label.style.align = gui.AlignType.Center;
            label.setSize(80, 14);
            label.setPos(cx - 40, isInput ? borderY - 19 : borderY + 9);
            parent.addChild(label);

            // 端口图标（中心对齐到 borderY）
            const slot = new VfxSlot(def, isInput, this.contextData.id, this._stage, def.id);
            const slotUI = slot.createUI(24, false, true);
            // icon 在 slotUI 内 (4, 5)，中心 (11, 12)；让中心对齐 (cx, borderY)
            slotUI.setPos(cx - 11, borderY - 12);
            parent.addChild(slotUI);

            if (isInput) {
                this._flowInSlots.push(slot);
            } else {
                this._flowOutSlots.push(slot);
            }
        }
    }

    /** 重建所有 Block 行，从 yOffset 开始 */
    rebuildBlocks(startY?: number): void {
        if (this._isRebuilding) return;
        this._isRebuilding = true;
        VfxContext._anyRebuildDepth++;

        // 双缓冲：上一代的延迟清理【不能】在这里同步执行——同一任务内连发两次 rebuild 时（如
        // setAttribute 展开箭头：props 写入触发 DataWatcher rebuild#1 + handler 显式 rebuild#2），
        // 同步执行会把唯一已绘制的旧代拆掉，而新代 Shape/文字都是延迟绘制 → 整节点裸帧。
        // 改为把上一代清理【合并】进本代清理，统一延迟到新内容绘制之后。
        const prevCleanup = this._pendingCleanup;
        this._pendingCleanup = null;

        const oldBlocks = this._blocks;
        const oldFlowOutRow = this._flowOutRow;
        const oldFlowOutSlots = this._flowOutSlots;
        const oldShaderPropRow = this._shaderPropRow;
        const oldShaderPropSlots = this._shaderPropSlots;
        const oldPropRowWidgets = this._propRowWidgets;
        const oldBg = this._bg;

        // 换成全新数组让 _rebuildBlocksInner 往里填新内容（此时【不】移除/销毁旧内容）
        this._blocks = [];
        this._flowOutSlots = [];
        this._shaderPropSlots = [];
        this._propRowWidgets = [];
        this._flowOutRow = null;
        this._shaderPropRow = null;
        this._keepOldBg = true;

        try {
            this._rebuildBlocksInner(startY);
        } finally {
            this._keepOldBg = false;
            this._isRebuilding = false;
            VfxContext._anyRebuildDepth--;
        }

        // 新代先隐身(alpha=0，style.opacity 立即生效、不影响布局/连线端点计算)：
        // 新代的 Shape 背景/TextField 字号排版都走 Timers.callLater 延迟一帧才定型，
        // 这一帧若可见会以"默认大字号裸文字 + 无框输入"叠在旧代上(文字放大重影 bug)。
        // 有旧代可垫时才隐身；初次构建(无旧代)保持原行为，避免节点出现延迟。
        const hasOld = oldBlocks.length > 0 || oldPropRowWidgets.length > 0 || !!oldBg;
        const newWidgets: gui.Widget[] = [];
        if (hasOld) {
            for (const b of this._blocks) { if (b.ui) newWidgets.push(b.ui); }
            for (const w of this._propRowWidgets) newWidgets.push(w);
            if (this._flowOutRow) newWidgets.push(this._flowOutRow);
            if (this._shaderPropRow) newWidgets.push(this._shaderPropRow);
            if (this._bg && this._bg !== oldBg) newWidgets.push(this._bg);
            for (const w of newWidgets) w.alpha = 0;
        }

        // 旧内容(已绘制)保留 1~2 帧；新代样式定型后原子换帧：新代显形 + 旧代移除（同一同步块，帧间无裸/无重影）。
        const cleanup = () => {
            for (const w of newWidgets) w.alpha = 1;                    // 新代显形（先显后拆，原子换帧）
            if (prevCleanup) { try { prevCleanup(); } catch (_) { } }   // 连发 rebuild 合并的更早一代
            for (const b of oldBlocks) { if (b.ui && b.ui.parent) b.ui.parent.removeChild(b.ui); b.dispose(); }
            if (oldFlowOutRow && oldFlowOutRow.parent) oldFlowOutRow.parent.removeChild(oldFlowOutRow);
            for (const s of oldFlowOutSlots) s.dispose();
            if (oldShaderPropRow && oldShaderPropRow.parent) oldShaderPropRow.parent.removeChild(oldShaderPropRow);
            for (const s of oldShaderPropSlots) s.dispose();
            for (const w of oldPropRowWidgets) { if (w.parent) w.parent.removeChild(w); }
            if (oldBg && oldBg !== this._bg && oldBg.parent) oldBg.parent.removeChild(oldBg);
        };
        this._pendingCleanup = cleanup;
        const raf: (cb: () => void) => void = (typeof requestAnimationFrame !== "undefined")
            ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
        raf(() => raf(() => { if (this._pendingCleanup === cleanup) { this._pendingCleanup = null; cleanup(); } }));
    }

    private _rebuildBlocksInner(startY?: number): void {
        // 注意：旧内容的移除/销毁已移交给 rebuildBlocks 的双缓冲延迟清理，这里【不】清理旧内容。
        const W = VfxContext.CTX_WIDTH;
        let yOffset = startY ?? this._getBlocksStartY();

        // Block 区域顶部间距
        yOffset += 6;

        // ── 通用属性行（所有 Context 类型统一使用 createPropRow） ──
        if (this.typeDef.properties) {
            if (!this.contextData.props) this.contextData.props = {};
            const inputRight = W - 10;
            for (const propDef of this.typeDef.properties) {
                if (this._evalHidden(propDef) || (propDef as any).blockHidden) continue;
                const propName = propDef.name;
                if (propDef.default != null && this.contextData.props[propName] == null) {
                    this.contextData.props[propName] = JSON.parse(JSON.stringify(propDef.default));
                }
                const childCountBefore = this.numChildren;
                const rowResult = createPropRow({
                    propDef: propDef as IVfxPropDef,
                    parent: this,
                    nodeId: this.contextData.id,
                    stage: this._stage,
                    getData: () => this.contextData.props![propName],
                    // 包 runFieldEdit：纯值编辑不触发整 context 重建(防一帧撕裂闪烁)。结构性变更另由 onRebuild 显式重建。
                    setData: (v: any) => { this._stage.runFieldEdit(() => { this.contextData.props![propName] = v; }); },
                    buildSlotId: (name: string) => name,
                    labelWidth: VfxContext.LABEL_W,
                    // 让 ShaderBlueprint 选择器选好后能联动写同节点的 shaderName（隐藏行）
                    siblingSet: (n: string, v: any) => { this._stage.runFieldEdit(() => { this.contextData.props![n] = v; }); },
                    onRebuild: () => { this.rebuildBlocks(); this._stage.refreshAllLines(); },
                    // 展开/折叠：只重建 + 增量重定位连线（不重建连线→不闪）
                    onExpandToggle: () => { this.rebuildBlocks(); this._stage.updateLineEndpoints(); },
                    expandState: this.contextData.props!,
                    startY: yOffset,
                    labelX: 10,
                    inputRight,
                    containerWidth: W,
                });
                for (let ci = childCountBefore; ci < this.numChildren; ci++) {
                    this._propRowWidgets.push(this.getChildAt(ci));
                }
                yOffset += rowResult.height;
            }
        }

        // ── ShaderGraph 输出：材质属性面板(读 .bps 暴露属性 + 逐 VFX 可编辑) ──
        yOffset = this._addMaterialProperties(yOffset);

        for (const bd of this.contextData.blocks) {
            const bDef = getBlockDef(bd.typeId);
            if (!bDef) continue;
            const block = new VfxBlock(bd, bDef, this.contextData.id, this._stage);
            const ui = block.createUI(W);
            ui.setPos(0, yOffset);
            this.addChild(ui);
            this._blocks.push(block);
            yOffset += block.height + VfxBlock.BLOCK_MARGIN;
        }

        // ── ShaderGraph 输出节点：shader-property 输入端口（让绑定显示成连线） ──
        yOffset = this._addShaderPropPorts(yOffset);

        // 无 Block 时保留最小空白区域（右键可添加 Block）
        const minBottom = this._bgY + VfxContext.HEADER_HEIGHT + 30;
        const bgBottomY = Math.max(yOffset, minBottom);

        // ── Flow 输出端口（图标骑在 bg 底部边框上） ──
        const hasFlowOut = this.typeDef.flowOutputs.length > 0;
        let totalH = bgBottomY;

        if (hasFlowOut) {
            // 容器仅覆盖底部 flow-out 区域，避免遮挡顶部 flow-in 图标
            const containerY = bgBottomY - 14;
            this._flowOutRow = new gui.Widget();
            this._flowOutRow.setSize(W, 14 + VfxContext.FLOW_OVERHANG);
            this._flowOutRow.setPos(0, containerY);
            this.addChild(this._flowOutRow);

            // borderY 相对于容器 = 14（即 bgBottomY 在容器内的位置）
            this._addFlowOnBorder(this.typeDef.flowOutputs, false, 14, this._flowOutRow);
            totalH = bgBottomY + VfxContext.FLOW_OVERHANG;
        }

        // ── 背景（仅覆盖 bgY → bgBottomY） ──
        this._recalcSize(bgBottomY, totalH);
    }

    private _getBlocksStartY(): number {
        return this._bgY + VfxContext.HEADER_HEIGHT;
    }

    // ─────────────────────────────────────────────────────────────
    // 材质属性面板(ShaderGraph 输出):读 shaderRes 指向的 .bps 暴露属性,
    // 逐 VFX 可编辑。纹理→shaderPropertyDefaults;数值/vec→写成单 Constant
    // expression(运行时已有 expression 求值会应用);动画(曲线/渐变,标 ◆)只读。
    // ─────────────────────────────────────────────────────────────
    private _isShaderGraphOutput(): boolean {
        const t = this.contextData.typeId;
        return t === "outputShaderGraphMesh" || t === "outputShaderGraphQuad";
    }

    private _addMaterialProperties(yOffset: number): number {
        if (!this._isShaderGraphOutput()) return yOffset;
        const shaderRes = (this.contextData.props?.shaderRes as string) || "";
        if (!shaderRes) return yOffset;
        if (this._matPropsLoadedKey !== shaderRes) {
            this._matPropsLoadedKey = shaderRes;
            this._matProps = null;
            this._loadMaterialProps(shaderRes);
            return yOffset;   // 异步加载中,加载完会 rebuild
        }
        const props = this._matProps;
        if (!props || props.length === 0) return yOffset;
        if (!this.contextData.props) this.contextData.props = {};
        const W = VfxContext.CTX_WIDTH;
        const inputRight = W - 10;
        for (const mp of props) {
            const animated = this._isMatPropAnimated(mp.uniformName);
            const propDef: IVfxPropDef = {
                name: "matprop_" + mp.uniformName,
                caption: (animated ? "◆ " : "") + mp.uniformName,
                type: mp.fieldType,
            } as IVfxPropDef;
            const childCountBefore = this.numChildren;
            const rowResult = createPropRow({
                propDef,
                parent: this,
                nodeId: this.contextData.id,
                stage: this._stage,
                getData: () => this._getMatPropValue(mp),
                setData: (v: any) => { if (!animated) this._setMatPropValue(mp, v); },
                buildSlotId: (name: string) => name,
                labelWidth: VfxContext.LABEL_W,
                onRebuild: () => { this.rebuildBlocks(); this._stage.refreshAllLines(); },
                onExpandToggle: () => { this.rebuildBlocks(); this._stage.updateLineEndpoints(); },
                expandState: this.contextData.props!,
                startY: yOffset,
                labelX: 10,
                inputRight,
                containerWidth: W,
            });
            for (let ci = childCountBefore; ci < this.numChildren; ci++) this._propRowWidgets.push(this.getChildAt(ci));
            yOffset += rowResult.height;
        }
        return yOffset;
    }

    private async _loadMaterialProps(shaderRes: string): Promise<void> {
        try {
            let uuid = shaderRes;
            if (uuid.startsWith("res://")) uuid = uuid.slice("res://".length);
            const info = await Editor.assetDb.getAsset(uuid);
            if (!info) { this._matProps = []; return; }
            const path = Editor.assetDb.getFullPath(info);
            const bps = await IEditor.utils.readJsonAsync(path);
            const arr = bps && bps.uniformData && bps.uniformData.uniformArr;
            const list: Array<{ uniformName: string; fieldType: string; bpsDefault: any }> = [];
            if (Array.isArray(arr)) {
                for (const u of arr) {
                    const d = u && u.data;
                    if (!d || !d.uniformName) continue;
                    const ft = this._bpsConstToFieldType(d.constDataID);
                    if (!ft) continue;
                    const def = d.inputList && d.inputList[0] ? d.inputList[0].defVal : undefined;
                    list.push({ uniformName: d.uniformName, fieldType: ft, bpsDefault: def });
                }
            }
            if (this._matPropsLoadedKey === shaderRes) {
                this._matProps = list;
                this.rebuildBlocks();
                this._stage.refreshAllLines();
            }
        } catch (e) {
            this._matProps = [];
        }
    }

    private _bpsConstToFieldType(constDataID: string): string | null {
        switch (constDataID) {
            case "basic/Float": return "number";
            case "basic/Vector2": return "vec2";
            case "basic/Vector3": return "vec3";
            case "basic/Vector4": return "vec4";
            case "basic/Boolean": return "boolean";
            case "texture/texture2D": return "Texture2D";
            default: return null;
        }
    }

    // .bps uniformName 常无下划线(MainTexture),但 VFX 存储 key 带下划线(_MainTexture)。
    // 在 store 里按 [name, _name, 去下划线] 顺序找到实际 key。
    private _matStorageKey(uniformName: string, store: any): string {
        if (!store) return uniformName;
        if (store[uniformName] != null) return uniformName;
        if (store["_" + uniformName] != null) return "_" + uniformName;
        const noU = uniformName.replace(/_/g, "");
        if (store[noU] != null) return noU;
        return uniformName;
    }

    private _matExprFor(uniformName: string): any {
        const store = (this.contextData.props as any)?.shaderPropertyExpressions;
        if (!store) return null;
        return store[this._matStorageKey(uniformName, store)] || null;
    }

    private _isMatPropAnimated(uniformName: string): boolean {
        const g = this._matExprFor(uniformName);
        if (!g || !g.nodes) return false;
        const PURE = ["Constant", "CombineVec2", "CombineVec3", "CombineVec4"];
        for (const id in g.nodes) if (PURE.indexOf(g.nodes[id].kind) < 0) return true;
        return false;
    }

    private _evalConstExpr(g: any): any {
        if (!g || !g.nodes) return undefined;
        const evalNode = (id: string): any => {
            const n = g.nodes[id]; if (!n) return 0;
            if (n.kind === "Constant") return n.value;
            if (typeof n.kind === "string" && n.kind.indexOf("CombineVec") === 0) {
                const comps = (n.inputs || []).map((iid: string) => Number(evalNode(iid)) || 0);
                const keys = ["x", "y", "z", "w"];
                const o: any = {};
                comps.forEach((c: number, i: number) => { if (keys[i]) o[keys[i]] = c; });
                return o;
            }
            return 0;
        };
        return evalNode(g.rootNodeId);
    }

    private _getMatPropValue(mp: { uniformName: string; fieldType: string; bpsDefault: any }): any {
        const props = this.contextData.props as any;
        const ft = mp.fieldType;
        const g = this._matExprFor(mp.uniformName);
        if (g) {
            if (!this._isMatPropAnimated(mp.uniformName)) {
                const v = this._evalConstExpr(g);
                if (v != null) return this._toFieldValue(ft, v);
            }
            return this._toFieldValue(ft, mp.bpsDefault);   // 动画:仅展示 .bps 默认
        }
        const defStore = props && props.shaderPropertyDefaults;
        const d = defStore ? defStore[this._matStorageKey(mp.uniformName, defStore)] : undefined;
        if (d != null) return this._toFieldValue(ft, d);
        return this._toFieldValue(ft, mp.bpsDefault);
    }

    // 写入用 key:优先复用已有 key(避免重复),否则用带下划线(转换器约定 refName)
    private _matWriteKey(uniformName: string, store: any): string {
        if (store) {
            if (store[uniformName] != null) return uniformName;
            if (store["_" + uniformName] != null) return "_" + uniformName;
            const noU = uniformName.replace(/_/g, "");
            if (store[noU] != null) return noU;
        }
        return uniformName.charAt(0) === "_" ? uniformName : "_" + uniformName;
    }

    private _setMatPropValue(mp: { uniformName: string; fieldType: string; bpsDefault: any }, v: any): void {
        if (!this.contextData.props) this.contextData.props = {};
        const props = this.contextData.props as any;
        const ft = mp.fieldType;
        if (ft === "Texture2D") {
            if (!props.shaderPropertyDefaults) props.shaderPropertyDefaults = {};
            let uuid: string | null = null;
            if (v && typeof v === "object" && v._$uuid) uuid = v._$uuid;
            else if (typeof v === "string") uuid = v.indexOf("res://") === 0 ? v.slice(6) : v;
            const key = this._matWriteKey(mp.uniformName, props.shaderPropertyDefaults);
            props.shaderPropertyDefaults[key] = uuid ? ("res://" + uuid) : "";
            // 主纹理同时写 props.mainTexture —— 让基础 mesh 路径(shaderName 空/无 shadergraph 材质时)
            // 也能显示纹理(引擎 getMeshTexturedMaterial 读 geometry.mainTexture)。对齐 Unity:Main Texture 直接驱动纹理。
            const _un = mp.uniformName.replace(/^_/, "").toLowerCase();
            if (_un === "maintexture" || _un === "maintex") {
                props.mainTexture = uuid ? ("res://" + uuid) : "";
            }
        } else {
            if (!props.shaderPropertyExpressions) props.shaderPropertyExpressions = {};
            const outType = ft === "color" ? "vec4" : ft === "number" ? "float" : ft;
            const key = this._matWriteKey(mp.uniformName, props.shaderPropertyExpressions);
            props.shaderPropertyExpressions[key] = {
                rootNodeId: "c", outputType: outType,
                nodes: { c: { kind: "Constant", outputType: outType, value: v } },
            };
        }
    }

    private _toFieldValue(ft: string, v: any): any {
        if (ft === "Texture2D") {
            // asset 字段(_createAssetRow)用裸 assetId(uuid)字符串,不是 {_$uuid}/res://
            if (!v) return "";
            if (typeof v === "object" && v._$uuid) return v._$uuid;
            if (Array.isArray(v)) v = v.length > 0 ? v[0] : "";
            if (typeof v === "string") return v.indexOf("res://") === 0 ? v.slice(6) : v;
            return "";
        }
        return v;
    }

    /**
     * 给 ShaderGraph 输出节点加一列 shader-property 输入端口（在节点左边框上，竖向堆叠）。
     * 端口集合来自 props.shaderPropertyExpressions(key=uniform名) + shaderPropertyBindings(key=exposedName)。
     * slotId 约定 "shaderprop_<key>"；连线由 refreshAllLines 根据 props.shaderBindingLinks 画出。
     * v1 端口设为不可交互(touchable=false)，仅展示派生连线，不支持拖拽增删。
     * @returns 追加端口后的 yOffset
     */
    private _addShaderPropPorts(yOffset: number): number {
        const props = this.contextData.props || {};
        const expr: Record<string, any> = (props as any).shaderPropertyExpressions || {};
        const binds: Record<string, any> = (props as any).shaderPropertyBindings || {};
        const blinks: Record<string, any> = (props as any).shaderBindingLinks || {};
        const keys: string[] = [];
        const typeOf: Record<string, string> = {};
        for (const k of Object.keys(expr)) {
            if (keys.indexOf(k) < 0) { keys.push(k); typeOf[k] = (expr[k] && expr[k].outputType) || "float"; }
        }
        for (const k of Object.keys(binds)) {
            if (keys.indexOf(k) < 0) { keys.push(k); typeOf[k] = "Texture2D"; }
        }
        // shaderBindingLinks 可能含非 shader 字段的绑定(如 Initialize 的 Bounds)→ 也生成端口
        for (const k of Object.keys(blinks)) {
            if (keys.indexOf(k) < 0) { keys.push(k); typeOf[k] = typeOf[k] || "float"; }
        }
        if (keys.length === 0) return yOffset;

        const W = VfxContext.CTX_WIDTH;
        const rowH = 20;
        const headerH = 16;
        const row = new gui.Widget();
        row.setPos(0, yOffset);

        // 小标题，区分于上方 Block 参数
        const title = new gui.TextField();
        title.text = "Bindings";
        title.style.fontSize = 10;
        title.color = 0x888888;
        title.setSize(W - 20, headerH);
        title.setPos(10, 2);
        row.addChild(title);

        let y = headerH;
        for (const k of keys) {
            const def: IVfxSlotDef = { id: "shaderprop_" + k, name: k, type: typeOf[k] };
            const slot = new VfxSlot(def, true, this.contextData.id, this._stage, def.id);
            const slotUI = slot.createUI(24, false, true);   // hideLabel：用下面手工 label
            // 图标中心对齐节点左边框 (x=0)，行内竖向居中
            slotUI.setPos(-11, y + rowH / 2 - 12);
            slotUI.touchable = false;   // v1 只展示，不允许拖拽连接（避免产生跟 shaderBindingLinks 不一致的连接）
            row.addChild(slotUI);

            const label = new gui.TextField();
            label.text = k;
            label.style.fontSize = 10;
            label.color = 0xAAAAAA;
            label.setSize(W - 20, 14);
            label.setPos(10, y + (rowH - 14) / 2);
            row.addChild(label);

            this._shaderPropSlots.push(slot);
            y += rowH;
        }

        row.setSize(W, y);
        this.addChild(row);
        this._shaderPropRow = row;
        return yOffset + y;
    }

    private _recalcSize(bgBottomY: number, totalH: number): void {
        const W = VfxContext.CTX_WIDTH;
        const bgH = bgBottomY - this._bgY;

        // 双缓冲期间保留旧 bg（由延迟清理统一移除），否则立即移除旧 bg
        if (this._bg && this._bg.parent && !this._keepOldBg) {
            this._bg.parent.removeChild(this._bg);
        }
        this._bg = new gui.Shape();
        this._bg.setPos(0, this._bgY);
        this._bg.setSize(W, bgH);
        const gBg = this._bg.getGraphics(gui.SRect);
        gBg.borderRadius = [6, 6, 6, 6];
        gBg.lineWidth = 1;
        gBg.lineColor.parse("#5e5e5e");
        gBg.fillColor.parse("#1a1a1a");
        this.addChildAt(this._bg, 0);

        // select shape 跟随 bg 大小
        if (this._selectShape) {
            this._selectShape.setPos(-2, this._bgY - 2);
            this._selectShape.setSize(W + 4, bgH + 4);
            if (this._selectShape.parent !== this) this.addChild(this._selectShape);
        }

        this.setSize(W, totalH);
    }

    // ---- 右键菜单（Add Block） ----

    private _showAddBlockMenu(): void {
        const compatibleBlocks = getBlocksForContext(this.contextData.typeId);
        if (compatibleBlocks.length === 0) return;

        // 按 category 分组
        const categoryMap = new Map<string, IVfxBlockTypeDef[]>();
        for (const bDef of compatibleBlocks) {
            const cat = bDef.category || "Other";
            if (!categoryMap.has(cat)) categoryMap.set(cat, []);
            categoryMap.get(cat)!.push(bDef);
        }

        const categoryItems: any[] = [];
        for (const [cat, defs] of categoryMap) {
            categoryItems.push({
                label: cat,
                type: "submenu",
                submenu: defs.map(d => ({ label: (d as any)._enTitle ?? d.title, click: () => this.addBlock(d.typeId) })),
            });
        }

        const menu = IEditor.Menu.create([{
            label: VfxI18n.ns.t("createBlock"),
            type: "submenu",
            submenu: categoryItems,
        }]);
        menu.show(this._stage);
    }

    // ---- Block 管理 ----

    addBlock(typeId: string): void {
        const bDef = getBlockDef(typeId);
        if (!bDef) return;

        const id = ++this._stage.graphData.autoID;
        const props: Record<string, any> = {};
        if (bDef.properties) {
            for (const p of bDef.properties) {
                if (p.default != null) props[p.name] = typeof p.default === "object" ? JSON.parse(JSON.stringify(p.default)) : p.default;
            }
        }
        this.contextData.blocks.push({
            id,
            typeId,
            enabled: true,
            props,
        });
    }

    removeBlock(blockId: number): void {
        const idx = this.contextData.blocks.findIndex(b => b.id === blockId);
        if (idx >= 0) {
            this.contextData.blocks.splice(idx, 1);
        }
    }

    // ---- Block 拖拽排序 ----

    private _dragIndicator: gui.Shape | null = null;

    /** 显示拖拽插入指示线 */
    showDragIndicator(dragBlock: VfxBlock, centerY: number): void {
        if (!this._dragIndicator) {
            this._dragIndicator = new gui.Shape();
            this._dragIndicator.setSize(VfxContext.CTX_WIDTH - 16, 2);
            const g = this._dragIndicator.getGraphics(gui.SRect);
            g.lineWidth = 0;
            g.fillColor.parse("#ff9232");
        }
        if (this._dragIndicator.parent !== this) this.addChild(this._dragIndicator);

        const targetIdx = this._getDragTargetIndex(dragBlock, centerY);
        const indicatorY = this._getBlockInsertY(targetIdx, dragBlock);
        this._dragIndicator.setPos(8, indicatorY - 1);
        this._dragIndicator.visible = true;
    }

    hideDragIndicator(): void {
        if (this._dragIndicator) this._dragIndicator.visible = false;
    }

    /** 完成拖拽：重排数据并重建 UI */
    finishBlockDrag(dragBlock: VfxBlock, centerY: number): void {
        const blocks = this.contextData.blocks;
        const fromIdx = blocks.findIndex(b => b.id === dragBlock.blockData.id);
        if (fromIdx < 0) return;

        let toIdx = this._getDragTargetIndex(dragBlock, centerY);
        if (toIdx === fromIdx || toIdx === fromIdx + 1) return; // 没有移动

        // 从原位置移除
        const [item] = blocks.splice(fromIdx, 1);
        // 如果目标在原位置之后，需要调整索引
        if (toIdx > fromIdx) toIdx--;
        blocks.splice(toIdx, 0, item);

        this.rebuildBlocks();
        this._stage.scheduleRefreshLines();
    }

    /** 根据拖拽中心 Y 计算目标插入索引 */
    private _getDragTargetIndex(dragBlock: VfxBlock, centerY: number): number {
        let idx = 0;
        for (const b of this._blocks) {
            if (b === dragBlock) { idx++; continue; }
            const blockCenterY = b.ui.y + b.height / 2;
            if (centerY < blockCenterY) return idx;
            idx++;
        }
        return idx;
    }

    /** 获取插入位置 idx 对应的 Y 坐标 */
    private _getBlockInsertY(targetIdx: number, dragBlock: VfxBlock): number {
        let i = 0;
        for (const b of this._blocks) {
            if (b === dragBlock) continue;
            if (i === targetIdx) return b.ui.y;
            i++;
        }
        // 插入到末尾
        const lastBlock = this._blocks.filter(b => b !== dragBlock).pop();
        if (lastBlock) return lastBlock.ui.y + lastBlock.height + VfxBlock.BLOCK_MARGIN;
        return this._getBlocksStartY() + 6;
    }

    // ---- 插槽查找 ----

    /** 通过 slotId 查找 flow 输入插槽 */
    getFlowInSlot(slotId?: string): VfxSlot | null {
        if (!slotId) return this._flowInSlots[0] || null;
        return this._flowInSlots.find(s => s.slotId === slotId) || null;
    }

    /** 通过 slotId 查找 flow 输出插槽（含 Block 输出端口） */
    getFlowOutSlot(slotId?: string): VfxSlot | null {
        if (!slotId) return this._flowOutSlots[0] || null;
        const ctxSlot = this._flowOutSlots.find(s => s.slotId === slotId);
        if (ctxSlot) return ctxSlot;

        // Block 输出端口: "block_<blockId>_<outputId>"
        const parsed = parseBlockSlotId(slotId);
        if (parsed) {
            for (const block of this._blocks) {
                if (block.blockData.id === parsed.blockId) {
                    return block.getOutputSlot(slotId);
                }
            }
        }
        return null;
    }

    /** 通过复合 slotId 查找 Block 输入插槽 */
    getInputSlot(slotId: string): VfxSlot | null {
        // flow 输入端口
        const flowIn = this._flowInSlots.find(s => s.slotId === slotId);
        if (flowIn) return flowIn;

        // shader-property 输入端口（"shaderprop_<uniform名>"）
        if (slotId.indexOf("shaderprop_") === 0) {
            const sp = this._shaderPropSlots.find(s => s.slotId === slotId);
            if (sp) return sp;
        }

        // Block 输入端口: "block_<blockId>_<inputId>"
        const parsed = parseBlockSlotId(slotId);
        if (parsed) {
            for (const block of this._blocks) {
                if (block.blockData.id === parsed.blockId) {
                    return block.getInputSlot(slotId);
                }
            }
        }
        return null;
    }

    // ---- hidden 表达式评估 ----

    /** 评估属性的 hidden 表达式 */
    private _evalHidden(propDef: { hidden?: any }): boolean {
        if (!propDef.hidden) return false;
        if (typeof propDef.hidden === 'boolean') return propDef.hidden;
        if (typeof propDef.hidden !== 'string') return false;
        const data = this.contextData.props || {};
        try {
            return !!new Function('data', 'return ' + propDef.hidden)(data);
        } catch (_e) {
            return false;
        }
    }

    // ---- DataWatcher ----

    private _onDataChange(sender: any, target: any, key: string): void {
        // 重建期间的数据写入（默认值回填等）不再级联触发重建，防跨 context 互相引爆
        if (VfxContext._anyRebuildDepth > 0) return;
        // 字段值提交(runFieldEdit)引发的同步通知：值已显示在控件里，跳过整块 rebuildBlocks
        // 避免拆建重绘——背景 Shape 重建延迟一帧 → 一帧撕裂闪烁(文字在、背景没)。
        // 结构性变更(下拉切 attribute/展开折叠/mask)由显式 onRebuild 重建；外部变更(undo/redo)无此标志照常重建刷新。
        if (this._stage && this._stage._fieldEditDepth > 0) return;
        if (target === this.contextData.uiData && (key === "x" || key === "y")) {
            if (key === "x") super.x = Math.floor(this.contextData.uiData.x);
            else super.y = Math.floor(this.contextData.uiData.y);
            this._stage.updateLineEndpoints();
            return;
        }

        // blocks 数组变化
        if (target === this.contextData.blocks) {
            this.rebuildBlocks();
            this._stage.refreshAllLines();
        }

        // props 变化 → 统一重建属性行
        if (target === this.contextData.props) {
            // 展开/折叠、[L]/[W] 空间切换等纯 UI 状态键（_expand_*/_expanded/_expandedB/_space*）由控件
            // 自身显式重建，这里不能再重建一次：否则同一任务内二次拆建 → 裸帧闪烁。
            // 只有真正的数据属性变化才走这里重建。
            if (typeof key === "string" && (key.indexOf("_expand") === 0 || key.indexOf("_space") === 0)) {
                return;
            }
            this.rebuildBlocks();
            this._stage.refreshAllLines();
            return;
        }

        // Block props 变化（如 setAttribute 的 attribute/source）
        for (const bd of this.contextData.blocks) {
            if (target === bd.props) {
                // 同上：Block 属性行/setAttribute 专属 UI 的展开折叠、[L]/[W] 空间切换
                // （_expand_*/_expanded/_expandedB/_space*）由 Block 自身显式重建，这里跳过，
                // 避免同一任务内二次拆建 → 裸帧闪烁（setAttribute 展开箭头写 _expanded 正是此路径）。
                if (typeof key === "string" && (key.indexOf("_expand") === 0 || key.indexOf("_space") === 0)) {
                    return;
                }
                this.rebuildBlocks();
                this._stage.refreshAllLines();
                return;
            }
        }
    }

    // ---- x/y 同步到 data ----

    set x(value: number) {
        if (this.contextData && this.contextData.uiData.x !== value) {
            this.contextData.uiData.x = value;
        }
        super.x = value;
    }
    get x() { return super.x; }

    set y(value: number) {
        if (this.contextData && this.contextData.uiData.y !== value) {
            this.contextData.uiData.y = value;
        }
        super.y = value;
    }
    get y() { return super.y; }

    // ---- 鼠标交互（拖拽 + 选中） ----

    private _onPointerDown(e: gui.Event): void {
        if (e.input.button === 2) {
            e.stopPropagation();
            this._showAddBlockMenu();
            return;
        }
        if (e.input.button !== 0) return;
        e.stopPropagation();

        // 点击 Context 背景时清除 Block 选中
        if (this.selectedBlock) {
            this.selectedBlock.unselect();
            this.selectedBlock = null;
        }

        this._isMouseMoved = false;
        VfxContext._downXY = { x: e.input.x, y: e.input.y };

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
        if (!VfxContext._downXY) return;

        if (!this._isMouseMoved) {
            const dx = e.input.x - VfxContext._downXY.x;
            const dy = e.input.y - VfxContext._downXY.y;
            if (Math.sqrt(dx * dx + dy * dy) < 5) return;
            this._isMouseMoved = true;
        }

        const s = this._stage.scale;
        const mx = (e.input.x - VfxContext._downXY.x) / s;
        const my = (e.input.y - VfxContext._downXY.y) / s;
        VfxContext._downXY.x = e.input.x;
        VfxContext._downXY.y = e.input.y;

        this._stage.moveSelection(mx, my);
    }

    private _onPointerUp(): void {
        VfxContext._downXY = null;
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
        if (this.selectedBlock) {
            this.selectedBlock.unselect();
            this.selectedBlock = null;
        }
        this._stage.removeFromSelection(this);
    }

    private _setSelectStyle(selected: boolean): void {
        if (this._selectShape) this._selectShape.visible = selected;
    }

    // ---- 清理 ----

    dispose(): void {
        // 先执行残留的双缓冲延迟清理，避免旧内容泄漏
        if (this._pendingCleanup) { const c = this._pendingCleanup; this._pendingCleanup = null; try { c(); } catch (_) { } }
        if (this.contextData) {
            IEditor.DataWatcher.removeListener(this.contextData, this._onDataChange, this);
        }
        this.unselect();
        for (const b of this._blocks) b.dispose();
        for (const s of this._flowInSlots) s.dispose();
        for (const s of this._flowOutSlots) s.dispose();
        for (const s of this._shaderPropSlots) s.dispose();
        if (this.parent) this.parent.removeChild(this);
        this.contextData = null;
        this._stage = null;
    }
}
