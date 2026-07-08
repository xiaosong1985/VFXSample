/**
 * OutputUpdate Compute Shader Template
 *
 * Runs before the actual Output shader. Performs:
 * 1. Camera-distance sorting (Bitonic Sort on global memory)
 * 2. Frustum culling (optional)
 * 3. IndirectDraw argument update
 *
 * The sorted index list is written to a SortedIndexBuffer which the
 * Output shader reads instead of AliveListRead.
 */

export interface IOutputUpdateOptions {
    cameraSort: boolean;
    frustumCull: boolean;
    hasMotionVectors: boolean;
}

export function generateOutputUpdate(
    commonCode: string,
    opts: IOutputUpdateOptions,
): string {
    const { cameraSort, frustumCull } = opts;

    const sortSection = cameraSort ? `
    // ── Camera-distance sort (per-workgroup local Bitonic Sort) ──
    // Load camera-distance key for each alive particle
    if (tid < aliveCount) {
        uint pidx = AliveListRead.indices[tid];
        Particle tmp = readParticle(pidx);
        vec3 worldPos = tmp.position;
        float dist = dot(worldPos - u_CameraPos, u_CameraForward);
        s_sortKey[tid] = dist;
        s_sortIdx[tid] = pidx;
    } else {
        s_sortKey[tid] = 1e30;
        s_sortIdx[tid] = 0u;
    }
    barrier();

    // Bitonic sort ascending (back-to-front: farthest first for alpha blending)
    for (uint k = 2u; k <= uint(SORT_CAPACITY); k <<= 1u) {
        for (uint j = k >> 1u; j > 0u; j >>= 1u) {
            uint ixj = tid ^ j;
            if (ixj > tid) {
                bool shouldSwap;
                if ((tid & k) == 0u) {
                    shouldSwap = s_sortKey[tid] > s_sortKey[ixj]; // ascending → back-to-front
                } else {
                    shouldSwap = s_sortKey[tid] < s_sortKey[ixj];
                }
                if (shouldSwap) {
                    float tKey = s_sortKey[tid];
                    s_sortKey[tid] = s_sortKey[ixj];
                    s_sortKey[ixj] = tKey;
                    uint tIdx = s_sortIdx[tid];
                    s_sortIdx[tid] = s_sortIdx[ixj];
                    s_sortIdx[ixj] = tIdx;
                }
            }
            barrier();
        }
    }

    // Write sorted indices to output buffer
    if (tid < aliveCount) {
        SortedIndex.indices[tid] = s_sortIdx[tid];
    }
    if (tid == 0u) {
        SortedIndex.count = aliveCount;
    }` : `
    // No sorting: copy AliveList to SortedIndex directly
    if (tid < aliveCount) {
        SortedIndex.indices[tid] = AliveListRead.indices[tid];
    }
    if (tid == 0u) {
        SortedIndex.count = aliveCount;
    }`;

    const cullSection = frustumCull ? `

    barrier();
    // ── Frustum culling ──
    // For each sorted particle, test against 6 frustum planes
    if (tid < aliveCount) {
        uint pidx = SortedIndex.indices[tid];
        Particle p = readParticle(pidx);
        vec4 clipPos = u_ViewProj * vec4(p.position, 1.0);
        float w = abs(clipPos.w);
        float margin = p.size * 2.0;
        bool visible = clipPos.x >= -w - margin && clipPos.x <= w + margin
                    && clipPos.y >= -w - margin && clipPos.y <= w + margin
                    && clipPos.z >= -w && clipPos.z <= w;
        if (!visible) {
            SortedIndex.indices[tid] = 0xFFFFFFFFu; // mark as culled
        }
    }` : "";

    return `Shader3D Start
{
    type: ComputeShader,
    name: "OutputUpdate",
    uniformMaps: [
        {
            u_CameraPos: { type: "Vector3" },
            u_CameraForward: { type: "Vector3" },
            u_ViewProj: { type: "Matrix4x4" }
        }
    ],
    code: "OutputUpdate_CS"
}
Shader3D End

GLSL Start

#defineGLSL OutputUpdate_CS

${commonCode}

buffer SortedIndexBuffer
{
    uint count;
    uint indices[];
}
SortedIndex;

#define SORT_CAPACITY 256

shared float s_sortKey[SORT_CAPACITY];
shared uint  s_sortIdx[SORT_CAPACITY];

layout(local_size_x = SORT_CAPACITY, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint tid = gl_LocalInvocationID.x;
    uint aliveCount = min(AliveListRead.count, uint(SORT_CAPACITY));
${sortSection}${cullSection}
}

#endGLSL

GLSL End
`;
}
