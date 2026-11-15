"""将 Fantastic 的 EMDF 元数据附到合成 E-AC-3 核心，生成离线封装回归素材"""

from pathlib import Path


def frames(data):
    """按 syncframe 声明长度拆分数据"""
    offset = 0
    while offset < len(data):
        size = ((((data[offset + 2] & 7) << 8) | data[offset + 3]) + 1) * 2
        yield data[offset:offset + size]
        offset += size


def crc16(data):
    """计算 E-AC-3 的 ANSI CRC，覆盖长度字段和附加元数据"""
    value = 0
    for byte in data:
        value ^= byte << 8
        for _ in range(8):
            value = ((value << 1) ^ 0x8005 if value & 0x8000 else value << 1) & 0xFFFF
    return value


root = Path(__file__).parent
metadata = list(frames((root / "../../../joc-core/tests/fixtures/joc_fixture.eac3").read_bytes()))
output = bytearray()
for index, core in enumerate(frames((root / "core.eac3").read_bytes())):
    reference = metadata[index % len(metadata)]
    marker = reference.find(b"\x58\x38", 16)
    container = b""
    if marker >= 0:
        size = int.from_bytes(reference[marker + 2:marker + 4], "big") + 4
        container = reference[marker:marker + size]
    size = 3072
    assert len(core) + len(container) + 2 <= size
    frame = bytearray(size)
    frame[:len(core)] = core
    frame[len(core):len(core) + len(container)] = container
    words = size // 2 - 1
    frame[2] = (frame[2] & 0xF8) | (words >> 8)
    frame[3] = words & 255
    frame[-2:] = crc16(frame[2:-2]).to_bytes(2, "big")
    output.extend(frame)
(root / "joc.eac3").write_bytes(output)
