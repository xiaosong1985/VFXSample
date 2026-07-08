import fs from "fs";
import fpath from "path";

@IEditorEnv.regAssetExporter(["vfx"])
export class VfxExporter extends IEditorEnv.AssetExporter {
    async handleExport(): Promise<void> {
        // 从 library 读取已导入的 .lvfx
        let lvfxPath = fpath.join(
            EditorEnv.projectPath,
            "library",
            this.asset.id.substring(0, 2),
            this.asset.id + "@0.lvfx"
        );

        if (!fs.existsSync(lvfxPath)) return;

        let content = await fs.promises.readFile(lvfxPath, "utf-8");
        this.exportInfo.contents[0] = { type: "text", data: content };
        (this.exportInfo.contents[0] as any).nameSuffix = "@0.lvfx";

        // 收集 shader 子资产依赖
        try {
            const compiled = JSON.parse(content);
            const links: { obj: any; prop: string; url: string }[] = [];
            for (const sys of compiled.systems || []) {
                if (sys.type !== "Particle") continue;
                for (const key of ["mesh", "initializeShader", "updateShader", "outputShader", "prepareDispatchShader"]) {
                    const ref: string = sys[key];
                    if (ref && ref.startsWith("res://")) {
                        links.push({ obj: sys, prop: key, url: ref });
                    }
                }
                // Multi-Output: extra output shader 依赖
                if (Array.isArray(sys.extraOutputs)) {
                    for (const extra of sys.extraOutputs) {
                        if (extra.outputShader && extra.outputShader.startsWith("res://")) {
                            links.push({ obj: extra, prop: "outputShader", url: extra.outputShader });
                        }
                    }
                }
            }
            // 全局曲线纹理依赖
            if (compiled.bakedTexture && compiled.bakedTexture.startsWith("res://")) {
                links.push({ obj: compiled, prop: "bakedTexture", url: compiled.bakedTexture });
            }
            if (links.length > 0)
                this.exportInfo.deps = this.parseLinks(links);
        } catch { }
    }
}
