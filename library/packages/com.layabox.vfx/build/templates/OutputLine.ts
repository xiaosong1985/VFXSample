/**
 * Output Line Compute Shader Template
 *
 * Each particle generates a line segment (2 vertices): from position to position + targetOffset.
 * Uses hardware lines (GL_LINES equivalent) or thin quads for WebGPU compatibility.
 *
 * RenderBuffer layout (per vertex, 4 vec4):
 *   [0] xyz=position, w=1
 *   [1] rgba=color
 *   [2] xy=uv, zw=0
 *   [3] xyz=normal, w=0
 */

export interface ILineOutputOptions {
    hasColor: boolean;
    hasAlpha: boolean;
    hasSize: boolean;
    blockCode: string;
    extraUniforms: string;
    simulateSpace: string;
    attrNames: Set<string>;
    targetOffset: { x: number; y: number; z: number };
}

export function generateLineOutput(
    commonCode: string,
    opts: ILineOutputOptions,
): string {
    const { blockCode, extraUniforms, attrNames, simulateSpace, targetOffset } = opts;
    const isWorld = simulateSpace === "World";

    const colorRGB = attrNames.has("color") ? "p.color" : "vec3(1.0)";
    const alpha = attrNames.has("alpha") ? "p.alpha" : "1.0";

    const worldToLocal = isWorld && attrNames.has("position")
        ? "    p.position = transformPosition(u_InvEmitterWorldMatrix, p.position);\n"
        : "";

    const blockLines = blockCode ? blockCode + "\n" : "";
    const tx = (targetOffset?.x ?? 0).toFixed(6);
    // 之前 Y default 0.1 不对称 (跟 X/Z 0 不一致), 像 placeholder; 统一 0 让 line targetOffset 未指定时不强加 Y 偏移
    const ty = (targetOffset?.y ?? 0).toFixed(6);
    const tz = (targetOffset?.z ?? 0).toFixed(6);

    return `Shader3D Start
{
    type: ComputeShader,
    name: "LineOutput",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }${extraUniforms}/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "LineOutput_CS"
}
Shader3D End

GLSL Start

#defineGLSL LineOutput_CS

/*VFX_CURVE_FUNC*/
${commonCode}

buffer RenderBuffer
{
    vec4 data[];
}
Render;

buffer IndirectBuffer
{
    uint count;
    uint instanceCount;
    uint firstInstance;
    uint baseVertex;
    uint firstVertex;
}
Indirect;

#define LINE_VERTEX_STRIDE 4

layout(local_size_x = 64, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint tid = gl_GlobalInvocationID.x;
    uint aliveCount = AliveListRead.count;

    if (tid >= aliveCount) return;

    uint particleIndex = AliveListRead.indices[tid];
    Particle p = readParticle(particleIndex);

${worldToLocal}${blockLines}
    vec3 startPos = p.position;
    vec3 endPos = p.position + vec3(${tx}, ${ty}, ${tz});

    uint vertBase = tid * 2u * uint(LINE_VERTEX_STRIDE);

    // Start vertex
    Render.data[vertBase + 0u] = vec4(startPos, 1.0);
    Render.data[vertBase + 1u] = vec4(${colorRGB}, ${alpha});
    Render.data[vertBase + 2u] = vec4(0.0, 0.5, 0.0, 0.0);
    Render.data[vertBase + 3u] = vec4(0.0, 1.0, 0.0, 0.0);

    // End vertex
    Render.data[vertBase + 4u] = vec4(endPos, 1.0);
    Render.data[vertBase + 5u] = vec4(${colorRGB}, ${alpha});
    Render.data[vertBase + 6u] = vec4(1.0, 0.5, 0.0, 0.0);
    Render.data[vertBase + 7u] = vec4(0.0, 1.0, 0.0, 0.0);

    // First thread sets indirect draw count
    if (tid == 0u) {
        Indirect.count = aliveCount * 2u;
        Indirect.instanceCount = 1u;
    }
}

#endGLSL

GLSL End
`;
}
