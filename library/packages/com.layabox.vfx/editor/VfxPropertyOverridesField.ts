/**
 * VisualEffect 组件 Inspector 的"Properties"区域自定义字段。
 *
 * 数据流：
 *   - this.target.data         → VisualEffect 组件 props 对象（含 asset / randomSeed / propertyOverrides 等）
 *   - this.target.getValue()   → 当前 propertyOverrides 对象（plain { [name]: number[] }）
 *   - this.target.data.asset   → LayaPro IDE 资源引用 wrapper `{ _$uuid, _$type }` 形态
 *                                通过 Editor.assetDb.getAsset(uuid) → fullPath → readJsonAsync 拿 .vfx JSON
 *
 * UI 结构（按 group 分组）：
 *   ┌──────────────────────────────────────────┐
 *   │ ▼ GroupName                              │  <- group title
 *   │   ☑ DisplayName  [NumericInput] [Input]  │  <- 一行：checkbox + label + editor
 *   │   ☐ Another      [NumericInput]          │
 *   └──────────────────────────────────────────┘
 *
 * 编辑控件按 type：
 *   - float / number / int → 单个 NumericInput
 *   - vec2 / vec3 / vec4   → 多个 NumericInput 横排
 *   - color                → ColorInput（色拾取器，含 alpha）
 *   - Gradient             → read-only placeholder（暂不支持 override）
 *   - 其他                 → 文字显示 default 值
 *
 * checkbox 关闭时 editor 灰显（touchable=false），值显示 default；开启后 editor 可交互，值写到 propertyOverrides[name]
 */
export class VfxPropertyOverridesField extends IEditor.PropertyField {
    private _box: gui.Box;
    private _rowHeight: number = 24;
    private _groupGap: number = 4;

    // asset.properties 缓存（async load）
    private _propertiesCache: any[] | null = null;
    private _cachedAssetKey: string = "";
    private _loadInflight: boolean = false;

    // 已构建的行(供 resize 时廉价重排, 不重建)
    private _rowItems: Array<{ row: gui.Box; label: gui.TextField; display: string; editor: any; editorY: number; editorH: number; overlay?: any }> = [];
    private _relayouting: boolean = false;

    // 分组折叠状态(组名 → 是否折叠), 点击组标题箭头切换, 折叠则不渲染该组属性行
    private _collapsed: { [group: string]: boolean } = {};

    // 本次构建累计的内容高度(用于撑高 box, 见 _setBoxHeight)
    private _builtHeight: number = 0;

    // "本字段自身 commit 触发的回声刷新"标志：commit 写 propertyOverrides → DataInspector 下一帧回调 refresh()，
    // 那次刷新只是我们自己编辑的回声(数据与 widget 都已是最新值)，若走全量 _rebuild 会把【正在拖动的滑条 widget】
    // 销毁重建 → 滑条拖不动。故跳过这次 echo；外部来源(切换对象/undo/换 asset)的 refresh 仍照常重建。
    private _selfCommitEcho: boolean = false;

    create(): IEditor.IPropertyFieldCreateResult {
        const box = new gui.Box();
        try {
            box.layout.type = gui.LayoutType.SingleColumn;   // 仅做行的纵向堆叠; 横向宽度由 _relayout 手动控制
            box.layout.foldInvisibles = true;
            box.layout.rowGap = 0;   // 无行间距, 使 _builtHeight 累加值 = 实际内容高度
        } catch { /* layout 设置失败不影响 */ }
        box.setSize(280, 24);
        this._box = box;
        // 面板缩放时只做廉价重排(setPos/setSize + 截断 label, 不 removeChildren 不重建) → 既不闪动也无重建延迟,
        // 且 caption 列宽跟随面板收缩(跟标准字段一致), 避免窄面板 label 溢出重叠.
        try { box.on("size_changed", this._onResize, this); } catch { }
        this._safeRefresh();
        return { ui: box, stretchWidth: true, captionDisplay: "none" };
    }

    /** box 尺寸变化 → 廉价重排已存在的行(不重建). 加 guard 防递归. */
    private _onResize(): void {
        if (this._relayouting) return;
        try { this._relayout(); } catch (e) { console.warn("[VfxPropertyOverrides] relayout err:", e); }
    }

    /** 按当前可用宽度重新摆放每行的 label / editor(setPos/setSize), 并截断 label 文字防溢出.
     *  纯轻量操作, 无 DOM 重建 → 拖动面板时实时跟手且不闪动. */
    private _relayout(): void {
        if (!this._box || this._rowItems.length === 0) return;
        this._relayouting = true;
        try {
            const totalW = this._availWidth();
            const rh = this._rowHeight;
            const cbW = 18, gap = 4;
            const labelAreaW = this._labelAreaWidth(totalW);
            const labelW = Math.max(24, labelAreaW - cbW - gap * 2);
            const editorX = labelAreaW;
            const editorW = Math.max(40, totalW - labelAreaW - 2);
            for (const it of this._rowItems) {
                if (!it || !it.row) continue;
                try { it.row.setSize(totalW, rh); } catch { }
                if (it.label) {
                    try {
                        it.label.setSize(labelW, rh);
                        it.label.setPos(cbW + gap, 0);
                        it.label.text = this._truncate(it.display, labelW);   // 手动截断, 不依赖 autoSize=Ellipsis(本版本不裁)
                    } catch { }
                }
                if (it.editor) {
                    try {
                        it.editor.setPos(editorX, it.editorY);
                        it.editor.setSize(editorW, it.editorH);
                    } catch { }
                }
                if (it.overlay) {   // HDR 标签覆盖在 editor 上，居中跟随
                    try {
                        it.overlay.setPos(editorX, 1);
                        it.overlay.setSize(editorW, rh - 2);
                    } catch { }
                }
            }
        } finally {
            this._relayouting = false;
        }
    }

    /** 按像素宽度估算可容纳字符数并截断(超出加省略号). fontSize 12 取保守 ~6.8px/char, 宁可短不溢出. */
    private _truncate(text: string, width: number): string {
        if (!text) return "";
        const maxChars = Math.max(1, Math.floor((width - 4) / 6.8));
        if (text.length <= maxChars) return text;
        return text.slice(0, Math.max(1, maxChars - 1)) + "…";
    }

    refresh(): void {
        // 跳过自身 commit 的回声刷新(见 _selfCommitEcho 注释)：滑条拖动期间每帧 commit 都会触发一次 refresh，
        // 若每次重建会销毁正在拖的 widget。这次刷新 widget 已是最新值，无需重建。
        if (this._selfCommitEcho) {
            this._selfCommitEcho = false;
            return;
        }
        this._safeRefresh();
    }

