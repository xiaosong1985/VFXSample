/**
 * PrepareDispatch compute shader — GPU Event 接收端的间接 dispatch 参数计算
 *
 * 由源系统 Update 写入 EventIndexBuffer.count 后执行，
 * 计算 GPUInitialize 所需的 workgroup 数量写入 GPUEventDispatchBuffer。
 */

export function generatePrepareDispatch(shaderName: string): string {
    return `\
Shader3D Start
{
    type: ComputeShader,
    name: "${shaderName}",
    uniformMaps: [
        {
            u_MaxSpawnCount: { type: "Int" }
        }
    ],
    code: "PrepareDispatch_CS"
}
Shader3D End

GLSL Start

#defineGLSL PrepareDispatch_CS

#include "VFXGPUEvent.glsl"

layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;

void main()
{
    uint eventCount = GPUEvent.count;
    uint totalSpawn = min(eventCount, uint(u_MaxSpawnCount));
    GPUEventDispatch.dispatchX = (totalSpawn + 63u) / 64u;
    GPUEventDispatch.dispatchY = 1u;
    GPUEventDispatch.dispatchZ = 1u;
}

#endGLSL

GLSL End`;
}
