import os
import sys
from PIL import Image

def process_image(input_path, output_path, threshold=28, fade_range=32):
    if not os.path.exists(input_path):
        print(f"File not found: {input_path}")
        return
        
    img = Image.open(input_path).convert("RGBA")
    pixels = img.load()
    width, height = img.size

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            # Max luminance indicator
            max_c = max(r, g, b)
            
            if max_c <= threshold:
                # Fully transparent background
                pixels[x, y] = (r, g, b, 0)
            elif max_c <= threshold + fade_range:
                # Smooth alpha falloff for clean edges
                alpha = int(255 * (max_c - threshold) / fade_range)
                pixels[x, y] = (r, g, b, alpha)

    img.save(output_path, "PNG")
    print(f"Successfully generated transparent floating PNG: {output_path}")

if __name__ == "__main__":
    brain_dir = r"C:\Users\ShadowBlade\.gemini\antigravity-cli\brain\f758128b-500d-42b9-ac84-7800391a8b02"
    public_assets = r"C:\Users\ShadowBlade\Documents\Projects\CAC\public\assets"

    mappings = [
        ("floating_hero_3d_1784703947675.jpg", "hero-3d-floating.png"),
        ("floating_ownership_3d_1784703960400.jpg", "icon-ownership-3d-floating.png"),
        ("floating_missing_3d_1784703971714.jpg", "icon-missing-3d-floating.png"),
        ("floating_title_3d_1784703984658.jpg", "icon-title-3d-floating.png"),
        ("floating_fraud_3d_1784703996052.jpg", "icon-fraud-3d-floating.png"),
        ("icon_asset_3d_1784703733513.jpg", "icon-asset-3d-floating.png"),
        ("icon_legal_3d_1784703746599.jpg", "icon-legal-3d-floating.png"),
        ("about_building_3d_1784703663095.jpg", "about-building-3d-floating.png")
    ]

    for src, dest in mappings:
        inp = os.path.join(brain_dir, src)
        outp = os.path.join(public_assets, dest)
        process_image(inp, outp)
