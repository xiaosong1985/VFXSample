import { VfxScenePanel } from "./VfxScenePanel";
import { VfxPropertyPanel } from "./VfxPropertyPanel";
import { VfxInspectorPanel } from "./VfxInspectorPanel";
import type { IVfxHost } from "./IVfxHost";

const LEFT_W = 250;
const RIGHT_W = 380;
const TITLE_H = 24;
const SPLITTER_W = 4;     // 左栏与画布之间的可拖拽分隔条宽度
const MIN_LEFT_W = 200;   // 左栏最小宽度
const MIN_MID_W = 200;    // 画布最小宽度（避免左栏拖太宽把画布挤没）

/**
 * VFX Graph 合并面板
 * - 三栏布局：左 Blackboard / 中 Scene 画布 / 右 Inspector
 * - 接收 .vfx 文件打开请求（postMessage 派发到 openFile 方法）
 * - Ctrl+S 保存 / Ctrl+Z 撤销 / Ctrl+Y 重做
 */
@IEditor.panel("VfxGraphPanel", {
    title: "VFX Graph",
    icon: "~/ui/type-icons/file/bp.svg",
    location: "embed",
    locationBase: "ScenePanel",
})
export class VfxGraphPanel extends IEditor.EditorPanel implements IVfxHost {
    private _scene: VfxScenePanel;
    private _propPanel: VfxPropertyPanel;
    private _inspector: VfxInspectorPanel;
    private _titleLabel: gui.TextField;
    private _saveBtn: gui.Button;
    private _body: gui.Widget;
    private _leftCol: gui.Widget;
    private _midCol: gui.Widget;
    private _rightCol: gui.Widget;
    private _splitter: gui.Shape;
    private _leftW = LEFT_W;          // 左栏当前宽度（可拖拽调整）
    private _dragStartX = 0;
    private _dragStartW = 0;

    get scene(): VfxScenePanel { return this._scene; }
    get propertyPanel(): VfxPropertyPanel { return this._propPanel; }
    get inspector(): VfxInspectorPanel { return this._inspector; }

    async create(): Promise<void> {
        this._panel = new gui.Widget();
        const panel = this._panel;

        // 预加载 VFX widget 资源
        await Promise.all([
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxContextNode.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxOperatorNode.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxBlockRow.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxEventNode.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxPropertyPanel.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxPropertyRow.widget"),
            gui.UIPackage.resourceMgr.load("editorResources/vfx/UI/VfxNodePicker.widget"),
        ]);

        // 顶部标题栏
        this._titleLabel = new gui.TextField();
        this._titleLabel.text = "VFX Graph";
        this._titleLabel.style.fontSize = 12;
        this._titleLabel.color = 0xcccccc;
        this._titleLabel.setPos(8, 4);
        panel.addChild(this._titleLabel);

        // 保存按钮（标题栏右侧）
        this._saveBtn = IEditor.GUIUtils.createButton(true);
        this._saveBtn.title = i18n.t("save");
        this._saveBtn.onClick(() => this.save(), this);
        panel.addChild(this._saveBtn);

        // 主体容器（三栏宿主）
        this._body = new gui.Widget();
        this._body.setPos(0, TITLE_H);
        panel.addChild(this._body);

        // 三栏
        this._leftCol = new gui.Widget();
        this._body.addChild(this._leftCol);

        this._rightCol = new gui.Widget();
        this._body.addChild(this._rightCol);

        this._midCol = new gui.Widget();
        this._body.addChild(this._midCol);

        // 左栏 / 画布之间的可拖拽分隔条（最后添加，保证在最上层可点）
        this._splitter = new gui.Shape();
        this._splitter.getGraphics(gui.SRect).fillColor.parse("#333333");
        this._splitter.touchable = true;
        try { (this._splitter as any).cursor = "ew-resize"; } catch { }
        this._body.addChild(this._splitter);
        this._splitter.on("pointer_down", this._onSplitterDown, this);

        // panel 尺寸变化时手动重排，避免 fairyGUI relation 多栏重叠的问题
        panel.on("size_changed", this._layout, this);
        this._layout();

        // 实例化三个子组件
        this._propPanel = new VfxPropertyPanel();
        await this._propPanel.create(this._leftCol, this);

        this._scene = new VfxScenePanel();
        await this._scene.create(this._midCol, this);

        this._inspector = new VfxInspectorPanel();
        await this._inspector.create(this._rightCol);
    }