    private _safeRefresh(): void {
        try { this._rebuild(); }
        catch (e: any) {
            console.warn("[VfxPropertyOverrides] refresh err:", e);
            try { this._addText(`[VFX] error: ${e?.message || e}`, 0xE57C5C); } catch { }
        }
    }

    private _rebuild(): void {
        if (!this._box) return;
        this._box.removeChildren();
        this._rowItems = [];
        this._builtHeight = 0;   // 累计内容高度, 构建后设到 box.height(否则下方组件会压上来重叠)

        const overrides = this._getOverrides();
        const properties = this._getAssetProperties();

        if (!properties) {
            if (this._loadInflight) {
                this._addText("(加载 properties 中...)", 0x888888);
            } else {
                const data = this.target?.data;
                const asset = data?.asset;
                if (asset) {
                    this._addText(`(无法解析 asset; type=${typeof asset}; 见 console)`, 0xE5C76A);
                } else {
                    this._addText("(请先设置 Asset)", 0x888888);
                }
            }
            this._setBoxHeight();
            return;
        }
        if (properties.length === 0) {
            this._addText("(此 VFX 未在 Blackboard 暴露 Property)", 0x888888);
            this._setBoxHeight();
            return;
        }

        // 按 group 分组（保持 Blackboard 内顺序）
        const groupOrder: string[] = [];
        const groups = new Map<string, any[]>();
        for (const p of properties) {
            const g = (p.group && p.group.length > 0) ? p.group : "Properties";
            if (!groups.has(g)) { groups.set(g, []); groupOrder.push(g); }
            groups.get(g)!.push(p);
        }

        for (let i = 0; i < groupOrder.length; i++) {
            const gname = groupOrder[i];
            const collapsed = this._collapsed[gname] === true;
            this._addGroupHeader(gname, collapsed);
            if (!collapsed) {
                for (const p of groups.get(gname)!) {
                    this._addPropertyRow(p, overrides);
                }
            }
            if (i < groupOrder.length - 1) this._addSpacer(this._groupGap);
        }

        // 构建完成后按当前宽度摆放一次(确定 label/editor 列宽与位置)
        this._relayout();
        // 把 box 高度撑到内容总高, 否则框架按 holder.height=panel.height 定位下个组件会重叠
        this._setBoxHeight();
    }

    /** box 高度设为已累计的内容总高(SingleColumn 布局不会自动撑高 box 自身, 需手动设) */
    private _setBoxHeight(): void {
        try { this._box.height = Math.max(this._builtHeight, this._rowHeight); } catch { }
    }

    /** 当前可用内容宽度.
     *  不能直接读 this._box.width: box 挂了 SingleColumn layout, layout 会把 box 宽度塌缩到内容宽度,
     *  跟框架给 panel 设的 Width relation(=holder.width) 打架, 读到的是塌缩后的过小值, 导致编辑控件填不满面板.
     *  改从 cell(InspectorItem) 直接取: 本字段 box 从 titleObject.x 起始铺满 holder, 可用宽度 = cell.width - titleObject.x. */
    private _availWidth(): number {
        try {
            const cell: any = (this as any).cell;
            if (cell && typeof cell.width === "number" && cell.width > 0) {
                const titleX = Number(cell.titleObject && cell.titleObject.x) || 0;
                const w = cell.width - titleX - 2;   // 右侧留 2px 边距
                if (w > 60) return w;
            }
        } catch { }
        return (this._box && this._box.width) || 280;
    }

    /** 计算 label 区域宽度, 使编辑控件起始位置对齐 IDE 标准属性面板的 value 列.
     *  复刻 InspectorItem 的 caption 宽度公式:
     *    w = clamp(floor((cell.width - sourceWidth) * 0.5) + titleInitWidth, 70, 400)   // caption 右边缘(cell 坐标)
     *  本字段 captionDisplay="none", box 从 titleObject.x 起始铺满, 故 value 列在 box-local = w - titleObject.x.
     *  读不到 cell 内部时回退到 0.38 启发式. */
    private _labelAreaWidth(totalW: number): number {
        try {
            const cell: any = (this as any).cell;
            if (cell && typeof cell.width === "number") {
                const sourceW = Number(cell.sourceWidth) || 0;
                const titleInitW = Number(cell._titleInitWidth) || 0;
                const titleX = Number(cell.titleObject && cell.titleObject.x) || 0;
                let w = Math.floor((cell.width - sourceW) * 0.5) + titleInitW;
                if (w < 70) w = 70; else if (w > 400) w = 400;
                const la = w - titleX;
                if (la > 30 && la < totalW - 40) return la;
            }
        } catch { }
        return Math.floor(totalW * 0.38);
    }

    // ── 行渲染 ────────────────────────────────────────────────────

