#!/usr/bin/env python3
"""
envelope_tool.py

Generate smooth, irregular, low-resolution "blob" envelope surfaces for
user-defined protein domains (selected by segid + resid) from an all-atom
PDB file. Think: simulated low-resolution EM-map isosurface per domain,
not a convex hull.

Pipeline:
  1. Load structure (MDAnalysis)
  2. Parse domain config (YAML) -> atom selections + per-domain viz params
  3. Build a shared 3D density grid; splat each atom as a Gaussian
  4. Voronoi-partition the grid so domains never overlap at interfaces
  5. Per domain: auto-calibrate isosurface threshold to match expected
     molecular volume, run marching cubes
  6. Taubin-smooth + decimate the mesh (smoothness is a user knob)
  7. Export per-domain OBJ + a combined PyMOL script with the requested
     color / transparency / cartoon settings baked in

Usage:
  python envelope.py structure.pdb domains.yaml -o out_dir/
  python envelope.py structure.pdb domains.yaml -o out_dir/ --preview

See also: server.py, which exposes this same pipeline (via envelope_core.py)
through an interactive web UI.
"""

import argparse
import os
import numpy as np
import yaml
import MDAnalysis as mda

from envelope_core import load_domain_config as _fill_defaults, expand_multichain_domains, run_pipeline


def load_domain_config(path):
    with open(path) as f:
        cfg = yaml.safe_load(f)
    domains, global_cfg = _fill_defaults(cfg)
    domains = expand_multichain_domains(domains)
    return domains, global_cfg


def main():
    ap = argparse.ArgumentParser(description="Generate blob-style domain envelopes from an all-atom PDB.")
    ap.add_argument("pdb", help="Input all-atom PDB file")
    ap.add_argument("config", help="YAML file defining domains and viz parameters")
    ap.add_argument("-o", "--outdir", default="envelope_out", help="Output directory")
    ap.add_argument("--preview", action="store_true", help="Save a static preview image at the end")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    u = mda.Universe(args.pdb)
    domains, global_cfg = load_domain_config(args.config)

    domain_outputs, script_path = run_pipeline(u, domains, global_cfg, args.pdb, args.outdir)

    print(f"      Open in PyMOL with: pymol {script_path}")
    print(f"      (this builds each envelope as a native PyMOL CGO mesh -- "
          f"no OBJ-import step, no extra dependencies needed inside PyMOL)")

    if args.preview:
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            from mpl_toolkits.mplot3d.art3d import Poly3DCollection

            fig = plt.figure(figsize=(9, 7))
            ax = fig.add_subplot(111, projection="3d")
            all_verts = []
            for d in domain_outputs:
                m = d["mesh"]
                r, g, b = d["color"]
                tri = m.vertices[m.faces]
                coll = Poly3DCollection(tri, facecolor=(r, g, b, d["transparency"] and 1 - d["transparency"] or 0.6),
                                         edgecolor="none")
                ax.add_collection3d(coll)
                all_verts.append(m.vertices)
            allv = np.vstack(all_verts)
            ax.set_xlim(allv[:, 0].min(), allv[:, 0].max())
            ax.set_ylim(allv[:, 1].min(), allv[:, 1].max())
            ax.set_zlim(allv[:, 2].min(), allv[:, 2].max())
            ax.set_box_aspect([np.ptp(allv[:, 0]), np.ptp(allv[:, 1]), np.ptp(allv[:, 2])])
            ax.set_axis_off()
            ax.view_init(elev=20, azim=35)
            plt.tight_layout()
            preview_path = os.path.join(args.outdir, "preview.png")
            plt.savefig(preview_path, dpi=150)
            print(f"      Preview image saved (no GUI window needed): {preview_path}")
        except Exception as e:
            print(f"      [note] Preview render skipped due to: {e}")


if __name__ == "__main__":
    main()