    /** 手动布局三栏 */
    private _layout(): void {
        const panel = this._panel;
        const W = panel.width;
        const H = panel.height;
        const bodyH = Math.max(0, H - TITLE_H);

        // 保存按钮在标题栏右上角
        const btnW = this._saveBtn.width;
        const btnH = this._saveBtn.height;
        this._saveBtn.setPos(Math.max(0, W - btnW - 8), Math.max(0, (TITLE_H - btnH) / 2));

        // 标题文本占左侧剩余空间
        this._titleLabel.setSize(Math.max(0, W - 16 - btnW - 8), TITLE_H - 4);
        this._body.setSize(W, bodyH);

        // 把左栏宽度 clamp 到当前可用范围（窗口变窄时自动收缩）
        const maxLeft = Math.max(MIN_LEFT_W, W - RIGHT_W - MIN_MID_W);
        this._leftW = Math.max(MIN_LEFT_W, Math.min(this._leftW, maxLeft));
        const leftW = this._leftW;

        this._leftCol.setPos(0, 0);
        this._leftCol.setSize(leftW, bodyH);

        this._rightCol.setPos(Math.max(leftW, W - RIGHT_W), 0);
        this._rightCol.setSize(RIGHT_W, bodyH);

        const midW = Math.max(0, W - leftW - RIGHT_W);
        this._midCol.setPos(leftW, 0);
        this._midCol.setSize(midW, bodyH);

        // 分隔条骑在左栏右边界上
        this._splitter.setPos(leftW - SPLITTER_W / 2, 0);
        this._splitter.setSize(SPLITTER_W, bodyH);
    }

    /** 分隔条拖拽：调整左栏宽度 */
    private _onSplitterDown(e: gui.Event): void {
        if (e.input.button !== 0) return;
        e.stopPropagation();
        this._dragStartX = e.input.x;
        this._dragStartW = this._leftW;
        e.capturePointer();
        this._splitter.on("pointer_move", this._onSplitterMove, this);
        this._splitter.on("pointer_up", this._onSplitterUp, this);
    }

    private _onSplitterMove(e: gui.Event): void {
        const W = this._panel.width;
        const maxLeft = Math.max(MIN_LEFT_W, W - RIGHT_W - MIN_MID_W);
        const dx = e.input.x - this._dragStartX;
        this._leftW = Math.max(MIN_LEFT_W, Math.min(maxLeft, this._dragStartW + dx));
        this._layout();
    }

    private _onSplitterUp(_e: gui.Event): void {
        this._splitter.off("pointer_move", this._onSplitterMove, this);
        this._splitter.off("pointer_up", this._onSplitterUp, this);
    }

    /** 通过 Editor.panelManager.postMessage("VfxGraphPanel", "openFile", assetId) 触发 */
    async openFile(assetId: string): Promise<void> {
        if (!assetId) return;
        await this._scene.open(assetId);
    }

    /**
     * panel 激活时调用 —— 恢复上次打开的 .vfx 文件
     * IDE 刷新 / 工程切换后 IDE 不会自动重新触发 openFile，需要 panel 自己记忆
     * 存储位置：workspaceConf 的 VfxGraphPanel 分段，key=lastAssetId
     */
    onStart(): void {
        const conf = Editor.workspaceConf.data.getSection(this.panelId);
        // workspaceConf ISection 只有 getNumber/getBool 强类型 + 通用 get；string 走通用 get
        const lastId = conf.get("lastAssetId", "") as string;
        if (lastId) {
            this.openFile(lastId).catch(err => {
                console.warn("[VfxGraphPanel] 恢复上次打开的 vfx 失败:", lastId, err);
            });
        }
    }

    /** panel 销毁时调用 —— 把当前打开的 .vfx UUID 写回 workspaceConf */
    onDestroy(): void {
        const conf = Editor.workspaceConf.data.getSection(this.panelId);
        conf.set("lastAssetId", this._scene?.assetId || "");
    }

    /** 保存当前文件 */
    async save(): Promise<boolean> {
        return this._scene.save();
    }

    /**
     * 编辑器关闭 / 面板销毁前由 PanelManager 自动调用。
     * 仅在有未保存改动时落盘，避免无文件 / 无改动时刷无谓日志。
     */
    async onSave(): Promise<void> {
        if (this._scene?.isModified)
            await this._scene.save();
    }

    /** 由 VfxScenePanel 通过 IVfxHost.updateTitle 回调 */
    updateTitle(fileName: string, modified: boolean): void {
        if (!this._titleLabel) return;
        this._titleLabel.text = `VFX Graph - ${fileName}${modified ? " *" : ""}`;
    }

    /** 全局热键处理 */
    onHotkey(combo: string): boolean {
        switch (combo) {
            case "save":
                this.save();
                return true;
            case "undo":
                this._scene?.history?.undo();
                return true;
            case "redo":
                this._scene?.history?.redo();
                return true;
        }
        return false;
    }
}
