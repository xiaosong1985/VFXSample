/**
 * UpdateStrips Compute Shader Template — Minimal Version
 *
 * Does NOT include VFXCommon (avoids naga 64-bit literal issues).
 * Reads the alive flag directly from AttributeBuffer at a known offset.
 *
 * StripDataBuffer layout (per strip, 4 uint):
 *   [0] FIRST_INDEX     — ring buffer start position (live, modified by scan & GPUInit)
 *   [1] NEXT_INDEX      — number of particles currently in the strip (live, modified by scan & GPUInit)
 *   [2] SNAP_FIRST      — snapshot firstIndex (written by Output thread 0, read by all render threads)
 *   [3] SNAP_NEXT       — snapshot nextIndex (written by Output thread 0, read by all render threads)
 */

export function generateUpdateStrips(particleStride: number, aliveSlot: number, aliveSwizzleIndex: number): string {
    // aliveSwizzleIndex: 0=x, 1=y, 2=z, 3=w
    const swizzle = ["x", "y", "z", "w"][aliveSwizzleIndex] || "x";

    return `Shader3D Start
{
    type: ComputeShader,
    name: "UpdateStrips",
    uniformMaps: [
        {
            u_StripCapacity: { type: "Int" },
            u_ParticlePerStrip: { type: "Int" }
        }
    ],
    code: "UpdateStrips_CS"
}
Shader3D End

GLSL Start

#defineGLSL UpdateStrips_CS

#include "VFXUtils.glsl"

buffer StripDataBuffer
{
    uint data[];
}
StripData;

#define NB_THREADS_PER_GROUP 64
layout(local_size_x = NB_THREADS_PER_GROUP, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint stripIndex = gl_LocalInvocationID.x + gl_WorkGroupID.x * NB_THREADS_PER_GROUP;
    if (stripIndex >= uint(u_StripCapacity)) return;

    uint base = stripIndex * 5u;
    uint ppsc = uint(u_ParticlePerStrip);
    uint firstIndex = StripData.data[base];
    uint count = min(StripData.data[base + 1u], ppsc);
    uint minAlive = StripData.data[base + 4u];

    // O(1) compaction using minAlive from Update's atomicMin (matches Unity UpdateStrips)
    bool isEmpty = (minAlive == 4294967295u); // 0xFFFFFFFF sentinel = no alive particles

    if (isEmpty) {
        StripData.data[base] = 0u;
        StripData.data[base + 1u] = 0u;
    } else {
        // Advance firstIndex past dead particles at the front
        StripData.data[base] = (firstIndex + minAlive) % ppsc;
        // Update count: subtract dead particles from front
        StripData.data[base + 1u] = (count > minAlive) ? count - minAlive : 0u;
    }

    // Snapshot for Output shader (stable read while Init may modify slots 0/1)
    StripData.data[base + 2u] = StripData.data[base];
    StripData.data[base + 3u] = StripData.data[base + 1u];

    // Reset minAlive for next frame
    StripData.data[base + 4u] = 4294967295u;
}

#endGLSL

GLSL End
`;
}
