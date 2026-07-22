"""生成岗位猎手插件图标 - 16/48/128 三种尺寸"""
from PIL import Image, ImageDraw, ImageFont
import os

ICON_DIR = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(ICON_DIR, exist_ok=True)

def make_icon(size):
    """绘制一个蓝底白靶心图标"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角蓝色背景
    margin = max(1, size // 16)
    radius = size // 5
    bg_color = (37, 99, 235, 255)  # #2563eb
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius, fill=bg_color
    )

    # 内层渐变(简化:画一个稍亮的圆角矩形)
    inner_margin = size // 6
    if size >= 48:
        draw.rounded_rectangle(
            [inner_margin, inner_margin, size - inner_margin, size - inner_margin],
            radius=radius // 2, fill=(29, 78, 216, 200)
        )

    # 画靶心(同心圆)
    cx, cy = size // 2, size // 2
    ring_r = size // 3
    if size >= 16:
        # 外环
        draw.ellipse(
            [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
            outline=(255, 255, 255, 230), width=max(1, size // 32)
        )
        # 中环
        mid_r = ring_r * 2 // 3
        draw.ellipse(
            [cx - mid_r, cy - mid_r, cx + mid_r, cy + mid_r],
            outline=(255, 255, 255, 200), width=max(1, size // 40)
        )
        # 中心点
        dot_r = max(2, size // 10)
        draw.ellipse(
            [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
            fill=(34, 197, 94, 255)  # 绿色中心
        )

    return img

for s in [16, 48, 128]:
    icon = make_icon(s)
    path = os.path.join(ICON_DIR, f"icon{s}.png")
    icon.save(path, "PNG")
    print(f"生成 {path} ({s}x{s})")

print("图标生成完成")
