import fpath from "path";

/**
 * VFX 资源类型注册
 *
 * 扩展名分工：
 * - .vfx  = editor 节点图（源），用户在 vfx editor 面板里编辑保存，
 *           被 VfxImporter (regAssetImporter(["vfx"])) 编译成 .lvfx + .computeshader 子资产
 * - .lvfx = runtime 格式（产物），引擎 VFXLoader (registerLoader(["lvfx"], ..., "LVFX")) 加载，
 *           VisualEffect.asset 字段引用的就是这个
 *
 * 资源选择对话框走 .lvfx 类型（assetTypeFilter: "LVFX"），用户可以选 importer 产出的
 * 子资产或手写的 runtime .lvfx 文件
 */
export class VfxAssetHelper {
    @IEditor.onLoad
    async onLoad() {
        let extensionManager = Editor.extensionManager;

        // .vfx：editor 源格式，type "VFXGraph"
        extensionManager.setFileType(["vfx"], "VFXGraph");
        extensionManager.setFileIcon(["vfx"], "~/ui/type-icons/file/bp.svg");
        extensionManager.addFileActions(["vfx"], {
            onOpen: async (asset) => {
                Editor.panelManager.showPanel("VfxGraphPanel");
                Editor.panelManager.postMessage("VfxGraphPanel", "openFile", asset.id);
            },
        });

        // .lvfx：runtime 产物格式，type "LVFX"（与引擎 VFXLoader 注册的 type 一致）
        // 让 VisualEffect.asset 字段（assetTypeFilter: "LVFX"）能找到 .lvfx 文件
        extensionManager.setFileType(["lvfx"], "LVFX");
        // .lvfx 是 .vfx 编译产物，用 bpsf.svg（蓝图产物图标），跟源 .vfx 的 bp.svg 区分开
        extensionManager.setFileIcon(["lvfx"], "~/ui/type-icons/file/bpsf.svg");
    }

    @IEditor.menu("Project/create/VFXGraph", {
        label: "VFX Graph",
        position: "after create",
    })
    static async createVfxGraph() {
        let project: IEditor.IProjectPanel = Editor.panelManager.getPanel("ProjectPanel");
        // 模板在工程内 VfxEditor/template/
        let templateAsset = await Editor.assetDb.getAsset("VfxEditor/template/VfxGraph.vfx", true);
        let templatePath = templateAsset ? Editor.assetDb.getFullPath(templateAsset) : "";
        project.createAsset("VfxGraph.vfx", templatePath);
    }
}
