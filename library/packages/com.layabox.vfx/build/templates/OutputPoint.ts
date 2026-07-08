/**
 * Output Point Compute Shader Template
 *
 * Each particle generates a single point vertex.
 * Simplest output type — each alive particle produces 1 vertex with position + color.
 *
 * RenderBuffer layout (per vertex, 3 vec4):
 *   [0] xyz=position, w=pointSize
 *   [1] rgba=color
 *   [2] xy=uv, zw=0
 */

export interface IPointOutputOptions {
    hasColor: boolean;
    hasAlpha: boolean;
    hasSize: boolean;
    blockCode: string;
    extraUniforms: string;
    simulateSpace: string;
    attrNames: Set<string>;
}

export function generatePointOutput(
    commonCode: string,
    opts: IPointOutputOptions,
): string {
    const { blockCode, extraUniforms, attrNames, simulateSpace } = opts;
    const isWorld = simulateSpace === "World";

    const colorRGB = attrNames.has("color") ? "p.color" : "vec3(1.0)";
    const alpha = attrNames.has("alpha") ? "p.alpha" : "1.0";
    const size = attrNames.has("size") ? "p.size" : "1.0";

    const worldToLocal = isWorld && attrNames.has("position")
        ? "    p.position = transformPosition(u_InvEmitterWorldMatrix, p.position);\n"
        : "";

    const blockLines = blockCode ? blockCode + "\n" : "";

    return `Shader3D Start
{
    type: ComputeShader,
    name: "PointOutput",
    uniformMaps: [
        {
            u_Capacity: { type: "Int" },
            u_EmitterWorldMatrix: { type: "Matrix4x4" },
            u_InvEmitterWorldMatrix: { type: "Matrix4x4" }${extraUniforms}/*VFX_EXTRA_UNIFORMS*/
        }
    ],
    code: "PointOutput_CS"
}
Shader3D End

GLSL Start

#defineGLSL PointOutput_CS

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

#define POINT_VERTEX_STRIDE 3

layout(local_size_x = 64, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint tid = gl_GlobalInvocationID.x;
    uint aliveCount = AliveListRead.count;

    if (tid >= aliveCount) return;

    uint particleIndex = AliveListRead.indices[tid];
    Particle p = readParticle(particleIndex);

${worldToLocal}${blockLines}
    uint vertBase = tid * uint(POINT_VERTEX_STRIDE);

    Render.data[vertBase + 0u] = vec4(p.position, ${size});
    Render.data[vertBase + 1u] = vec4(${colorRGB}, ${alpha});
    Render.data[vertBase + 2u] = vec4(0.5, 0.5, 0.0, 0.0);

    if (tid == 0u) {
        Indirect.count = aliveCount;
        Indirect.instanceCount = 1u;
    }
}

#endGLSL

GLSL End
`;
}
