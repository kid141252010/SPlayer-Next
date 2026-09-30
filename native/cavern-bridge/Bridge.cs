using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Cavern;
using Cavern.Format;
using Cavern.Format.Renderers;

namespace CavernBridge;

[StructLayout(LayoutKind.Sequential)]
public struct CavernStreamInfo
{
    public int SampleRate;
    public int StaticChannelCount;
    public int DynamicObjectCount;
    public int TotalObjectCount;
    public long LengthSamples;
    public int HasObjects;
}

[StructLayout(LayoutKind.Sequential)]
public struct CavernObjectInfo
{
    public float X;
    public float Y;
    public float Z;
    public float Volume;
    public float Size;
    public int ChannelType;
    public int IsDynamic;
}

internal sealed class DecoderContext : IDisposable
{
    public AudioReader Reader { get; }
    public Renderer Renderer { get; }
    public int SampleRate { get; }
    public int StaticCount { get; }
    public int DynamicCount { get; }
    public int TotalCount { get; }
    public Cavern.Channels.ReferenceChannel[] StaticChannels { get; }

    public DecoderContext(AudioReader reader, Renderer renderer)
    {
        Reader = reader;
        Renderer = renderer;
        SampleRate = reader.SampleRate;

        if (renderer is EnhancedAC3Renderer eac3)
        {
            StaticChannels = eac3.GetStaticChannels() ?? Array.Empty<Cavern.Channels.ReferenceChannel>();
            StaticCount = StaticChannels.Length;
            DynamicCount = eac3.DynamicObjects;
        }
        else
        {
            StaticChannels = renderer.GetChannels() ?? Array.Empty<Cavern.Channels.ReferenceChannel>();
            StaticCount = StaticChannels.Length;
            DynamicCount = Math.Max(0, renderer.Objects.Count - StaticCount);
        }

        TotalCount = renderer.Objects.Count;
    }

    public void Dispose()
    {
        try
        {
            Renderer.Dispose();
        }
        catch { }

        try
        {
            Reader.Dispose();
        }
        catch { }
    }
}

public static unsafe class Exports
{
    [UnmanagedCallersOnly(EntryPoint = "cavern_is_available")]
    public static int CavernIsAvailable() => 1;

    [UnmanagedCallersOnly(EntryPoint = "cavern_open")]
    public static IntPtr CavernOpen(byte* utf8Path, CavernStreamInfo* outInfo)
    {
        if (utf8Path == null || outInfo == null) return IntPtr.Zero;

        try
        {
            string path = Marshal.PtrToStringUTF8((IntPtr)utf8Path) ?? string.Empty;
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return IntPtr.Zero;

            AudioReader reader = AudioReader.Open(path);
            if (reader == null) return IntPtr.Zero;

            reader.ReadHeader();
            Renderer renderer = reader.GetRenderer();
            if (renderer == null)
            {
                reader.Dispose();
                return IntPtr.Zero;
            }

            var ctx = new DecoderContext(reader, renderer);
            outInfo->SampleRate = ctx.SampleRate;
            outInfo->StaticChannelCount = ctx.StaticCount;
            outInfo->DynamicObjectCount = ctx.DynamicCount;
            outInfo->TotalObjectCount = ctx.TotalCount;
            outInfo->LengthSamples = reader.Length;
            outInfo->HasObjects = renderer.HasObjects ? 1 : 0;

            GCHandle handle = GCHandle.Alloc(ctx);
            return GCHandle.ToIntPtr(handle);
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "cavern_read_block")]
    public static int CavernReadBlock(
        IntPtr contextHandle,
        int sampleCount,
        float* outPlanarSamples,
        CavernObjectInfo* outObjectInfo)
    {
        if (contextHandle == IntPtr.Zero || sampleCount <= 0 || outPlanarSamples == null)
            return 0;

        try
        {
            GCHandle handle = GCHandle.FromIntPtr(contextHandle);
            if (!handle.IsAllocated || handle.Target is not DecoderContext ctx)
                return 0;

            float[][] objectSamples = ctx.Renderer.GetNextObjectSamples(sampleCount);
            if (objectSamples == null || objectSamples.Length == 0)
                return 0;

            int totalObjects = Math.Min(ctx.TotalCount, objectSamples.Length);

            // 填充每个对象的时变元数据（坐标、音量、尺寸）
            if (outObjectInfo != null)
            {
                var sources = ctx.Renderer.Objects;
                for (int i = 0; i < totalObjects; i++)
                {
                    bool isDynamic = i >= ctx.StaticCount;
                    int channelType = i < ctx.StaticChannels.Length
                        ? (int)ctx.StaticChannels[i]
                        : (int)Cavern.Channels.ReferenceChannel.Unknown;

                    if (i < sources.Count)
                    {
                        Source src = sources[i];
                        outObjectInfo[i] = new CavernObjectInfo
                        {
                            X = src.Position.X,
                            Y = src.Position.Y,
                            Z = src.Position.Z,
                            Volume = src.Volume,
                            Size = src.Size,
                            ChannelType = channelType,
                            IsDynamic = isDynamic ? 1 : 0
                        };
                    }
                    else
                    {
                        outObjectInfo[i] = new CavernObjectInfo
                        {
                            X = 0,
                            Y = 0,
                            Z = 0,
                            Volume = 1.0f,
                            Size = 0,
                            ChannelType = channelType,
                            IsDynamic = isDynamic ? 1 : 0
                        };
                    }
                }
            }

            // 平面拷贝音频数据：每个对象连续存放 sampleCount 个 float 样本
            for (int i = 0; i < totalObjects; i++)
            {
                float[] samples = objectSamples[i];
                float* dest = outPlanarSamples + (i * sampleCount);
                if (samples != null && samples.Length > 0)
                {
                    int toCopy = Math.Min(sampleCount, samples.Length);
                    fixed (float* src = samples)
                    {
                        Buffer.MemoryCopy(src, dest, sampleCount * sizeof(float), toCopy * sizeof(float));
                    }
                    if (toCopy < sampleCount)
                    {
                        new Span<float>(dest + toCopy, sampleCount - toCopy).Clear();
                    }
                }
                else
                {
                    new Span<float>(dest, sampleCount).Clear();
                }
            }

            return sampleCount;
        }
        catch
        {
            return 0;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "cavern_seek")]
    public static int CavernSeek(IntPtr contextHandle, long sampleOffset)
    {
        if (contextHandle == IntPtr.Zero || sampleOffset < 0) return 0;

        try
        {
            GCHandle handle = GCHandle.FromIntPtr(contextHandle);
            if (!handle.IsAllocated || handle.Target is not DecoderContext ctx)
                return 0;

            ctx.Reader.Seek(sampleOffset);
            return 1;
        }
        catch
        {
            return 0;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "cavern_close")]
    public static void CavernClose(IntPtr contextHandle)
    {
        if (contextHandle == IntPtr.Zero) return;

        try
        {
            GCHandle handle = GCHandle.FromIntPtr(contextHandle);
            if (handle.IsAllocated)
            {
                if (handle.Target is DecoderContext ctx)
                {
                    ctx.Dispose();
                }
                handle.Free();
            }
        }
        catch { }
    }
}