    /** 一行：[checkbox] [label] [editor widget] */
    private _addPropertyRow(p: any, overrides: { [name: string]: number[] }): void {
        try {
            const totalW = this._availWidth();
            // 勾选语义对齐 Unity m_Overridden：
            //   有显式条目(数组)=勾；条目为 null=用户显式取消(覆盖 prefab 标记)；
            //   无条目时回退资产的 prefabOverridden 标记(转换器从 Unity prefab m_PropertySheet 带出,
            //   值已烘进 default → 勾上显示烘焙值,与 Unity 面板一致)。
            const entry = overrides[p.name];
            // 勾选 = 有非 null 条目(数组/对象/字符串都算)；null = 用户显式取消；无条目回退 prefabOverridden 标记
            const enabled = entry !== undefined ? (entry !== null) : (p.prefabOverridden === true);
            const curVal = Array.isArray(entry) ? entry : this._toNumberArray(p.default, p.type);
            const display = p.displayName && p.displayName.length > 0 ? p.displayName : p.name;

            // 行容器: 不用 layout, 子节点 setPos 定位. 这里只做初始摆放, 面板缩放时由 _relayout 重新摆放(无重建).
            const rh = this._rowHeight;
            const cbW = 18;
            const gap = 4;
            const labelAreaW = this._labelAreaWidth(totalW);
            const labelW = Math.max(24, labelAreaW - cbW - gap * 2);  // editor 起始 x = cbW + gap + labelW + gap = labelAreaW
            const editorX = labelAreaW;
            const editorW = Math.max(40, totalW - labelAreaW - 2);

            const row = new gui.Box();
            row.setSize(totalW, rh);

            // checkbox —— 固定, 左对齐, 垂直居中
            const cb = this._createCheckbox(enabled);
            cb.setSize(cbW, 18);
            cb.setPos(0, Math.floor((rh - 18) / 2));
            cb.on("changed", () => {
                const newOn = (cb as any).selected;
                if (newOn) {
                    const cur = overrides[p.name];
                    if (cur === undefined || cur === null) {
                        // 勾上 → 写入该类型的默认 override 值(数值=number[]/gradient={stops}/texture=res://uuid)
                        overrides[p.name] = this._defaultOverrideValue(p);
                    }
                } else if (!newOn) {
                    if (p.prefabOverridden === true) {
                        // prefab 标记勾选的行：取消时写 null 占位（否则 rebuild 又按标记勾回）。
                        // 运行时 _applyPropertyOverrides 只认数组条目，null 自然跳过。
                        (overrides as any)[p.name] = null;
                    } else if (overrides[p.name] !== undefined) {
                        delete overrides[p.name];
                    }
                }
                this._commit(overrides);
                this._safeRefresh();
            }, this);
            row.addChild(cb);

            // label —— 固定宽度列, 文字由 _relayout 手动截断防溢出, 列宽对齐标准 caption 使编辑控件与标准 value 列对齐
            const label = new gui.TextField();
            label.text = display;
            label.color = enabled ? 0xEEEEEE : 0x999999;
            label.wrap = false;
            try { label.style.fontSize = 12; } catch { }
            try { (label.style as any).valign = (gui as any).VAlignType.Middle; } catch { }   // 文字垂直居中，跟 checkbox 中心对齐
            try { (label as any).title = display; } catch { }   // 悬停显示完整名
            label.setSize(labelW, rh);
            label.setPos(cbW + gap, 0);
            row.addChild(label);

            // editor —— 初始摆放在 editorX/editorW, 之后由 _relayout 随面板宽度重新摆放(无重建)
            const t = String(p.type).toLowerCase();
            let editor: any = null, editorY = 1, editorH = rh - 2;
            if (t === "float" || t === "number" || t === "int") {
                // Unity m_ValueFilter:1 → 转换器写入 p.range=[min,max]：有区间则用 slider(对齐 Unity Inspector)
                const range = (Array.isArray(p.range) && p.range.length === 2) ? p.range : null;
                editor = this._addNumericEditor(row, p.name, curVal, overrides, enabled, editorX, editorW, rh, t === "int", range);
                editorY = 1; editorH = rh - 2;
            } else if (t === "vec2" || t === "vec3" || t === "vec4") {
                const dim = t === "vec2" ? 2 : (t === "vec3" ? 3 : 4);
                editor = this._addVecEditor(row, p.name, curVal, dim, overrides, enabled, editorX, editorW, rh);
                editorY = 0; editorH = rh;
            } else if (t === "color") {
                editor = this._addColorEditor(row, p.name, curVal, overrides, enabled, editorX, editorW, rh);
                editorY = 1; editorH = rh - 2;
            } else if (t === "gradient") {
                editor = this._addGradientEditor(row, p, overrides, enabled, editorX, editorW, rh);
                editorY = 1; editorH = rh - 2;
            } else if (t === "texture2d") {
                editor = this._addTextureEditor(row, p, overrides, enabled, editorX, editorW, rh);
                editorY = 1; editorH = rh - 2;
            } else if (t === "bool") {
                editor = this._addBoolEditor(row, p.name, curVal, overrides, enabled, editorX, editorW, rh);
                editorY = 0; editorH = rh;
            } else if (t === "mesh") {
                editor = this._addMeshEditor(row, p, overrides, enabled, editorX, editorW, rh);
                editorY = 1; editorH = rh - 2;
            } else {
                // 仍不支持的类型(Texture3D/Cube...)显示只读说明
                const note = new gui.TextField();
                note.text = `(${p.type}: 暂不支持)`;
                note.color = 0x888888;
                note.wrap = false;
                try { note.style.fontSize = 11; } catch { }
                note.setSize(editorW, rh);
                note.setPos(editorX, 0);
                row.addChild(note);
                editor = note; editorY = 0; editorH = rh;
            }

            this._box.addChild(row);
            // HDR 标签(gradient/color 编辑器在 HDR 值时挂在 editor 上，叠在 swatch 中央，对齐 Unity)
            this._rowItems.push({ row, label, display, editor, editorY, editorH, overlay: (editor as any)?._hdrOverlay || null });
            this._builtHeight += this._rowHeight;
        } catch (e) {
            console.warn("[VfxPropertyOverrides] addPropertyRow failed for", p?.name, e);
        }
    }

    /** Float/Int 编辑控件：无 range 用单个 NumericInput；有 range(Unity m_ValueFilter:1)用 NumericInputWithSlider
     *  (滑条+数字框组合，跟 IDE 标准 NumberField 一致)。返回 widget 供 _relayout 重新摆放 */
    private _addNumericEditor(
        row: gui.Box, propName: string, values: number[],
        overrides: { [name: string]: number[] }, enabled: boolean,
        x: number, width: number, rh: number, intMode: boolean,
        range: number[] | null = null,
    ): any {
        const localVals: number[] = [Number(values?.[0] ?? 0)];
        // 区间有效且跨度 ≤360 才用 slider（对齐标准 NumberField 阈值；超大区间滑条精度无意义，退回纯输入框）
        const useSlider = !!range && isFinite(range[0]) && isFinite(range[1])
            && range[1] > range[0] && (range[1] - range[0]) <= 360;
        let input: any;
        try {
            input = gui.UIPackage.createWidgetSync(useSlider
                ? "~/ui/basic/Input/NumericInputWithSlider.widget"
                : "~/ui/basic/Input/NumericInput.widget");
        } catch {
            input = gui.UIPackage.createWidgetSync("~/ui/basic/Input/NumericInput.widget");
        }
        try {
            if (intMode) input.step = 1;
            if (useSlider) {
                // 先设 min/max 后设 value：min/max 的 setter 会把 slider.value 同步到 input 当前值
                input.min = range![0];
                input.max = range![1];
                // 小数位对齐 Unity 滑条：int 0 位、float 1 位（避免 70.035 这种长尾）。
                // fractionDigits 同时决定 slider.wholeNumbers(==0 时整数步进)。
                try { input.fractionDigits = intMode ? 0 : 1; } catch { }
            }
            input.value = localVals[0];
            // slider 组合控件用 editable 关闭交互(同时禁 slider 与输入框)；纯输入框用 touchable
            if (useSlider) { try { input.editable = enabled; } catch { } }
            else { input.touchable = enabled; }
            input.alpha = enabled ? 1.0 : 0.4;
        } catch { }
        input.setSize(width, rh - 2);
        input.setPos(x, 1);
        // 拖动滑条 / 输入框提交都会 emit "submit" → 实时写回 override(对齐 Unity 拖动即生效)
        input.on("submit", () => {
            if (!enabled) return;
            localVals[0] = Number(input.value);
            overrides[propName] = localVals.slice();
            this._commit(overrides);
        }, this);
        row.addChild(input);
        return input;
    }

