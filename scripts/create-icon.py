"""Render TRACE's original vector mark as PNG and Windows ICO. No remote assets."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
ASSETS.mkdir(exist_ok=True)
SIZE = 1024
image = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((20, 20, 1004, 1004), radius=226, fill='#111820')
draw.rounded_rectangle((34, 34, 990, 990), radius=213, outline='#243241', width=10)
draw.line([(112, 698), (272, 698), (272, 526), (414, 526)], fill='#213b45', width=18, joint='curve')
draw.line([(725, 864), (725, 690), (869, 690), (869, 469)], fill='#213b45', width=18, joint='curve')
for cx, cy in [(112, 698), (869, 469)]:
    draw.ellipse((cx-23, cy-23, cx+23, cy+23), fill='#152730', outline='#2d6266', width=8)
draw.line([(271, 392), (512, 392), (512, 254), (732, 254)], fill='#ffb547', width=68, joint='curve')
draw.line([(512, 392), (512, 748)], fill='#ffb547', width=68)
for cx, cy in [(271, 392), (732, 254), (512, 748)]:
    draw.ellipse((cx-59, cy-59, cx+59, cy+59), fill='#ffb547')
    draw.ellipse((cx-24, cy-24, cx+24, cy+24), fill='#111820')
image.save(ASSETS / 'icon.png')
image.save(ASSETS / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
(ASSETS / 'icon.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<rect x="20" y="20" width="984" height="984" rx="226" fill="#111820"/>
<rect x="34" y="34" width="956" height="956" rx="213" fill="none" stroke="#243241" stroke-width="10"/>
<g fill="none" stroke="#213b45" stroke-width="18"><path d="M112 698H272V526H414"/><path d="M725 864V690H869V469"/></g>
<g fill="#152730" stroke="#2d6266" stroke-width="8"><circle cx="112" cy="698" r="23"/><circle cx="869" cy="469" r="23"/></g>
<path d="M271 392H512V254H732M512 392V748" fill="none" stroke="#ffb547" stroke-width="68" stroke-linejoin="round"/>
<g fill="#ffb547"><circle cx="271" cy="392" r="59"/><circle cx="732" cy="254" r="59"/><circle cx="512" cy="748" r="59"/></g>
<g fill="#111820"><circle cx="271" cy="392" r="24"/><circle cx="732" cy="254" r="24"/><circle cx="512" cy="748" r="24"/></g>
</svg>''', encoding='utf-8')
print('TRACE icon generated:', ASSETS / 'icon.ico')
