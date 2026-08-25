from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os, math

# ── BRAND TOKENS
W, H       = 1200, 630
GREEN_DEEP = (7, 12, 9)
GREEN      = (28, 56, 40)
PARCHMENT  = (237, 217, 176)
AMBER      = (224, 122, 21)

# ── CANVAS — green card panel with edge vignette
panel = np.full((H, W, 3), GREEN, dtype=np.float32)

xs = np.linspace(0, 1, W, dtype=np.float32)
ys = np.linspace(0, 1, H, dtype=np.float32)
horiz = 1 - 4*(xs - 0.5)**2
vert  = 1 - 4*(ys - 0.5)**2
mask  = np.clip(np.outer(vert, horiz)**0.6, 0, 1)

for c in range(3):
    panel[:,:,c] = (
        panel[:,:,c] * mask +
        np.full((H, W), GREEN_DEEP[c], dtype=np.float32) * (1 - mask)
    )

img  = Image.fromarray(np.clip(panel, 0, 255).astype(np.uint8)).convert('RGBA')
draw = ImageDraw.Draw(img)

# ── V LOGO
cx, cy = W // 2, H // 2 - 20
R  = 108

# Circle ring
draw.ellipse([(cx-R, cy-R), (cx+R, cy+R)], outline=(*PARCHMENT, 55), width=2)

# Outer V (parchment)
vw = int(R * 0.72)
vt = cy - int(R * 0.52)
vb = cy + int(R * 0.50)
for w in [4, 3, 2]:
    alpha = 180 if w == 3 else 60
    draw.line([(cx - vw, vt), (cx, vb)], fill=(*PARCHMENT, alpha), width=w)
    draw.line([(cx + vw, vt), (cx, vb)], fill=(*PARCHMENT, alpha), width=w)

# Inner V (amber)
ivw  = int(R * 0.36)
ivb  = cy + int(R * 0.05)
for w in [4, 3, 2]:
    alpha = 255 if w == 3 else 80
    draw.line([(cx - ivw, vt), (cx, ivb)], fill=(*AMBER, alpha), width=w)
    draw.line([(cx + ivw, vt), (cx, ivb)], fill=(*AMBER, alpha), width=w)

# ── FONTS
def find_font(names, size):
    dirs = ['/System/Library/Fonts/', '/System/Library/Fonts/Supplemental/',
            '/Library/Fonts/', os.path.expanduser('~/Library/Fonts/')]
    for name in names:
        for d in dirs:
            p = os.path.join(d, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except:
                    pass
    return ImageFont.load_default(size=size)

font_hero  = find_font(['Georgia Bold.ttf', 'GeorgiaBd.TTF', 'TimesNewRomanPS-BoldMT.otf', 'Arial Bold.ttf'], 68)
font_label = find_font(['Menlo-Regular.ttf', 'Monaco.dfont', 'CourierNewPSMT.ttf'], 17)
font_sub   = find_font(['Georgia.ttf', 'Times New Roman.ttf', 'Arial.ttf'], 21)

# Eyebrow
eye = 'EST. 2024  ·  NEW ENGLAND'
eb  = draw.textbbox((0,0), eye, font=font_label)
draw.text(((W-(eb[2]-eb[0]))//2, cy-R-44), eye, font=font_label, fill=(*PARCHMENT, 75))

# VALIDARE CAPITAL
hero = 'VALIDARE CAPITAL'
hb   = draw.textbbox((0,0), hero, font=font_hero)
hy   = cy + R + 40
draw.text(((W-(hb[2]-hb[0]))//2, hy), hero, font=font_hero, fill=(*PARCHMENT, 235))

# Amber rule
ry = hy + (hb[3]-hb[1]) + 26
draw.rectangle([(W//2-40, ry), (W//2+40, ry+1)], fill=(*AMBER, 200))

# Tagline
tag = 'Execution-led. Valuation-focused. Bold impact.'
tb  = draw.textbbox((0,0), tag, font=font_sub)
draw.text(((W-(tb[2]-tb[0]))//2, ry+18), tag, font=font_sub, fill=(*PARCHMENT, 115))

# URL bottom-right
url = 'validarecap.com'
ub  = draw.textbbox((0,0), url, font=font_label)
draw.text((W-(ub[2]-ub[0])-52, H-46), url, font=font_label, fill=(*AMBER, 170))

# Save
out = '/Users/kulltivate/code/validare-website/og.png'
img.convert('RGB').save(out, 'PNG', optimize=True)
print(f'Saved: {out}')
