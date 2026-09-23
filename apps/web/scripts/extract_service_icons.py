from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


SERVICE_IDS = (
    'property-forensic',
    'family-estate',
    'property-intelligence',
    'missing-property',
    'asset-tracing',
    'title-investigation',
    'fraud-investigation',
    'legal-coordination',
    'property-sale',
    'buyer-matching',
    'investment-consultancy',
    'renovation-consultancy',
)

EXPECTED_SOURCE_SIZE = (768, 512)
OUTPUT_SIZE = (192, 171)


def extract_icons(source_path: Path, output_dir: Path) -> list[Path]:
    source = Image.open(source_path).convert('RGBA')
    if source.size != EXPECTED_SOURCE_SIZE:
        raise ValueError(
            f'Expected a {EXPECTED_SOURCE_SIZE[0]}x{EXPECTED_SOURCE_SIZE[1]} '
            f'master, received {source.size}.'
        )

    pixels = np.asarray(source)
    alpha_mask = pixels[:, :, 3] > 0
    labels, component_count = ndimage.label(
        alpha_mask,
        structure=np.ones((3, 3), dtype=np.uint8),
    )
    if component_count != len(SERVICE_IDS):
        raise ValueError(
            f'Expected {len(SERVICE_IDS)} connected alpha components, '
            f'found {component_count}.'
        )

    components = []
    for label_id, slices in enumerate(ndimage.find_objects(labels), start=1):
        if slices is None:
            continue
        y_slice, x_slice = slices
        component_mask = labels[y_slice, x_slice] == label_id
        y_center, x_center = ndimage.center_of_mass(
            alpha_mask,
            labels,
            label_id,
        )
        components.append(
            {
                'label': label_id,
                'slices': slices,
                'mask': component_mask,
                'center': (float(x_center), float(y_center)),
                'area': int(component_mask.sum()),
            }
        )

    # Sort by visual row, then by column. Each global component is one complete
    # icon, so pixels that cross a nominal sprite boundary stay with their owner.
    components.sort(key=lambda component: component['center'][1])
    ordered_components = []
    for row_start in range(0, len(components), 4):
        row = components[row_start : row_start + 4]
        row.sort(key=lambda component: component['center'][0])
        ordered_components.extend(row)

    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    for service_id, component in zip(SERVICE_IDS, ordered_components, strict=True):
        y_slice, x_slice = component['slices']
        tile_pixels = pixels[y_slice, x_slice].copy()
        tile_pixels[~component['mask']] = 0
        tile = Image.fromarray(tile_pixels, 'RGBA')

        if tile.width > OUTPUT_SIZE[0] or tile.height > OUTPUT_SIZE[1]:
            raise ValueError(
                f'{service_id} component {tile.size} exceeds canvas {OUTPUT_SIZE}.'
            )

        canvas = Image.new('RGBA', OUTPUT_SIZE, (0, 0, 0, 0))
        offset = (
            (OUTPUT_SIZE[0] - tile.width) // 2,
            (OUTPUT_SIZE[1] - tile.height) // 2,
        )
        canvas.alpha_composite(tile, offset)

        alpha = canvas.getchannel('A')
        content_box = alpha.getbbox()
        if content_box is None:
            raise ValueError(f'{service_id} produced an empty image.')

        corners = (
            alpha.getpixel((0, 0)),
            alpha.getpixel((OUTPUT_SIZE[0] - 1, 0)),
            alpha.getpixel((0, OUTPUT_SIZE[1] - 1)),
            alpha.getpixel((OUTPUT_SIZE[0] - 1, OUTPUT_SIZE[1] - 1)),
        )
        if any(corners):
            raise ValueError(f'{service_id} has non-transparent corner pixels: {corners}.')

        output_path = output_dir / f'{service_id}.png'
        canvas.save(output_path, 'PNG', optimize=True)
        print(
            f'{service_id}: component={component["label"]} '
            f'area={component["area"]} bbox={tile.size}'
        )
        written.append(output_path)

    return written


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Extract isolated CAC service icons from the transparent master.'
    )
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()

    for path in extract_icons(args.input, args.output_dir):
        print(path)


if __name__ == '__main__':
    main()