    /** Bool 编辑控件：勾选框(参考 Unity Inspector 的 bool 行)。override 存 [1]/[0]，
     *  运行时 _applyPropertyOverrides 走 length=1 → setPropertyFloat 驱动 bool uniform((u_VfxProp != 0.0))。
     *  commit 内置 _selfCommitEcho 守卫,不会回声重建销毁 widget。返回 widget 供 _relayout 重摆。 */
    private _addBoolEditor(
        row: gui.Box, propName: string, values: number[],
        overrides: { [name: string]: number[] }, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        const localVals: number[] = [Number(values?.[0] ?? 0) ? 1 : 0];
        const cb: any = this._createCheckbox(localVals[0] === 1);
        try { cb.setSize(20, 18); cb.setPos(x, Math.floor((rh - 18) / 2)); } catch { }
        try { cb.touchable = enabled; cb.alpha = enabled ? 1.0 : 0.4; } catch { }
        cb.on("changed", () => {
            if (!enabled) return;
            localVals[0] = cb.selected ? 1 : 0;
            overrides[propName] = localVals.slice();
            this._commit(overrides);
        }, this);
        row.addChild(cb);
        return cb;
    }

    /** Vec2/3/4 编辑控件：直接复用 IDE 标准 Vec*Field.widget 预制件,
     *  其内部 relation 会把 x/y/z/w 输入框等分并随宽度伸缩(跟 Position 字段完全一致). 返回 widget. */
    private _addVecEditor(
        row: gui.Box, propName: string, values: number[], dim: number,
        overrides: { [name: string]: number[] }, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        const res = dim === 2 ? "Vec2Field" : (dim === 3 ? "Vec3Field" : "Vec4Field");
        let widget: any = null;
        try { widget = gui.UIPackage.createWidgetSync(`~/ui/basic/Inspector/${res}.widget`); } catch { }
        if (!widget) {
            // 预制件不可用 → 兜底用单个 NumericInput 显示第一分量
            return this._addNumericEditor(row, propName, values, overrides, enabled, x, width, rh, false);
        }
        const axes = ["x", "y", "z", "w"];
        const localVals: number[] = [];
        for (let i = 0; i < dim; i++) localVals[i] = Number(values?.[i] ?? 0);

        try { widget.getController("checkable").selectedIndex = 0; } catch { }   // 关掉 nullable 勾选, 始终显示输入框
        for (let i = 0; i < dim; i++) {
            const ni: any = widget.getChild(axes[i]);
            if (!ni) continue;
            try { ni.value = localVals[i]; ni.touchable = enabled; } catch { }
            const idx = i;
            ni.on("submit", () => {
                if (!enabled) return;
                localVals[idx] = Number(ni.value);
                overrides[propName] = localVals.slice();
                this._commit(overrides);
            }, this);
        }
        try { widget.alpha = enabled ? 1.0 : 0.4; } catch { }
        widget.setSize(width, rh);
        widget.setPos(x, 0);
        row.addChild(widget);
        return widget;
    }

    /** Color 编辑控件：ColorInput 色拾取器. 返回 widget 供 _relayout 重新摆放 */
    private _addColorEditor(
        row: gui.Box, propName: string, values: number[],
        overrides: { [name: string]: number[] }, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        try {
            const input: any = gui.UIPackage.createWidgetSync("~/ui/basic/ColorPicker/ColorInput.widget");
            const r0 = Number(values?.[0] ?? 0);
            const g0 = Number(values?.[1] ?? 0);
            const b0 = Number(values?.[2] ?? 0);
            const a = Number(values?.[3] ?? 1);
            // HDR(分量>1)按最大分量归一化到 [0,1] 显示，保留色相(对齐 Unity color 字段显示色相)。
            // 否则 HDR 值灌进 gui.Color → getStyleString hex 溢出 → 颜色错乱(蓝显示成绿)。单色 swatch 用归一化
            // 而非 clamp:clamp 会把 HDR 蓝变白丢色相。存原始 HDR，提交时未改则还原(见下)。
            this._colorOrig[propName] = [r0, g0, b0, a];
            const m = Math.max(r0, g0, b0, 1);
            try {
                // ColorInput 用 gui.Color 设值(归一化后的显示色)。
                // ⚠ 必须直接设 colorValue：ColorInput 构造函数不初始化 _colorValue(初始 undefined)，
                // 原先的 `if (input.colorValue)` 守卫永远 false → 颜色从没设上 → 显示预制件默认绿(本 bug 根因)。
                try { (input as any).checkable = false; } catch { }   // 关 nullable 勾选，确保始终显示颜色值
                try { (input as any).hideAlpha = true; } catch { }     // 忽略 alpha 当不透明显示(纯色，无棋盘格)，贴近 Unity HDR 颜色字段
                const col = new gui.Color();
                col.r = r0 / m; col.g = g0 / m; col.b = b0 / m; col.a = a;
                (input as any).colorValue = col;
                input.touchable = enabled;
                input.alpha = enabled ? 1.0 : 0.4;
            } catch (e) { console.warn("[VfxPropertyOverrides] color init failed", e); }
            input.setSize(width, rh - 2);
            input.setPos(x, 1);
            input.on("submit", () => {
                if (!enabled) return;
                try {
                    const c: any = (input as any).colorValue;
                    if (c) {
                        const er = Number(c.r) || 0, eg = Number(c.g) || 0, eb = Number(c.b) || 0;
                        const ea = (c.a != null ? Number(c.a) : 1);
                        // 未改(值≈归一化后的原始 HDR)→ 还原原始 HDR；改了→用编辑值(LDR)
                        const orig = this._colorOrig[propName];
                        if (orig) {
                            const om = Math.max(orig[0], orig[1], orig[2], 1);
                            const near = (xv: number, yv: number) => Math.abs(xv - yv) <= 0.01;
                            if (near(er, orig[0] / om) && near(eg, orig[1] / om) && near(eb, orig[2] / om) && near(ea, orig[3])) {
                                overrides[propName] = [orig[0], orig[1], orig[2], orig[3]];
                                this._commit(overrides);
                                return;
                            }
                        }
                        overrides[propName] = [er, eg, eb, ea];
                        this._commit(overrides);
                    }
                } catch (e) { console.warn("[VfxPropertyOverrides] color submit err", e); }
            }, this);
            row.addChild(input);
            if (r0 > 1 || g0 > 1 || b0 > 1) (input as any)._hdrOverlay = this._makeHdrOverlay(row, x, width, rh);
            return input;
        } catch (e) {
            // ColorInput widget 不存在或抛错 → fallback 用单个 NumericInput
            console.warn("[VfxPropertyOverrides] ColorInput fallback to NumericInput:", e);
            return this._addNumericEditor(row, propName, values, overrides, enabled, x, width, rh, false);
        }
    }

