import fs from "fs";
import fpath from "path";
import { VfxBuild } from "../build/VfxBuild";

@IEditorEnv.regAssetImporter(["vfx"])
export class VfxImporter extends IEditorEnv.AssetImporter {
    public async handleImport(): Promise<void> {
        this.clearLibrary();

        let content = fs.readFileSync(this.assetFullPath, "utf-8");
        let json: any;
        try {
            json = JSON.parse(content);
        } catch {
            return;
        }

        // 编译图数据 → .lvfx 运行时数据
        let compiled = VfxBuild.compile(json, this.asset.id);

        // 为每个 Particle system 的 3 个 compute shader 创建子资产
        let baseName = this.asset.fileName.replace(/\.vfx$/, "");
        let systemIdx = 0;
        for (const sys of compiled.systems) {
            if (sys.type !== "Particle") { systemIdx++; continue; }
            for (const stage of ["initialize", "update", "output", "prepareDispatch", "updateStrips"] as const) {
                const key = `${stage}Shader` as const;
                const code = sys[key];
                if (!code) continue;
                const subName = `${baseName}_s${systemIdx}_${stage}.computeshader`;
                const subId = `${systemIdx}_${stage}`;
                const sub = this.createSubAsset(subName, subId);
                fs.writeFileSync(sub.fullPath, code, "utf-8");
                sys[key] = "res://" + sub.id;
            }

            // Multi-Output: 额外 output shader 也需要写成子资产文件
            if (Array.isArray(sys.extraOutputs)) {
                for (let oi = 0; oi < sys.extraOutputs.length; oi++) {
                    const extra = sys.extraOutputs[oi];
                    if (extra.outputShader && typeof extra.outputShader === "string" && !extra.outputShader.startsWith("res://")) {
                        const subName = `${baseName}_s${systemIdx}_o${oi + 1}_output.computeshader`;
                        const subId = `${systemIdx}_o${oi + 1}_output`;
                        const sub = this.createSubAsset(subName, subId);
                        fs.writeFileSync(sub.fullPath, extra.outputShader, "utf-8");
                        extra.outputShader = "res://" + sub.id;
                    }
                }
            }

            systemIdx++;
        }

        // 全局曲线纹理 KTX 子资产（所有 system 共享一张）
        if (compiled.curveTextureData) {
            const texData = compiled.curveTextureData;
            const halfData = float32ToHalf(new Float32Array(texData.data));
            const sub = this.createSubAsset(`${baseName}_curveTex.ktx`, "curveTex");

            const tmpBin = fpath.join(this.tempPath, `tmpCurveTex.bin`);
            await fs.promises.writeFile(tmpBin, Buffer.from(halfData.buffer, halfData.byteOffset, halfData.byteLength));
            const ret = await IEditorEnv.utils.runTool("KtxPixelTool", [
                "-w", String(texData.width), "-h", String(texData.height),
                "-f", "RGBA16", "-i", tmpBin, "-o", sub.fullPath,
            ]);
            if (ret.code !== 0) console.error(`KtxPixelTool failed: ${ret.error || ret.output}`);

            const metaPath = sub.fullPath.replace(/\.ktx$/, ".json");
            await IEditorEnv.utils.writeJsonAsync(metaPath, {
                type: 0,
                sRGB: false,
                wrapMode: 1,      // Clamp
                filterMode: 1,    // Bilinear
                mipmap: false,
                files: [{ ext: "ktx" }],
            });

            compiled.bakedTexture = "res://" + sub.id;
            delete compiled.curveTextureData;
        }

        // 创建子资产 → library/{id前2位}/{assetId}@0.lvfx
        let name = this.asset.fileName.replace(/\.vfx$/, ".lvfx");
        let subAsset = this.createSubAsset(name, "0");
        await IEditorEnv.utils.writeJsonAsync(subAsset.fullPath, compiled);
    }
}

/** Float32 → Float16 (IEEE 754 half-precision) 转换 */
function float32ToHalf(f32: Float32Array): Uint16Array {
    const result = new Uint16Array(f32.length);
    const view = new DataView(f32.buffer, f32.byteOffset, f32.byteLength);
    for (let i = 0; i < f32.length; i++) {
        const bits = view.getUint32(i * 4, true);
        const sign = (bits >> 16) & 0x8000;
        const exp = ((bits >> 23) & 0xFF) - 127 + 15;
        const frac = bits & 0x7FFFFF;

        if (exp <= 0) {
            // Subnormal or zero
            if (exp < -10) {
                result[i] = sign;
            } else {
                const m = (frac | 0x800000) >> (1 - exp);
                result[i] = sign | (m >> 13);
            }
        } else if (exp >= 31) {
            // Overflow → Inf or NaN
            result[i] = sign | 0x7C00 | (frac ? (frac >> 13) | 1 : 0);
        } else {
            result[i] = sign | (exp << 10) | (frac >> 13);
        }
    }
    return result;
}
