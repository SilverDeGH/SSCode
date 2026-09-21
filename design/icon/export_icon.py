"""Export the launcher artwork at 1024px. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SIZE = 2048
# Adaptive launchers show the central 72 of the 108-unit layer.
def point(x, y):
    return ((x - 18) * SIZE / 72, (y - 18) * SIZE / 72)

icon = Image.new('RGB', (SIZE, SIZE), '#142B50')
draw = ImageDraw.Draw(icon)
draw.polygon([point(0, 0), point(108, 0), point(108, 20), point(0, 91)], fill='#19365E')

def stroke(points, color):
    radius = SIZE / 24
    coords = [point(*p) for p in points]
    draw.line(coords, fill=color, width=round(radius * 2), joint='curve')
    for x, y in coords:
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)

stroke([(72,34),(45,34),(32,44)], '#F4F8FF')
draw.polygon([point(*p) for p in [(30,46.2),(41,54),(34,41.8)]], fill='#F4F8FF')
stroke([(76,64),(63,74),(36,74)], '#5DE1DD')
draw.polygon([point(*p) for p in [(78,61.8),(67,54),(74,66.2)]], fill='#5DE1DD')
draw.polygon([point(*p) for p in [(54,41),(57.9,50.1),(67,54),(57.9,57.9),(54,67),(50.1,57.9),(41,54),(50.1,50.1)]], fill='#5DE1DD')
icon.resize((1024,1024), Image.Resampling.LANCZOS).save(OUT / 'sscode-icon.png')
mask = Image.new('L', (SIZE,SIZE))
ImageDraw.Draw(mask).rounded_rectangle((0,0,SIZE-1,SIZE-1), radius=SIZE*0.23, fill=255)
icon.putalpha(mask)
icon.resize((512,512), Image.Resampling.LANCZOS).save(OUT / 'sscode-icon-preview.png')