    /** 勾选某属性时写入的默认 override 值，按类型给出正确形态：
     *  数值=number[]（_toNumberArray）/ Gradient={stops:[...]}（深拷资产默认）/ Texture2D="res://uuid" 字符串 */
    private _defaultOverrideValue(p: any): any {
        const t = String(p.type).toLowerCase();
        if (t === "gradient") {
            const stops = (p.default && Array.isArray(p.default.stops)) ? p.default.stops : [];
            try { return { stops: JSON.parse(JSON.stringify(stops)) }; } catch { return { stops: [] }; }
        }
        if (t === "texture2d" || t === "mesh") {
            // 资源引用类(纹理/mesh)：override 存 res://uuid 字符串
            const d = p.default;
            const url = Array.isArray(d) ? d[0] : (typeof d === "string" ? d : "");
            return url || "";
        }
        return this._toNumberArray(p.default, p.type);
    }

    /** Texture2D 编辑控件：ResourceInput 资源选择器（限 Image 类型）。override 存 "res://uuid" 字符串。 */
    private _addTextureEditor(
        row: gui.Box, p: any, overrides: any, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        let input: any = null;
        try { input = gui.UIPackage.createWidgetSync("~/ui/basic/Input/ResourceInput.widget"); }
        catch (e) { console.warn("[VfxPropertyOverrides] ResourceInput unavailable:", e); }
        if (!input) {
            const note = new gui.TextField();
            note.text = "(Texture2D)"; note.color = 0x888888; note.wrap = false;
            note.setSize(width, rh); note.setPos(x, 0); row.addChild(note);
            return note;
        }
        try { input.typeFilter = ["Image"]; } catch { }
        // 当前值：override(res://uuid) 优先，否则资产默认 default[0]
        const cur = overrides[p.name];
        let url = (typeof cur === "string" && cur)
            ? cur
            : (Array.isArray(p.default) ? p.default[0] : (typeof p.default === "string" ? p.default : ""));
        const uuid = (typeof url === "string") ? url.replace(/^res:\/\//, "") : "";
        try { input.text = uuid; } catch { }
        try { input.editable = enabled; input.grayed = !enabled; } catch { }
        try { input.alpha = enabled ? 1.0 : 0.5; } catch { }
        input.setSize(width, rh - 2);
        input.setPos(x, 1);
        input.on("submit", () => {
            if (!enabled) return;
            try {
                const asset = (input as any).assetValue;
                if (asset && asset.id) overrides[p.name] = "res://" + asset.id;
                else if (typeof url === "string" && url) overrides[p.name] = url;   // 清空时回退默认 url，保持有效
                this._commit(overrides);
            } catch (e) { console.warn("[VfxPropertyOverrides] texture submit err", e); }
        }, this);
        row.addChild(input);
        return input;
    }

    /** Mesh 编辑控件：ResourceInput 资源选择器（限 Mesh 类型）。override 存 "res://uuid" 字符串。
     *  运行时 _applyPropertyOverrides 按属性 type=Mesh 分流到 setPropertyMesh → 重绑 GPU 几何换 mesh。 */
    private _addMeshEditor(
        row: gui.Box, p: any, overrides: any, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        let input: any = null;
        try { input = gui.UIPackage.createWidgetSync("~/ui/basic/Input/ResourceInput.widget"); }
        catch (e) { console.warn("[VfxPropertyOverrides] ResourceInput unavailable:", e); }
        if (!input) {
            const note = new gui.TextField();
            note.text = "(Mesh)"; note.color = 0x888888; note.wrap = false;
            note.setSize(width, rh); note.setPos(x, 0); row.addChild(note);
            return note;
        }
        try { input.typeFilter = ["Mesh"]; } catch { }
        // 当前值：override(res://uuid) 优先，否则资产默认 default[0]
        const cur = overrides[p.name];
        let url = (typeof cur === "string" && cur)
            ? cur
            : (Array.isArray(p.default) ? p.default[0] : (typeof p.default === "string" ? p.default : ""));
        const uuid = (typeof url === "string") ? url.replace(/^res:\/\//, "") : "";
        try { input.text = uuid; } catch { }
        try { input.editable = enabled; input.grayed = !enabled; } catch { }
        try { input.alpha = enabled ? 1.0 : 0.5; } catch { }
        input.setSize(width, rh - 2);
        input.setPos(x, 1);
        input.on("submit", () => {
            if (!enabled) return;
            try {
                const asset = (input as any).assetValue;
                if (asset && asset.id) overrides[p.name] = "res://" + asset.id;
                else if (typeof url === "string" && url) overrides[p.name] = url;   // 清空时回退默认 url
                this._commit(overrides);
            } catch (e) { console.warn("[VfxPropertyOverrides] mesh submit err", e); }
        }, this);
        row.addChild(input);
        return input;
    }

    /** Gradient 编辑控件：复用 IDE GradientInput.widget（点击弹 GradientEditDialog 编辑）。override 存 {stops:[{t,color:{r,g,b,a}}]}。
     *  ⚠ HDR 限制：IDE 颜色选择器是 LDR(0-1)，编辑某 stop 会把它 clamp 到 [0,1]；未触碰的 stop 保留原 HDR 值。 */
    private _addGradientEditor(
        row: gui.Box, p: any, overrides: any, enabled: boolean,
        x: number, width: number, rh: number,
    ): any {
        let input: any = null;
        try { input = gui.UIPackage.createWidgetSync("~/ui/basic/ColorPicker/GradientInput.widget"); }
        catch (e) { console.warn("[VfxPropertyOverrides] GradientInput unavailable:", e); }
        if (!input) {
            const note = new gui.TextField();
            note.text = "(gradient)"; note.color = 0x888888; note.wrap = false;
            note.setSize(width, rh); note.setPos(x, 0); row.addChild(note);
            return note;
        }
        // 当前 stops：override({stops}) 优先，否则资产默认
        const cur = overrides[p.name];
        const stops = (cur && typeof cur === "object" && Array.isArray(cur.stops))
            ? cur.stops
            : ((p.default && Array.isArray(p.default.stops)) ? p.default.stops : []);
        // 显示用 clamp(HDR>1 分量截白，对齐 Unity 渐变条 clamp 带的爆白主视觉)；
        // 存原始 HDR stops，提交时把"未被编辑"的 stop 还原成原始 HDR(见 _reconcileHdrStops)→ 不丢未改 stop 的强度。
        this._gradientOrig[p.name] = (Array.isArray(stops) ? stops : []).map((s: any) => {
            const c = s.color || {};
            const a0 = Array.isArray(c) ? c[3] : c.a;
            return {
                t: Number(s.t) || 0,
                color: {
                    r: Number(Array.isArray(c) ? c[0] : c.r) || 0,
                    g: Number(Array.isArray(c) ? c[1] : c.g) || 0,
                    b: Number(Array.isArray(c) ? c[2] : c.b) || 0,
                    a: a0 != null ? Number(a0) : 1,
                },
            };
        });
        try {
            const gv = (input as any).value;   // GradientInput 内部已 new GradientValue()，直接复用其实例
            if (gv && typeof gv.fromData === "function") {
                gv.fromData(this._stopsToLayaGradient(stops));   // _stopsToLayaGradient 内 clamp 显示
                (input as any).value = gv;     // 触发 setter 刷新渐变条显示
            }
        } catch (e) { console.warn("[VfxPropertyOverrides] gradient set value err", e); }
        try { (input as any).checkable = false; } catch { }
        try { input.touchable = enabled; input.alpha = enabled ? 1.0 : 0.5; } catch { }
        input.setSize(width, rh - 2);
        input.setPos(x, 1);
        input.on("submit", () => {
            if (!enabled) return;
            try {
                const gv = (input as any).value;
                if (gv && typeof gv.toData === "function") {
                    // 编辑器吐 clamp/LDR 值 → 未改的 stop 还原原始 HDR，改了的用编辑值
                    const editedStops = this._layaGradientToStops(gv.toData());
                    overrides[p.name] = { stops: this._reconcileHdrStops(editedStops, this._gradientOrig[p.name]) };
                    this._commit(overrides);
                }
            } catch (e) { console.warn("[VfxPropertyOverrides] gradient submit err", e); }
        }, this);
        row.addChild(input);
        const _isHdrGrad = (Array.isArray(stops) ? stops : []).some((s: any) => {
            const c = s.color || {};
            return (Number(Array.isArray(c) ? c[0] : c.r) || 0) > 1
                || (Number(Array.isArray(c) ? c[1] : c.g) || 0) > 1
                || (Number(Array.isArray(c) ? c[2] : c.b) || 0) > 1;
        });
        if (_isHdrGrad) (input as any)._hdrOverlay = this._makeHdrOverlay(row, x, width, rh);
        return input;
    }

    /** HDR 显示用：每个 gradient 属性的原始 HDR stops(按位置 t)。clamp 显示后，提交时未被编辑的 stop 据此还原完整 HDR。 */
    private _gradientOrig: { [name: string]: any[] } = {};

    /** HDR 显示用：每个 color 属性的原始 HDR 值 [r,g,b,a]。归一化显示后，提交时未改则还原完整 HDR。 */
    private _colorOrig: { [name: string]: number[] } = {};

    /** 提交协调：编辑器吐回 clamp/LDR 值。若某 stop 的值 ≈ 原始 HDR 的 clamp(说明用户没动它)→ 还原原始 HDR；
     *  否则用编辑值(用户确实改了，接受 LDR)。按位置 t 匹配，容差含字节往返误差。
     *  对齐 Unity:HDR 渐变条 clamp 带爆白显示(见 [[reference_unity_hdr_color_computation]])，编辑只动 clamp 后的 LDR。 */
    private _reconcileHdrStops(editedStops: any[], origStops: any[]): any[] {
        const orig = Array.isArray(origStops) ? origStops : [];
        const cl = (v: number) => Math.min(1, Math.max(0, v));
        const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;   // 字节往返 ~1/255 容差
        return (Array.isArray(editedStops) ? editedStops : []).map(s => {
            const ec = s.color || {};
            let match: any = null, best = 0.02;
            for (const o of orig) {
                const d = Math.abs((Number(o.t) || 0) - (Number(s.t) || 0));
                if (d <= best) { best = d; match = o; }
            }
            if (match) {
                const oc = match.color || {};
                const sameAsClampedOrig =
                    near(Number(ec.r) || 0, cl(Number(oc.r) || 0)) &&
                    near(Number(ec.g) || 0, cl(Number(oc.g) || 0)) &&
                    near(Number(ec.b) || 0, cl(Number(oc.b) || 0)) &&
                    near((ec.a != null ? Number(ec.a) : 1), (oc.a != null ? Number(oc.a) : 1));
                if (sameAsClampedOrig) {
                    // 未改 → 还原原始 HDR(完整强度)
                    return { t: s.t, color: { r: Number(oc.r) || 0, g: Number(oc.g) || 0, b: Number(oc.b) || 0, a: (oc.a != null ? Number(oc.a) : 1) } };
                }
            }
            return s;   // 改了 → 用编辑值(LDR)
        });
    }

    /** 我方 stops [{t,color:{r,g,b,a}}] → Laya GradientValue 数据(RGB/alpha 键分离)。
     *  ⚠ HDR 显示 clamp：HDR>1 分量截到 [0,1] → 超亮处爆白(对齐 Unity 渐变条 clamp 带的爆白主视觉)。
     *  同时避免 >1 撑爆 gui.Color.getStyleString 的 hex 转换(round(c*255)>0xFF 让 hex 串畸形 → 青显示成橄榄)。
     *  仅影响【显示】，override/运行时仍是原始 HDR stops(未改 stop 提交时由 _reconcileHdrStops 还原)。 */
    private _stopsToLayaGradient(stops: any[]): any {
        const src = (Array.isArray(stops) && stops.length)
            ? stops
            : [{ t: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { t: 1, color: { r: 1, g: 1, b: 1, a: 1 } }];
        const rgb: number[] = [];
        const alpha: number[] = [];
        for (const k of src) {
            const c = k.color || {};
            let r = Number(Array.isArray(c) ? c[0] : c.r) || 0;
            let g = Number(Array.isArray(c) ? c[1] : c.g) || 0;
            let b = Number(Array.isArray(c) ? c[2] : c.b) || 0;
            const a = Array.isArray(c) ? c[3] : c.a;
            // clamp 到 [0,1]：HDR>1 分量截白(对齐 Unity clamp 带爆白主视觉)；同时避免 >1 撑爆 getStyleString hex
            r = Math.min(1, Math.max(0, r));
            g = Math.min(1, Math.max(0, g));
            b = Math.min(1, Math.max(0, b));
            const t = Number(k.t) || 0;
            rgb.push(t, r, g, b);
            alpha.push(t, (a != null ? Number(a) : 1));
        }
        return {
            _mode: 0,
            _colorRGBKeysCount: src.length, _rgbElements: rgb,
            _colorAlphaKeysCount: src.length, _alphaElements: alpha,
        };
    }

    /** Laya GradientValue 数据 → 我方 stops。RGB/alpha 键位置可能不同，取并集逐点采样合并。 */
    private _layaGradientToStops(data: any): any[] {
        const rgbArr = data._rgbElements || [];
        const alphaArr = data._alphaElements || [];
        const rgbN = data._colorRGBKeysCount || 0;
        const alphaN = data._colorAlphaKeysCount || 0;
        const rgbKeys: any[] = [];
        for (let i = 0; i < rgbN; i++) rgbKeys.push({ t: rgbArr[i * 4], r: rgbArr[i * 4 + 1], g: rgbArr[i * 4 + 2], b: rgbArr[i * 4 + 3] });
        const alphaKeys: any[] = [];
        for (let i = 0; i < alphaN; i++) alphaKeys.push({ t: alphaArr[i * 2], a: alphaArr[i * 2 + 1] });
        if (!rgbKeys.length) rgbKeys.push({ t: 0, r: 1, g: 1, b: 1 });
        if (!alphaKeys.length) alphaKeys.push({ t: 0, a: 1 });
        const posSet = new Set<number>();
        for (const k of rgbKeys) posSet.add(k.t);
        for (const k of alphaKeys) posSet.add(k.t);
        const positions = Array.from(posSet).sort((a, b) => a - b);
        return positions.map(t => {
            const rgb = this._sampleKeys(rgbKeys, t, ["r", "g", "b"]);
            const a = this._sampleKeys(alphaKeys, t, ["a"]).a;
            return { t, color: { r: rgb.r, g: rgb.g, b: rgb.b, a } };
        });
    }

    /** 在键数组上对 t 做分段线性采样(各 field 独立)。keys 须按 t 升序，元素含 .t 及各 field。 */
    private _sampleKeys(keys: any[], t: number, fields: string[]): any {
        const out: any = {};
        if (!keys.length) { for (const f of fields) out[f] = 0; return out; }
        if (t <= keys[0].t) { for (const f of fields) out[f] = keys[0][f]; return out; }
        const last = keys[keys.length - 1];
        if (t >= last.t) { for (const f of fields) out[f] = last[f]; return out; }
        for (let i = 0; i < keys.length - 1; i++) {
            const a = keys[i], b = keys[i + 1];
            if (t >= a.t && t <= b.t) {
                const u = (t - a.t) / Math.max(b.t - a.t, 1e-6);
                for (const f of fields) out[f] = a[f] + (b[f] - a[f]) * u;
                return out;
            }
        }
        for (const f of fields) out[f] = last[f];
        return out;
    }

    /** 在 editor(渐变条/颜色 swatch)上叠 "HDR" 标签(分量>1 时)，对齐 Unity HDR 显示。
     *  touchable=false 让点击穿透到下方编辑器；返回标签供 _relayout 跟随重定位。 */
    private _makeHdrOverlay(row: gui.Box, x: number, w: number, rh: number): gui.TextField {
        const tf = new gui.TextField();
        tf.text = "HDR";
        // 对齐 Unity centeredGreyMiniLabel：柔和灰字、无描边(去掉之前白字黑描边的生硬效果)。
        // 0x9A9A9A 中性灰在蓝/白/爆白/深底上都可读，又不扎眼。
        tf.color = 0x9A9A9A;
        tf.wrap = false;
        try { tf.style.fontSize = 10; } catch { }
        try { tf.style.align = gui.AlignType.Center; } catch { }
        try { (tf.style as any).valign = (gui as any).VAlignType.Middle; } catch { }
        try { (tf as any).touchable = false; } catch { }   // 点击穿透到下方编辑器
        tf.setSize(w, rh - 2);
        tf.setPos(x, 1);
        row.addChild(tf);   // 在 editor 之后添加 → z 序在上层
        return tf;
    }

    /** 创建 checkbox widget（清空 default "text" 字段避免跟 label 文字重叠） */
    private _createCheckbox(checked: boolean): gui.Button {
        const cb: any = gui.UIPackage.createWidgetSync("~/ui/basic/Button/Checkbox_as.widget");
        try { cb.text = ""; cb.selected = checked; cb.width = 20; } catch { }
        return cb;
    }

    /** 单行 TextField（group title / placeholder） */
    private _addText(text: string, color: number, fontSize: number = 12): void {
        try {
            const tf = new gui.TextField();
            tf.text = text;
            tf.color = color;
            tf.wrap = false;
            try { tf.style.fontSize = fontSize; } catch { }
            tf.setSize(this._availWidth() - 4, this._rowHeight);
            this._box.addChild(tf);
            this._builtHeight += this._rowHeight;
        } catch (e) {
            console.warn("[VfxPropertyOverrides] addText failed:", e);
        }
    }

    /** 可折叠的分组标题: 点击切换折叠状态(箭头 ▼ 展开 / ▶ 折叠), 折叠时不渲染该组属性行(参考 Unity foldout) */
    private _addGroupHeader(gname: string, collapsed: boolean): void {
        try {
            const tf = new gui.TextField();
            tf.text = `${collapsed ? "▶" : "▼"} ${gname}`;
            tf.color = 0xAACCEE;
            tf.wrap = false;
            try { tf.style.fontSize = 13; } catch { }
            try { (tf as any).touchable = true; } catch { }
            try { (tf as any).cursor = "pointer"; } catch { }
            tf.setSize(this._availWidth() - 4, this._rowHeight);
            tf.on("click", () => {
                this._collapsed[gname] = !(this._collapsed[gname] === true);
                this._safeRefresh();
            }, this);
            this._box.addChild(tf);
            this._builtHeight += this._rowHeight;
        } catch (e) {
            console.warn("[VfxPropertyOverrides] addGroupHeader failed:", e);
        }
    }

    /** Group 之间空白行 */
    private _addSpacer(height: number): void {
        try {
            const tf = new gui.TextField();
            tf.text = "";
            tf.setSize(1, height);
            this._box.addChild(tf);
            this._builtHeight += height;
        } catch { }
    }

    // ── 数据 helpers ──────────────────────────────────────────────

    /** 取当前 propertyOverrides（字段是 JSON string，反序列化成 object 给 UI 用） */
    private _getOverrides(): { [name: string]: number[] } {
        try {
            const v = this.target?.getValue();
            // 已经是 object（老版本场景兼容）
            if (v && typeof v === "object") return v;
            // string 形式
            if (typeof v === "string" && v.length > 0) {
                try {
                    const parsed = JSON.parse(v);
                    return (parsed && typeof parsed === "object") ? parsed : {};
                } catch { return {}; }
            }
            return {};
        } catch { return {}; }
    }

    /** 取 asset.properties（async load .vfx JSON） */
    private _getAssetProperties(): any[] | null {
        try {
            const data = this.target?.data;
            const asset = data?.asset;
            if (!asset) { this._propertiesCache = null; this._cachedAssetKey = ""; return null; }

            // 形态 1：已加载 VFXAsset 实例
            if (Array.isArray((asset as any).properties)) {
                return (asset as any).properties;
            }

            // 形态 2/3：拿 uuid（LayaPro IDE wrapper 用 _$uuid）
            let uuid: string | null = null;
            if (typeof asset === "string") {
                uuid = asset.replace(/^res:\/\//, "");
            } else if (typeof asset === "object") {
                const a: any = asset;
                uuid = a._$uuid || a.uuid || a._uuid || a.id || null;
            }
            if (!uuid) {
                try {
                    console.log("[VfxPropertyOverrides] unknown asset shape:", typeof asset,
                        typeof asset === "object" ? Object.keys(asset as any).slice(0, 10) : asset);
                } catch { }
                return null;
            }

            // cache 命中
            if (this._propertiesCache && this._cachedAssetKey === uuid) {
                return this._propertiesCache;
            }
            if (this._loadInflight) return null;

            // async 加载
            this._loadInflight = true;
            const myKey = uuid;
            (async () => {
                try {
                    // ⭐优先读【源 .laya.vfx】（剥掉 "@N" 子资产后缀）：prefabOverridden 标记/initialEventName/
                    // events 只在源文件里全；编译后 @0.lvfx 的 properties 不带标记（VfxBuild 不透传且需重导才更新）。
                    // 源读不到时回退子资产（兼容手写 .lvfx 直挂的场景）。
                    const srcKey = myKey.split("@")[0];
                    let assetInfo: any = await (Editor as any).assetDb?.getAsset?.(srcKey);
                    if (!assetInfo && srcKey !== myKey) assetInfo = await (Editor as any).assetDb?.getAsset?.(myKey);
                    if (!assetInfo) return;
                    const fullPath: string = (Editor as any).assetDb?.getFullPath?.(assetInfo);
                    if (!fullPath) return;
                    const json: any = await (IEditor as any).utils?.readJsonAsync?.(fullPath);
                    if (!json) return;
                    // initialEvent：组件上已有值一律保持（用户手填的名字绝不能被重导/重转覆盖）；
                    // 只有空值才回填资产文件的 initialEventName（读不到则 OnPlay）。
                    try {
                        const dataObj: any = this.target?.data;
                        if (dataObj && !dataObj.initialEvent) {
                            dataObj.initialEvent = json.initialEventName || json.props?.initialEventName || "OnPlay";
                        }
                    } catch { }
                    if (Array.isArray(json.properties)) {
                        this._propertiesCache = json.properties;
                        this._cachedAssetKey = myKey;
                        this._safeRefresh();
                    }
                } catch (e) {
                    console.warn("[VfxPropertyOverrides] async load failed:", e);
                } finally {
                    this._loadInflight = false;
                }
            })();
            return null;
        } catch { return null; }
    }

    /** VFXPropertyDesc.default 正规化成 number[] */
    private _toNumberArray(value: any, type: string): number[] {
        const t = String(type).toLowerCase();
        if (Array.isArray(value)) {
            const r = value.map(v => Number(v) || 0);
            switch (t) {
                case "vec4": case "color":
                    while (r.length < 4) r.push(0);
                    return r.slice(0, 4);
                case "vec3":
                    while (r.length < 3) r.push(0);
                    return r.slice(0, 3);
                case "vec2":
                    while (r.length < 2) r.push(0);
                    return r.slice(0, 2);
                default:
                    return r.length > 0 ? [r[0]] : [0];
            }
        }
        if (typeof value === "number") return [value];
        if (value && typeof value === "object") {
            const keys = t === "color" ? ["r", "g", "b", "a"] : ["x", "y", "z", "w"];
            const r: number[] = [];
            for (const k of keys) {
                if (k in value) r.push(Number((value as any)[k]) || 0);
            }
            if (r.length > 0) return r;
        }
        switch (t) {
            case "vec4": case "color": return [0, 0, 0, 0];
            case "vec3": return [0, 0, 0];
            case "vec2": return [0, 0];
            default: return [0];
        }
    }

    /** 写回 propertyOverrides 到 target data，触发 dirty + scene save
     *  序列化成 JSON string —— LayaPro 序列化层不识别 plain object dynamic-key map（会 fallback null），
     *  必须 string 才能正确保存到 .ls 文件。
     */
    private _commit(overrides: { [name: string]: number[] }): void {
        try {
            const json = JSON.stringify(overrides || {});
            // 预告：本次 setValue 会让 DataInspector 下一帧回调 refresh()，那次跳过重建(见 _selfCommitEcho)
            this._selfCommitEcho = true;
            this.target?.setValue(json);
        } catch (e) {
            this._selfCommitEcho = false;
            console.warn("[VfxPropertyOverrides] commit failed:", e);
        }
    }
}
