from PIL import Image
import numpy as np

src = Image.open("src/assets/cac-logo-source.jpeg").convert("RGB")
arr = np.array(src).astype(np.float32)

# Same alpha derivation as before (distance from white), but we now find the
# CONTENT bbox using a real visibility threshold instead of raw getbbox(),
# which was fooled by near-zero alpha noise (jpeg compression artifacts)
# into including a large invisible margin above the roofline.
white_dist = 255 - arr.min(axis=2)
alpha = np.clip(white_dist * 2.4, 0, 255).astype(np.uint8)
rgba = np.dstack([arr.astype(np.uint8), alpha])
full = Image.fromarray(rgba, mode="RGBA")

THRESH = 20
mask = alpha > THRESH
rows = np.any(mask, axis=1)
cols = np.any(mask, axis=0)
top, bottom = np.where(rows)[0][[0, -1]]
left, right = np.where(cols)[0][[0, -1]]
pad = 4
top = max(0, top - pad)
left = max(0, left - pad)
bottom = min(full.size[1] - 1, bottom + pad)
right = min(full.size[0] - 1, right + pad)
print("full logo tight content box:", (left, top, right, bottom))

full_trimmed = full.crop((left, top, right + 1, bottom + 1))
full_trimmed.save("public/logo-full.png")
print("full logo (icon + wordmark):", full_trimmed.size)

# Icon-only mark: crop above the wordmark text (same 715px line as before,
# relative to the ORIGINAL 1080x1080 canvas), then apply the same real
# content-bbox trim within that slice.
icon_slice = full.crop((0, 0, 1080, 715))
islice_arr = np.array(icon_slice)
ialpha = islice_arr[:, :, 3]
imask = ialpha > THRESH
irows = np.any(imask, axis=1)
icols = np.any(imask, axis=0)
itop, ibottom = np.where(irows)[0][[0, -1]]
ileft, iright = np.where(icols)[0][[0, -1]]
itop = max(0, itop - pad)
ileft = max(0, ileft - pad)
ibottom = min(icon_slice.size[1] - 1, ibottom + pad)
iright = min(icon_slice.size[0] - 1, iright + pad)
print("icon mark tight content box:", (ileft, itop, iright, ibottom))

icon_trimmed = icon_slice.crop((ileft, itop, iright + 1, ibottom + 1))
icon_trimmed.save("public/icon.png")
print("icon mark:", icon_trimmed.size)

# Square favicon/apple-touch-icon: pad the tightly-cropped icon mark to a
# square canvas so it isn't stretched.
w, h = icon_trimmed.size
side = max(w, h)
padpx = int(side * 0.12)
canvas_side = side + padpx * 2
canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
canvas.paste(icon_trimmed, ((canvas_side - w) // 2, (canvas_side - h) // 2), icon_trimmed)

favicon = canvas.resize((256, 256), Image.LANCZOS)
favicon.save("public/favicon.png")

apple = canvas.resize((180, 180), Image.LANCZOS)
apple.save("public/apple-touch-icon.png")

# cac.png: full lockup (icon + wordmark), transparent, tightly cropped.
full_trimmed.save("public/cac.png")

print("done")
